---
"@runfusion/fusion": minor
---

summary: The chat composer's target selector can now pick a durable agent, not only a model.
category: feature
dev: `ChatThinkingLevelControl` gained an `agents` list section; choosing an agent emits the `useChat.setSessionModel` agent branch (model pair cleared), and "Chat as model" returns to the model lane by omitting `agentId`.
