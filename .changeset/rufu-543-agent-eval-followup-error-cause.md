---
"@runfusion/fusion": patch
---

summary: Agent evaluation tools now report the real database error and resolve an exact agent ID without a full roster read.
category: fix
dev: Both manager evaluation tools map store failures through `summarizeErrorForOperator`, so a failed query reads as its innermost cause plus truncated SQL instead of Drizzle's bare `Failed query:` shell; `AgentStore.resolveAgent` documents and pins the exact-ID fast path (single indexed by-id read) with a PostgreSQL test asserting zero roster listings on an ID hit.
