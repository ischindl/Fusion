---
"@runfusion/fusion": patch
---

summary: Self-healing stops treating cards with an in-flight merge as unowned.
category: fix
dev: `TaskStore.peekMergeQueue()` ordered by the Boost/arrival expression built from `project.tasks` while selecting only `merge_queue`, so PostgreSQL rejected it (`missing FROM-clause entry for table "tasks"`) and every call threw since the Boost ordering landed. Its caller answered from the catch, so merge-lane ownership read as false for every card. Pinned by `merge-queue-peek-order.pg.test.ts`.
