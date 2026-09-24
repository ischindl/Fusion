---
"@runfusion/fusion": patch
---

summary: Retry returns a stalled card to the queue and runs it instead of parking it forever.
category: fix
dev: "`MoveTaskOptions` gains `parkOnHold?: boolean`, threaded to the single hold-lane park predicate in `applyResetOnEntryEffects` (the only move-path writer of `userPaused = true`). Default (absent) parks exactly as before; operator Retry surfaces (`fn_task_retry`, `fn task retry`) pass `parkOnHold: false`, which suppresses the park, lifts a stale one, and keeps `moveSource: "user"` for attribution. Manual drags, intake creation and engine rebounds are unchanged."
