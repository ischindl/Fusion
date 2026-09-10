---
"@runfusion/fusion": minor
---

summary: Continue a long Direct chat in a fresh session with one click once context usage passes a threshold (default 75%).
category: feature
dev: New project settings `chatHandoffEnabled` / `chatHandoffThresholdPercent`; `POST /api/chat/sessions/:id/handoff` archives the source (transcript kept) and creates a sibling session with the same agent/model/thinkingLevel, seeded with a one-time handoff-briefing primer message. Audit markers `chat:handoff-session-created` / `chat:handoff-session-failed`.
