---
"@runfusion/fusion": patch
---

summary: A card stranded by an archived gate record now re-runs that gate automatically instead of waiting forever.
category: fix
dev: Remediation-archived pre-merge carriers (skipped + `remediationArchivedAt`, no bypass/arbitration) classify as not-run, so the FN-9243 in-place re-seed re-runs the gate; the stall reason derives `pre-merge-gate-pending`. Review-gate-entry classification moved to core `isReviewGateNode`/`clampReviewGateEntry`.
