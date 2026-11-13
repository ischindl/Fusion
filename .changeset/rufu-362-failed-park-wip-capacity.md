---
"@runfusion/fusion": patch
---

summary: Failed tasks no longer hold a WIP lane slot, so ready cards stop being refused capacity behind dead ones.
category: fix
dev: Column WIP occupancy is now decided by one shared core predicate, `isFailedWipPark`, consumed by both in-transaction counters, the hold/release sweep's mirror and the dashboard workflow-switcher counts. A `status:"failed"` row still renders in its lane but occupies no slot. The exclusion sits ahead of both count arms, so a failed row holds no slot either as a column occupant or through a `transitionPending` reservation aimed at the column; a `transitionPending` marker counts only on a live (non-failed) row. Exported from both `@fusion/core` barrels (`index.ts` and the merge-gate barrel).
