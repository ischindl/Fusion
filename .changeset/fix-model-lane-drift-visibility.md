---
"@runfusion/fusion": patch
---

summary: Warn when changing a workflow's model surfaces tasks still pinned to the old model, including default-workflow tasks.
category: fix
dev: PATCH /workflows/:id/setting-values now returns `modelDrift` for execution/planning/validator lanes. Drift baseline is captured inside the settings write transaction (no stale-read race), and default-workflow patches pass `includeNullSelection` so no-workflow-selection tasks are counted. New `TaskStore.updateWorkflowSettingValuesWithPrevious` and `getModelLaneDrift(..., { includeNullSelection })`.
