---
"@runfusion/fusion": patch
---

summary: One recovery path re-runs a landed card's missing post-merge gate, with a bounded budget and a named refusal reason.
category: fix
dev: Upstream's `resumeMissingPostMergeGate` (FN-9442) is now the only post-merge resume; `reseedUnrunPostMergeGate` (RUFU-306) is deleted. Refusals carry a fixed reason code, the seed budget is 3 per card+gate read from the durable task log, and the per-project evidence contract (RUFU-430) is threaded through the new decision/blocker seam, so boards without a CI reporter are never asked for CI artifacts.
