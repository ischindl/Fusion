---
"@runfusion/fusion": patch
---

summary: FUSION_HYBRID_EXECUTOR=1 no longer blocks dashboard writes while project runtimes load at boot.
category: fix
dev: Boot backgrounds `HybridExecutor.initialize()` on dashboard/serve/daemon so the migration holding server is released on schedule; adds `whenReady()`, `resolveHybridExecutorReadiness`, `shutdownInitWaitTimeoutMs` (default 5s) and `startupCapacityProbeTimeoutMs` (default 2.5s); live isolation transitions now answer 503 `hybrid_executor_starting`/`hybrid_executor_failed` instead of transitioning against a half-loaded executor.
