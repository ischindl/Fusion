---
"@runfusion/fusion": patch
---

summary: Board lane-metadata repairs no longer rescan the whole board, so the dashboard spends less time in git-sized task scans.
category: performance
dev: `GET /api/tasks/board-workflows?taskIds=…&partial=1` resolves task→workflow mapping for exactly those ids with zero whole-table reads; the board's unmapped-lane repair now uses it and merges the partial answer instead of replacing the lane set. Requests without the flag keep the previous unbounded shape byte-for-byte.
