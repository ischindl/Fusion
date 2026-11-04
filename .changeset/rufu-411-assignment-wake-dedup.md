---
"@runfusion/fusion": patch
---

summary: Stop an assigned agent from being woken over and over by an assignment that never changed.
category: fix
dev: `agent:assigned` now fires only when the bound task actually changed, matching the emit discipline `task:assignee-changed` already used. The heartbeat assignment lane delivers one wake per (agent, goal, observable delta) per window — the delta is agent id, task id, agent state, bound task id, and triggering comment ids — and suppresses an identical arrival on both the immediate arm and the run-completion arm. The window is the single constant `ASSIGNMENT_WAKE_SUPPRESSION_WINDOW_MS` (5 minutes). New run-audit event `agent:assignment-wake-suppressed` (ids/counts/fixed enums only, one row per suppression episode, never zero) keeps "why did my agent not wake?" answerable.
