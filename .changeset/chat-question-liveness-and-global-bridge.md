---
"@runfusion/fusion": patch
---

summary: Question cards stop looking actionable when their turn dies; global chat views now receive every project's chat events.
category: fix
dev: `chat:*` SSE connections without a `projectId` bridge every live scoped ChatStore (previously only the default store, so global chat views were deaf to scoped generations). Awaiting-question predicates in ChatView and Task Planner Chat share liveness gates (last row + live generation / sending turn + non-interrupted) exported from `utils/parseQuestionToolCall`.
