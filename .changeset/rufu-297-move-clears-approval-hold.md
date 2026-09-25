---
"@runfusion/fusion": minor
---

summary: Dragging an approval-held card out of review no longer strands it; drifted holds self-heal.
category: fix
dev: Pair invariant — an approval hold's gate evidence must survive or the hold goes with it. A user move out of a review lane that wipes `workflowStepResults` clears `awaiting-approval`/`awaitingApprovalReason` atomically (`task:move-cleared-approval-hold`); `human-plan-approval` and `merge-blocked-by-policy` are never cleared. New self-healing sweep `reconcile-orphaned-non-convergence-holds` repairs pre-fix drifted `code-review-non-convergence` holds in place (`task:reconcile-orphaned-non-convergence-hold`).
