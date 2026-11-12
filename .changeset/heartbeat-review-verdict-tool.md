---
"@runfusion/fusion": minor
---

summary: Reviewer heartbeats can now record a code-review verdict, so reviewed cards reach the merge door instead of parking.
category: feature
dev: New `fn_record_review_verdict` heartbeat tool writes one pre-merge `code-review` step row through the fenced step-result writer and closes the card's live reviewer-run attempt; candidacy is decided from the live row (never over a row carrying `reviewInputFingerprint` or `remediationArchivedAt`), tip equality is proven with `probeReviewChangesSinceCommit`, and the recorded fingerprint is the merge door's own derivation. The heartbeat wake injects the tool only after asking that same candidacy decision (`heartbeatReviewVerdictGateOpens`), so a wake whose card cannot take a verdict is never handed a tool that can only refuse. Emits `task:review-verdict-recorded` (ids and fixed enums only, bounded seam). No board move, no column change, workspace cards refused honestly.
