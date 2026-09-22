---
"@runfusion/fusion": minor
---

summary: Health probes now run on a dedicated PostgreSQL connection; add FUSION_PG_POOL_MAX to raise the per-store pool cap.
category: feature
dev: /api/health connectivity, task-ID integrity, and migration-marker queries use a dedicated max:1 connection instead of the store's runtime pool, so scheduler fan-out can no longer flap ok/degraded. The task-ID integrity detector now accepts `{ projectId }` and health scopes it to the engine project: task IDs are unique per project on PostgreSQL, and the unscoped scan reported every cross-project ID reuse as corruption. Precedence for pool size is per-call `poolMax` option > `FUSION_PG_POOL_MAX` (integer 1..500, invalid values warn and fall back) > default 3.
