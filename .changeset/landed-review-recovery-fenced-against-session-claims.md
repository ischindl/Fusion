---
"@runfusion/fusion": patch
---

summary: Landed-review recovery now refuses to reclaim a card a live session still claims, instead of racing it.
category: fix
dev: Upstream FN-9402's fence is threaded through our checkout-lease and `isTaskExecutionLive` guards; `TaskAtomicPersistFence` is re-exported from `@fusion/core` for callers that pass a persist fence.
