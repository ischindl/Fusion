---
"@runfusion/fusion": patch
---

summary: Hold-release sweeps stop re-resolving the board's workflow graph once per card.
category: performance
dev: One workflow-IR resolution per distinct workflow per scheduler pass plus a synchronous cache read per card; the hold/release sweep now shares the scheduler's already-warm IR cache (`HoldReleaseDeps.irCache`). Measured witness: 25 workflow-scope reads per sweep for a 24-card board → 3, independent of board size. `hold-release.ts` remains the sole owner of the `hold → wip` crossing.
