---
"@runfusion/fusion": patch
---

summary: Restore stalled-review badges, timed-execution totals, and fresh-agent-log stall suppression on board listings.
category: fix
dev: Backend listTasks no longer excludes the log column in slim mode (stalledReview and timedExecutionMs derive from it before the log is stripped), and hasFreshAgentLogActivitySinceTaskUpdate is ported into all task-store read hydration paths so streaming merge/review agents suppress Stalled/Merge-stalled badges (mirrors main's FNXC:WorkflowLifecycle 2026-07-01 behavior lost in the PG cutover store split).
