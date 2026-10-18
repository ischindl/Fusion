---
"@runfusion/fusion": patch
---

summary: Switching a project's isolation mode is refused by live work, not by a stale number or an unreachable runtime.
category: fix
dev: The busy guard in `ProjectManager.restartProjectRuntime()` now decides from a new decision-time `ProjectRuntime.observeInFlight()` observation (`{ inFlightTasks, proven, source }`) instead of the cached `getMetrics()` estimate, refusing both when work is observed live and when a transport cannot prove idleness (`inFlightTasks > 0` or `proven === false`). `getMetrics()` remains the display/health estimate and may stay cached. A wedged child process now probes `GET_METRICS` under a 1500 ms bound behind a generation-guarded cache writer, and a remote node that cannot be reached keeps its last real observation instead of failing open to zero. The 409 body for `active_tasks` gains `details.inFlightUnproven: true` on refusals the transport could not certify — omitted, never `false`, when live work was actually observed — so `activeTaskCount: 0` no longer reads as "blocked by nothing, yet refused". `force: true` keeps its bypass semantics and no longer pays for a metrics probe it would overrule.
