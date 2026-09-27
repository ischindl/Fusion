---
"@runfusion/fusion": patch
---

summary: Board reads less data: the Done lane and the agent-stats panel stop shipping and computing content the board never renders.
category: performance
dev: "`GET /api/tasks` and `GET /api/tasks/done` now return the same compacted board row as `GET /api/tasks/page` (step identity/status kept, reviewer bodies and `summary` dropped); full content still comes from `GET /api/tasks/:id`. `GET /api/agents/stats` counts queued cards from the project lane vocabulary instead of resolving a workflow per card. `TaskStore.listCompletedTasks` gained an opt-in `compactBoardFeed` option; the default row shape is unchanged."
