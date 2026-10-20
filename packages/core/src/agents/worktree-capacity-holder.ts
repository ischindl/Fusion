import type { Task } from "../types.js";
import { taskHoldsUnmergedCheckout } from "../tasks/file-scope-lease.js";
import { isRunningAgentTask, type RunningAgentTaskShape } from "./live-agent-count.js";

export type WorktreeCapacityTaskShape = RunningAgentTaskShape
  & Pick<Task, "worktree" | "workspaceWorktrees">;
/*
FNXC:OverlapScheduling 2026-09-09-00:40 (RUFU-200) / FNXC:ExternalBlock 2026-10-19-20:18 (RUFU-374):
The downgrade-only `checkoutProvenEmpty` flag used to be declared here, which is why only the
worktree dimension could consume it. RUFU-374 needed the identical proof for the external-block
branch of `isRunningAgentTask` — the same question, the same fail-closed rule, one flag — so the
declaration moved up to `RunningAgentTaskShape` and this shape inherits it. Keep exactly one
spelling: a per-dimension copy of the flag would let the two capacity gates drift apart on the very
evidence they share.
*/

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
