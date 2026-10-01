---
"@runfusion/fusion": patch
---

summary: A planner session that cannot update a REVISEd plan now spends a replan turn and stops looping.
category: fix
dev: Failed planner sessions inside a live Plan Review `REVISE` episode append a `Workflow revision key: plan-review` task-log marker, so they share the graph's existing Plan Review replan ceiling instead of the unbounded filesystem-recovery rebound; exhaustion parks on the existing `plan-review-replan-cap` operator surface. The scheduler's spec-staleness rebound now shares the planning recovery budget and parks with `SPEC_STALENESS_RECOVERY_EXHAUSTED:`. New run-audit event `task:plan-replan-session-failure-budget` records ids/counts/fixed outcomes only.
