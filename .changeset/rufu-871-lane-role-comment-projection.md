---
"@runfusion/fusion": patch
---

summary: The engine's most frequent whole-board read no longer loads card comment and steering bodies.
category: performance
dev: `listTasksInLaneRoles` now declares its read-set (`workflowStepResults`, `source`, `steps`, `description`, `summary`, `attachments`) instead of taking the undeclared full row, which leaves the `comments` + `steeringComments` pair out of the SELECT. Measured reason: after the `log` column was dropped from this read, the retained mass moved to the comment pair — a production retainer walk counted 5,821 `comments` and 5,810 `steeringComments` properties on ~5.8k hydrated task rows versus 89 `log` edges, with `string` nodes at 84.6% of the heap. A consumer that genuinely reads comments passes `includeComments: true`; no call site does today and that is pinned by `lane-role-read-comment-projection.test.ts`.
