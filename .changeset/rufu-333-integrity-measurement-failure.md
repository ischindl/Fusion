---
"@runfusion/fusion": minor
---

summary: The task-ID integrity canary now says "not measured" instead of "healthy" when it cannot read the database.
category: fix
dev: The synchronous detector now raises `TaskIdIntegrityMeasurementError` (defined once in `packages/core/src/tasks/task-id-integrity.ts` and re-exported from `@fusion/core/postgres`) instead of returning an empty report. New exports: `TASK_ID_INTEGRITY_NOT_MEASURED`, and the `TaskIdIntegrityState` / `TaskIdIntegrityMeasurementFailure` types. `TaskStore.buildTaskIdIntegrityFallbackReport()`, `detectAndCacheTaskIdIntegrityReport()`, `mergeTaskIdIntegrityReports()`, `refreshTaskIdIntegrityReport()` and `getTaskIdIntegrityReport()` now return `TaskIdIntegrityState`, and `taskIdIntegrityReport` starts unmeasured. Merging ranks a real measurement failure above the never-measured sentinel, which ranks above any completed scan, so `status: "ok"` can only come from a scan that finished.
