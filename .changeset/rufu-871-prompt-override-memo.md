---
"@runfusion/fusion": patch
---

summary: Cut repeated workflow-prompt database reads on board loads, so dashboards and schedulers issue far fewer queries.
category: performance
dev: Resolves built-in workflow IRs from a TTL+epoch memo over the async prompt-override read (same
  `FUSION_WORKFLOW_SELECTION_MEMO_MS` knob; `0` disables both memos). `updateWorkflowPromptOverrides`
  now bumps `workflowDefinitionEpoch()`, so epoch-guarded IR caches stop serving a pre-edit prompt text.
  Hit/miss/stale-epoch counters publish as `prompt_override_memo_*` retention sources on `/metrics`.
