/**
 * FNXC:PostgresCutover 2026-07-10:
 * Async Drizzle counterparts of the sync `transition-pending.ts` helpers for
 * the crash-safe `tasks.transition_pending` marker (U3/KTD-2) in PostgreSQL
 * backend mode. Backend-mode `moveTaskInternal` writes the marker inside the
 * same `transactionImmediate` as the column change and clears it after the
 * post-commit hook runner; `recoverStaleTransitionPendingImpl` sweeps stale
 * markers on startup/maintenance. Before this port, backend mode silently
 * skipped the marker write (clear was a swallowed `store.db` throw) and the
 * recovery sweep threw "SQLite Database is not available in backend mode" —
 * while `countActiveInCapacitySlotAsync` ALREADY counts pending markers in
 * PG, so the marker column is load-bearing for capacity there.
 */

import { eq, isNotNull, isNull, ne, and } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import { projectScopeFor, type DrizzleDb, type DbTransaction } from "../../postgres/data-layer.js";
import {
  type TransitionPending,
  deserializeTransitionPending,
  serializeTransitionPending,
} from "../../tasks/transition-types.js";

type Handle = DrizzleDb | DbTransaction;

/*
FNXC:TaskListReadProjectScope 2026-11-07-01:34 (RUFU-871):
`project.tasks` is ONE shared table partitioned by `project_id`, and task identity is
project-local — the same id exists in several projects. These helpers take a bare
`Handle` (no `AsyncDataLayer`), so the bound project must travel as the trailing
`projectId` argument, exactly like the QueryHandle convention the other async stores
use. An absent/blank id is deliberately a no-op predicate (`projectScopeFor`), which
keeps unbound compatibility and analytics readers reading everything.
*/

/**
 * Read the pending marker for a task. Mirrors the sync contract: `null` when
 * the column is NULL/empty/malformed (a corrupt marker degrades to settled),
 * `undefined` only when the task row does not exist.
 */
export async function readTransitionPendingAsync(
  handle: Handle,
  taskId: string,
  projectId?: string,
): Promise<TransitionPending | null | undefined> {
  const rows = await handle
    .select({ transitionPending: schema.project.tasks.transitionPending })
    .from(schema.project.tasks)
    .where(and(
      projectScopeFor(schema.project.tasks.projectId, projectId),
      eq(schema.project.tasks.id, taskId),
    ))
    .limit(1);
  const row = rows[0] as { transitionPending: string | null } | undefined;
  if (row === undefined) return undefined;
  if (row.transitionPending == null || row.transitionPending === "") return null;
  return deserializeTransitionPending(row.transitionPending);
}

/** Write (set or replace) the pending marker. Run inside the move transaction. */
export async function writeTransitionPendingAsync(
  handle: Handle,
  taskId: string,
  pending: TransitionPending,
  projectId?: string,
): Promise<void> {
  await handle
    .update(schema.project.tasks)
    .set({ transitionPending: serializeTransitionPending(pending) })
    .where(and(
      projectScopeFor(schema.project.tasks.projectId, projectId),
      eq(schema.project.tasks.id, taskId),
    ));
}

/** Clear the pending marker (NULL) once post-commit hooks complete. */
export async function clearTransitionPendingAsync(
  handle: Handle,
  taskId: string,
  projectId?: string,
): Promise<void> {
  await handle
    .update(schema.project.tasks)
    .set({ transitionPending: null })
    .where(and(
      projectScopeFor(schema.project.tasks.projectId, projectId),
      eq(schema.project.tasks.id, taskId),
    ));
}

/**
 * List live task ids carrying a non-empty pending marker — the recovery
 * sweep's scan set. Mirrors the sync sweep's SELECT (non-deleted rows only).
 *
 * FNXC:TaskListReadProjectScope 2026-11-07-01:34 (RUFU-871):
 * This scan drove `recoverStaleTransitionPendingImpl` across EVERY project's rows: a
 * bound store re-ran foreign post-commit hooks and its clear wiped the foreign
 * marker, because the sweep's own by-id reads/clears cannot distinguish a same-id row
 * in another partition. The predicate belongs in the query, not in the caller.
 */
export async function listTransitionPendingTaskIdsAsync(
  handle: Handle,
  projectId?: string,
): Promise<string[]> {
  const rows = await handle
    .select({ id: schema.project.tasks.id })
    .from(schema.project.tasks)
    .where(and(
      projectScopeFor(schema.project.tasks.projectId, projectId),
      isNotNull(schema.project.tasks.transitionPending),
      ne(schema.project.tasks.transitionPending, ""),
      isNull(schema.project.tasks.deletedAt),
    ));
  return rows.map((row) => (row as { id: string }).id);
}
