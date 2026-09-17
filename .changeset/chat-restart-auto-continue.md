---
"@runfusion/fusion": minor
---

summary: A chat turn orphaned by a server restart is now continued automatically once, as a visible system auto-retry row.
category: feature
dev: The stale in-flight sweep reports each materialized session to a dashboard-injected handler that re-checks the transcript tail and sends the continuation through the normal send path (`userMessageMetadata.reason = "restart-recovery"`). Manual continues and live generations are skipped.
