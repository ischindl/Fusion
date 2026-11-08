---
"@runfusion/fusion": patch
---

summary: Stop the board stalling while it re-checks approved-plan scope drift.
category: performance
dev: The approved-plan file-scope matcher compiled one RegExp per (modified file x declared pattern) pair inside `evaluateSpecDrift`. It now compiles each pattern once per evaluation and reuses it for every path, so a card with 20 scope patterns and 500 modified files drops from ~29.5 ms to ~0.39 ms per evaluation (75x) and pattern compilation no longer scales with modified-file count. Drift verdicts are unchanged (golden digest identical before and after); nothing is memoized across planning passes. Pinned by `packages/core/src/__tests__/planner/spec-drift-scope-cost.test.ts`.
