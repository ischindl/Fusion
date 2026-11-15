/**
 * FNXC:CodeOrganization 2026-08-03-17:00:
 * releasePreExecutionWorktree peeled from TaskExecutor (U4).
 *
 * Drops a pre-execution worktree that never ran and has no commits/uncommitted work,
 * so withdrawn/paused cards do not hold disk forever. Fail-soft; never blocks lifecycle moves.
 */
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { TaskStore } from "@fusion/core";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { executorLog, formatError } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { RemovalReason, removeWorktree } from "../worktree/worktree-pool.js";
// FNXC:WorktreePreservation 2026-11-08-05:20 (RUFU-278): imported from the preservation leaf so a test that doubles
// the whole pool barrel cannot erase the distinction between a protection and a failure on this path.
import { settlePreservedWorktreeRemoval } from "../worktree/worktree-preservation.js";
import { resolveExternalExecutionCheckoutRoute } from "../execution/external-execution-checkout.js";
import { preExecutionWorktreeHasWork } from "./worktree-git-refs.js";

export type ReleasePreExecutionWorktreeDeps = {
  store: TaskStore;
  rootDir: string;
  activeWorktrees: Map<string, Set<string>>;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  hasLiveTaskSessionSurface: (taskId: string) => boolean;
};

export async function releasePreExecutionWorktree(
  deps: ReleasePreExecutionWorktreeDeps,
  taskId: string,
  reason: string,
): Promise<boolean> {
  // FNXC:WorktreePreservation 2026-11-08-05:20 (RUFU-278): the path the refusal spoke about, hoisted so the catch can
  // name it without re-reading the row it just failed around.
  let attemptedWorktreePath: string | null = null;
  try {
    const live = await deps.store.getTask(taskId);
    if (!live?.worktree) return false;
    attemptedWorktreePath = live.worktree;
    /*
    FNXC:ExternalExecutionCheckout 2026-08-09-22:43:
    Never release an operator-owned external checkout as a pre-execution worktree.
    */
    const externalExecutionRoute = await resolveExternalExecutionCheckoutRoute(live);
    if (externalExecutionRoute.configured) return false;
    if (live.firstExecutionAt || live.executionStartedAt) return false;
    if (activeSessionRegistry.isPathActive(live.worktree) || activeSessionRegistry.isPathActive(resolvePath(live.worktree))) return false;
    if (deps.hasLiveTaskSessionSurface(taskId) || executingTaskLock.has(taskId)) return false;

    if (existsSync(live.worktree)) {
      if (await preExecutionWorktreeHasWork(live.worktree)) {
        executorLog.log(`${taskId}: keeping pre-execution worktree ${live.worktree} — it carries commits or uncommitted changes`);
        return false;
      }
      const settings = await deps.store.getSettings();
      await removeWorktree({
        rootDir: deps.rootDir,
        worktreePath: live.worktree,
        settings,
        taskId,
        reason: RemovalReason.SelfHealingReclaim,
      });
    }
    deps.activeWorktrees.get(taskId)?.delete(live.worktree);
    await deps.store.updateTask(taskId, { worktree: null, branch: null, branchWriteOrigin: "engine" as const, baseCommitSha: null, sessionFile: null }, deps.getRunContextFor(taskId));
    await deps.store.logEntry(taskId, `Released the pre-execution worktree (${reason}) — it will be re-acquired when planning or execution resumes`, undefined, deps.getRunContextFor(taskId)).catch(() => undefined);
    executorLog.log(`${taskId}: released pre-execution worktree ${live.worktree} (${reason})`);
    return true;
  } catch (error) {
    /*
    FNXC:WorktreePreservation 2026-11-08-05:20 (RUFU-278):
    `SelfHealingReclaim` is a defensive reason, so this removal can refuse on content. The pointers were already safe
    here — the throw skips the clear below — but the whole episode was engine-log-only, so the operator saw a card
    that simply never released its checkout with nothing saying why. A refusal now reads as the protection it is, on
    the card; anything else keeps its existing warn.
    */
    const settled = await settlePreservedWorktreeRemoval({
      store: deps.store,
      taskId,
      worktreePath: attemptedWorktreePath ?? "unknown",
      reason: RemovalReason.SelfHealingReclaim,
      lane: "pre-execution-release",
      error,
      runId: deps.getRunContextFor(taskId)?.runId,
    });
    if (!settled) {
      executorLog.warn(`${taskId}: could not release the pre-execution worktree: ${formatError(error).message}`);
    }
    return false;
  }
}
