---
"@runfusion/fusion": patch
---

summary: Projects list now reports the real runtime state from saved settings instead of guessing per project.
category: fix
dev: `GET /api/projects` and `/api/projects/across-nodes` resolve `runtimeEnabled`/`runtimeState` from `project.config.settings` in ONE batched central read (`CentralCore.getProjectRuntimeEnabledFlags` -> `readProjectRuntimeEnabledFlags`) instead of opening a TaskStore per project, which wrote `store:open` provenance from a read route and reported 14 of 25 projects as `runtimeState: "unknown"`. The per-store read remains only as the fallback when the central read cannot answer.
