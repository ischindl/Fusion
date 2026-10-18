---
"@runfusion/fusion": patch
---

summary: A refused move out of Todo now names the real blocker and what happens next, instead of one generic code.
category: fix
dev: `WipAdmissionResult`, `promoteHeldTask` and `releaseHeldTaskByEvent` refusals carry `reason` typed from `UnplannedForExecutionEvaluation`; the wire `rejection`/`code` stays `unplanned-for-execution` and the reason selects the `messageKey`. An explicit release arms pre-release Plan Review through `seedPreReleasePlanReviewContinuation` (or clears a dead planner's stale `planning` claim when it is the sole blocker); no `force`/waiver path was added.
