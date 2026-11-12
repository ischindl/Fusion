---
"@runfusion/fusion": minor
---

summary: A review gate that never reports a verdict is now named on the card, with an operator bypass.
category: feature
dev: New stall codes `rerun-armed` / `rerun-exhausted` (read off the gate row's own `priorAttempts`, no new counter), `ReviewBypassTargetKind` gains `"verdictless-skipped"` (singular cards only), `WORKFLOW_STEP_NOT_RUN_REASONS` gains `required-gate-refused-owed-verdict`, and the FN-295 restore sweep now excludes a gate only while its remediation wave is open. No new run-audit event: the codes ride the existing stall rows.
