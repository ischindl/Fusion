---
"@runfusion/fusion": patch
---

summary: Stuck-step recovery (`fn_workflow_step_resume`) now works on cards the engine parked.
category: fix
dev: `TaskStore.resumeWorkflowStep`'s pause gate reuses the shared operator-hold predicate (`isOperatorPausedForOperatorEscapeHatch`, renamed from the RUFU-218 bypass predicate) and refuses only `paused` + `userPaused`; the refusal sentence, in-place semantics, and `task:resume-step` audit event are unchanged.
