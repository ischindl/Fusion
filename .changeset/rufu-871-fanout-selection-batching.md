---
"@runfusion/fusion": patch
---

summary: The scheduler's board-wide fanout sweep reads workflow lanes in one query instead of one per card.
category: performance
dev: `emitHighOverlapFanoutWarnings` now fills its per-sweep selection cache with `prefetchWorkflowSelections` (the same call the scheduling pass already made), so a sweep costs one batched read instead of one SELECT per unarchived card. Sweep lifetime is unchanged — the cache still dies with the sweep, so a selection written between sweeps is observed by the next. Ratchet: `scheduler-workflow-selection-read-once-per-tick.test.ts` asserts one batch and zero per-card reads for a 12-card board.
