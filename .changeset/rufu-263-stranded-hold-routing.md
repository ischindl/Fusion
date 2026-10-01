---
"@runfusion/fusion": patch
---

summary: Stranded-card recovery stops re-writing the same recovery line every 15 minutes for waits another seam owns.
category: fix
dev: `reconcileStrandedWorkflowContinuations` now reads each `held` row's `blockedReason`. Principal-routing, named-principal, role-pool and FN-514 human-merge holds are left untouched (their owning seam re-takes them through the same due-gate); a file-scope wait is left alone while the task still names its blocker; `dependency:*` waits are deferred on a durable `retryAfter` ladder (30m → 2h → 6h) and re-queued the moment the dependency clears; unknown reasons still recover on the first pass and are bounded after that. Card-history lines and audit rows are written once per unchanged condition, with a new `workflowWorkItem:reconcile-stranded-no-action` row as the durable trace of a withheld recovery. No migration — the existing `retryAfter` column carries the ladder.
