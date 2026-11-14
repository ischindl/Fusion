---
"@runfusion/fusion": patch
---

summary: Board lanes now lead with the cards that need attention, not with whatever is oldest.
category: fix
dev: Adds a fourth lane read mode `order=attention` on `GET /tasks/page` (with a `reviewScope=1` lane claim the server confirms against resolved column traits), a shared 7-tier ladder in `@fusion/core` (`resolveAttentionTier` / `sqlAttentionTier`) applied inside the Boost bucket, and `laneQueueScopeForColumn` on the client. Engine dispatch keeps `queue-order` unchanged; the SQL mirror may under-rank but never over-rank the client, and the one declared divergence is `pausedReason: "in-review-stall-deadlock"` (tier 3 hydrated, tier 4 durable). A lane ranked by attention now also keeps its head at the top of the lane's own scroll container when the attention card arrives there, instead of the virtualiser scrolling it above the fold.
