import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { isFusionDeletableBranch, type Task, type TaskStore } from "@fusion/core";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { moveTaskToContainedBackwardTarget } from "../execution/lifecycle-move.js";
import {
  classifyForeignOnlyContamination,
  reanchorBranchToBase,
  resolveTrustedIntegrationRefs,
} from "../execution/branch-conflicts.js";
import type { RunAuditor } from "../util/run-audit.js";
import { generateSyntheticRunId } from "../util/run-audit.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { isUsableTaskWorktree } from "../worktree/worktree-pool.js";

const execAsync = promisify(exec);
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface RecoverForeignOnlyContaminationDeps {
  repoDir: string;
  taskStore: TaskStore;
  runAudit: RunAuditor;
  integrationBranch: string;
}

export interface RecoverForeignOnlyContaminationResult {
  recovered: boolean;
  subtype?: "reanchor" | "branch-discard";
  reason?: string;
}

/*
FNXC:BranchConflictRecovery 2026-09-13-02:20:
RUFU-231 Step 3 audit contract: the zero-loss PROOF gets its own bounded row (emitted the
moment the classifier accepts the shape, before any git mutation), so a wedge is diagnosable
from run-audit even when the release half then fails. The release/re-queue outcome rides the
existing `task:auto-recover-foreign-only-contamination` success row (`subtype` = which self-claim
release ran, `requeued` = fixed enum of the contained-lane move outcome). Both facets stay
ids/counts/fixed-enums — no branch prose, no error text.
*/
function requeueOutcome(move: {
  moved: boolean;
  deferred?: string;
  reason?: string;
}): "moved" | "retained-in-place" | "no-contained-target" | "capacity-deferred" {
  if (move.moved) return "moved";
  if (move.reason === "no-contained-target") return "no-contained-target";
  if (move.deferred === "capacity") return "capacity-deferred";
  return "retained-in-place";
}

export async function recoverForeignOnlyContamination(
  task: Task,
  deps: RecoverForeignOnlyContaminationDeps,
): Promise<RecoverForeignOnlyContaminationResult> {
  if (!task.branch || !task.worktree) return { recovered: false, reason: "missing-branch-or-worktree" };

  const baseSha = task.baseCommitSha ?? task.baseBranch ?? task.executionStartBranch ?? deps.integrationBranch;
  if (!baseSha) {
    await deps.runAudit.database({
      type: "task:auto-recover-foreign-only-contamination-skipped",
      target: task.id,
      metadata: { reason: "baseSha-unresolved" },
    });
    return { recovered: false, reason: "baseSha-unresolved" };
  }

  /*
  FNXC:BranchBaseIdentity 2026-09-13-02:40:
  RUFU-231: the contamination classification measures landedness against EVERY trusted
  integration identity (local integration branch + `<remote>/<integration>` refs). A card
  rebased onto origin/main carries foreign commits that ARE landed there; without the
  trusted set the classification saw them as unique and recovery stayed unreachable.
  */
  const trustedRefs = await resolveTrustedIntegrationRefs(deps.repoDir, deps.integrationBranch);
  const classification = await classifyForeignOnlyContamination({
    repoDir: deps.repoDir,
    branchName: task.branch,
    baseSha,
    taskId: task.id,
    trustedRefs,
  });

  if (classification.kind !== "foreign-only-no-own-work" && classification.kind !== "foreign-only-already-upstream") {
    await deps.runAudit.database({
      type: "task:auto-recover-foreign-only-contamination-skipped",
      target: task.id,
      metadata: { reason: "ambiguous", kind: classification.kind },
    });
    return { recovered: false, reason: "ambiguous" };
  }

  /*
  FNXC:BranchConflictRecovery 2026-09-13-02:20:
  RUFU-231: the branch is now PROVEN to own nothing a release could lose (zero own commits,
  foreign content landed on a trusted integration identity). Record the proof at the proof
  moment — bounded seam (AGENTS FN-9175), ids/counts/fixed enums only.
  */
  await emitBoundedRunAudit(deps.taskStore, {
    agentId: "recovery",
    runId: generateSyntheticRunId("branch-conflict-zero-loss", task.id),
    taskId: task.id,
    domain: "database",
    mutationType: "task:branch-conflict-zero-loss-proven",
    target: task.id,
    metadata: {
      taskId: task.id,
      kind: classification.kind,
      trustedRefCount: trustedRefs.length,
    },
  });

  if (await isUsableTaskWorktree(deps.repoDir, task.worktree)) {
    await reanchorBranchToBase({
      repoDir: deps.repoDir,
      worktreePath: task.worktree,
      branchName: task.branch,
      baseSha,
      taskId: task.id,
    });

    /*
    FNXC:LifecycleContainment 2026-08-28-03:03:
    Foreign-only contamination recovery moves only to the adjacent backward lifecycle role. Missing
    targets and capacity refusal stay in place, preserving the repaired branch/worktree metadata.
    */
    const move = await moveTaskToContainedBackwardTarget(deps.taskStore, task.id, "contamination-recovery", {
      moveSource: "engine",
      preserveResumeState: true,
      preserveProgress: true,
      preserveWorktree: true,
    }, task.column);
    await deps.taskStore.updateTask(task.id, {
      recoveryRetryCount: 0,
      nextRecoveryAt: null,
      error: null,
      paused: false,
      pausedReason: null,
    });
    await deps.runAudit.database({
      type: "task:auto-recover-foreign-only-contamination",
      target: task.id,
      metadata: { subtype: "reanchor", kind: classification.kind, baseSha, requeued: requeueOutcome(move) },
    });
    return { recovered: true, subtype: "reanchor" };
  }

  if (activeSessionRegistry.isPathActive(task.worktree)) {
    await deps.runAudit.database({
      type: "task:auto-recover-foreign-only-contamination-skipped",
      target: task.id,
      metadata: { reason: "active-session", kind: classification.kind },
    });
    return { recovered: false, reason: "active-session" };
  }

  await execAsync("git worktree prune", { cwd: deps.repoDir, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }).catch(() => undefined);
  if (isFusionDeletableBranch(task, task.branch)) {
    await execAsync(`git branch -D ${quote(task.branch)}`, { cwd: deps.repoDir, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }).catch(() => undefined);
  }

  /*
    FNXC:LifecycleContainment 2026-08-28-03:03:
    Foreign-only contamination recovery moves only to the adjacent backward lifecycle role. Missing
    targets and capacity refusal stay in place, preserving the repaired branch/worktree metadata.
    */
  const move = await moveTaskToContainedBackwardTarget(deps.taskStore, task.id, "contamination-recovery", {
    moveSource: "engine",
    preserveResumeState: true,
    preserveProgress: true,
    preserveWorktree: false,
  }, task.column);
  await deps.taskStore.updateTask(task.id, {
    recoveryRetryCount: 0,
    nextRecoveryAt: null,
    error: null,
    paused: false,
    pausedReason: null,
    worktree: null,
    branch: null, branchWriteOrigin: "engine" as const,
    baseCommitSha: null,
    modifiedFiles: [],
  });
  await deps.runAudit.database({
    type: "task:auto-recover-foreign-only-contamination",
    target: task.id,
    metadata: {
      subtype: "branch-discard",
      kind: classification.kind,
      baseSha,
      requeued: requeueOutcome(move),
      worktreePresent: existsSync(task.worktree),
    },
  });
  return { recovered: true, subtype: "branch-discard" };
}
