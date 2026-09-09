---
"@runfusion/fusion": minor
---

summary: Transfer any task card to another project in one click, with live cross-project progress tracking on both sides.
category: feature
dev: New `POST /api/tasks/:id/transfer` copies title/description/attachments through the target project's own store (own prefix, own intake), stamps bidirectional `sourceMetadata` pointers (no new columns), is idempotent per (source, target project) via the proposal-claim unique index, refuses unresolvable targets with `409 details.reason:"target-unresolvable"`, and emits bounded `task:cross-project-handoff`/`-failed` run-audit events.
