---
"@runfusion/fusion": minor
---

summary: Edit a chat message and resume the conversation from that point.
category: feature
dev: Adds ChatStore.deleteMessagesFrom + PATCH /api/chat/sessions/:id/messages/:messageId; rewinds the pi SessionManager (createBranchedSession) so the model forgets discarded turns. Direct model-loop chats only.
