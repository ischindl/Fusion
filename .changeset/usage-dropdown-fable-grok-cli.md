---
"@runfusion/fusion": minor
---

summary: Usage dropdown now shows the Claude Fable weekly window and Grok CLI subscription credit usage.
category: feature
dev: Claude per-model weekly usage is parsed generically from the OAuth payload's `limits[]` scoped entries (the `seven_day_fable` key guess was disproven by a live probe); Grok prefers `~/.grok/auth.json` OIDC credentials against `cli-chat-proxy.grok.com/v1/billing?format=credits`, falling back to the xAI API-key validity card.
