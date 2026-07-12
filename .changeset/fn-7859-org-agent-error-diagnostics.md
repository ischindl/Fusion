---
"@runfusion/fusion": patch
---

summary: Agent inspection tools now show why agents are in error or paused.
category: fix
dev: fn_agent_show and fn_list_agents surface lastError, pauseReason, and recovery counters for error/paused agents. Durable non-recoverable heartbeat errors are parked paused with error-unrecoverable and emit agent:error-parked-unrecoverable instead of sitting indefinitely in bare error.
