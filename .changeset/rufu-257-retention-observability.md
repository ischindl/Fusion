---
"@runfusion/fusion": minor
---

summary: Bound every dashboard cache and add a retention census so memory growth is attributable before it crashes.
category: feature
dev: `/metrics` now exposes `fusion_retention_source_*` gauges per registered source with a named ceiling (plus `tracked_bytes`, `coverage_ratio`, `residual_bytes`, `heap_used_bytes`), previously unbounded module-scope caches in the dashboard server gained TTL/LRU bounds without changing TTL or hit semantics, and `pnpm check:retention-coverage` (in `test:gate:static`) fails the build on any module-scope Map/Set that declares no bound. The `fusion_retention_op_total{source}` / `fusion_retention_op_latency_bucket{le}` op lane is fed by every cache built through the bounded TTL seam plus the hand-rolled diff-stats cache, so a source's traffic and latency join its byte gauge on the same `source` label. There is deliberately no `fusion_retention_pressure` series: the pressure signal reaches operators as a `retention pressure (heap-ratio|source-at-ceiling):` dashboard-log warning plus a one-per-day Mailbox notice, so it arrives without a Prometheus scrape. Triage procedure: `docs/solutions/performance/dashboard-heap-growth-runbook.md`.
