import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { RunMutationContext, Settings, Task, TaskStore } from "@fusion/core";
import type { RunAuditor } from "../util/run-audit.js";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";
import type { TaskBaseAuditFallbackReason, TaskBaseOutcome } from "./task-base-resolution.js";

const defaultExecAsync = promisify(exec);
type ExecAsyncImpl = typeof defaultExecAsync;

export type WorkspaceBaseBranchSource = "task-base-branch" | "recorded-base" | "repo-integration" | "legacy-entry";
export type WorkspaceBaseBranchFallbackReason = "unresolvable-in-repo" | "sibling-task-branch" | "recorded-base-vanished";
export type WorkspaceBaseBranchStage = "acquire" | "land" | "revert" | "self-heal";

export interface WorkspaceRepoBaseBranchResolution {
  branch: string;
  requested?: string;
  source: WorkspaceBaseBranchSource;
  fallbackReason?: WorkspaceBaseBranchFallbackReason;
}

export type ResolveWorkspaceRepoBaseBranchOptions = {
  repoRootDir: string;
  repoRelPath: string;
  settings: Partial<Settings>;
  logger?: Pick<Console, "warn">;
  execImpl?: ExecAsyncImpl;
} & (
  | { mode: "acquire"; task: Pick<Task, "baseBranch">; recordedBaseBranch?: never }
  | { mode: "recorded"; task: Pick<Task, never>; recordedBaseBranch?: string }
);

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalized(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function resolveRepoIntegrationBranch(
  repoRootDir: string,
  settings: Partial<Settings>,
  logger?: Pick<Console, "warn">,
): Promise<string> {
  return resolveIntegrationBranch(
    repoRootDir,
    { ...settings, integrationBranch: undefined, baseBranch: undefined },
    logger ? { logger } : undefined,
  );
}

async function refExistsInRepo(repoRootDir: string, ref: string, execImpl: ExecAsyncImpl): Promise<boolean> {
  try {
    const { stdout } = await execImpl(`git rev-parse --verify ${quoteShellArg(`${ref}^{commit}`)}`, {
      cwd: repoRootDir,
      encoding: "utf8",
    });
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

async function resolveRefInRepo(repoRootDir: string, ref: string, execImpl: ExecAsyncImpl): Promise<string | undefined> {
  if (await refExistsInRepo(repoRootDir, ref, execImpl)) return ref;

  const remoteRef = `origin/${ref}`;
  if (!await refExistsInRepo(repoRootDir, remoteRef, execImpl)) return undefined;

  /*
  FNXC:Workspace 2026-08-20-01:21:
  A remote-tracking-only requested base can fork a worktree but cannot be a land or revert target:
  those lifecycle paths require refs/heads/<branch>. Materialize the verified remote ref as the
  requested local branch once, then record the local name so every later stage targets it safely.
  */
  try {
    await execImpl(`git branch -- ${quoteShellArg(ref)} ${quoteShellArg(remoteRef)}`, {
      cwd: repoRootDir,
      encoding: "utf8",
    });
  } catch {
    // A concurrent creator may have won; only accept the race if the local ref now verifies.
  }
  return await refExistsInRepo(repoRootDir, ref, execImpl) ? ref : undefined;
}

/**
 * Resolve the only ref a workspace sub-repository may use at a given lifecycle stage.
 *
 * FNXC:Workspace 2026-08-20-00:56:
 * Acquire may inspect task.baseBranch after verifying it in this repository. Recorded mode is
 * structurally separate and never reads task.baseBranch, so changing a task after acquisition
 * cannot retarget an already-created worktree during land, self-heal, or revert.
 */
export async function resolveWorkspaceRepoBaseBranch(
  opts: ResolveWorkspaceRepoBaseBranchOptions,
): Promise<WorkspaceRepoBaseBranchResolution> {
  const execImpl = opts.execImpl ?? defaultExecAsync;
  const integrationBranch = () => resolveRepoIntegrationBranch(opts.repoRootDir, opts.settings, opts.logger);

  if (opts.mode === "recorded") {
    const requested = normalized(opts.recordedBaseBranch);
    if (!requested) {
      return { branch: await integrationBranch(), source: "legacy-entry" };
    }
    const resolved = await resolveRefInRepo(opts.repoRootDir, requested, execImpl);
    if (resolved) return { branch: resolved, requested, source: "recorded-base" };
    return {
      branch: await integrationBranch(),
      requested,
      source: "repo-integration",
      fallbackReason: "recorded-base-vanished",
    };
  }

  const requested = normalized(opts.task.baseBranch);
  if (!requested) return { branch: await integrationBranch(), source: "repo-integration" };
  if (/^fusion\/fn-/i.test(requested)) {
    return {
      branch: await integrationBranch(),
      requested,
      source: "repo-integration",
      fallbackReason: "sibling-task-branch",
    };
  }

  const resolved = await resolveRefInRepo(opts.repoRootDir, requested, execImpl);
  if (resolved) return { branch: resolved, requested, source: "task-base-branch" };
  return {
    branch: await integrationBranch(),
    requested,
    source: "repo-integration",
    fallbackReason: "unresolvable-in-repo",
  };
}

/*
FNXC:TaskBaseResolution 2026-09-16-02:35 (RUFU-245):
Fresh-creation base resolution reuses this event rather than minting a new type: an operator
querying "which ref did this card get cut from, and why?" must find the answer in ONE event
stream per card. `source: "local-integration"` separates these rows from the requested-base rows
above, and `repoRelPath` is omitted for single-repo projects. Ref names and SHAs stay out of both
`metadata` and `target` — the operator-readable sentence lives in the task log, never here.
*/
export type TaskBaseResolutionAuditSource = "local-integration";

/**
 * Record which base verdict a fresh task-branch acquisition reached.
 *
 * Observability only: the bounded auditor swallows an absent or hostile sink, so a stalled
 * telemetry write can never become an acquisition lifecycle dependency (FN-9175).
 */
export async function recordTaskBaseResolution(opts: {
  audit?: Pick<RunAuditor, "git">;
  task: Pick<Task, "id">;
  /** Repository the verdict was proven in; doubles as the audit target (path, not ref). */
  rootDir: string;
  /** Set only for a workspace sub-repository. */
  repoRelPath?: string;
  outcome: TaskBaseOutcome;
  fallbackReason?: TaskBaseAuditFallbackReason;
}): Promise<void> {
  try {
    await opts.audit?.git({
      type: "worktree:workspace-repo-base-branch",
      target: opts.rootDir,
      metadata: {
        taskId: opts.task.id,
        ...(opts.repoRelPath ? { repoRelPath: opts.repoRelPath } : {}),
        stage: "acquire",
        source: "local-integration" satisfies TaskBaseResolutionAuditSource,
        outcome: opts.outcome,
        ...(opts.fallbackReason ? { fallbackReason: opts.fallbackReason } : {}),
      },
    });
  } catch {
    // Audit is never a base-resolution gate; the operator-visible refusal rides the task log.
  }
}

export async function recordWorkspaceBaseBranchDecision(opts: {
  store: Pick<TaskStore, "logEntry">;
  audit?: Pick<RunAuditor, "git">;
  task: Pick<Task, "id">;
  repoRelPath: string;
  repoAbsPath: string;
  resolution: WorkspaceRepoBaseBranchResolution;
  stage: WorkspaceBaseBranchStage;
  runContext?: RunMutationContext;
}): Promise<void> {
  const { resolution } = opts;
  if (!resolution.requested) return;

  const outcome = resolution.source === "task-base-branch" || resolution.source === "recorded-base"
    ? "honored"
    : "fallback";
  const message = outcome === "honored"
    ? `Workspace sub-repo ${opts.repoRelPath} ${opts.stage} uses base branch ${resolution.branch} requested as ${resolution.requested}.`
    : `Workspace sub-repo ${opts.repoRelPath} ${opts.stage} could not use requested base branch ${resolution.requested}; using ${resolution.branch}.`;

  // Decision breadcrumbs are observability only; failure must not change git lifecycle semantics.
  try {
    await opts.store.logEntry(opts.task.id, message, undefined, opts.runContext);
  } catch {
    // Best effort, matching workspace acquisition's safeObserve contract.
  }
  try {
    await opts.audit?.git({
      type: "worktree:workspace-repo-base-branch",
      target: opts.repoAbsPath,
      metadata: {
        taskId: opts.task.id,
        repoRelPath: opts.repoRelPath,
        stage: opts.stage,
        source: resolution.source,
        outcome,
        ...(resolution.fallbackReason ? { fallbackReason: resolution.fallbackReason } : {}),
      },
    });
  } catch {
    // Refs are deliberately absent from audit metadata; do not escalate an audit failure.
  }
}
