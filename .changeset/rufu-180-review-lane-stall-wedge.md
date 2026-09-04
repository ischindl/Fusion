---
"@runfusion/fusion": patch
---

summary: Cards stuck in the review lane now announce the blocker once instead of staying silently on the board.
category: feature
dev: Wedge descriptors compose from the hydrated `stallReason` authority under `stall:<code>` reasonKeys (merge-blocker, pre-merge-gate-pending, held-human-review) behind the legacy failed-card classifier. New self-healing sweep registers as `reconcile-review-stall-notification` (startup + maintenance batches) and emits the same-named run-audit event with ids/counts/outcomes-only metadata.
