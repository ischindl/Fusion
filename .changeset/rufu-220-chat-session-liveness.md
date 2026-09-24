---
"@runfusion/fusion": minor
---

summary: Chat conversation rows now show whether a reply is still Generating or Stale — waiting for reclaim.
category: feature
dev: The reclaim floor and the in-flight age-reference chain moved to `@fusion/core/chat-liveness` (`classifyChatInFlightLiveness`), which the engine's stale-in-flight sweep now delegates to, so the sidebar label and the reclaim decision share one rule. New registered keys `chat.generating`, `chat.generationStale`, `chat.generationLivenessTitle`.
