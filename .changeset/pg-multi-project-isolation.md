---
"@runfusion/fusion": minor
---

summary: Isolate projects sharing the embedded PostgreSQL cluster — tasks, config, and archived tasks are scoped per project.
category: feature
dev: PR #2007 (Approach A) — project_id partition key on project.tasks/project.archived_tasks/archive.archived_tasks with taskProjectScope threaded through every scan/claim/count; per-project config rows; startup factory binds the AsyncDataLayer to options.projectId; drift self-heal generalized to schema-qualified entries; archived-board reads scoped (review P1 fix).
