---
"@runfusion/fusion": patch
---

summary: Planner oversight no longer re-posts the same steering guidance to a card every tick.
category: fix
dev: `PlannerRecoveryController.dispatch` suppresses an identical `decision.reason` for the same (taskId, watchedStage) inside a 30-minute window and counts it (`getSuppressedGuidanceCount()`); the window is measured from the last successful post, so a failed post does not silence a card. The FN-7577 healthy-signal budget reset is unchanged because the overseer badge derives from `attemptCount`.
