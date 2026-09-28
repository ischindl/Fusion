---
"@runfusion/fusion": minor
---

summary: A review escalated to a human now sends an operator notice instead of staying silent.
category: fix
dev: The review-stall sweep reports `stallAgeMs` from durable lane-entry evidence (`columnMovedAt`, then `updatedAt`) instead of the re-stamped `stallReason.observedAt`, and when `NotificationService` returns `unavailable` for a card the review-convergence protocol escalated (`reviewConvergenceStage >= 3` with a non-zero escalation count) it writes one idempotent mailbox notice per 6 h window plus `task:review-convergence-escalation-notice`. Non-escalated stalls keep the existing wedge-episode path unchanged; `notice` is recorded in the sweep's audit row so a declined delivery stays distinguishable from a suppression.
