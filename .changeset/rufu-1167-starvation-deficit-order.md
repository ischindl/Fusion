---
"@runfusion/fusion": patch
---

summary: Release sweep reaches the cards it skipped most often first, so repair fixes stop queueing behind their own lane.
category: fix
dev: `orderTasksForReleaseEvaluation` orders the armed partition by its own persisted `holdReleaseStarvation.stallCount` (deficit desc, queue order as the tie-break) instead of arrival alone. Self-draining: `clearHoldReleaseStarvationBadges` still clears the episode off every card a pass evaluated, so an evaluated card leaves the deficit ordering on the next pass. No new priority level, no extra reads, no migration.
