---
"@runfusion/fusion": patch
---

summary: Fix board load stalling for minutes on large projects — task workflow selections are now read in one query.
category: performance
dev: `buildBoardWorkflowsPayload` resolves per-card workflow selections with `getTaskWorkflowSelectionsAsync` (one `inArray` read) instead of awaiting `getTaskWorkflowSelectionAsync` once per card, which made `GET /tasks/board-workflows` an N+1 (12-25s measured on a 65-card board). Stores that only expose the singular reader keep the per-task path, and a failed batch falls back to it rather than failing the board.
