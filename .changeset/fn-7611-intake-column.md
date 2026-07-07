---
"@runfusion/fusion": patch
---

summary: New tasks now land in the selected workflow's intake column instead of always jumping to Planning/triage.
category: fix
dev: Removed hardcoded `column: "triage"` overrides in `fn_task_create` (engine `createTaskCreateTool` and pi extension) and in signal/GitHub-import/planning create surfaces that had no `workflowId` or (for planning subtask routes) accepted one but still forced `column`. `TaskStore.createTask` already resolves `input.column || resolvedEntryColumn || "triage"`; callers no longer defeat that resolution. A custom workflow's non-triage `intake`-trait column (e.g. `Inbox`) now correctly captures new cards inert until released, while the default builtin:coding workflow still lands cards in `triage` byte-identically. The pi-extension `fn_task_create` response text now echoes the actual landing column instead of a fixed `"Column: triage"` string.
