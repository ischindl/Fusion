---
"@runfusion/fusion": patch
---

summary: The Board's top progress bar no longer sweeps forever on an idle board.
category: fix
dev: Bar visibility is now `isStale && isBoardRefreshInFlight`, composed in `app/utils/boardLoadIndicator.ts`; `useTasks` tracks in-flight board refreshes. Restored four dashboard test files that still mocked the retired `fetchTasks` call.
