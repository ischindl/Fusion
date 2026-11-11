---
"@runfusion/fusion": patch
---

summary: A busy board no longer pays one database round trip per card to compute the running-agent count.
category: performance
dev: The whole-board running-agent reader (`countRunningAgentsInStore`, driven by the metrics domain sampler every 5 s and by every footer request, on both UI and engine hosts) now batch-reads workflow selections with `prefetchWorkflowSelections` instead of resolving one selection row per task, and the `fn project` CLI twin does the same. Measured before the change: 843 + 310 open cards at a 5 s tick = ~230 single-row `task_workflow_selection` SELECTs per second, 78 % of active PostgreSQL time on the box. A store without the batch reader, or a refused batch, keeps the previous per-task fallback and the same count. Remaining whole-board readers with the same unfixed shape (follow-up, not changed here): `register-project-routes` health completed-count, `register-system-maintenance-routes` column counts, `triage` stale-planning scan, `worktree-pool` reclaim scans, `recovery-reconciler`, `merger-integration-worktree`, `worktree-ownership`, `surfacing-sweeps`, `project-engine`.
