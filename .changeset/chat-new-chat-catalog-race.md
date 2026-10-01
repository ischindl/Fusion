---
"@runfusion/fusion": patch
---

summary: New Chat no longer claims no default model is configured while the model catalog is still loading.
category: fix
dev: `handleNewChat` performs one forced `refreshModelsCache()` before refusing, and `refreshModelsCache()` now resolves to the state it published (null on failure). A cached catalog carrying no default provider/model pair is treated as a cache miss and dropped on a failed refetch instead of being reused as truth.
