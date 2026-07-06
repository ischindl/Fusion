---
"@runfusion/fusion": patch
---

summary: Fix manual PR actions hidden when a task auto-merge override was on but global auto-merge was off.
category: fix
dev: TaskDetailModal isManualPrFlow now keys off live global autoMergeEnabled, not the per-task effective override (regression from FN-7255).
