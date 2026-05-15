---
"@runfusion/fusion": patch
---

Auto-recovery: contamination + message-delivery handlers. Adds ContaminationAutoRecoveryHandler (issueRetry for branch-cross-contamination, composes with FN-4499 bootstrap re-anchor and FN-4428 contamination classifier) and MessageDeliveryAutoRecoveryHandler (bounded retry-or-park for fn_send_message / fn_post_room_message inside agent-tools.ts). New ProjectSettings.autoRecovery failure class "message-delivery-failure". New run-audit event types contamination:retry-issued, contamination:irreducible-pause, message-delivery:retry-issued, message-delivery:park. Genuine destructive-ambiguity contamination still pauses; userPaused (FN-4429) is preserved; autoRecovery.mode === "off" is byte-identical to legacy behavior at every wired site.
