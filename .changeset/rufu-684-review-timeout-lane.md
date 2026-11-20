---
"@runfusion/fusion": minor
---

summary: Review steps now get their own timeout budget (default 30 min) instead of sharing the 15-minute step budget.
category: feature
dev: New workflow setting `workflowReviewStepTimeoutMs` (number, minimum 60000) arms Plan Review, Code Review, post-merge verification and review-prefixed custom review steps at the larger of that value and `workflowStepTimeoutMs`, so a board that already raised the shared budget is never shortened; `workflowStepTimeoutMs` now arms only the remaining prompt-mode steps (execution, completion summary). The two-attempt ceiling is unchanged: a timed-out primary still gets exactly one fresh secondary session and a second timeout stays fail-closed. Every expired attempt additionally emits a `task:workflow-step-timeout` run-audit row (lane, step, attempt kind, budget) so the timeout rate stays measurable after task-log retention.
