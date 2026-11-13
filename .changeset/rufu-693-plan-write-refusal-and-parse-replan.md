---
"@runfusion/fusion": minor
---

summary: A plan with no executable step is now sent back for a rewrite instead of dying as a failed card.
category: feature
dev: `fn_task_prompt_write` refuses a stepless plan with `refusal: "missing-implementation-steps"` (counts only, never plan text), ranked after the reset fence and the store's own shrink guard. In the graph, a `missing-implementation-steps` parse refusal now parks the card `needs-replan` in place with recovery counters cleared -- the same feedback path as an invalid step-dependency refusal -- instead of terminalizing it, and no new backward-move reason or F5 widening was added.
