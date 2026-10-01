---
"@runfusion/fusion": minor
---

summary: Landed cards whose post-merge gate can never run now reach the operator instead of deferring forever.
category: fix
dev: Terminal post-merge reseed refusals (`workspace`, `no-post-merge-node`, `rerun-budget-exhausted`, `unsupported-store`) now write one idempotent mailbox notice per 6 h window plus `task:auto-merge-finalize-post-merge-gate-unreachable`, and finalization returns a reason carrying `[post-merge gate unreachable: <refusal>]` so the merge-retry path can classify it. Transient refusals (`active-continuation`, `operator-held`, `workflow-selection-changed`) keep the old deferred behaviour. Also drops a duplicated `isWorkspaceTask` guard in the seeder.
