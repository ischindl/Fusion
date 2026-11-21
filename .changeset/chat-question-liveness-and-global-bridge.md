---
"@runfusion/fusion": patch
---

summary: Question cards stop looking actionable when their turn dies; global chat views now receive every project's chat events.
category: fix
dev: `chat:*` SSE connections without a `projectId` bridge every live scoped ChatStore (previously only the default store, so global chat views were deaf to scoped generations). Awaiting-question predicates in ChatView and Task Planner Chat share one liveness gate exported from `utils/parseQuestionToolCall`: the last row, not streaming, not interrupted, and itself holding an unanswered question tool call. That content proof replaced the earlier "last row + live generation / sending turn" gate in RUFU-1065, because nothing holds an in-flight generation for a turn that ended by asking a question, and it is the same decision the server makes before stamping `metadata.questionAnswer`.
