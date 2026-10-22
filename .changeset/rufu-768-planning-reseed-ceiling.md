---
"@runfusion/fusion": patch
---

summary: Cards that crash at Plan Review now park for the operator after a bounded number of planning re-seeds.
category: fix
dev: Planning escalations now count card-level re-seed cycles in `sourceMetadata.planningReseedCycles` (limit 3, reset on a clean handoff) and park the task `failed` with `PLANNING_RESEED_CYCLE_EXHAUSTED:` instead of writing `needs-replan`, which triage always re-consumed. New audit event `task:planning-reseed-cycle` (ids/counts/fixed outcome only).
