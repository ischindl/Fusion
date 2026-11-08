/*
FNXC:TaskIdGlobalUniqueness 2026-11-08-09:19 (RUFU-320):
Creates the database-wide task-id claim registry and backfills it from the cards that already exist.

The defect: `project.tasks` is keyed `(project_id, id)` — a deliberate per-project partition — so the
id STRING was never a namespace. A card created from agent chat with no explicit project minted the
server default project's prefix while its row was stamped with the destination project's id, and the
operator's database ended up holding two live cards named `RUFU-002`/`RUFU-003` that differed only by
`project_id`. `fn task show RUFU-003` then resolved by default project and opened the wrong card.

The table's primary key is `task_id` ALONE. That shape is the whole point and it is why this table
lives in the unpartitioned `central` schema: the project-schema isolation guards (`schema-applier.test.ts`
project-ownership, forced-RLS, and project_id-in-every-key/unique-index checks) require a physical
`project_id` column and `project_id` inside every key. Putting `project_id` into this key reinstates
exactly the duplicate this migration exists to prevent; relaxing those guards would weaken the project
data-isolation contract. `central` is the only schema that can host a key on the id alone, and it
already hosts cross-node coordination tables (`central.task_claims` — a per-project ownership LEASE
with a `(project_id, task_id)` key, a different concern, deliberately not reused here).

Rows are never deleted or reassigned: a minted string stays claimed after its card is archived,
soft-deleted, or purged, which is the same no-reuse rule the allocator applies to sequences. A
re-claim by the OWNING project stays legal — archive/restore, soft-deleted id reuse, and tombstone
resurrection all re-insert the id they already own.

Runtime access is inherited, not granted here: `0006_project_ownership.sql` already loops `project`,
`central`, and `archive` with USAGE, table DML, sequences, and ALTER DEFAULT PRIVILEGES, so a table
this migration creates in `central` is reachable by `fusion_runtime` (proved by
`global-task-id-claim.pg.test.ts` rather than assumed).

Backfill is conflict-ignore and ordered by (project_id, id), so the earliest project on an already
shared string keeps it. A pre-existing cross-project duplicate is a fact about the operator's data,
not a migration error: the upgrade MUST succeed over it. The census goes into `central.__meta` under a
dedicated key — ids and a count only, never titles or payload text — and the operator's authoritative
view is the `cross_project_duplicate_id` anomaly the store-open integrity report surfaces
(`tasks/task-id-integrity.ts`). Renumbering an existing card is destructive and remains the
operator's decision; this migration reports and never rewrites.
*/

CREATE TABLE IF NOT EXISTS central.global_task_id_claim (
  task_id text PRIMARY KEY,
  project_id text NOT NULL,
  created_at text NOT NULL,
  reservation_id text
);

/*
FNXC:TaskIdGlobalUniqueness 2026-11-08-09:33 (RUFU-320):
`reservation_id` makes the claim two-phase. A reservation claims its number in its own transaction and
stamps the column; committing the reservation clears it (claim permanent); aborting or expiring deletes
it (nothing was created, so nothing is burned). Without the pending phase, a second project reserving
concurrently with a sibling's uncommitted reservation sees an empty registry and mints the same string:
`project.distributed_task_id_reservations` is RLS-partitioned, so reservations alone cannot serialize
projects that share a prefix. Every delete of a pending claim is scoped to project_id, because a
session cannot see another project's reservations and must not conclude they are gone.
*/
CREATE INDEX IF NOT EXISTS global_task_id_claim_reservation_idx
  ON central.global_task_id_claim (reservation_id)
  WHERE reservation_id IS NOT NULL;

-- Backfill only where the row tables exist. `applySchema` runs a single migration in isolation against
-- deliberately partial databases (a marker-only fixture for drift probes, a pre-0001 upgrade target), so
-- an unconditional reference to `project.tasks` aborts the whole upgrade on a database that has no task
-- table at all. Guarded by existence, the census simply records nothing there and the table stays empty
-- until the first real claim is written.
DO $$
DECLARE
  tasks_present boolean := to_regclass('project.tasks') IS NOT NULL;
  archived_present boolean := to_regclass('archive.archived_tasks') IS NOT NULL;
BEGIN
  IF NOT (tasks_present AND archived_present) THEN
    RETURN;
  END IF;

  /*
  Live cards first, then archived ones, ordered by (project_id, task_id) so the earliest project on an
  already shared string keeps it. Same-string duplicates inside one project (a row that exists in both
  tables) collapse on the conflict target.
  */
  INSERT INTO central.global_task_id_claim (task_id, project_id, created_at)
  SELECT seeded.task_id, seeded.project_id,
         to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:MS"Z"')
  FROM (
    SELECT id AS task_id, project_id FROM project.tasks
    UNION
    SELECT id AS task_id, project_id FROM archive.archived_tasks
    ORDER BY project_id, task_id
  ) AS seeded
  ON CONFLICT (task_id) DO NOTHING;

  /*
  Record — do not fail on — ids that more than one project already holds. Counted from the row tables
  (not from this table, which by construction keeps one owner per string), so the number is the
  operator's real exposure. Ids are never written here; only the count.
  */
  INSERT INTO central.__meta (key, value)
  SELECT
    'rufu-320:cross-project-duplicate-task-ids',
    (
      SELECT COALESCE(COUNT(*), 0)::text
      FROM (
        SELECT shared.task_id
        FROM (
          SELECT id AS task_id, project_id FROM project.tasks
          UNION
          SELECT id AS task_id, project_id FROM archive.archived_tasks
        ) AS shared
        GROUP BY shared.task_id
        HAVING COUNT(DISTINCT shared.project_id) > 1
      ) AS collided
    )
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
END $$;
