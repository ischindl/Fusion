---
"@runfusion/fusion": patch
---

summary: A review-lane card parked by a never-ran pre-merge gate now self-repairs instead of failing silently forever.
category: fix
dev: The bounded auto-merge retry seam defers (no status/error/retry burn) on not-run refusals of any wrapping (`task:merge-unrun-gate-retry-deferred`); a new self-healing repair clears such parks in place and re-seeds the earliest zero-result gate (`task:merge-unrun-gate-park-repaired`); the stall and wedge authorities share the `stall:pre-merge-gate-pending` reason key so the RUFU-180 notification fires across the repair→refusal transition. Stale-content and generic merge parks are unchanged.
