---
"@runfusion/fusion": patch
---

Stop losing uncommitted dev edits during task merges. Two fixes to the merger:

1. The pre-merge autostash in `stashUnrelatedRootDirChanges` no longer silently proceeds when stash creation fails over a dirty working tree. It now throws `AutostashCreationFailedError`, which the merger catches and surfaces to the task feed before any destructive `git reset --hard` / `git clean -fd` runs — your edits stay in the working tree.

2. `acquireReuseHandoff` no longer refuses the handoff on a dirty reused task worktree (the FN-5138 "Merge handoff refused (working-tree-dirty)" failure). It now autostashes the dirty content (`git add -A` → `git stash create` → `git stash store -m fusion-reuse-handoff-autostash:<taskId>:<ts>`), emits a `merge:reuse-handoff-autostash` audit event with the stash SHA and a recover command, and lets the merge proceed.

The new failure mode `dirty-worktree-autostash-failed` is reserved for the (rare) case where stash creation itself fails — so the operator can distinguish "we tried and failed" from the old "we refused to try."
