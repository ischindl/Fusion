---
"@runfusion/fusion": patch
---

summary: The review dispatch sweep resolves each workflow once per pass instead of once per card.
category: performance
dev: `findReviewLaneCandidates` ticks every 15 s and walked every card, resolving that card's workflow selection and workflow IR individually. It now prefills the selection cache with one `getTaskWorkflowSelectionsAsync` batch read (the pattern the scheduler already uses) and passes a per-pass `irCache`, so both reads scale with distinct workflows rather than with board size. The read-attribution sampler named this sweep as the dominant producer of workflow-selection reads in a 5-minute window (`361/6581`, `252/5280`). Absent workflow definitions stay retryable — that invariant is pinned by `workflow-ir-resolver-coalescing.test.ts` and this change does not touch it. Covered by `review-sweep-resolution-reuse.test.ts`, which asserts read counts and fails without the change.
