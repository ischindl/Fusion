---
"@runfusion/fusion": minor
---

summary: The retention census on /metrics now covers the engine's own retained collections, not just dashboard caches.
category: feature
dev: Adds a numbers-only host registry exported from `@fusion/core` (`registerHostRetentionSource` / `listHostRetentionSources`); `createRetentionSampler` folds it into the same census before each sample, so `fusion_retention_source_entries{source="executor_*"}`, `..._bytes{source}` and `fusion_retention_coverage_ratio` now attribute ~27 task-keyed executor collections that previously sat in the residual.
