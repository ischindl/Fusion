---
"@runfusion/fusion": patch
---

summary: A new diagnostic row flags task list reads that pull across projects instead of one bound project.
category: fix
dev: `task:unbound-list-read` (`packages/core/src/postgres/task-list-read-scope.ts`) is emitted once per violating read site per 15-minute window — plus one warning line naming the remedy, `createTaskStoreForBackend({ rootDir, projectId })` — when a task LIST read runs on a shared-PostgreSQL layer with no bound project. Recorded, not refused: `TASK_LIST_READ_SCOPE_ENFORCEMENT` is the single flip point and promotes to a throw only once production traffic shows the violating call-site set empty or every site bound. Watched sites: `readLiveTaskRows`, `countLiveTasks`, `readCompletedTaskPage`, `readTaskRowsBySourceLineage`, `listStrandedRefinements`, the capacity candidate scan, the `transitionPending` marker scan. The discriminator is the layer's existing `backend` descriptor, so a legacy SQLite store and by-id reads/writes keep the documented no-op scope. `createProjectStore` in `packages/cli/src/project-resolver.ts` now passes the registry `project.id` for its two project-resolvable callers.
