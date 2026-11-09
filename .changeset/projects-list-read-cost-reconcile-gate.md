---
"@runfusion/fusion": patch
---

summary: Stop the project-list read from opening a database write transaction on every poll.
category: performance
dev: `GET /api/projects` and `GET /api/projects/across-nodes` repaired legacy `initializing` project rows with `reconcileProjectStatuses` (a `transactionImmediate` write sweep) on every request. The sweep is now premise-gated: it runs only when the freshly listed project rows name an `initializing` status, and a row still stuck after a sweep is re-repaired at most once per 60 s per process. Responses are byte-identical, including the repaired `status`.
