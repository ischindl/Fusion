---
"@runfusion/fusion": patch
---

summary: Fix custom workflow columns on PostgreSQL: tasks land in their workflow's intake column and can move out of it.
category: fix
dev: Backend create paths now thread resolvedEntryColumn (workflow manual intake, e.g. Coding (Ideas) "ideas") into task creation and the bootstrap-prompt gate; move validation resolves the task workflow IR via getTaskWorkflowSelectionAsync in backend mode (the sync resolver silently fell back to builtin:coding and rejected every move out of a custom column).
