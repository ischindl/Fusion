---
"@runfusion/fusion": patch
---

summary: Fix Planning Mode Back button showing a generation screen instead of the previous question.
category: fix
dev: handleBack in PlanningModeModal no longer transitions to the loading view during the deterministic rewindPlanningSession; Back returns directly to the previous question form (success and error paths) and never renders .planning-loading.
