---
"@runfusion/fusion": patch
---

summary: Cards that finish into review no longer block overlapping cards; parked waits clear on the next pass.
category: fix
dev: Both file-scope lease classifiers (`classifyFileScopeLease` in the engine, `classifyRepairFileScopeLease` in the store) answer `none` for a review-trait column, before the checkout, pause, or status question. A review card keeps its branch, worktree, and merge-queue position — only the scheduling claim is released — and the merge door still re-proves declared file scope at squash time. No new sweeper, setting, or migration: already-parked `overlapBlockedBy` rows and held continuations drain through the existing stale-overlap and released-overlap passes.
