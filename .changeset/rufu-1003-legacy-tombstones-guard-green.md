---
"@runfusion/fusion": patch
---

summary: Make the deleted-cutover-machinery guard truthful again and run it in the merge gate.
category: internal
dev: Removes `packages/engine/src/workflows/overlap-plan-revalidation.ts`, which FN-375 retired and af234684e3 re-added off a stale base; overlap-wait episodes stay owned by `synchronizeOverlapWaitBeforeExecution` at worktree acquisition / implementation entry, and the waiter wake stays owned by `releaseFileScopeWaitingContinuations`. `src/__tests__/legacy-tombstones.test.ts` joins the `engine-core` merge-gate allow-list, so re-introducing tombstoned machinery now fails the PR instead of quietly reddening a check nobody reads.
