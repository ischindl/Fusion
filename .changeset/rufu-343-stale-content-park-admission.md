---
"@runfusion/fusion": patch
---

summary: A review card parked by the engine's own stall watchdog now recovers itself instead of sitting paused forever.
category: fix
dev: Stale-content park candidacy is provenance-aware (operator/user/deleted pauses still refuse), the park shape is read positionally so a watchdog-wrapped refusal is classified `stall-deadlock`, and the seed lane evaluates the merge door past the park, releasing a park whose sentence is disproven without burning a review cycle.
