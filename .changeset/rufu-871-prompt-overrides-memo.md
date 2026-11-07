---
"@runfusion/fusion": patch
---

summary: Board and engine lanes stop re-reading per-card workflow prompt text; caches now notice prompt edits.
category: performance
dev: Resolves the second-hottest read behind `task_workflow_selection` (69 of ~500 DB statements/s sampled in one `/api/tasks/page`). `resolveWorkflowIrById` memoizes the async prompt-override read per (workflow, project) under the SAME `FUSION_WORKFLOW_SELECTION_MEMO_MS` TTL plus `workflowDefinitionEpoch()` — no second TTL. `updateWorkflowPromptOverrides` now bumps that epoch, which also fixes a stale-IR bug: `EpochedWorkflowIrCache` keys override-applied built-in IRs by `workflowId\0projectId` and was only invalidated on definition create/update/delete, so editing a prompt override left long-lived sweep caches serving the previous text. New rates: `prompt_override_memo_hits` / `_misses` / `_stale_epoch`.
