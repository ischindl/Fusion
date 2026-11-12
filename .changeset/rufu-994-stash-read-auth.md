---
"@runfusion/fusion": patch
---

summary: Stash project memory is now readable, and a refused recall reports why.
category: fix
dev: Memory read paths resolve the global stash-api-key secret like capture does; refusals emit the memory:stash-read-refused audit code and the last outcome on GET /api/memory/backend.
