---
"@runfusion/fusion": patch
---

summary: A card waiting at the head of the planning queue now says why it is waiting instead of staying silent.
category: fix
dev: Planning-continuation admission returns the `PlanningContinuationAdmission` union instead of a boolean, so each arm owns a deferral bound through one table (`planningAdmissionDeferralMs`) and no examined row can leave a drain pass due and unleased; only a shared-capacity refusal latches the rest of the window; one throwing row is bounded and skipped instead of aborting the pass. A pass that examined rows and dispatched none emits one `task:planning-window-outcome` (ids/counts/fixed buckets) at most once per 15-minute floor for the whole stalled class — never keyed on the window head, which the pass itself rotates — and attributes that row to the head card so retention can collect it; it also writes one History line per card and reason, dispatched detached and flushed once per pass so a slow store cannot delay the rows behind it. The dispatch queue order itself is unchanged: `listDueWorkflowWorkItems` already applied `taskQueueOrderBy()` before its `LIMIT`, and `planning-dispatch-queue-order-ratchet.test.ts` is a keep-this-true ratchet on that fact.
