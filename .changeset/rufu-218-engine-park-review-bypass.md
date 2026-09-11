---
"@runfusion/fusion": patch
---

summary: Review-lane bypass now works on an engine-parked card; only a manual pause still refuses it.
category: fix
dev: RUFU-218 — the review-bypass gate tested bare `paused`, so a card the engine parked for itself (graph-failure park, stall-deadlock park, mission-autopilot hold, or an outside-worktree `external-block` freeze — all `paused: true` with `userPaused` left unset) lost its only escape from a wedged review gate, while its stall banner kept naming that gate. Admission is now `isOperatorPausedForReviewBypass` (`paused === true && userPaused === true`) — the same `userPaused` discriminant the manual-retry reset and provider-health monitor use — shared by the pure derivation, all four read paths, and `TaskStore.bypassFailedPreMergeReviewStep`, so menu and API still agree. `pausedReason` is never consulted: those park sinks write no reason. The operator-hold refusal message is byte-identical. A bypass on a parked card mutates only the step-result row — no unpause, no move, no merge — so the card stays parked and still merge-blocked until the operator retries or unpauses.
