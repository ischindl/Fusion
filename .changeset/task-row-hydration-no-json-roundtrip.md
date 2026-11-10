---
"@runfusion/fusion": patch
---

summary: Task rows hydrate about 2.8x faster, cutting the JSON churn behind dashboard stutter.
category: performance
dev: `pgRowToTaskRow` no longer re-stringifies PostgreSQL jsonb just so `fromJson` can re-parse it (50.0 us/row vs 141.4 us/row, `FUSION_ROW_HYDRATION_BENCH=1`). Roll back per-process with `FUSION_JSONB_READ_PASSTHROUGH=0` and restart; no rebuild needed.
