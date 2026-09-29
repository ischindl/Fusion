---
"@runfusion/fusion": patch
---

summary: A landed card waiting on a post-merge gate that never ran can now be released by an operator.
category: fix
dev: `POST /tasks/:id/bypass-review` (and the dashboard action) now derives POST-merge gates too, stamping the audited `skipped` carrier with `phase: "post-merge"`; `getRequiredPostMergeEvidenceBlocker` accepts that audited waiver through the same `isAuditedOperatorBypass` predicate the pre-merge door uses. Pre-merge gates keep precedence and an automated (fast-mode) actor still cannot satisfy either door.
