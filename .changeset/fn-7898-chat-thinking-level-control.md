---
"@runfusion/fusion": minor
---

summary: Change a chat's thinking level mid-conversation from the composer
category: feature
dev: Extends `PATCH /api/chat/sessions/:id` with an optional `thinkingLevel` field (validated via existing `validateThinkingLevel`); adds `useChat().setSessionThinkingLevel` and the new `ChatThinkingLevelControl` component (Brain-icon trigger + popover) wired into `ChatView`'s direct-session composer, gated to non-CLI model-loop sessions only.
