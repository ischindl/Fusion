---
"@runfusion/fusion": patch
---

summary: The capacity sweep reads workflow lanes for all cards in one query instead of one per card.
category: performance
dev: `enrichedTopLevelAgentTasksFromStore` now fills its caller-owned pass cache with `prefetchWorkflowSelections` before resolving cards, so a sweep costs one batched read instead of one SELECT per card. The pass-cache contract (the next sweep must observe selection writes) is unchanged; stores without a batch read fall back to the previous per-card reads. Measured before: 63,210 `workflowSelection` seam reads in a 5-minute window with zero running cards.
