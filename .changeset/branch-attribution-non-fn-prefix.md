---
"@runfusion/fusion": patch
---

summary: Cards in projects with a non-FN id prefix can re-acquire a worktree that holds their own commits.
category: fix
dev: Commit attribution (`packages/engine/src/execution/branch-conflicts.ts`) recognised only `FN-<n>` task ids in `Fusion-Task-Id` trailers and conventional-commit scopes, so work committed under a project `settings.taskPrefix` like `SANE` was read as unattributed and a deleted worktree path made the branch permanently `foreign-unmerged`. Attribution now matches the canonical task-id grammar (`[A-Z][A-Z0-9]*-\d+`), and branch-name owner derivation (`deriveTaskIdFromFusionBranch`) is intentionally unchanged because it gates branch deletion.
