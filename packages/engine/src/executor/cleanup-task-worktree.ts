/**
 * FNXC:CodeOrganization 2026-08-03-15:40:
 * TaskExecutor.cleanup peeled from TaskExecutor (U4).
 *
 * Drops in-memory active-worktree tracking and removes the single-repo worktree
 * when no other task still needs it. Workspace roots are tracking-only (never removed).
 */
import type { TaskStore, WorkspaceConfig } from "@fusion/core";
import { findWorktreeUser } from "../merger.js";
import { RemovalReason } from "../worktree/worktree-pool.js";
// FNXC:WorktreePreservation 2026-11-08-05:30 (RUFU-278): the preservation leaf rather than the pool barrel, so a test
// doubling the barrel cannot erase the protection/failure distinction here.
import { settlePreservedWorktreeRemoval } from "../worktree/worktree-preservation.js";
import { executorLog } from "../logger.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirror TaskExecutor method surface
type AnyFn = (...args: any[]) => any;

export type CleanupTaskWorktreeDeps = {
  store: TaskStore;
  workspaceConfig: WorkspaceConfig | null | undefined;
  ensureWorkspaceConfig?: () => Promise<WorkspaceConfig | null>;
  activeWorktrees: Map<string, Set<string>>;
  getActiveWorktreePaths: (taskId: string) => string[];
  removeOwnWorktreeWithReconcile: AnyFn;
};

export async function cleanupTaskWorktree(
  deps: CleanupTaskWorktreeDeps,
  taskId: string,
): Promise<void> {
  const workspaceConfig = deps.ensureWorkspaceConfig
    ? await deps.ensureWorkspaceConfig()
    : deps.workspaceConfig;
  const worktreePaths = deps.getActiveWorktreePaths(taskId);
  if (worktreePaths.length === 0) return;

  deps.activeWorktrees.delete(taskId);

  /*
  FNXC:Workspace 2026-08-15-05:13:
  In workspace mode the tracked path is the browse-only non-git root, never a removable worktree.
  Per-repo teardown belongs to SelfHealingManager.reconcileOrphanedWorkspaceWorktrees for complete
  and terminal lanes, while archive-lifecycle owns archived rows. A failed task may be retried, so
  executor cleanup only drops in-memory tracking and must not discard sub-repo work at this boundary.
  */
  if (workspaceConfig) {
    return;
  }
  // Non-workspace tasks hold a one-element set — preserve the original single-path removal semantics.
  const worktreePath = worktreePaths[0];

  // Check if another task still needs this worktree
  const otherUser = await findWorktreeUser(deps.store, worktreePath, taskId);
  if (otherUser) {
    executorLog.log(`Worktree retained for ${taskId} — still needed by ${otherUser}`);
    return;
  }

  try {
    const settings = await deps.store.getSettings();
    await deps.removeOwnWorktreeWithReconcile({
      worktreePath,
      settings,
      taskId,
      reason: RemovalReason.ExecutorDispose,
    });
    executorLog.log(`Cleaned up worktree for ${taskId}`);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    /*
    FNXC:WorktreePreservation 2026-11-08-05:30 (RUFU-278):
    This lane passes `ExecutorDispose`, a non-defensive reason that cannot refuse on content today, so the settle call
    is normally a no-op and the existing error log stands. It is here because `reason` arrives from the caller: the
    moment any caller routes a defensive reason through this teardown, a content refusal must be recorded as the
    protection it is instead of surfacing as `Failed to clean up worktree` — which is how RUFU-260's episode first
    reached an operator. No pointer is cleared on this path either way.
    */
    const settled = await settlePreservedWorktreeRemoval({
      store: deps.store,
      taskId,
      worktreePath,
      reason: RemovalReason.ExecutorDispose,
      lane: "executor-teardown",
      error: err,
    });
    if (!settled) {
      executorLog.error(`Failed to clean up worktree for ${taskId}:`, errorMessage);
    }
  }
}
