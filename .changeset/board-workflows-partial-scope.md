---
"@runfusion/fusion": patch
---

summary: Add an opt-in `partial=1` scope to the board-workflows endpoint so named task ids no longer cost a full board scan.
category: performance
dev: `GET /api/tasks/board-workflows?taskIds=…&partial=1` resolves the task→workflow mapping for exactly those ids with zero whole-table reads; requests without the flag keep the previous unbounded shape byte-for-byte.
