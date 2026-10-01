---
"@runfusion/fusion": minor
---

summary: Aged planning cards now say why they are not being planned: throttle, wrong lane, stuck work, or unadmitted.
category: feature
dev: Seven new `TaskStallReasonCode` values (`plan-admission-throttled`, `plan-lane-ineligible`, `plan-premise-held`, `plan-spec-unreadable`, `plan-recovery-backoff`, `plan-no-admission`, `recoverable-work`) derive from a nullable `sourceMetadata.planAdmissionStall` episode that must only ever be written with a key-level `sourceMetadataPatch`. New self-healing sweep `reconcile-planning-admission-stall` (startup + maintenance batch 1, report-only, 48 h default threshold or the planning column's `recovery.stalenessMs`) emits `task:planning-admission-stalled` / `task:planning-admission-stalled-no-action`; the same sweep retracts the episode when a card stops being a candidate, and the manual Retry reset clears it alongside RUFU-246's premise episode. Who gets examined is bounded before the 200-candidate cap by the project's `intake`/`hold` column vocabulary — otherwise merged cards whose status was cleared back to nothing fill the oldest-first slice and the aged planning cards are never reached — and the `recoverable-work` probe covers a `branch` claim with no recorded worktree, which is what a cleaned-up executor checkout leaves behind.
