---
"@runfusion/fusion": patch
---

summary: `/metrics` now exposes `fusion_eventloop_delay_ms`, so loop starvation is measurable without board traffic.
category: feature
dev: p50/p95/p99/mean/max gauges from `monitorEventLoopDelay({ resolution: 10 })` in the runtime sampler, injectable via `createRuntimeSampler({ eventLoopDelay })` (pass `null` to opt out). Replaces the inference previously drawn from `fusion_system_last_request_age_ms`, which only carries evidence while a request is waiting.
