---
"@runfusion/fusion": patch
---

summary: Board counters count queued cards in the database instead of loading every card.
category: performance
dev: `GET /api/agents/stats` now uses `countLiveTasks` (the same SQL `COUNT(*)` the board lane pager uses for its `total`) instead of `listTasks(...).length`. The SQLite backend, which has no async layer, keeps the previous column-scoped read.
