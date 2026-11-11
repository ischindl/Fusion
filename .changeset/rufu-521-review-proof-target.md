---
"@runfusion/fusion": patch
---

summary: Review content proof now measures the task branch, so a drifted checkout can't fake an empty review.
category: fix
dev: Singular review-input fingerprints target `task.branch` with a base proven against that tip (recorded `baseCommitSha` only when it is an ancestor of the tip). `empty-review-input:v1` is emitted only when the branch and HEAD legs both report no content; an unresolvable branch refuses as `branch-ref-unresolvable` instead. Fingerprints for cards whose HEAD already equals the branch tip are unchanged, so stored approvals stay valid.
