---
"@runfusion/fusion": patch
---

summary: A board lane whose tasks failed to load now shows an error with Retry instead of "No tasks".
category: fix
dev: `Column`/`ListView` render a `role="alert"` load-failure state instead of the empty placeholder when the lane read rejected, and a failed board refresh now auto-retries on the shared bounded `resyncRetry` ladder (2 s, then 8 s) instead of waiting for a manual reload.
