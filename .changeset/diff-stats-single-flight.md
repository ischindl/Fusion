---
"@runfusion/fusion": patch
---

summary: Board badges no longer fan out one git lane per card; identical diff-stat polls share a single computation.
category: fix
dev: `GET /api/tasks/:id/diff?stats=1` coalesces concurrent identical keys onto one computation; the rendezvous table is census-registered as `task_diff_stats_in_flight`.
