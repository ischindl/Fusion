---
"@runfusion/fusion": minor
---

summary: Review cards parked by the engine's own stall deadlock get re-reviewed instead of starving.
category: fix
dev: `classifyReviewCard` no longer buckets a card as `excluded-paused` when the only pause is `pausedReason: "in-review-stall-deadlock"` — an engine-authored park. `userPaused` and every other pause reason keep the old meaning, and a card with a recorded verdict is still protected by the recorded-verdict rule. Unblocks the saneca shape where 27 `in-review` cards reported `completed-review-status-none repeated 3× without progress` while `[ReviewDispatchSweep] excluded-paused` refused to dispatch the missing Code Review verdict.
