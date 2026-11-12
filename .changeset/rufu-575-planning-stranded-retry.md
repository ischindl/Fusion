---
"@runfusion/fusion": patch
---

summary: Retry now revives a card whose planning run timed out, keeping its plan, lane, steps and worktree.
category: fix
dev: One shared core leaf (`classifyPlanningStrandedRetry` / `buildPlanningStrandedRetryPatch` in `packages/core/src/tasks/planning-stranded-retry.ts`) decides admission for the CLI, the pi extension, the chat tool and the board route, from the row and its lane only - never from `PROMPT.md`. A planning-exhausted row also stops reading as "progressing", so the stuck-card alert names it and tells you to Retry. The reseed diagnostic `recoveryDisposition` now separates its authors (`escalated-reseed` = planning lane, new `escalated-execution-reseed` = execution lane), so a card merely queued for a slot is neither alerted on nor re-planned.
