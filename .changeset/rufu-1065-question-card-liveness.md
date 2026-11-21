---
"@runfusion/fusion": patch
---

summary: Questions the assistant asks in Chat stay answerable until you actually reply, instead of locking over at once.
category: fix
dev: Question-card liveness is now a transcript fact. `isLiveQuestionAwaitingAnswer` takes `holdsAwaitingQuestion` instead of `isSessionGenerating` and `isPlannerQuestionAwaitingAnswer` takes it instead of `isSending`; both derive it from the new `holdsAwaitingQuestionToolCall` in `app/utils/parseQuestionToolCall.ts`, which mirrors the server-side `isAwaitingQuestionToolCall` behind `findAwaitingQuestionMessageId`. No server or store change: a card is actionable exactly while a reply would still be stamped with `metadata.questionAnswer`, and an `interrupted` row stays a record.
