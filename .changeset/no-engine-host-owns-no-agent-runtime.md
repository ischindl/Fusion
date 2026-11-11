---
"@runfusion/fusion": patch
---

summary: A dashboard host no longer wakes or stops durable agents the engine host is running.
category: fix
dev: `fn dashboard --no-engine` no longer builds a `HeartbeatMonitor`/`HeartbeatTriggerScheduler` (wakes are engine-owned), heartbeat stale-run reapers and `POST /api/agents/:id/runs[/stop]` now check the run's `processPid` owner first, and `POST /api/agents/:id/runs` on an executor-less host returns 501 `agent-runtime-not-hosted-here` instead of writing a run row nobody will drive. New shared predicate: `classifyHeartbeatRunOwner` in `@fusion/engine`.
