---
"@runfusion/fusion": patch
---

summary: Chat turns orphaned by a dashboard restart now surface as "interrupted" with Retry, not silence.
category: fix
dev: The stale in-flight-generation sweep materializes an `interrupted` assistant row from the durable checkpoint payload (streamed text/thinking/completed tool calls) before clearing the flag; evidence-free payloads keep the previous plain clear. Audit gains count-only `materializedCount`.
