---
"@runfusion/fusion": patch
---

summary: Every board row states its lifecycle, so a deleted card can no longer be counted as alive.
category: fix
dev: `GET /api/tasks`, `GET /api/tasks/page` and `GET /api/tasks/:id` now stamp `lifecycle` (`live` | `deleted` | `archived`) on every projected row at the HTTP boundary (never inside `rowToTask`). `?includeDeleted=1` now really returns tombstones: the implicit `archived`-sentinel lane exclusion is relaxed for a forensic read only, so the payload stays live-board-plus-tombstones and never merges historical lanes or an explicit `excludeColumns` arm. The single-task route answers a tombstone in one request: `404` with `details.code: "TASK_SOFT_DELETED"` plus the `deletedAt` timestamp, or `200` with the row self-marked `deleted` when the caller asked forensically; an id that never existed stays a plain `404` with no code. A delete refused by live dependents or lineage children is reported at delete time as `409` with `TASK_HAS_DEPENDENTS` / `TASK_HAS_LINEAGE_CHILDREN` while the row demonstrably stays live and listed. Consumers no longer need to filter deleted ids.
