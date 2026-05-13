---
"@runfusion/fusion": patch
---

Fix overlap requeue state reconciliation so durable assigned agents are no longer left in `running` state with stale `executionTaskId` links when their task is requeued in Todo. Adds scheduler rollback plus self-healing backstops for stale running/task-column mismatches.
