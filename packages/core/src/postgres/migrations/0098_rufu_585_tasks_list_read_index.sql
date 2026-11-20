/*
FNXC:TasksListReadIndex 2026-11-20-06:45 (RUFU-585):
An index that matches the board page's OWN comparator, so the ordered page walk touches only the
requesting project's rows instead of walking every project in the cluster.

What was actually measured (`scripts/bench-tasks-list-reads.mjs`, `EXPLAIN (ANALYZE, BUFFERS)`
over the page SQL the store itself emits), stated because the first draft of this comment claimed
a different story and the numbers do not support it:

  WHERE deleted_at IS NULL AND project_id = $1 AND "column" IS DISTINCT FROM $2
  ORDER BY created_at ASC, COALESCE(substring(id from '-([0-9]+)$')::numeric, 0) ASC LIMIT $3

This query is NOT what made the operator's board load cost seconds. At `limit=20` on a seeded
2000-card project it executes in 1.2 ms examining 21 rows. The 2.9 s floor that opened this card
is event-loop CPU saturation, not this statement (the repo's own
FNXC:ListReadPromptParseCache 2026-10-02 note in `task-store/task-artifacts-ops.ts` records
`/api/health` answering in 2.9-5.6 s during the PROMPT.md re-parse storm, i.e. every route paid
that cost, not just this one). Do not cite this index as the fix for that floor.

What IS wrong here, and what this index fixes, is that the walk burns OTHER projects' rows:
no index supplied this comparator, so the planner used `idxTasksCreatedAt` and filtered:

  Index Scan using "idxTasksCreatedAt" ... Rows Removed by Filter: 230   Buffers: 71   (limit=20)
  Index Scan using "idxTasksCreatedAt" ... Rows Removed by Filter: 5450  Buffers: 1599 (limit=600)

`idxTasksProjectLiveColumn` is (project_id, "column"): it selects the project but encodes no
order. `idxTasksCreatedAt` encodes an order but is project-blind and non-partial. Neither can
serve the comparator, so an ordered walk spends rows on every other project on the cluster and
that waste grows with the cluster at a FIXED limit - the cluster-proportional work this card is
about. Same rows, this index as the only one serving the comparator:

  Index Scan using "idxTasksProjectLiveCreatedId" ... Buffers: 5,  examined 20 (limit=20)
  Index Scan using "idxTasksProjectLiveCreatedId" ... Buffers: 47, examined 600, no Sort node,
      Execution Time 1.097 ms against 4.8 ms without it (limit=600)

  34x fewer buffers at limit=600, 14x at limit=20, and the Sort node disappears entirely.

The tie-break is not decoration: `ORDER BY created_at` alone would let one page return a
different 20 rows than the same request a second later, and the JS comparator this SQL mirrors
(`readLiveTaskRows`) breaks ties on the numeric suffix of the task id. The index carries the same
expression as `numericTaskSuffix` in `task-store/async/async-persistence.ts`.

THE MEASURED LIMITATION, stated so nobody has to rediscover it: the index is correct and strictly
cheaper, but the planner does not always choose it. With both indexes present and the measured
project holding 2000 of ~20000 live rows (10% of the cluster) it still preferred
`idxTasksCreatedAt`, mispricing 1097 against this index's 1272 while the real times were 4.8 ms
against 1.1 ms; a covering variant carrying `INCLUDE ("column")` did not flip that choice either.
It IS chosen as the project's share falls (measured chosen at 0.25%: 50 rows of ~20000). So this
is a shared-cluster fix - the embedded-PG shape where several projects coexist and the board's own
project is a minority of `tasks` - and it changes nothing on a dominant-project table. It is
additive and costs nothing there, which is the honest size of the claim.

Partial on live rows, matching `ACTIVE_TASK_FILTER`, so tombstones cost nothing and the index stays
small. Leading with `project_id` is what removes the foreign-row burn above.

Why not DROP `idxTasksCreatedAt`: it is not this card's contract to remove it. Other read paths
(age sweeps, staleness probes) order by `created_at`/`updated_at` with no project or live
predicate, and this repo's rule is that removing a capability needs its own evidence and its own
changeset. This migration is purely additive: one index, no backfill, no drop, and the baseline
`0000_initial.sql` stays untouched, following the RUFU-299/0097 precedent.

Consequence every consumer inherits: an ordered page read can now be index-supplied, so a future
change to the page comparator that does not ALSO change this index silently leaves the comparator
without an index again. `rufu-585-list-page-plan.pg.test.ts` pins the pair together for exactly
that reason.
*/

CREATE INDEX IF NOT EXISTS "idxTasksProjectLiveCreatedId"
  ON project.tasks (
    project_id,
    created_at,
    COALESCE(substring(id from '-([0-9]+)$')::numeric, 0)
  )
  WHERE deleted_at IS NULL;
