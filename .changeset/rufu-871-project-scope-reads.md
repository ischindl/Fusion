---
"@runfusion/fusion": patch
---

summary: Task list reads now only ever load the bound project's cards, not every project's.
category: fix
dev: Store list reads over the shared `project.tasks` table fold in the store's bound `project_id` (stranded refinements, the WIP/capacity candidate scan and its `task_workflow_selection` join, the `transitionPending` recovery scan and its marker reads/writes). An unbound, project-agnostic layer still reads across projects by design; a source ratchet now fails a new unscoped task-table list read unless it registers a reason.
