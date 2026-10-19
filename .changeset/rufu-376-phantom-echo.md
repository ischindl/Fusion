---
"@runfusion/fusion": patch
---

summary: Branch-conflict notices no longer name a worktree that was never checked out.
category: fix
dev: `BranchConflictError` now carries the requested destination in the new `desiredWorktreePath` field; `conflictingWorktreePath` is populated only for a checkout git proves exists (empty means proven: none). Refusal messages, card `error` text, formatted log lines and a paused card's `worktree` column omit the path for `foreign-unmerged` collisions; audit rows keep it under `desiredWorktreePath`.
