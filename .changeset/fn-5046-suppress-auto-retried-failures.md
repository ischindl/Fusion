---
"@runfusion/fusion": minor
---

Add `failureNotificationMode: "terminal-only"` to suppress ntfy/webhook
failure notifications while the engine is still auto-retrying a task.
Notifications fire only once the task is paused or escalated to in-review.
Default behavior (`sticky-only`) is unchanged.
