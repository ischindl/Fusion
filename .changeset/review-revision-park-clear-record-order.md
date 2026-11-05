---
"@runfusion/fusion": patch
---

summary: A card the engine un-parks now always carries the explanation of why it was un-parked.
category: fix
dev: `reconcile-review-revision-stall-parks` writes its task-history line BEFORE the guarded park clear instead of after. A cleared card no longer matches the sweep's admission predicate (`isEngineAuthoredInReviewStallPark` requires `paused === true`), so under the old order a `logEntry` rejection — the RUFU-275 `fn extension TaskStore boot timed out after 30000ms` class — aborted the pass after the state change and the explanation was gone permanently with no retry path. The accepted cost is that a card whose guarded write drifts can hold a line while staying parked: noise, not loss. Each card's read-admit-log-clear-record block also now runs inside its own try/catch, so one card's refusing write no longer aborts the whole pass, which previously left every later mis-parked card unrepaired. `task:merge-review-revision-park-cleared` keeps its name and its four metadata keys and stays after the applied clear; its FN-9175 bounded-sink conformance is now proven behaviorally for absent, throwing, rejecting, and never-settling sinks in `review-revision-stall-park.test.ts`.
