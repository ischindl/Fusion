---
"@runfusion/fusion": patch
---

summary: Fix tasks in planning/intake columns starting execution before they were specified.
category: fix
dev: The hold-release entry guard (reserveSlot in scheduler.ts, issueRelease in hold-release.ts) is now trait-based (isUnplannedForExecution resolves the `intake` trait plus `status:"planning"`/bootstrap-stub PROMPT.md) instead of keyed on the literal `todo` column id, so renamed custom intake columns (e.g. `ideas`, `Inbox`) are covered too. promoteHeldTask/releaseHeldTaskByEvent also route through the same guard (FN-7648).
