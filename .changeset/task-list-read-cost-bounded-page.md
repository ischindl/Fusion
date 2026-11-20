---
"@runfusion/fusion": patch
---

summary: Board loads read only what the page shows, instead of the whole cluster's queue and workflow selections.
category: performance
dev: `TaskStore.getMergeQueuedTaskIdsAsync(ids?)` now accepts the caller's id set and predicates on it (omitting the argument keeps the old whole-table answer); new index `idxTasksProjectLiveCreatedId` on `project.tasks (project_id, created_at, numeric task-id suffix) WHERE deleted_at IS NULL` ships as migration 0098 and advances the schema ceiling to 0098. `pnpm bench:tasks-list-reads` reproduces the measurement; it needs a free PostgreSQL port (5499 by default). The index is only selected by the planner while the board's project is a minority of the shared `tasks` table — on a single-project database it is inert and nothing regresses.
