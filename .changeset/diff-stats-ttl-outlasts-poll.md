---
"@runfusion/fusion": patch
---

summary: Card diff badges no longer recompute a git lane on every board poll.
category: performance
dev: `TASK_DIFF_STATS_CACHE_TTL_MS` was 10 s while `TaskCard` polls the active columns every 30 s, so every poll was a cold miss and re-ran the diff lane — measured as 32% of subprocess-spawn CPU at idle, with `/api/health` answering in 1.3 s. The window is now 60 s (two poll cycles); the `+N ~M` badge can lag a real change by up to the TTL on the stats lane only. Pinned by `diff-stats-ttl-outlasts-poll.test.ts` because the drift is silent.
