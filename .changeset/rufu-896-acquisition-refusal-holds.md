---
"@runfusion/fusion": patch
---

summary: A card waiting on a file-scope peer now queues instead of failing and rebuilding its worktree.
category: fix
dev: A refused `acquireTaskWorktree` (file-scope overlap wait) no longer writes `status:"failed"` plus error prose. Both refusal shapes — the typed `OverlapResumeSynchronizationError` and the bare Error the heartbeat retry cap would compose — now write a durable `queued` hold through `transitionQueuedEpisode` with the predecessor in `overlapBlockedBy`, consume no `recoveryRetryCount` strike, and are skipped by the next heartbeat instead of re-entering acquisition. `task:overlap-acquisition-parked` gains `holdWrite` and `holdSource`. The terminal write survives only as a fallback when the hold cannot be persisted.
