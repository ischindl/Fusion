---
"@runfusion/fusion": patch
---

summary: New FUSION_METRICS_DOMAIN_INTERVAL_MS throttles board-count sampling that competed with the UI.
category: performance
dev: Domain arm default stays 5000 ms; set 15000 to match a 15s Prometheus scrape. A live CDP profile put `listTasksImpl` at 39,2% of dashboard process CPU, with the sampler's own chain (`defaultListTasks` 27,4%, `sampleDomain` 11,6%) most of it — it hydrates cards only to tally `task.column`. Values below 1000 ms or unparseable fall back to the default.
