---
"@runfusion/fusion": patch
---

summary: A card applying review corrections is no longer parked as a stalled review deadlock.
category: fix
dev: New stall reason code `awaiting-review-revision`. The in-review stall ladder records the wait but withholds the terminal park while an authored `REVISE` and a pending remediation step both hold; the new `reconcile-review-revision-stall-parks` sweep (startup + maintenance batch 1) un-parks cards the previous build froze and emits `task:merge-review-revision-park-cleared`. Consent precedence: with automatic processing withheld the new code is not claimed at all and the card keeps its `merge-blocker` / `held-human-review` report, matching the engine's own ladder; the repair sweep carries the sibling repairs' consent, live-session, and merge-ownership admission and re-checks it inside its guarded write.
