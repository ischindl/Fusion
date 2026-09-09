import type { Task } from "../types.js";
import { taskHoldsUnmergedCheckout } from "../tasks/file-scope-lease.js";
import { isRunningAgentTask, type RunningAgentTaskShape } from "./live-agent-count.js";

export type WorktreeCapacityTaskShape = RunningAgentTaskShape
  & Pick<Task, "worktree" | "workspaceWorktrees"> & {
    /**
     * RUFU-200: `true` ONLY when the caller proved — via git, per repository — that every retained
     * checkout of this task is a clean tree AND zero commits ahead of its base. Absent or `false`
     * means "holder" (fail-closed): a caller that could not obtain the proof must keep today's
     * counting, because the cost of a wrong downgrade is releasing a slot that still protects
     * someone's uncommitted work. The engine computes this in
     * `persistedWorktreeHolderTaskIdsFromStore` from the shared `CheckoutEmptinessProver` cache.
     */
    checkoutProvenEmpty?: boolean;
  };

/*
FNXC:CapacityModel 2026-09-01-14:49:
Worktree capacity counts a live WIP task before acquisition because dispatch commits the slot before
its checkout path is persisted; counting only acquired paths would under-count that transfer window
and over-admit execution. A task with a retained singular or workspace checkout also counts in any
eligible non-terminal lane, because a replan bounce keeps real on-disk work that execution will resume.
Planning-only tasks satisfy neither condition and therefore consume no worktree slot.

FNXC:CapacityModel 2026-09-01-16:01:
A Plan Review replan bounce carries `status:"needs-replan"`, which is intentionally not a live-agent
status, while retaining the execution checkout it will resume onto. Count that real checkout before
consulting agent liveness so it cannot disappear from the host-resource gate; pause, failure, and
terminal lifecycle state still release the slot.

DELIBERATE-LITERAL — resolved lifecycle metadata wins when present. The legacy `done` and
`in-progress` names are compatibility fallbacks for callers whose task shape predates those fields;
historical-sentinel rows are excluded from the live inventory before this predicate runs.
*/
export function isWorktreeCapacityHolder(task: WorktreeCapacityTaskShape): boolean {
  const terminalKind = task.columnTerminalKind
    ?? (task.column === "done" ? "complete" : "none");
  if (terminalKind !== "none" || task.paused || task.userPaused || task.status === "failed") return false;
  /*
  FNXC:OverlapScheduling 2026-09-09-00:40 (RUFU-200):
  A retained checkout claims a worktree slot only while it has something to preserve. The phantom
  holder RUFU-198 sat in a planning lane behind an unmet dependency with a clean, zero-commits-ahead
  checkout and still consumed one of the operator's `maxWorktrees` slots, which is how the readout
  reported 3/4 while every "holder" had nothing on disk worth protecting. `checkoutProvenEmpty` is
  downgrade-only and fail-closed (see the field doc): absent/`false` keeps today's exact counting.
  A proven-empty checkout falls through to the liveness checks instead of returning early, so a
  genuinely running WIP card still counts through its own clause.
  */
  if (taskHoldsUnmergedCheckout(task) && task.checkoutProvenEmpty !== true) return true;
  if (!isRunningAgentTask(task)) return false;
  return task.columnCountsTowardWip ?? task.column === "in-progress";
}
