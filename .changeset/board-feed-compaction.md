---
"@runfusion/fusion": patch
---

summary: Board lanes ship lighter payloads, cutting the Done column's initial fetch by roughly 60%.
category: performance
dev: `GET /tasks/page` now drops `output`/`notes`/`findings`/`priorAttempts` from `workflowStepResults` and the unused `summary` field after server-side derivations; full bodies remain available via `GET /tasks/:id` and `/tasks/:id/workflow-results`.
