---
"@runfusion/fusion": patch
---

summary: A heartbeat run that reported done clears its running badge at once instead of showing "stuck" for a cadence.
category: fix
dev: The accepted `fn_heartbeat_done` boundary writes `heartbeatDoneAccepted` onto its own run row before the session is aborted, then closes the run `completed` and settles the agent badge; the scheduler reap and the orphaned-running reconcile read that acknowledgement through `hasAcceptedHeartbeatDone` and close such a run ahead of their work budgets, refusing any run this process still holds a session for. Reports Health `stuck` now requires that proof (an open run with no accepted done, or a live session); an aged running row with neither renders the non-actionable `desynced` cell and adds no action line. No new settings, no schema migration, no threshold moved.
