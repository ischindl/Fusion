---
"@runfusion/fusion": patch
---

summary: Heartbeat stops offering operator-parked (hard-cancelled) cards as ready or claimable work.
category: fix
dev: Wake Delta ranking and the auto-claim selector now treat `userPaused` as parked like `paused`; the count line splits `operator-paused`/`engine-paused` and `claimTaskForAgent` gains a `user_paused` refusal reason.
