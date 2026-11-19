---
"@runfusion/fusion": minor
---

summary: A project whose review lane has no enabled reviewer is now recorded as a queryable event.
category: feature
dev: Emits `task:review-dispatch-declined` (ids/counts only: `reasonCode`, `enabledReviewerCount`, `waitingCount`, `candidateTaskIds` capped at 20) with `target` = project id and `task_id` NULL, deduped per project episode with a recovery re-arm. Previously the E4 decline was a cooldown-limited `log.warn` only, so "which projects can nobody review?" was unanswerable after log rotation. Written through the awaited `emitBoundedRunAuditWithOutcome` lane so the row is durable when the tick returns (the void lane's accepted emit is only queued since RUFU-453). Deliberately outside the curated delivery-pipeline catalogue — documented as prose in `docs/run-audit.md`, which `run-audit-catalogue.test.ts` locks table-for-table. Repair stays an operator action in Agents.
