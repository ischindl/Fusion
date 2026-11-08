---
"@runfusion/fusion": patch
---

summary: Task IDs are minted from the card's own project and stay unique across every project in the database.
category: fix
dev: Adds `central.global_task_id_claim` (migration 0096, keyed on the task id alone) written in the same transaction as every task row, makes the allocator skip numbers a sibling project claimed, reads a bound project's prefix from its own `project.config` instead of merged settings, refuses a create that names another project's destination (`task-id-minting-partition-mismatch`), refuses a foreign project's write of a claimed id (`task-id-claim-owned-by-another-project`), reports pre-existing collisions as the `cross_project_duplicate_id` integrity anomaly, and raises `task-id-ambiguous-across-projects` on a bare id that resolves in several projects. Nothing is renumbered.
