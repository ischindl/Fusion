---
"@runfusion/fusion": patch
---

summary: A card re-running on its own branch is no longer reported as contaminated by its own commits.
category: fix
dev: Commit attribution is now three-way (`own` / `foreign` / `unattributed`) from one shared classifier in `packages/engine/src/execution/branch-attribution.ts`. A word-bounded task-id token anywhere in a commit subject counts as the card's own work (`source: "own-mention"`), and a commit that names no card is counted as unattributed instead of foreign. `task:worktree-contamination-detected` gains `nonAttributedCommitCount` and its `foreignCommitShas` never carries own or unattributed shas; `merge:scope:auto-widen` widens own work and refuses `no-attribution` where it previously refused `foreign-commit`; the dashboard done-range attribution returns `nonAttributedCommitCount` and its Task Detail hide gate reads `foreignCommitCount + nonAttributedCommitCount`. Declared file scope is unchanged: only own commits contribute files.
