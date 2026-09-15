/*
FNXC:OverlapWaitSynchronization 2026-09-13-04:01:
The model-owned overlap revalidation gate was removed. Historical pending/repair episodes become deterministic ready briefings without deleting delivery evidence, and the phase constraint prevents the removed state machine from returning.

FNXC:PostgresSchema 2026-09-15-22:37:
This file names task_overlap_waits in bare DDL and DML with no existence guard of its own, which is only safe because the applier never reaches it unconditionally: a separate to_regclass statement decides whether the relation exists, and this migration runs only when that probe reports it present. Keep that order — PostgreSQL resolves relation names at analysis time, so a guard inside a statement cannot protect a read in the same statement. Databases that predate the relation therefore defer this migration (marker unrecorded) and apply it on a later boot once the relation exists.

The rebuilt phase constraint is the durable half of that removal: the retired revalidation-pending and repair-required phases must never be permitted again, which is why the applier re-applies this migration whenever it finds a CHECK that still lists them or rows stranded in them.
*/
ALTER TABLE project.task_overlap_waits
  DROP CONSTRAINT IF EXISTS ck_task_overlap_wait_phase;

UPDATE project.task_overlap_waits
SET
  phase = 'ready',
  receipt = CASE
    WHEN receipt IS NULL THEN NULL
    ELSE (receipt
      - 'revalidationVerdict'
      - 'invalidatedPromise'
      - 'revalidationFeedback')
      || jsonb_build_object(
        'decision',
        CASE
          WHEN NULLIF(BTRIM(receipt->>'briefing'), '') IS NOT NULL THEN 'briefing'
          ELSE 'resume'
        END
      )
  END
WHERE phase IN ('revalidation-pending', 'repair-required');

ALTER TABLE project.task_overlap_waits
  ADD CONSTRAINT ck_task_overlap_wait_phase
  CHECK (phase IN ('observed','analyzing','freshness-pending','ready','delivered','cancelled'));
