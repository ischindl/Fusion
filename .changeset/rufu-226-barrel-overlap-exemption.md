---
"@runfusion/fusion": patch
---

summary: Shared barrel export files no longer serialize unrelated cards through the scheduler queue.
category: fix
dev: Scheduler overlap matching, BlockedBy stamping, and queue-facing stale-clear repair skip holders whose only overlap is a shared barrel (`*/src/index.ts`, `*/src/index.<gate|graph|server|client|browser>.ts`, `src/index.*.ts`); new `isSharedBarrelOnlyOverlap` export from `@fusion/core` classifies the exemption as a first-class `shared-barrel-export` overlap reason. Merge-time guards (step-session file invariance, shared-branch guard, squash scope partition) keep counting barrels; scopes carrying concrete files serialize on those overlaps as before.
