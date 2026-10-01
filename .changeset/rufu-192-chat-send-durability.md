---
"@runfusion/fusion": patch
---

summary: A chat send no longer destroys your typed prompt; the text survives until the server stores it.
category: fix
dev: The chat stream now acknowledges the stored user turn (`user_persisted`); ChatView clears the composer and draft only at that acknowledgement or at the pending-queue hand-off, restores them on any failure, refuses a session-less submit visibly, and blocks a duplicate re-submit of an unacknowledged prompt. styles.css also gains the missing `.toast-warning` rule so warning-severity toasts render on the semantic `--color-warning` background.
