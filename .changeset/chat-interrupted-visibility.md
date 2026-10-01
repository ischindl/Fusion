---
"@runfusion/fusion": patch
---

summary: Interrupted chat turns now say so and open their Thinking; reply-less turns explain themselves.
category: fix
dev: `metadata.interrupted` rows render a visible notice and auto-expand the thinking disclosure; whitespace-only assistant turns with thinking/tool calls render a "no reply generated" note (locale keys `chat.responseInterrupted`, `chat.noReplyGenerated`).
