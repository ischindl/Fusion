---
"@runfusion/fusion": patch
---

summary: Board reads workflow lanes far less often, removing a 288-reads-per-second store hot path.
category: performance
dev: The resolver's no-cache selection read is now bounded by a TTL+epoch memo (`FUSION_WORKFLOW_SELECTION_MEMO_MS`, default 500 ms, `0` restores live-per-call). Measured before the change: 86,307 `workflowSelection` seam reads in one 5-minute window with zero running cards. An in-process selection write drops an entry immediately via `workflowSelectionEpoch()`; the TTL is the bound on a write made by another process, which is why the epoch counter alone was not enough. `readSelectionWithCoalescing` keeps its coalescer and concurrency bound unchanged.
