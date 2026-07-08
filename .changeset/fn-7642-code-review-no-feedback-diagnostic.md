---
"@runfusion/fusion": patch
---

summary: Code Review/Plan Review/CE gate failures now record a diagnostic instead of "(no feedback captured)".
category: fix
dev: When an enabled optional-group (`code-review`, `plan-review`, `browser-verification`) or CE `source:"node"` skill-gate template node fails via a dispatch/infra exception rather than a reviewer verdict, `WorkflowGraphExecutor` now synthesizes a non-blank `WorkflowStepResult.output` from the underlying `node:<id>:error` context-patch key (falling back to the failure `value`, then a stable sentinel) instead of leaving `output`/`notes` field-absent. Fixes Runfusion/Fusion#1946. `status`, verdict extraction, edge routing, and self-healing's `latestFailedPreMergeStep` selection are unchanged.
