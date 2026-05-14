---
"@runfusion/fusion": patch
---

Fix false-positive `BranchCrossContaminationError` that paused tasks at start when their stored `baseCommitSha` was stale relative to `main`. The contamination check now computes a fresh merge-base against the integration branch instead of reusing the diff-stable `task.baseCommitSha`, and `captureBaseCommitSha` only preserves a prior stored value when resuming an existing worktree. Diff-base stability across resumed sessions is preserved (FN-4309/FN-4383 behavior unchanged).
