---
"@runfusion/fusion": minor
---

summary: Agents can mark handled inbox messages as read, so answered mail stops re-waking the heartbeat every tick.
category: feature
dev: Adds the agent-facing `fn_ack_messages` tool (recipient-scoped id list, no bulk flag) and makes a reply sent with `reply_to_message_id` acknowledge its parent message. `read` stays the single consumption flag; `fn_read_messages` remains read-only so a failed tick still re-delivers unanswered mail.
