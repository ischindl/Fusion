---
"@runfusion/fusion": patch
---

Wire `HybridExecutor` into serve/dashboard/daemon startup behind `shouldUseHybridExecutor` gating. This adds optional multi-project runtime orchestration (project runtimes + node health monitoring) while preserving default single-project local behavior unless the gate enables it.
