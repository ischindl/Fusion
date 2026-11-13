---
"@runfusion/fusion": minor
---

summary: A plan with no executable step is now sent back for a rewrite instead of dying as a failed card.
category: feature
dev: `fn_task_prompt_write` refuses a stepless plan with `refusal: "missing-implementation-steps"` (counts only, never plan text), ranked after the reset fence and the store's own shrink guard. In the graph, a `missing-implementation-steps` parse refusal registers `parse-missing-implementation-steps` as a `wip -> hold` reason and returns the card to its workflow's planning lane as `needs-replan` via `moveTaskToReplanColumn`; `failed` is never written, and a move that cannot happen holds the card in place rather than inventing a column.
