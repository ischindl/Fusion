---
"@runfusion/fusion": patch
---

Improve workflow-step scope gating for pre-merge checks. The built-in Frontend UX Design workflow step now auto-skips using both diff scope and declared `## File Scope` signals, reducing off-domain runs. Prompt-mode pre-merge workflow steps now perform end-of-step file-scope enforcement with a new `workflowStepScopeEnforcement` project setting (`block` default, `warn`, `off`) and honor task `scopeOverride` bypasses.
