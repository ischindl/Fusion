---
"@runfusion/fusion": patch
---

summary: A card waiting on another live card's file-scope lease is no longer re-queued by self-healing every ~15 minutes.
category: fix
dev: The stranded-continuation classifier (`workflows/stranded-continuation-reclaim.ts`) gains a `converge` disposition: a `held` row whose own `blockedReason` proves nothing but whose task row carries `overlapBlockedBy` on a live, non-terminal, non-deleted holder is CASed to the canonical `file-scope:<blockerId>` wait reason plus the deferral ladder in one write, with no `[recovery]` task-log line and no re-queue event row. Holder liveness is resolved lazily (only for verdicts that reached the unclaimable shape), a non-resolvable/terminal holder keeps the existing first-sight reclaim, and the sustained branch still re-queues when the task's blocker drifts to another card. `releaseFileScopeWaitingContinuations` remains the only wake path.
