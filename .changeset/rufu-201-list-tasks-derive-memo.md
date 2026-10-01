---
"@runfusion/fusion": patch
---

summary: Engine board sweeps skip dashboard-only badges, cutting engine CPU, GC pressure, and hot PostgreSQL reads.
category: performance
dev: `listTasks` gains `derive: false` to skip UI-signal derivation (board feed keeps deriving by default); the startup slim-list memo now hands out one frozen shared snapshot invalidated by task events, with `STARTUP_SLIM_LIST_MEMO_TTL_MS` = 15s as the cross-process staleness ceiling. Converted callers: triage admission/sweep/poll reads, scheduler tick reads (`startupMemo: false` retained), the gridlock sweep (lifecycle also resolved once per pass instead of twice), and `listTasksInLaneRoles` (kept non-slim because the merge lane reads `task.log`). See `docs/solutions/performance/list-tasks-derive-optout-and-memo.md`.
