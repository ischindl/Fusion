---
"@runfusion/fusion": patch
---

summary: Unloaded projects can no longer be reported as loaded when their settings cannot be read.
category: fix
dev: `GET /api/projects` and `/api/projects/across-nodes` now emit `runtimeState: "enabled" | "disabled" | "unknown"` alongside `runtimeEnabled`, and `runtimeEnabled` is true only when the value was positively read. Previously an unreadable per-project store fell through to `runtimeEnabled: true`; measured in production two projects with persisted `runtimeEnabled=false` answered `true`. Absent settings still mean enabled, matching `isProjectRuntimeEnabled`.
