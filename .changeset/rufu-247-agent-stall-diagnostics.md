---
"@runfusion/fusion": minor
---

summary: `fn agent show`/`fn agent list` report why an agent stalled and which cards it is holding.
category: feature
dev: New browser-safe core leaf `agents/agent-pause-reasons.ts` (pause-reason vocabulary, `unknown` sentinel, `classifyAgentStall`) plus `agents/agent-diagnostic-projection.ts` (diagnostic lines, batched pending-approval counts, assigned-card inventory) are exported from both core barrels and the browser compatibility leaf; the dashboard stall resolver now re-exports that table instead of owning a copy. Pi `fn_list_agents`/`fn_agent_show` and engine `fn_list_agents` render the same lines, so a paused lane with no recorded reason reads as `unknown` everywhere instead of printing nothing.
