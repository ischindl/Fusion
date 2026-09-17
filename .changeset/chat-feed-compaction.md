---
"@runfusion/fusion": patch
---

summary: Chat threads open faster — history tool calls ship previews; full bodies load when expanded.
category: performance
dev: `GET /chat/sessions/:id/messages` now compacts `metadata.toolCalls` to identity/status/preview (question tools keep full args); expanding a disclosure fetches one message's full bodies via the new `GET /chat/sessions/:id/messages/:messageId`. Opt out of compaction with `?full=1`.
