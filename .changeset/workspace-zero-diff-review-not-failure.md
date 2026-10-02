---
"@runfusion/fusion": patch
---

summary: Zero-diff workspace cards stop being recorded as failed reviews and parked by the stall classifier.
category: fix
dev: `reviewWorkspacePerRepo` now consults `classifyWorkspaceZeroAcquire` before recording "No changes — not reviewed", passing the per-repository observation it already captured (`ahead === false` with zero changed files). A workspace whose task declared itself commit-free, whose every declared repository was acquired, and whose every repository is proven at its merge-base now aggregates to APPROVE with honest per-repository `NOT_REVIEWED` records and no invented fingerprint. The declaration plus the probe are both required, so an unprobed tree, a partially acquired scope, or an undeclared task keeps the existing operator-visible refusal. No core type was widened: `WorkflowRepositoryReviewOutcome.status` is unchanged, and `evaluatePreMergeApprovals` only cross-compares repositories carrying modified content.
