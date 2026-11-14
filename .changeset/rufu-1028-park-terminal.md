---
"@runfusion/fusion": patch
---

summary: Execution re-arm ceiling park is now terminal and says so when a reset disturbs it.
category: fix
dev: `claimRearmSlot` reads the durable `sourceMetadata.executionRearmEpisode` park rather than the `status`/`error` columns, so a merge-state reset or a generic overseer retry can no longer restart a spent ladder at attempt 1. New audit mutation `task:execution-rearm-park-marker-cleared` records a cleared park badge (ids/counts/enums only, bounded by the `logEntryOnce` window). `mergeDetails` readers (`cleanupMergeStateForReverification` triggers, the completed-work hand-off in `unpause-resume`/`resume-orphaned`, the review-scoped `task-column-restart`) now ask `mergeDetailsCarriesMergeEvidence` instead of truthiness, so recovery bookkeeping (`pushRecovery`, `mergeBoundaryRecovery`, `executionRearm`) no longer reads as merge evidence. `reconcileReleasedOverlapWaits` gained a fourth candidate source: cards named by a pending `taskOverlapWaits` row with no row-level blocker left (feature-detected, 2 s bound). A passing code-review approval does not lift an exhausted ceiling.
