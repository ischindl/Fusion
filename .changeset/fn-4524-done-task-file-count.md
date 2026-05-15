---
"@runfusion/fusion": patch
---

Fix inaccurate "files changed" counts on done tasks. Done-task lineage aggregation now unions per-lineage-commit file sets (instead of sweeping `earliestParent..latestSha`), so interleaved non-task commits no longer inflate the count, and rename/copy entries are deduplicated. Additions/deletions counting no longer drops lines that start with `++` or `--`. Add regression tests in `packages/dashboard/src/__tests__/routes-diff-done-tasks.test.ts` that compare done-task diff stats against real git shortstat outputs for lineage, rename/copy, squash-merge, and `++`/`--` patch content scenarios.
