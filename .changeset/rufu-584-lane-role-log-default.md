---
"@runfusion/fusion": patch
---

summary: Engine board reads stop loading task history text they never use, easing dashboard memory pressure.
category: performance
dev: `listTasksInLaneRoles` now excludes the `log` column unless a caller passes `includeLog: true`; the projection that RUFU-756 made opt-in is the default, and no consumer opts back in.
