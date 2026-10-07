---
"@runfusion/fusion": patch
---

summary: A card stuck on a refusal no longer buries its own history — the engine states a refusal once.
category: fix
dev: "`task:workflow-run-suspended` and `task:auto-merge-finalize-column-mismatch-no-action` are now recorded on the transition into the wait/refusal instead of once per engine pass (a card parked at a capacity seam wrote 108 identical audit rows in 45 min; 7 cards wrote 5,356 finalize rows in one day). A changed reason, lane, status, or blocker still records immediately. The merge-confirmed fast path appends its task-log line only when the refusal changes, which restores RUFU-452's verdict-less-gate re-run budget: it counts strikes in the per-task log, which is capped at 1,000 entries and was being rotated by the repeated text. Suppressed restatements remain available at debug level under `FUSION_DEBUG=1`. Reset the in-process state in tests via `resetWorkflowRunSuspendedNoticeState()` / `resetFinalizationNoticeState()`."
