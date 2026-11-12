---
"@runfusion/fusion": patch
---

summary: A truncated plan can no longer replace an accepted spec: the board refuses the write and names the copy to restore.
category: fix
dev: The authoritative `PROMPT.md` write now verifies the landed bytes and refuses a material shrink (prior >= 4096 B, new payload below half) with `PROMPT_SHRINK_REJECTED:`, naming the largest stored `plan` document revision as the recovery source; a mismatching authoritative write restores the previous version only under a re-read fence that never overwrites a newer write. `fn_task_prompt_write` reports it as the typed `PLAN_PROMPT_WRITE_REFUSED` refusal with reason `prompt-shrink-rejected` instead of a store outage, worktree plan writeback reports `recovery-shrunk`, and planning parks `PLANNING_FAILED_SPEC_PROMPT_SHRUNK` instead of blaming operator heading shape. Escape hatch: an intentional slim replacement sets `promptShrinkAuthorized: true` on the task update (the task-update route, the merge-boundary correction, the duplicate-marker body); AI prompt-write surfaces are never authorized.
