---
"@runfusion/fusion": minor
---

summary: Cards waiting on a release pass now say so on the card, instead of promising a run that keeps not happening.
category: feature
dev: New stall code `release-sweep-budget-starved` from `sourceMetadata.holdReleaseStarvation`; sweep summary gains `armed-first=`/`starved-armed=`/`oldest-deferred=`; audit event `task:hold-release-starved`. The per-pass wall-clock budget (`SWEEP_BUDGET_MS`, 10 s) is unchanged — the only new number is `MAX_ARMED_PRIORITY_IDS` (200), the size of the armed front partition, not a per-pass evaluation count. New read: `TaskStore.listActiveTaskContinuationTaskIds`.
