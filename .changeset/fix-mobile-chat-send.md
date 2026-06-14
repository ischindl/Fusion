---
"@fusion/dashboard": patch
---

Fix two mobile chat send failures. The regular chat send button was dead to touch because the action only ran on `onClick`, which iOS suppresses after `preventDefault()` in the touch sequence — it now fires from pointerdown/touchstart with a dedupe latch. Quick chat messages could strand in the composer (shown locally but never sent to the agent or persisted) when a dropped stream left the streaming flag stuck `true`; a queued send now detects the stale flag via the stream's connection state and the server's generation status, then recovers and flushes.
