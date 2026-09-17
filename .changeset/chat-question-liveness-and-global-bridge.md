---
"@runfusion/fusion": patch
---

summary: Question cards now stay actionable only while the asking turn is still alive; a dead or interrupted question renders as a record instead of a stuck input, and globally-opened chat views receive all projects' chat events.
category: fix
dev: `chat:*` SSE connections without a `projectId` bridge every live scoped ChatStore (previously only the default store, so global chat views were deaf to scoped generations). Awaiting-question predicates in ChatView and Task Planner Chat share liveness gates (last row + live generation / sending turn + non-interrupted) exported from `utils/parseQuestionToolCall`.
