---
"@runfusion/fusion": patch
---

Completed/no-commit executions that finalize to review no longer get re-parked failed when later teardown overwrites completion-finalize abort provenance with a hard-cancel marker. Genuine user/global pauses, merge-seam retry routing, and active-execution hard-cancel behavior are preserved.
