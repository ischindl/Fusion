---
"@runfusion/fusion": patch
---

summary: Planner oversight polling no longer loads each card's full log text on every sweep.
category: performance
dev: `listTasksInLaneRoles` gained an opt-in `excludeLog` and the `pollPlannerOverseer` sweep (45s cadence, one engine per project) passes it. The log-bearing default is unchanged for every other consumer, because the merge-buffer lane-role consumer pattern-matches log content. Guarded by `lane-role-read-log-projection.test.ts`, which enumerates the allowed narrowing call sites.
