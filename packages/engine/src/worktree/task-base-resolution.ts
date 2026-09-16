/**
 * Shared task-branch base resolver: which ref a fresh task branch may be cut from,
 * and when that base must be refused instead.
 *
 * FNXC:TaskBaseResolution 2026-09-16-02:35 (RUFU-245):
 * A fresh task branch is anchored to the LOCAL integration ref (local `main`), never to
 * `<remote>/<default>`. The remote-tracking ref is a lagging copy: when the operator has local
 * commits that were never pushed, cutting from `origin/main` produces a branch whose base commit
 * is absent from local `main`, which is the zero-own-commit / foreign-base merge wedge (see
 * `__tests__/self-healing-zero-own-commit-foreign-base.real-git.test.ts`). When local and remote
 * integration refs have genuinely diverged, neither is a safe base, and reconciling them
 * (push vs. pull) is an operator decision the engine must not guess — so acquisition refuses with
 * one named operator-visible reason, `TASK_BASE_DIVERGED:`, instead of producing a branch that
 * cannot merge.
 *
 * The divergence proof uses only already-available refs (`rev-parse --verify`,
 * `merge-base --is-ancestor` in both directions). This module NEVER fetches, pulls, or merges:
 * fetching would silently move the comparison target mid-decision, which is the
 * auto-reconciliation this refusal exists to prevent.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Settings } from "@fusion/core";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";

const defaultExecAsync = promisify(exec);

/**
 * Injectable exec seam. Mirrors `promisify(exec)`'s success shape; a rejected call must carry the
 * child-process `code` so a failed `merge-base --is-ancestor` (code 1 = "not an ancestor") stays
 * distinguishable from an unreadable-repository error (code >= 2).
 */
export type TaskBaseExecImpl = (
  command: string,
  options: { cwd: string; encoding?: unknown },
) => Promise<{ stdout: string }>;

/** Fixed relation between the local integration ref and its remote-tracking counterpart. */
export type TaskBaseRelation =
  | "aligned"
  | "ahead"
  | "behind"
  | "diverged"
  /** The remote side could not be read, so no divergence claim is possible. */
  | "remote-unresolvable"
  /** The local integration ref itself does not resolve to a commit. */
  | "local-unresolvable";

/** Only a proven divergence refuses acquisition. */
export type TaskBaseRefusal = "base-diverged-from-remote" | null;

/** Fixed explanation for the relation, kept separate so `relation` stays a pure topology value. */
export type TaskBaseReason =
  | "aligned"
  | "local-ahead"
  | "remote-ahead"
  | "diverged"
  /** `worktreeRebaseBeforeMerge === false`: no remote ref participates in base selection at all. */
  | "remote-rebase-disabled"
  | "remote-ref-unresolvable"
  | "remote-ancestry-unreadable"
  | "local-ref-unresolvable";

/** Enumerated `worktree:workspace-repo-base-branch` outcome values for base-resolution rows. */
export type TaskBaseOutcome =
  | "resolved-local-base"
  | "refused-diverged"
  | "skipped-remote-unresolvable"
  | "skipped-remote-rebase-disabled";

/** Enumerated `fallbackReason` values paired with the skipped outcomes. */
export type TaskBaseAuditFallbackReason =
  | "remote-rebase-disabled"
  | "remote-ref-unresolvable"
  | "remote-ancestry-unreadable"
  | "local-ref-unresolvable";

export interface TaskBranchBaseResolution {
  /** Resolved local integration branch name (e.g. `main`). */
  integrationBranch: string;
  /** Resolved local integration SHA, or null when the local ref does not resolve. */
  localSha: string | null;
  /** Remote name used for the comparison, or null when none participates. */
  remote: string | null;
  /** `<remote>/<integrationBranch>`, or null when no remote participates. */
  remoteRef: string | null;
  remoteSha: string | null;
  relation: TaskBaseRelation;
  /**
   * The only start point a fresh task branch may use: ALWAYS the local integration ref. This stays
   * populated even on a refusal so a caller that must not throw (none today) still cannot be
   * silently handed a remote ref.
   */
  base: string;
  refusal: TaskBaseRefusal;
  reason: TaskBaseReason;
  /** Audit outcome for `recordTaskBaseResolution`. */
  outcome: TaskBaseOutcome;
  /** Present only when divergence is proven: commits local has that the remote lacks. */
  aheadCount?: number;
  /** Present only when divergence is proven: commits the remote has that local lacks. */
  behindCount?: number;
  /** Audit `fallbackReason` for the skipped outcomes; undefined when nothing was skipped. */
  fallbackReason?: TaskBaseAuditFallbackReason;
}

export const TASK_BASE_DIVERGED_PREFIX = "TASK_BASE_DIVERGED:";

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Operator-facing refusal sentence. The prefix lives in the `Error.message` itself so every
 * acquisition caller's park-with-error-message path surfaces the identical named reason without
 * re-authoring it (RUFU-245).
 */
export function taskBaseDivergedMessage(input: {
  localRef: string;
  remoteRef: string;
  aheadCount: number;
  behindCount: number;
  repoRelPath?: string;
}): string {
  const scope = input.repoRelPath ? `repository ${input.repoRelPath}: ` : "";
  return (
    `${TASK_BASE_DIVERGED_PREFIX} ${scope}local integration branch '${input.localRef}' has diverged from ` +
    `'${input.remoteRef}' (local is ${input.aheadCount} commit(s) ahead and ${input.behindCount} commit(s) behind), ` +
    `so neither is a safe base for a fresh task branch. Reconcile '${input.localRef}' with ` +
    `'${input.remoteRef}' by pushing or pulling — an operator decision — then retry this card.`
  );
}

/**
 * Raised instead of creating a worktree when the task's base is proven diverged. Carries the
 * evidence (named refs + both `rev-list --count` values) so callers can log or park without
 * re-deriving it. Deliberately NOT a `WorktreeBaseRefreshError`: a diverged main does not
 * self-heal, so the "leave queued" disposition would recreate the re-dispatch wedge RUFU-231 removed.
 */
export class TaskBranchBaseDivergedError extends Error {
  readonly localRef: string;
  readonly remoteRef: string;
  readonly aheadCount: number;
  readonly behindCount: number;
  /** Set only for a workspace sub-repository, so the operator learns WHICH repo diverged. */
  readonly repoRelPath?: string;

  constructor(input: {
    localRef: string;
    remoteRef: string;
    aheadCount: number;
    behindCount: number;
    repoRelPath?: string;
  }) {
    super(taskBaseDivergedMessage(input));
    this.name = "TaskBranchBaseDivergedError";
    this.localRef = input.localRef;
    this.remoteRef = input.remoteRef;
    this.aheadCount = input.aheadCount;
    this.behindCount = input.behindCount;
    this.repoRelPath = input.repoRelPath;
  }
}

/** Cross-boundary safe test: a re-thrown or re-hydrated error keeps its `name`. */
export function isTaskBranchBaseDivergedError(error: unknown): error is TaskBranchBaseDivergedError {
  return error instanceof TaskBranchBaseDivergedError
    || (typeof error === "object" && error !== null
      && (error as { name?: unknown }).name === "TaskBranchBaseDivergedError");
}

async function revParseCommit(
  rootDir: string,
  ref: string,
  execImpl: TaskBaseExecImpl,
): Promise<string | null> {
  try {
    const { stdout } = await execImpl(`git rev-parse --verify ${quoteShellArg(`${ref}^{commit}`)}`, {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const sha = stdout.trim();
    return sha || null;
  } catch {
    return null;
  }
}

type AncestryProbe = { ok: true; ancestor: boolean } | { ok: false };

/**
 * `git merge-base --is-ancestor <a> <b>`: exit 0 = ancestor, exit 1 = NOT an ancestor (a real
 * answer), any other failure = unreadable (fail open, never a divergence claim).
 */
async function isAncestor(
  rootDir: string,
  ancestor: string,
  descendant: string,
  execImpl: TaskBaseExecImpl,
): Promise<AncestryProbe> {
  try {
    await execImpl(
      `git merge-base --is-ancestor ${quoteShellArg(ancestor)} ${quoteShellArg(descendant)}`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    return { ok: true, ancestor: true };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 1) return { ok: true, ancestor: false };
    return { ok: false };
  }
}

async function countCommits(
  rootDir: string,
  exclusive: string,
  inclusive: string,
  execImpl: TaskBaseExecImpl,
): Promise<number> {
  try {
    const { stdout } = await execImpl(
      `git rev-list --count ${quoteShellArg(`${exclusive}..${inclusive}`)}`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(count) ? count : 0;
  } catch {
    return 0;
  }
}

/*
FNXC:TaskBaseResolution 2026-09-16-02:35 (RUFU-245):
Mirrors `resolveIntegrationRemote`'s ladder (explicit setting → branch.<ref>.remote → lone/origin
remote) against the injected exec seam instead of importing it: the merge-side helper shells out
through its own execAsync, and the resolver must route EVERY git read through one seam so the
no-fetch/no-pull/no-merge guarantee is assertable from a single spy.
*/
async function resolveRemoteName(input: {
  rootDir: string;
  settings: Partial<Settings>;
  integrationBranch: string;
  execImpl: TaskBaseExecImpl;
}): Promise<string | null> {
  const configured = input.settings.worktreeRebaseRemote?.trim();
  if (configured) return configured;

  try {
    const { stdout } = await input.execImpl(
      `git config --get branch.${quoteShellArg(input.integrationBranch)}.remote`,
      { cwd: input.rootDir, encoding: "utf-8" },
    );
    const tracked = stdout.trim();
    if (tracked) return tracked;
  } catch {
    // No tracked-remote entry; fall through to remote discovery.
  }

  try {
    const { stdout } = await input.execImpl("git remote", { cwd: input.rootDir, encoding: "utf-8" });
    const remotes = stdout.trim().split(/\s+/).filter(Boolean);
    if (remotes.length === 1) return remotes[0];
    if (remotes.includes("origin")) return "origin";
  } catch {
    // No remote discovery possible.
  }

  return null;
}

/**
 * Does a stored start-point ref name denote the integration branch itself?
 *
 * A card's `executionStartBranch` reaches acquisition in whatever shape the operator or planner wrote
 * it — `main`, `refs/heads/main`, `origin/main`, `refs/remotes/origin/main` — and all four name the
 * SAME local base. Callers must recognize every shape: treating a default-base card as if it named a
 * dependency base would route it through the squash-import planner and rewrite its own base commits
 * as an import commit, leaving the branch with zero commits of its own.
 *
 * Matching is exact against the integration branch name (plus each known remote), never a generic
 * "strip the first path segment" rule: a real dependency branch such as `feature/main` must not be
 * mistaken for the integration base. SHA equality covers exotic remote names.
 *
 * FNXC:TaskBaseResolution 2026-09-16-02:35 (RUFU-245).
 */
export function namesIntegrationBranch(
  raw: string | undefined,
  integrationBranch: string,
  remoteCandidates: readonly string[] = [],
): boolean {
  const value = raw?.trim();
  if (!value || !integrationBranch) return false;
  if (value === integrationBranch || value === `refs/heads/${integrationBranch}`) return true;
  for (const remote of remoteCandidates) {
    if (!remote) continue;
    if (value === `${remote}/${integrationBranch}`) return true;
    if (value === `refs/remotes/${remote}/${integrationBranch}`) return true;
  }
  return false;
}

/**
 * Resolve the LOCAL integration ref and the commit it points at — the two facts every base
 * decision needs, from one seam so no caller re-derives them.
 *
 * Never throws: an unresolvable ref returns `localSha: null` and the caller picks its own fallback
 * (the squash-import planner falls back to ambient HEAD, the divergence comparison fails open).
 * Read-only, and issues no remote git call.
 *
 * FNXC:TaskBaseResolution 2026-09-16-02:35 (RUFU-245): fresh task branches anchor here (the local
 * integration ref) rather than to a remote-tracking ref, so a local branch that has not caught up to
 * origin is still the sanctioned base; divergence against origin is a separate, explicit verdict.
 */
export async function resolveLocalIntegrationBase(input: {
  rootDir: string;
  settings: Settings | Partial<Settings>;
  logger?: Pick<Console, "warn">;
  execImpl?: TaskBaseExecImpl;
}): Promise<{ integrationBranch: string; localSha: string | null }> {
  const execImpl = input.execImpl ?? (defaultExecAsync as unknown as TaskBaseExecImpl);
  const settings = (input.settings ?? {}) as Partial<Settings>;
  const integrationBranch = await resolveIntegrationBranch(
    input.rootDir,
    settings,
    input.logger ? { logger: input.logger } : undefined,
  );
  const localSha = await revParseCommit(input.rootDir, integrationBranch, execImpl);
  return { integrationBranch, localSha };
}

/**
 * Resolve the ref a fresh task branch must be cut from, plus the divergence verdict.
 *
 * Read-only by construction: every git call is `rev-parse` / `merge-base` / `rev-list` /
 * `config` / `remote`. Callers gate on `refusal`, record `outcome` through
 * `recordTaskBaseResolution`, and never re-derive the comparison themselves.
 */
export async function resolveTaskBranchBase(input: {
  rootDir: string;
  settings: Settings | Partial<Settings>;
  taskId?: string;
  logger?: Pick<Console, "warn">;
  execImpl?: TaskBaseExecImpl;
}): Promise<TaskBranchBaseResolution> {
  const execImpl = input.execImpl ?? (defaultExecAsync as unknown as TaskBaseExecImpl);
  const settings = (input.settings ?? {}) as Partial<Settings>;

  const { integrationBranch, localSha } = await resolveLocalIntegrationBase(input);

  const localBase = localSha ?? integrationBranch;

  if (!localSha) {
    return {
      integrationBranch,
      localSha: null,
      remote: null,
      remoteRef: null,
      remoteSha: null,
      relation: "local-unresolvable",
      base: integrationBranch,
      refusal: null,
      reason: "local-ref-unresolvable",
      outcome: "resolved-local-base",
      fallbackReason: "local-ref-unresolvable",
    };
  }

  /*
  FNXC:TaskBaseResolution 2026-09-16-02:35 (RUFU-245):
  With rebase-before-merge disabled, no remote ref participates in base selection at all — the
  branch is created locally and never relocated onto a remote. Comparing divergence in that state
  would refuse work the operator explicitly configured to stay local, so the comparison is skipped
  entirely and no remote git read is issued.
  */
  if (settings.worktreeRebaseBeforeMerge === false) {
    return {
      integrationBranch,
      localSha,
      remote: null,
      remoteRef: null,
      remoteSha: null,
      relation: "remote-unresolvable",
      base: localBase,
      refusal: null,
      reason: "remote-rebase-disabled",
      outcome: "skipped-remote-rebase-disabled",
      fallbackReason: "remote-rebase-disabled",
    };
  }

  const remote = await resolveRemoteName({
    rootDir: input.rootDir,
    settings,
    integrationBranch,
    execImpl,
  });
  const remoteRef = remote ? `${remote}/${integrationBranch}` : null;
  const remoteSha = remoteRef ? await revParseCommit(input.rootDir, remoteRef, execImpl) : null;

  if (!remote || !remoteRef || !remoteSha) {
    return {
      integrationBranch,
      localSha,
      remote,
      remoteRef,
      remoteSha,
      relation: "remote-unresolvable",
      base: localBase,
      refusal: null,
      reason: remote ? "remote-ref-unresolvable" : "remote-ref-unresolvable",
      outcome: "skipped-remote-unresolvable",
      fallbackReason: "remote-ref-unresolvable",
    };
  }

  const localInRemote = await isAncestor(input.rootDir, localSha, remoteSha, execImpl);
  const remoteInLocal = await isAncestor(input.rootDir, remoteSha, localSha, execImpl);

  /*
  FNXC:TaskBaseResolution 2026-09-16-02:35 (RUFU-245): Fail-open rule. A failed ancestry probe is
  an unreadable repository, not a divergence proof, so it must never refuse: today's local-base
  acquisition runs unchanged rather than blocking work on a git read.
  */
  if (!localInRemote.ok || !remoteInLocal.ok) {
    return {
      integrationBranch,
      localSha,
      remote,
      remoteRef,
      remoteSha,
      relation: "remote-unresolvable",
      base: localBase,
      refusal: null,
      reason: "remote-ancestry-unreadable",
      outcome: "skipped-remote-unresolvable",
      fallbackReason: "remote-ancestry-unreadable",
    };
  }

  if (localInRemote.ancestor && remoteInLocal.ancestor) {
    return {
      integrationBranch,
      localSha,
      remote,
      remoteRef,
      remoteSha,
      relation: "aligned",
      base: localBase,
      refusal: null,
      reason: "aligned",
      outcome: "resolved-local-base",
    };
  }

  if (localInRemote.ancestor) {
    return {
      integrationBranch,
      localSha,
      remote,
      remoteRef,
      remoteSha,
      // Strictly behind: a linear rebase onto the remote stays legitimate (FN-8839).
      relation: "behind",
      base: localBase,
      refusal: null,
      reason: "remote-ahead",
      outcome: "resolved-local-base",
    };
  }

  if (remoteInLocal.ancestor) {
    return {
      integrationBranch,
      localSha,
      remote,
      remoteRef,
      remoteSha,
      relation: "ahead",
      base: localBase,
      refusal: null,
      reason: "local-ahead",
      outcome: "resolved-local-base",
    };
  }

  const aheadCount = await countCommits(input.rootDir, remoteSha, localSha, execImpl);
  const behindCount = await countCommits(input.rootDir, localSha, remoteSha, execImpl);

  return {
    integrationBranch,
    localSha,
    remote,
    remoteRef,
    remoteSha,
    relation: "diverged",
    base: localBase,
    refusal: "base-diverged-from-remote",
    reason: "diverged",
    outcome: "refused-diverged",
    aheadCount,
    behindCount,
  };
}
