---
"@runfusion/fusion": patch
---

summary: Engine status banner stops reporting a running project as disconnected and startable.
category: fix
dev: "`GET /api/engine/status` is evidence-based and additive: it adds `engineHandle`, `externallyOwned`, `runningAgentCount` (absent when unknown, never a fabricated 0), `startingSince`, `startingAgeMs`, `startingStage`, `lastStartFailure` and `canResume`, and computes `canStart` instead of always returning true, so `connected:false` + `starting:true` + `canStart:true` is now unrepresentable. Liveness is proven from the engine handle, cross-process singleton ownership, or running lanes in already-open stores only — a status poll never opens a store. A never-settling start is now a bounded, age- and stage-trackable attempt that reconciliation can retry under a capped backoff, and `POST /api/engine/start` refuses a live/starting/externally-owned project with 409. Banner copy added for all 7 locales."
