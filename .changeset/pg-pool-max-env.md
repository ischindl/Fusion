---
"@runfusion/fusion": minor
---

summary: Add FUSION_PG_POOL_MAX so operators can raise the per-store PostgreSQL pool cap and stop health-banner flapping.
category: feature
dev: Precedence is per-call `poolMax` option > `FUSION_PG_POOL_MAX` (integer 1..500, invalid values warn and fall back) > default 3. The dashboard health probe shares each store's runtime pool; under scheduler fan-out a cap of 3 can starve the 5s probe deadline.
