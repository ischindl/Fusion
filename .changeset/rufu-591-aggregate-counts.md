---
"@runfusion/fusion": patch
---

summary: Agent panels and the roster view open fast: the server reuses its agent store and answers totals in the database.
category: performance
dev: Dashboard routes share one initialized `AgentStore` per option shape (`getSharedAgentStore`) instead of constructing and `init()`-ing one per request; `sanitizeAgentTaskLinks` resolves workflow lanes through the batched `getTaskWorkflowSelectionsAsync` (reads constant in the number of linked cards, previously ~3N reads per poll) instead of one selection plus one workflow-definition read per card; `aggregateTaskTokenTotalsByAgentLinkAsync` returns one row per agent from SQL rather than shipping every token-bearing task row to Node (SQLite keeps the row-shipped accumulator verbatim); and the dashboard roster now shares one in-flight refresh per `(projectId, includeEphemeral)` through a refcounted owner, with each variant hydrating its own `AGENTS:<projectId>` cache slot. Response JSON shapes are unchanged.
