---
"@runfusion/fusion": patch
---

summary: Retry transient ntfy publish failures so one-shot task notifications are less likely to be lost.
category: fix
dev: Adds bounded ntfy fetch retries for network, timeout, 5xx, and 429 failures with a per-attempt timeout.
