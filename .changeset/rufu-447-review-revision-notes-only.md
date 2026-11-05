---
"@runfusion/fusion": patch
---

summary: A card whose review asked for changes in prose is no longer failed out; the stall park returns after a 6-hour grace.
category: fix
dev: `isAwaitingReviewRevision`'s second clause now accepts any pending step instead of only a step carrying `step.remediation` provenance, bounded by `REVIEW_REVISION_PARK_DEFER_HORIZON_MS` (6h, measured off the authored `REVISE` row and exported from both `@fusion/core` barrels). Past the horizon the card falls back to `merge-blocker` and the alertable park path resumes. The `awaiting-review-revision` stall sentence changed wording; it is catalog-owned in all seven locales.
