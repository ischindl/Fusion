---
"@runfusion/fusion": minor
---

summary: Unload a project's engine runtime from the Projects menu while its board stays readable.
category: feature
dev: New persisted project setting `runtimeEnabled` (absent = true). `false` disarms every periodic engine lane for that project — scheduler pass, triage poll, self-healing maintenance, heartbeat dispatch, planner-overseer poll, workflow-continuation pump, cron and maintenance sweeps — so the project issues no engine database reads and arms no timers; already-running passes are never aborted. Dashboard read routes keep serving the project's board, cards, and history. `globalPause` / `enginePaused` semantics are unchanged. Toggle surface: `POST /api/projects/:id/runtime` and the Engine control menu; each operator switch records one `project:runtime-toggled` run-audit row.
