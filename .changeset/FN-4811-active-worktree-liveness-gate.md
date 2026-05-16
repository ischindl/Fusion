---
"@runfusion/fusion": patch
---

fix(FN-4811): refuse to force-remove worktrees actively bound to live sessions

Adds a hard liveness gate to the executor's conflict-recovery paths so that
`cleanupConflictingWorktree` and `handleBranchConflict` refuse to remove a
worktree that is currently bound to an active executor session — either via
the in-memory `activeWorktrees` map or via a non-done, non-paused
`in-progress` task in the store. When the requesting task has
`executorAllowSiblingBranchRename`, the recovery flow now falls through to
the suffix-rename path instead of force-removing the live owner's worktree.

This is the canonical fix for the FN-4781/FN-4804 cascade:
"assigned worktree path disappeared mid-task", two parallel runs for the
same task alive simultaneously, cross-task contamination, and post-merge
"branch tip misbound but content found on main" rescues firing on every
successful merge. The new `findActiveWorktreeOwner()` helper centralizes
the liveness check across both gating points.
