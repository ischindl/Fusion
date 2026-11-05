---
"@runfusion/fusion": patch
---

summary: Planning discovery reads workflow selections in one batch instead of one per candidate card.
category: performance
dev: `discoverReadyPlanningTasks` (the triage poll, the engine's hottest loop) threaded a per-pass `irCache` but no selection cache, so cards sharing a workflow shared the IR parse while each still paid its own `task_workflow_selection` read — cost scaled with the planning backlog, which is what grows when a board is throttled. The pass now prefills a `WorkflowSelectionCache` with one `prefetchWorkflowSelections` batch and passes it to the same `resolveWorkflowIrForTask` call. The candidate filter is unchanged, so a card admitted before is admitted after; a store without the batch API keeps the previous per-card behavior and loses no card. Named by runtime stack samples after the review-sweep fix left the read rate unchanged (~100 000 singular reads per 5-minute window before and after), which showed the sweep was a layer on top of this loop rather than the demand. Covered by `triage-discovery-selection-prefill.test.ts`, which counts reads and fails without the change.
