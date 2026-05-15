---
"@runfusion/fusion": patch
---

Fix the executor no-`fn_task_done` retry race with self-healing branch/worktree reclaim by re-validating live worktree/branch bindings before retry sessions and converting missing/incomplete/unregistered worktree session-start failures into clean `todo` requeues with preserved progress.
