---
"@runfusion/fusion": patch
---

Fix the task detail chat always showing "No agent is working on this task" for in-progress tasks. The active-session check required a persistent `assignedAgentId`/`checkedOutBy`, but in the default ephemeral-agents mode the scheduler never sets those fields, so an actively-executing task always read as idle. An assignment is now sufficient-but-not-necessary: a non-blocked, non-`queued` in-progress task counts as a live agent session on its own (`queued` stays assignment-gated, in-review is unchanged).
