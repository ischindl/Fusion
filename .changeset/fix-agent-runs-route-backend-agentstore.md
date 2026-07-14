---
"@runfusion/fusion": patch
---

summary: Fix manual agent-run creation failing on PostgreSQL when a heartbeat executor is attached.
category: fix
dev: POST /api/agents/:id/runs built its AgentStore without the scoped store's AsyncDataLayer on the heartbeat-executor branch, hitting the removed SQLite runtime in backend mode; it now borrows the layer like the record-only branch.
