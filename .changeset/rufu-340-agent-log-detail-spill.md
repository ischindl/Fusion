---
"@runfusion/fusion": minor
---

summary: Task and run logs keep long tool output: oversized payloads are stored out-of-line and returned whole.
category: feature
dev: Agent-log rows over the 4 096-char inline bound now keep an exact prefix plus a `detailSpill` pointer (`body`, `digest`, `chars`, `bytes`) into `.fusion/agent-log-detail-spill/`, per producing log. Readers (`fn_task_logs_read`, Raw Logs, CLI, HTTP) resolve it; `pruneAgentLogFiles` reclaims bodies no surviving row references. The engine's byte-budget prose is gone, replaced by a counted 256 KiB memory ceiling (`agentLogMemoryCeilingExceedances()`).
