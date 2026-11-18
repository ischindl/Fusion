---
"@runfusion/fusion": patch
---

summary: A durable agent whose heartbeat delivery is intentionally withheld no longer reads as stale or unresponsive.
category: fix
dev: `HeartbeatTriggerScheduler.onTimerTick` records `agent.metadata.heartbeatTimerLiveness` on the three fire-and-skip paths (wake-suppressed, idle-skip, parallel-execution); the reports-health classifier, the dashboard health pill and the fleet strip all resolve it through the new browser-safe leaf `@fusion/core/heartbeat-timer-liveness`, each bounded by its own existing staleness window, so no threshold moved. The stamp is the physical fire instant and the refresh bound is half an effective interval, so a lane that keeps firing on cadence always refreshes the record before either window can lapse. Pause, engine pause, live-run, ineligible-state and delivered paths write nothing, and a lane with no fire evidence is still `**stale**` / `Unresponsive`.
