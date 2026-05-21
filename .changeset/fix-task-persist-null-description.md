---
"@runfusion/fusion": patch
---

Coerce `task.description` to an empty string when persisting in `TaskStore.getTaskPersistValues`. The `description` column is `NOT NULL`, so a task with a missing description previously failed insertion with a constraint error. Defaulting to `""` mirrors the existing `?? null` / `?? 0` treatment of other optional fields.
