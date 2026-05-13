---
"@runfusion/fusion": minor
---

Defer "task failed" push notifications so they only fire when a failure persists. New global settings `failureNotificationDelayMs` (default 30000) and `failureNotificationMode` (default `sticky-only`) gate the behavior; set mode to `all` or delay to `0` to restore legacy immediate dispatch.
