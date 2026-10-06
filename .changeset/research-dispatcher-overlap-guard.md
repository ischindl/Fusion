---
"@runfusion/fusion": patch
---

summary: Fixed research polling stacking database reads until the dashboard ran out of memory.
category: fix
dev: `ResearchRunDispatcher.tick()` now skips an interval while the previous pass is still awaiting the store. A live heap snapshot held 1 125 suspended `listResearchRuns` frames from stacked 1-second polls.
