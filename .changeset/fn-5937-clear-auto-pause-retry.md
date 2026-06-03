---
"@runfusion/fusion": patch
---

Clear the in-review stall deadlock auto-pause on user-initiated retry so dashboard, CLI, and extension retries can actually resume merge/execution work without overriding manual pauses.
