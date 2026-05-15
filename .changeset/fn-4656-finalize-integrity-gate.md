---
"@runfusion/fusion": patch
---

Finalize-to-done now requires ownership evidence: tasks only complete when a task-owned landed commit is proven or when no-op completion is proven against the merge target. Legitimate no-op finalize paths now reconcile stale metadata by clearing inherited `modifiedFiles` and stamping empty `landedFiles` markers. Unproven finalize cases are audit-logged and auto-retried by requeuing to `todo` for fresh execution instead of silently landing as done.
