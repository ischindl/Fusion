import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { Task, TaskStore } from "@fusion/core";
import {
  classifyBootstrapMisbinding,
  inspectBranchConflict,
  reanchorBranchToBase,
} from "../branch-conflicts.js";
import type { AutoRecoveryContext, AutoRecoveryDecision, AutoRecoveryFailure } from "../auto-recovery.js";
import { createLogger, type Logger } from "../logger.js";
import type { RunAuditor } from "../run-audit.js";

const execAsync = promisify(exec);
const baseLog = createLogger("auto-recovery:branch-worktree");
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

export interface BranchWorktreeRecoveryDeps {
  taskStore: TaskStore;
  runAudit: RunAuditor;
  logger?: Logger;
  spawnAiRecoverySession?: (
    failure: AutoRecoveryFailure,
    decision: AutoRecoveryDecision,
    ctx: AutoRecoveryContext,
  ) => Promise<{ outcome: "resolved" | "exhausted" | "error"; metadata?: Record<string, unknown> }>;
  now?: () => Date;
}

interface RecoveryEvidence {
  branchExists: boolean;
  worktreePresent: boolean;
  tipSha?: string;
  inspectionKind?: string;
}

export class BranchWorktreeAutoRecoveryHandler {
  constructor(private readonly deps: BranchWorktreeRecoveryDeps) {}

  private get logger(): Logger {
    return this.deps.logger ?? baseLog;
  }

  private async runGit(repoDir: string, command: string): Promise<string> {
    const { stdout } = await execAsync(command, {
      cwd: repoDir,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: "utf-8",
    });
    return stdout.trim();
  }

  private quote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  private async hasBranchRef(repoDir: string, branchName: string): Promise<boolean> {
    try {
      await this.runGit(repoDir, `git rev-parse --verify ${this.quote(`refs/heads/${branchName}`)}`);
      return true;
    } catch {
      return false;
    }
  }

  private async getTipSha(repoDir: string, branchName: string): Promise<string | undefined> {
    try {
      return await this.runGit(repoDir, `git rev-parse --verify ${this.quote(`refs/heads/${branchName}`)}`);
    } catch {
      return undefined;
    }
  }

  private async getWorktreeBranchMap(repoDir: string): Promise<Map<string, string>> {
    const output = await this.runGit(repoDir, "git worktree list --porcelain").catch(() => "");
    const map = new Map<string, string>();
    let path: string | null = null;
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      if (line.startsWith("branch refs/heads/") && path) {
        map.set(line.slice("branch refs/heads/".length).trim(), path);
      }
      if (!line.trim()) path = null;
    }
    return map;
  }

  private async resolveRepoDir(ctx: AutoRecoveryContext, failure: AutoRecoveryFailure): Promise<string> {
    const repoFromFailure = typeof failure.evidence?.repoDir === "string" ? failure.evidence.repoDir : undefined;
    if (repoFromFailure) return repoFromFailure;
    if (ctx.task.worktree) {
      const top = await this.runGit(ctx.task.worktree, "git rev-parse --show-toplevel").catch(() => "");
      if (top) return top;
    }
    return process.cwd();
  }

  private async requeueAfterRecovery(task: Task, failure: AutoRecoveryFailure, rationale: string, evidence: RecoveryEvidence): Promise<void> {
    if (task.userPaused) return;
    if (task.column === "in-progress") {
      await this.deps.taskStore.updateTask(task.id, { branch: null, baseCommitSha: null });
    }
    await this.deps.taskStore.moveTask(task.id, "todo", {
      moveSource: "engine",
      preserveResumeState: true,
      preserveProgress: true,
      preserveWorktree: false,
    });
    await this.deps.runAudit.database({
      type: "branch-worktree:auto-requeue",
      target: task.id,
      metadata: {
        class: failure.class,
        rationale,
        prevPausedReason: task.pausedReason ?? null,
        evidence,
      },
    });
  }

  private async emitIrreduciblePause(task: Task, failure: AutoRecoveryFailure, reason: string, evidence: Record<string, unknown>): Promise<void> {
    await this.deps.runAudit.database({
      type: "branch-worktree:irreducible-pause",
      target: task.id,
      metadata: {
        class: failure.class,
        reason,
        evidence,
      },
    });
  }

  async issueRetry(failure: AutoRecoveryFailure, decision: AutoRecoveryDecision, ctx: AutoRecoveryContext): Promise<void> {
    if (ctx.task.userPaused) {
      this.logger.warn(`auto-recovery: skipped (userPaused) class=${failure.class} task=${ctx.task.id}`);
      return;
    }
    if (decision.auditMetadata.mode === "off") return;

    const repoDir = await this.resolveRepoDir(ctx, failure);
    const branchName = (ctx.task.branch ?? (typeof failure.evidence?.branchName === "string" ? failure.evidence.branchName : "")).trim();
    const conflictingWorktreePath = (ctx.task.worktree ?? (typeof failure.evidence?.conflictingWorktreePath === "string"
      ? failure.evidence.conflictingWorktreePath
      : typeof failure.evidence?.worktreePath === "string"
        ? failure.evidence.worktreePath
        : "")).trim();
    if (!branchName || !conflictingWorktreePath) return;

    const inspection = await inspectBranchConflict({
      repoDir,
      branchName,
      conflictingWorktreePath,
      requestingTaskId: ctx.task.id,
      ownerTaskId: ctx.task.id,
      startPoint: ctx.task.baseCommitSha ?? "main",
    });

    if (inspection.kind === "stale-resolved" || inspection.kind === "fully-subsumed" || inspection.kind === "tip-already-merged") {
      await this.requeueAfterRecovery(ctx.task, failure, inspection.kind, {
        branchExists: await this.hasBranchRef(repoDir, branchName),
        worktreePresent: existsSync(conflictingWorktreePath),
        tipSha: "tipSha" in inspection ? inspection.tipSha : undefined,
        inspectionKind: inspection.kind,
      });
      return;
    }

    if (inspection.kind === "stale") {
      await this.runGit(repoDir, "git worktree prune").catch(() => undefined);
      const [branchExists, map] = await Promise.all([
        this.hasBranchRef(repoDir, branchName),
        this.getWorktreeBranchMap(repoDir),
      ]);
      if (!branchExists) {
        await this.requeueAfterRecovery(ctx.task, failure, "stale-branch-deleted", {
          branchExists,
          worktreePresent: false,
          inspectionKind: inspection.kind,
        });
        return;
      }
      if (!map.has(branchName)) {
        await this.requeueAfterRecovery(ctx.task, failure, "stale-resolved-after-prune", {
          branchExists,
          worktreePresent: false,
          inspectionKind: inspection.kind,
        });
        return;
      }
    }

    if (inspection.kind === "reclaimable" && inspection.taskAttributedCommitCount === 0) {
      const bootstrap = await classifyBootstrapMisbinding({
        repoDir,
        branchName,
        baseSha: ctx.task.baseCommitSha ?? "main",
        taskId: ctx.task.id,
        foreignCommits: [],
      }).catch(() => ({ isBootstrapMisbinding: false, ownCommitCount: 0, nonAttributedCount: 0 }));

      if (bootstrap.isBootstrapMisbinding) {
        const reanchor = await reanchorBranchToBase({
          repoDir,
          worktreePath: inspection.livePath,
          branchName,
          baseSha: ctx.task.baseCommitSha ?? "main",
          taskId: ctx.task.id,
        }).catch(() => null);

        if (reanchor) {
          await this.requeueAfterRecovery(ctx.task, failure, "bootstrap-misbinding-reanchor", {
            branchExists: true,
            worktreePresent: true,
            tipSha: inspection.tipSha,
            inspectionKind: inspection.kind,
          });
          return;
        }
      }
    }

    if (inspection.kind === "live-foreign") {
      await this.emitIrreduciblePause(ctx.task, failure, "live-foreign", {
        branchName,
        conflictingWorktreePath,
        inspectionKind: inspection.kind,
      });
      return;
    }

    const branchExists = await this.hasBranchRef(repoDir, branchName);
    const tipSha = await this.getTipSha(repoDir, branchName);
    await this.emitIrreduciblePause(ctx.task, failure, "deterministic-unresolved", {
      branchName,
      conflictingWorktreePath,
      inspectionKind: inspection.kind,
      branchExists,
      worktreePresent: existsSync(conflictingWorktreePath),
      tipSha,
    });
  }

  async spawnAiRecovery(failure: AutoRecoveryFailure, decision: AutoRecoveryDecision, ctx: AutoRecoveryContext): Promise<void> {
    if (!this.deps.spawnAiRecoverySession) return;
    if (decision.auditMetadata.mode !== "ai-assisted") return;

    const result = await this.deps.spawnAiRecoverySession(failure, decision, ctx);
    await this.deps.runAudit.database({
      type: "branch-worktree:ai-session-spawned",
      target: ctx.task.id,
      metadata: {
        class: failure.class,
        outcome: result.outcome,
        evidence: {
          ...(failure.evidence ?? {}),
          allowedTools: ["bash:git-log", "bash:git-rev-parse", "bash:git-diff", "fn_task_create"],
        },
      },
    });

    if (result.outcome === "resolved") {
      await this.issueRetry(failure, decision, ctx);
      return;
    }

    await this.emitIrreduciblePause(ctx.task, failure, "ai-session-unresolved", {
      outcome: result.outcome,
      ...(result.metadata ?? {}),
    });
  }
}
