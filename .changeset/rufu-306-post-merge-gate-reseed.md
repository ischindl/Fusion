---
"@runfusion/fusion": patch
---

summary: Cards whose merge landed but whose post-merge gate never ran are re-seeded instead of parking forever.
category: fix
dev: `getRequiredPostMergeEvidenceBlocker` now distinguishes a `missing` gate (seedable) from a real negative verdict (never re-run); new `reseedUnrunPostMergeGate` seeds the missing gate in place with a durable 3-per-(task,gate) budget and emits `task:merge-unrun-post-merge-gate-reseeded`, called from auto-merge finalization and `reconcileLandedReviewTask`. `fn task reconcile` no longer prints "already complete" for a card whose required gate has not reported — it reports the reason and exits non-zero. Repairs `post-landing-worktree-cleanup.test.ts`, whose 11 failures on `main` came from fixtures predating the required post-merge gate and the `moveTaskIf` move seam.
