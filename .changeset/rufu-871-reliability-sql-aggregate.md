---
"@runfusion/fusion": patch
---

summary: Dashboard no longer loads tens of thousands of audit rows to compute Reliability numbers, which was filling its memory.
category: fix
dev: The Reliability headline folded `merge-attempt-*` phases per task from up to 50,000 hydrated `run_audit_events` rows. It now calls `getMergeAttemptPhaseCounts` in `@fusion/core`, which groups in PostgreSQL and returns one row per task; the SQLite layer keeps the JS fold behind `mergeAttemptPhaseCountsFromEvents`, and both feed `mergeAttemptsFromPhaseCounts`.
