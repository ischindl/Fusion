---
"@runfusion/fusion": patch
---

summary: Board sweeps read workflow selections in one batched query instead of one query per task.
category: performance
dev: Self-healing role resolvers (`resolvePreWipColumns`, `resolveReviewColumnsFor`, `resolveActiveWorkColumnsFor`, `resolvePauseAbortColumnsFor`, `filterByPreWipRole`) thread a sweep-scoped `WorkflowSelectionCache` hydrated by `prefetchWorkflowSelections`. Cache lifetime stays per-sweep, so a selection write is observed by the next pass. Ratcheted by `packages/engine/src/__tests__/self-healing-selection-read-shape.test.ts` and `packages/core/src/__tests__/workflow-selection-sweep-cache.test.ts`.
