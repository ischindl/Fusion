---
"@runfusion/fusion": minor
---

summary: Health probes now run on a dedicated PostgreSQL connection; add FUSION_PG_POOL_MAX to raise the per-store pool cap.
category: feature
dev: /api/health connectivity, task-ID integrity, and migration-marker queries use a dedicated max:1 connection instead of the store's runtime pool, so scheduler fan-out can no longer flap ok/degraded. Precedence for pool size is per-call `poolMax` option > `FUSION_PG_POOL_MAX` (integer 1..500, invalid values warn and fall back) > default 3.
