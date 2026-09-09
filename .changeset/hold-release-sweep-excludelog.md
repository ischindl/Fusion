---
"@runfusion/fusion": patch
---

summary: Hold-release board sweep stops fetching task logs, cutting the engine's most expensive recurring read.
category: performance
dev: '`listTasks` gains `excludeLog: true` to drop the `log` jsonb column from the SQL projection for a consumer that provably never reads it. Effective only alongside `derive: false` — with derivation on, `log` is a derivation input for `stalledReview`/`timedExecutionMs`, so asking for both is a documented no-op and cannot disable a board badge. Unlike `slim`, it does not re-parse PROMPT.md for tasks with empty persisted `steps` and blanks no other field. Converted caller: the hold-release full-board sweep (`packages/engine/src/execution/hold-release.ts`), which now reads `derive: false, excludeLog: true`. See `docs/solutions/performance/list-tasks-derive-optout-and-memo.md`.'
