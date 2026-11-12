---
"@runfusion/fusion": patch
---

summary: A throttled planning card is no longer killed as stuck and parked forever; Retry now releases that park.
category: fix
dev: New exported constant `STUCK_LOOP_EXHAUSTED_PAUSE_REASON` from `@fusion/core`; the stuck-kill requeue classifies an unplanned `PROMPT.md` seed through `isUnplannedSeedPrompt` (so it cold-retries a fresh plan instead of claiming to resume a draft), arms an in-process re-admission cooldown so the killed card cannot immediately retake its planning slot, and `buildAutoPauseClearPatch` now lifts the stuck-loop park for engine pauses, so operator Retry unpauses the card, zeroes `stuckKillCount`, and re-seeds planning. Explicit operator pauses are never lifted.
