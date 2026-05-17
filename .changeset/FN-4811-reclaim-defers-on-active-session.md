---
"@runfusion/fusion": patch
---

fix(FN-4811): defer self-healing reclaim when worktree has an active session

The `reclaimSelfOwnedBranchConflicts` sweep was force-pausing actively-running tasks. When a task's branch tip was already on `main` (the `tip-already-merged` inspection), the sweep tried `removeWorktree({ reason: SelfHealingBranchConflict })`. The FN-4811 active-session gate correctly refused (the worktree was still bound to a live executor session), but the outer catch escalated the thrown error to `AutoRecoveryDispatcher` with class `branch-conflict-unrecoverable`. The dispatcher's `pause` decision then marked the task `failed + paused + pausedReason="branch-conflict-unrecoverable"` — even though the executor was making real progress (FN-4819 reproduction).

Fix: at the top of the per-task reclaim loop, check `activeSessionRegistry.isPathActive(task.worktree)` and `continue` for any task whose worktree is currently bound to a live executor/merger/step session. The reclaim retries on the next sweep when the session has finished and the worktree is genuinely free.
