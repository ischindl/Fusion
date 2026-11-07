---
"@runfusion/fusion": patch
---

summary: Board lanes load again — the board's workflow-lane request reads the workflow catalog once instead of once per workflow.
category: fix
dev: `GET /api/tasks/board-workflows` enumerated every current-task row as a fully hydrated `Task` to read only `task.id`, and re-read each workflow it describes (`getWorkflowPromptOverridesAsync` / `getWorkflowDefinition`) — ~20 awaited round trips, 11 of them per-workflow, on a process whose 3-connection pool was saturated. The enumeration now declares an id-only read (`fields: []`, `derive: false`) and one catalog read is shared by the complete-lane vocabulary and `buildBoardWorkflowsPayload`, which gained an optional `workflowCatalog` argument. Response shape is unchanged; `board-workflows-read-cost.test.ts` is a read-count ratchet.
