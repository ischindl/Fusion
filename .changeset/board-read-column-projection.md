---
"@runfusion/fusion": patch
---

summary: The board's hottest background reads now fetch only the columns they use, cutting Postgres row and jsonb parsing.
category: performance
dev: `countRunningAgentsInStore` and the review-lane dispatch sweep now pass `fields: ["workflowStepResults"]` to `store.listTasks` (the running-agent count also passes `derive: false`). Two `project-store-resolver` fixtures that pinned the old `{ slim: true }` shape were updated to the new one.
