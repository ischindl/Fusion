---
"@runfusion/fusion": patch
---

summary: A stalled review card now names the gate that stalled it, not just "task is paused".
category: fix
dev: "`getTaskMergeBlocker` keeps refusing; only the sentence changes, and only for a card the engine itself parked with `pausedReason: in-review-stall-deadlock`. A hand pause still answers `task is paused` verbatim. New `describeEngineStallParkBlocker` reports the required pre-merge gate's latest row (status + whether a verdict was ever authored), names a gate that was audited-bypassed while no merge owner ran, or returns nothing at all rather than guessing."
