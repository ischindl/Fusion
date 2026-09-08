---
"@runfusion/fusion": patch
---

summary: A shell command that writes files is now governed by file_write_delete on both gates.
category: fix
dev: A bash call could only ever classify as git_write or command_execution, so `command_execution: allow` plus `file_write_delete: require-approval` did not do what it reads as: a redirection rewrote a tracked file with no approval request. One shared helper, escalateShellCategoryForFileWrite in gating-classifications.ts, is now used by both evaluateAgentActionGate and resolvePermanentAgentToolDecision, as that module's two-path-drift rule requires. The escalation is comparative and one-directional, so it can only make a call more gated and every policy where file_write_delete is not stricter is unaffected. detectsShellFileWrite is documented in source as best effort, not a sandbox. When the escalation fires, `operation` becomes "shell file write" so an operator is not asked to approve a file write under the label of the git read inside it.
