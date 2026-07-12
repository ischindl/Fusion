---
"@runfusion/fusion": patch
---

summary: Agent chat exposes the same tools on desktop and browser; messaging tools no longer silently drop.
category: fix
dev: Project-scoped chat (getOrCreateScopedChatManager/resolveScopedChatManager) now wires and refreshes the engine MessageStore, mirroring setPluginRunner, so fn_send_message/fn_read_messages survive lazy engine boot; a reduced-tool-schema condition now emits a diagnostic/agent-visible signal instead of failing silently per call (FN-7854).
