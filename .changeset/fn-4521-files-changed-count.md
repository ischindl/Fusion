---
"@runfusion/fusion": patch
---

Fix inconsistent "files changed" counts between TaskCard and the Task Changes tab. (1) Active tasks without a worktree now fetch the same branch-fallback diff for both surfaces. (2) Done-task lineage aggregation now unions per-lineage-commit file sets instead of sweeping the parent..HEAD range, so interleaved non-task commits no longer inflate the count. (3) Additions/deletions counting no longer drops lines that start with `++` or `--`.
