---
"@runfusion/fusion": patch
---

summary: A planning database-lock timeout re-queues with backoff instead of failing the card.
category: fix
dev: A `workflow-principal-fence-unavailable` refusal is now classified as infrastructure (`lock-transport` / `store-unavailable` / `cause-unknown`) instead of falling through to the terminal `PLANNING_FAILED_EXHAUSTED` park, so a Postgres advisory-lock grant timeout no longer reads as "the Planner failed". Triage retries it with backoff within a dispatch, and the new `reconcile-planning-fence-parks` self-healing sweep (startup + maintenance batch 1) re-probes the fence under the same per-task planning lifecycle lock and writes `status: "needs-replan"` on success — never a column move, never a review-lane bounce — with a `requeueCount` budget counted across dispatches in `planningFailure.principalFence`. While such a card waits it alerts under the new `planning-fence-unavailable` wedge descriptor, and a genuine authoring exhaustion keeps its existing generic `terminal-failed` alert behavior. Two run-audit mutations record the pass: `task:reconcile-planning-fence-park` and `task:reconcile-planning-fence-park-no-action`, metadata ids/counts/fixed enums only (`taskId`, `column`, `stalenessMs`, `requeueCount`, `requirement`, `outcome`); refusal sentences and error text are never stored.
