---
"@runfusion/fusion": patch
---

summary: Root project-scoped PostgreSQL stores and merges at the project directory, and fix backend-mode agent watching.
category: fix
dev: createTaskStoreForBackend honors an explicit rootDir over projectId re-resolution (stale bootstrap PROMPT.md pinned cards "unplanned"); drainMergeQueue roots git operations at store.getRootDir() (merges aborted with branch-missing in in-process dashboards); AgentStore.startWatching no longer trips the sqlite getLastModified gate in backend mode.
