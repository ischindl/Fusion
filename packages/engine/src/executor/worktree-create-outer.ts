/**
 * FNXC:CodeOrganization 2026-08-03-15:20:
 * Outer createWorktree loop + squash-import + post-create remote rebase peeled from
 * TaskExecutor (U4 Slice B). Inject deps; keep thin class facades for spy/assignment surfaces.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { RunMutationContext, Settings } from "@fusion/core";
import { isBranchConflictError } from "../execution/branch-conflicts.js";
import { StaleWorktreeIndexLockError } from "../worktree/worktree-stale-lock.js";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";
import {
  namesIntegrationBranch,
  resolveLocalIntegrationBase,
  type TaskBaseExecImpl,
} from "../worktree/task-base-resolution.js";
import { executorLog } from "../logger.js";
import { quoteShellArg } from "./shell-quote.js";
import { NonRetryableWorktreeError } from "./worktree-registry-helpers.js";

const execAsync = promisify(exec);

export type WorktreeOuterStore = {
  updateTask: (taskId: string, patch: Record<string, unknown>) => Promise<unknown>;
  getSettings: () => Promise<Settings | Partial<Settings>>;
  /** Mirrors TaskStore.logEntry so safe breadcrumbs match main (action, outcome?, runContext?). */
  logEntry: (
    taskId: string,
    action: string,
    outcome?: string | undefined,
    runContext?: RunMutationContext | undefined,
  ) => Promise<unknown>;
};

export type WorktreeOuterCreateDeps = {
  rootDir: string;
  store: WorktreeOuterStore;
  maxWorktreeRetries: number;
  worktreeRetryDelaysMs: number[];
  resolveWorktreeStartPoint: (startPoint: string, taskId: string) => Promise<string | null>;
  planSquashImportFromDep: (
    taskId: string,
    depTip: string,
    originalStartPoint: string | undefined,
  ) => Promise<{ depTip: string; mainBase: string; label: string } | null>;
  tryCreateWorktree: (
    branch: string,
    path: string,
    taskId: string,
    startPoint?: string,
    attemptNumber?: number,
    recoveryDepth?: number,
    allowSiblingBranchRename?: boolean,
    settings?: Partial<Settings>,
  ) => Promise<{ path: string; branch: string }>;
  squashImportDepIntoWorktree: (
    worktreePath: string,
    taskId: string,
    depTip: string,
    label: string,
  ) => Promise<void>;
  rebaseNewWorktreeOntoRemote: (
    worktreePath: string,
    branch: string,
    taskId: string,
    settingsOverride?: Settings,
  ) => Promise<void>;
  /** Optional git seam for the local-base probe; production omits it and uses the real `exec`. */
  execImpl?: TaskBaseExecImpl;
};

/**
 * Resolve a stored baseBranch to a concrete commit SHA.
 *
 * Returns `null` (not throw) when the ref cannot be resolved — typically
 * because the upstream dep's branch was merged and deleted while this task
 * sat queued/stuck. Callers should treat null as "fall back to default base"
 * rather than fail the task permanently.
 */
export async function resolveWorktreeStartPoint(
  rootDir: string,
  store: Pick<WorktreeOuterStore, "logEntry">,
  startPoint: string,
  taskId: string,
): Promise<string | null> {
  const command = isAbsolute(startPoint) && existsSync(startPoint)
    ? `git -C "${startPoint}" rev-parse --verify HEAD^{commit}`
    : `git rev-parse --verify "${startPoint}^{commit}"`;

  try {
    const { stdout } = await execAsync(command, { cwd: rootDir });
    return stdout.trim() || startPoint;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await store.logEntry(
      taskId,
      `Worktree base ref "${startPoint}" is missing — falling back to default base`,
      errorMessage,
    );
    return null;
  }
}

/**
 * Squash-merge the dep's content into a worktree that's already branched
 * off main. Produces one commit on the worktree branch carrying the dep's
 * content, instead of inheriting the dep's individual commits. Best-effort:
 * any failure (conflict, hooks, IO) leaves the worktree at main and the
 * caller proceeds — the dependent task will then need to import the dep's
 * content itself, but the worktree itself is still usable.
 */
export async function squashImportDepIntoWorktree(
  store: Pick<WorktreeOuterStore, "logEntry">,
  worktreePath: string,
  taskId: string,
  depTip: string,
  label: string,
): Promise<void> {
  // No-op when dep is already represented in the worktree's history.
  try {
    await execAsync(
      `git merge-base --is-ancestor ${quoteShellArg(depTip)} HEAD`,
      { cwd: worktreePath },
    );
    return;
  } catch {
    // Not an ancestor — proceed.
  }

  // Try a squash-merge. `--no-commit` is implied by `--squash`; the merge
  // either stages the dep's diff or fails (conflicts / unrelated histories).
  try {
    await execAsync(
      `git merge --squash --allow-unrelated-histories ${quoteShellArg(depTip)}`,
      { cwd: worktreePath },
    );
  } catch (err) {
    // Reset any partial state so the worktree stays usable, then rethrow
    // so the caller can decide whether to log/fall-through.
    await execAsync("git reset --hard HEAD", { cwd: worktreePath }).catch(
      () => undefined,
    );
    throw err;
  }

  // If no diff was staged the dep is content-equivalent to main; nothing
  // to commit.
  try {
    await execAsync("git diff --cached --quiet", { cwd: worktreePath });
    return; // exit 0 → no staged changes, nothing to commit
  } catch {
    // exit non-zero → staged changes exist, proceed to commit.
  }

  // Always non-empty (subject + body via two -m args). Drop
  // --allow-empty-message: we never want git to silently accept an empty
  // message — a missing message here would make the commit hard to
  // attribute / explain in `git log` and break downstream consumers that
  // parse merge metadata from commit messages.
  const subject = `chore(${taskId}): import dependency content from ${label}`;
  const body =
    `Squash-imported the working tree of ${label} as a single commit so this ` +
    `branch carries the dep's content without inheriting its individual commits. ` +
    `If the dep is later squash-merged to main, this commit's patch-id should ` +
    `match the merge and rebase cleanly.`;
  try {
    await execAsync(
      `git commit -m ${quoteShellArg(subject)} -m ${quoteShellArg(body)}`,
      { cwd: worktreePath },
    );
  } catch (commitErr) {
    await execAsync("git reset --hard HEAD", { cwd: worktreePath }).catch(
      () => undefined,
    );
    throw commitErr;
  }

  await store.logEntry(
    taskId,
    `Squash-imported dependency content from ${label} into worktree (single import commit instead of inheriting raw commits)`,
  );
}

/**
 * After creating a fresh task worktree, fetch the configured remote and
 * rebase the task branch onto `<remote>/<defaultBranch>`. The result is a
 * branch that contains origin's tip plus any local main commits, so the
 * eventual merge has fewer surprises and the executor sees the freshest
 * code its peers/CI may have published.
 *
 * No-op when `worktreeRebaseBeforeMerge` is disabled, no remote is
 * configured/resolvable, or the rebase produces conflicts (we abort and
 * leave the worktree as-is so the executor can still run).
 */
/**
 * FNXC:WorktreeRebase 2026-08-09-00:48:
 * A fresh worktree must refresh against the same integration-branch-first contract that
 * selected its start point. Root checkout may be on a sibling task branch and must never
 * select this rebase target. Refresh remains best-effort; enabled skips/failures are logged.
 */
export async function rebaseNewWorktreeOntoRemote(
  rootDir: string,
  store: WorktreeOuterStore,
  worktreePath: string,
  branch: string,
  taskId: string,
  settingsOverride?: Settings,
): Promise<void> {
  let settings: Settings | Partial<Settings> | undefined = settingsOverride;
  if (!settings) {
    try {
      settings = await store.getSettings();
    } catch {
      return;
    }
  }
  if (settings.worktreeRebaseBeforeMerge === false) return;

  /*
  FNXC:WorktreeRebase 2026-08-09-00:48:
  Match TaskExecutor.safeLogEntry arity: (taskId, message, undefined, runContext).
  Tests pin the four-argument breadcrumb shape for enabled skips and failures.
  */
  const safeLog = (action: string) => {
    try {
      void Promise.resolve(store.logEntry(taskId, action, undefined, undefined)).catch(() => undefined);
    } catch {
      // best-effort breadcrumb
    }
  };

  let remote = settings.worktreeRebaseRemote?.trim() || "";
  if (!remote) {
    try {
      const { stdout } = await execAsync("git remote", { cwd: rootDir });
      const remotes = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      if (remotes.includes("origin")) remote = "origin";
      else if (remotes.length === 1) remote = remotes[0];
    } catch {
      // No remote resolvable — nothing to rebase against.
    }
  }
  if (!remote) {
    safeLog("Skipped new worktree rebase refresh — no remote was resolvable");
    return;
  }

  let integrationBranch: string;
  try {
    integrationBranch = await resolveIntegrationBranch(rootDir, settings as Settings, { logger: executorLog });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    executorLog.warn(`Worktree rebase: could not resolve integration branch for ${taskId}: ${message}`);
    safeLog(`Skipped new worktree rebase refresh — integration branch could not be resolved for ${remote}`);
    return;
  }

  const remoteRef = `${remote}/${integrationBranch}`;

  try {
    await execAsync(`git fetch ${quoteShellArg(remote)} ${quoteShellArg(integrationBranch)}`, { cwd: rootDir });
  } catch (err) {
    executorLog.warn(
      `Worktree rebase: fetch ${remote} ${integrationBranch} failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    safeLog(`Could not refresh new worktree rebase target ${remoteRef} — fetch failed; kept local base.`);
    return;
  }

  /*
  FNXC:TaskBaseResolution 2026-09-16-03:26 (RUFU-245):
  Rebasing a fresh branch onto `<remote>/<integration>` is only coherent while one side is a
  descendant of the other. When local integration and the freshly-fetched remote-tracking ref have
  PROVEN-diverged (both `merge-base --is-ancestor` checks fail with git's definitive exit code 1),
  the rebase would graft the entire upstream lineage onto a branch whose local base already carries
  different commits — the zero-own-commit foreign-base branch RUFU-245 refuses at acquisition must
  not be re-introduced by the post-create rebase. Skipping is safe and never wedges anything: the
  branch simply keeps its local base and the merge-time rebase stays untouched.

  Fail open on every other shape: a strictly-behind (linear) remote still rebases exactly as today
  (FN-8839), and an unreadable ref, a non-definitive git failure (exit code other than 1), or any
  probe error runs today's rebase unchanged — a git read must never block work, and the existing
  mocked suites (empty rev-parse stdout = unreadable) keep flowing to the rebase.
  */
  try {
    const localProbe = await execAsync(`git rev-parse --verify ${quoteShellArg(`${integrationBranch}^{commit}`)}`, { cwd: rootDir });
    const remoteProbe = await execAsync(`git rev-parse --verify ${quoteShellArg(`${remoteRef}^{commit}`)}`, { cwd: rootDir });
    const localIntegrationSha = localProbe.stdout.trim();
    const remoteIntegrationSha = remoteProbe.stdout.trim();
    if (localIntegrationSha && remoteIntegrationSha) {
      const isDefinitivelyNotAncestor = async (candidate: string, other: string): Promise<boolean> => {
        try {
          await execAsync(`git merge-base --is-ancestor ${quoteShellArg(candidate)} ${quoteShellArg(other)}`, { cwd: rootDir });
          return false;
        } catch (err) {
          if ((err as { code?: unknown }).code === 1) return true;
          throw err;
        }
      };
      const remoteHasAllLocal = !await isDefinitivelyNotAncestor(localIntegrationSha, remoteIntegrationSha);
      const localHasAllRemote = !await isDefinitivelyNotAncestor(remoteIntegrationSha, localIntegrationSha);
      if (!remoteHasAllLocal && !localHasAllRemote) {
        safeLog(`Skipped new worktree rebase refresh — local ${integrationBranch} and ${remoteRef} have diverged; kept local base.`);
        return;
      }
    }
  } catch {
    // Probe unreadable or ambiguous — fail open to today's rebase.
  }

  try {
    await execAsync(`git rebase ${quoteShellArg(remoteRef)}`, { cwd: worktreePath });
    safeLog(`Rebased new worktree branch ${branch} onto ${remoteRef}`);
    /*
    FNXC:BranchBaseIdentity 2026-09-13-00:25:
    This rebase IS the divergence source the RUFU-217 wedge traced: for a card that later
    commits nothing, the branch tip literally becomes `<remote>/<integrationBranch>` —
    another lineage's landed commit — while local main sits elsewhere. Acquisition's
    finalizeCreatedWorktree therefore records the base identity AFTER this rebase, using the
    descendant-aware fork-point rule in resolveCapturedBaseCommitSha, so the row's
    `baseCommitSha` names the remote-tracking identity the branch actually sits on (which
    remote was used is visible by resolving `<remote>/<integrationBranch>` against it).
    */
  } catch (rebaseErr) {
    const msg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
    executorLog.warn(
      `Worktree rebase: rebase onto ${remoteRef} failed for ${taskId} — aborting and leaving local base intact: ${msg}`,
    );
    try {
      await execAsync("git rebase --abort", { cwd: worktreePath });
    } catch {
      // best-effort
    }
    safeLog(
      `Could not rebase new worktree onto ${remoteRef} — kept local base. The merge-time rebase will retry with conflict resolution.`,
    );
  }
}

/*
FNXC:Worktrees 2026-07-19-15:47:
Branch-needing task work must be created with `git worktree add` in an isolated checkout. Per the
AGENTS.md “Prefer main For Direct Work; Use Worktrees For Branches” standing rule, rootDir is
never switched with `git checkout` or `git switch` to select a task branch; see the primary-checkout
invariant regression test for the executable guard.
*/
export async function createWorktree(
  deps: WorktreeOuterCreateDeps,
  branch: string,
  path: string,
  taskId: string,
  startPoint?: string,
  allowSiblingBranchRename = false,
): Promise<{ path: string; branch: string }> {
  // Track the worktree path we're attempting to use (may change during recovery)
  const currentPath = path;
  let resolvedStartPoint: string | undefined;
  if (startPoint) {
    const resolved = await deps.resolveWorktreeStartPoint(startPoint, taskId);
    if (resolved === null) {
      // Stored baseBranch no longer exists (e.g., upstream dep merged and branch
      // deleted while this task sat queued/stuck). Clear it on the task so any
      // subsequent retry branches from the default base, and proceed from HEAD.
      await deps.store.updateTask(taskId, { executionStartBranch: null });
    } else {
      resolvedStartPoint = resolved;
    }
  }

  /*
  FNXC:TaskBaseResolution 2026-09-16-02:35 (RUFU-245):
  A default-base card names the integration branch itself as its start point (`main`, `origin/main`,
  `refs/heads/main` — all one base). Running the squash-import planner for such a card treats the
  card's OWN base as a dependency: it plans an import of the integration tip onto the integration
  base and leaves the new branch with zero commits of its own — the exact zero-own-commit shape that
  wedge RUFU-231/RUFU-237 could not clear. So the planner runs only for a genuine dependency base,
  and a card whose start point already IS the integration base starts straight from the resolved local
  integration SHA (FN-2729's dep-squash path is untouched: distinct bases still plan an import).
  */
  const settings = await deps.store.getSettings();
  const localBase = resolvedStartPoint
    ? await resolveLocalIntegrationBase({
        rootDir: deps.rootDir,
        settings,
        execImpl: deps.execImpl,
      }).catch(() => ({ integrationBranch: "", localSha: null as string | null }))
    : null;
  const remoteCandidates = [settings.worktreeRebaseRemote, "origin"].filter(
    (remote): remote is string => typeof remote === "string" && remote.length > 0,
  );
  const startPointIsIntegrationBase = !!localBase && (
    namesIntegrationBranch(startPoint, localBase.integrationBranch, remoteCandidates)
    || (!!localBase.localSha && resolvedStartPoint === localBase.localSha)
  );
  const squashImport = resolvedStartPoint && !startPointIsIntegrationBase
    ? await deps.planSquashImportFromDep(taskId, resolvedStartPoint, startPoint)
    : null;
  const initialStartPoint = squashImport ? squashImport.mainBase : resolvedStartPoint;

  for (let attempt = 0; attempt < deps.maxWorktreeRetries; attempt++) {
    try {
      const result = await deps.tryCreateWorktree(
        branch,
        currentPath,
        taskId,
        initialStartPoint,
        attempt,
        0,
        allowSiblingBranchRename,
        settings,
      );
      // Squash-import dep content into the freshly created worktree so the
      // branch contains main's history + 1 import commit instead of the
      // dep's raw commits.
      if (squashImport) {
        await deps.squashImportDepIntoWorktree(
          result.path,
          taskId,
          squashImport.depTip,
          squashImport.label,
        ).catch((importErr: unknown) => {
          executorLog.warn(
            `Squash-import of ${squashImport.label} into ${result.branch} failed for ${taskId} (continuing without): ${importErr instanceof Error ? importErr.message : String(importErr)}`,
          );
        });
      }
      /*
       * FNXC:WorktreeRebase 2026-08-09-00:48:
       * Fetch and rebase the just-created task branch only when the setting is enabled.
       * Failures here never abort task setup.
       */
      await deps.rebaseNewWorktreeOntoRemote(result.path, result.branch, taskId).catch((err: unknown) => {
        executorLog.warn(
          `Post-create worktree rebase failed for ${taskId} (continuing): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return result;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isLastAttempt = attempt === deps.maxWorktreeRetries - 1;
      const isBranchConflict = isBranchConflictError(error);
      const isTerminalWorktreeError = error instanceof NonRetryableWorktreeError || error instanceof StaleWorktreeIndexLockError || isBranchConflict;

      if (isLastAttempt || isTerminalWorktreeError) {
        await deps.store.logEntry(
          taskId,
          `Worktree creation failed after ${deps.maxWorktreeRetries} attempts`,
          errorMessage,
        );
        if (isBranchConflict) {
          throw error;
        }
        throw new Error(
          `Failed to create worktree after ${deps.maxWorktreeRetries} attempts: ${errorMessage}`,
        );
      }

      // Wait before retry (exponential backoff)
      const delay = deps.worktreeRetryDelaysMs[attempt] || 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Should never reach here, but TypeScript needs a return
  throw new Error("Unexpected exit from worktree creation retry loop");
}
