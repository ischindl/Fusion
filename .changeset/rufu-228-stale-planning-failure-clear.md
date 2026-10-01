---
"@runfusion/fusion": patch
---

summary: A card that recovers from a planning failure no longer keeps its stale red error band.
category: fix
dev: The forward planning-to-WIP lane crossing now clears a stale terminal `status`/`error`, mirroring the existing reopen and Done clears.
