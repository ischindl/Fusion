---
"@runfusion/fusion": patch
---

summary: Stall-parked workspace cards stop staying red forever; the stall watchdog no longer blocks its own repair.
category: fix
dev: "`reconcileWorkspacePartialLands` GUARD 2 now refuses only a real operator stop (`userPaused`, or `paused` with no engine reason). The engine's own `in-review-stall-deadlock` park is driven over: the per-repo land is re-enqueued and the park is cleared by compare-and-set, recorded as `parkCleared` on `task:reconcile-workspace-partial-land`. Any other named park (`external-block`, `awaiting-approval`, `error-unrecoverable`) stays refused."
