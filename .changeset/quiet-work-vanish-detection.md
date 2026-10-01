---
"@runfusion/fusion": minor
---

summary: Vanished-task alerts: a task directory that resolves on no board read now reports itself with salvage steps.
category: feature
dev: New self-healing sweep `reconcile-vanished-task-dirs` (maintenance batch 1, cadence-gated with `cleanup-orphans`) classifies disk-mirror × row-presence × branch evidence into a fixed taxonomy, emits `task:vanished-approved-work`, and sends one idempotent mailbox notice per (task, reason, 6 h) bucket. New `TaskStore.resolveTaskIdPresence`/`resolveTaskIdPresenceForIds` distinguish a live row from a soft-delete tombstone and an archive snapshot; `taskIdExistsAnywhere` is now documented as collapse-all-three and kept for reservation checks. Resurrection tombstone purge now writes `task:row-purged-for-resurrection` in the same transaction as the parent delete and raises `TombstonePurgeUnauditedError` (tombstone preserved) if that write fails; the `task_workflow_selection`/`workflow_steps` child purge moved after the commit and is best-effort. Detector is report-only — it never recreates, re-imports, or deletes a task directory. See `docs/solutions/reliability/vanished-task-directory-rufu-225.md`.
