---
"@runfusion/fusion": patch
---

summary: A review waiver that is refused now says why, instead of quietly hiding the action.
category: feature
dev: The task read paths ship `task.reviewBypassDecline` (`{ reason, workflowStepId? }`) beside the existing `task.reviewBypass` capability, naming which class refused: `operator-task-hold`, `not-in-review-lane`, `no-refusing-gate`, `post-merge-review-not-owed`, `workspace-scope-withheld`, or `workflow-ir-unreadable` (the last authored by the hydration seam, whose `catch` previously returned the same silent `undefined` a fully-approved card returns). Each class has exactly one sentence, resolved by `resolveReviewBypassDeclineHint` and rendered by the shared Actions container as a plain explanation line - never a menu item, never a disabled or empty shell - on both the desktop and mobile menu shapes. Copy totality is compile-enforced (the copy map is a `Record` over `ReviewBypassDeclineReason`), and an unknown reason from a newer daemon still explains itself rather than going silent. Acceptance rules are unchanged: bypass stays operator-only, and what the store accepts is still exactly what the capability names.
