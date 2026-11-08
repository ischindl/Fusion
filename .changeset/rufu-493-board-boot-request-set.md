---
"@runfusion/fusion": patch
---

summary: The board now requests only board data; usage, agent stats, and per-card badges load on demand.
category: performance
dev: `GET /tasks/board-workflows` gains `?scope=lanes` (workflow catalog only, zero task-table reads) and keeps `?taskIds=&partial=1`; every parameter is appended after one separator and joined by `&`, and a lanes-only answer never overwrites the cached card-to-lane mapping. The mount read stays whole-board because a partial answer merges and cannot express a removed lane or moved default. `useUsageData` is a single dispatcher with a five-minute snapshot, `useAgents` gained an `enabled` gate that App opens only once the board's own read has answered AND `capacityRiskBannerEnabled` is on, per-card mission/agent labels are viewport-gated and coalesced per mission id, and `useTaskDiffStats` now arms through `useVisibilityAwarePoll` instead of its own interval. Contract documented in `docs/performance/board-boot-request-set.md` and pinned by `app/__tests__/board-boot-request-set.test.tsx` on request paths, counts, and PARSED query parameters — including a guard that the gate ships in `App.tsx` and not only in the harness.
