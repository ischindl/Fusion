---
"@runfusion/fusion": patch
---

summary: A card whose recorded working directory has vanished is repaired automatically instead of stalling or looping.
category: fix
dev: One classifier (`classifyTaskWorktreeState` in `packages/engine/src/worktree/worktree-pointer-state.ts`) decides the three states a worktree pointer can be in - live and matching, live but unclaimed, or stale - and says so when git will not answer rather than reporting "no registrations". `reconcileWorktreePointers()` clears the stale case on WIP and review cards (it runs after the existing metadata reconcile, which stays the only writer of an adopted path); acquisition now makes the same repair durable when it finds it, so the cleared column survives the run instead of being re-derived on every dispatch. The repair nulls only the working-directory column: `branch`, its commits and git's own worktree record are never touched, and nothing is pruned, removed or emptied because a row named a stale path. New events `task:reconcile-worktree-pointer` and its `-no-action` companion carry ids and fixed enums only.
