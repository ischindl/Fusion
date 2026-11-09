/**
 * Async task-ID integrity detector for PostgreSQL (U8).
 *
 * FNXC:TaskIdIntegrity 2026-06-24-15:00:
 * PostgreSQL-backed equivalent of the SQLite `detectTaskIdIntegrityAnomalies`
 * in `task-id-integrity.ts`. The detector is preserved per the feature
 * description ("Preserve task-ID-integrity detector") and surfaces the same
 * anomaly kinds via the same `TaskIdIntegrityReport` shape so the dashboard
 * banner and `/api/health` payload remain compatible.
 *
 * The detector checks for (VAL-HEALTH-003):
 *   - duplicate task IDs inside `tasks`
 *   - task IDs that exist in both `tasks` and `archived_tasks` (cross-table
 *     collision)
 *   - `distributed_task_id_state.next_sequence` values that point at or below
 *     an already-used numeric suffix (sequence drift)
 *   - active task rows whose prefix falls outside the prefixes declared in
 *     `distributed_task_id_state`
 *
 * All queries use the Drizzle query builder against the project schema so the
 * detector works identically against embedded or external PostgreSQL.
 */

import { sql } from "drizzle-orm";
import type { DrizzleDb } from "./data-layer.js";
import {
  TaskIdIntegrityMeasurementError,
  type TaskIdCrossProjectDuplicate,
  type TaskIdIntegrityAnomaly,
  type TaskIdIntegrityReport,
} from "../tasks/task-id-integrity.js";
import { PROJECT_SCHEMA, ARCHIVE_SCHEMA } from "./schema/_shared.js";

/*
FNXC:TaskIdIntegrityCanary 2026-10-18-22:31 (RUFU-333):
`TaskIdIntegrityMeasurementError` is DEFINED once, in `../tasks/task-id-integrity.js` (the sync arm),
and is re-exported here so the shipped `@fusion/core/postgres` import path keeps resolving unchanged.
RUFU-301 homed the class in this PostgreSQL module, which left the synchronous detector with no
importable failure type — one of the reasons that arm stayed fail-open. Homing it in the shared module
is what lets both arms throw the SAME class object: each surface catches it by identity, so a second
class of the same name would type-check while making every `instanceof` guard on the other arm's error
false. A re-export, never a second definition, is what preserves that identity across `@fusion/core`
and `@fusion/core/postgres`.
*/
export { TaskIdIntegrityMeasurementError };

const TASK_ID_PATTERN = /^([A-Z][A-Z0-9]*)-(\d+)$/;

function parseTaskId(taskId: string): { prefix: string; sequence: number } | null {
  const match = taskId.trim().toUpperCase().match(TASK_ID_PATTERN);
  if (!match) return null;
  const sequence = Number.parseInt(match[2], 10);
  if (!Number.isFinite(sequence)) return null;
  return { prefix: match[1], sequence };
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function buildReport(
  checkedAt: string,
  anomalies: TaskIdIntegrityAnomaly[],
  crossProjectDuplicates?: TaskIdCrossProjectDuplicate[],
): TaskIdIntegrityReport {
  return {
    // An informational finding is not an anomaly: `status` stays the partition of the anomaly kinds only.
    status: anomalies.length > 0 ? "anomaly" : "ok",
    checkedAt,
    anomalies,
    ...(crossProjectDuplicates && crossProjectDuplicates.length > 0 ? { crossProjectDuplicates } : {}),
  };
}

/**
 * FNXC:TaskIdIntegrity 2026-06-24-15:05:
 * Detect task-ID integrity anomalies against a PostgreSQL backend via Drizzle.
 * This is the async PostgreSQL equivalent of the sync SQLite
 * `detectTaskIdIntegrityAnomalies(db)`.
 *
 * The detector intentionally does NOT filter on `deletedAt` for the `tasks`
 * table — soft-deleted IDs must remain visible to integrity checks (FN-5105).
 *
 * @param db The runtime Drizzle instance.
 * @param options Optional project partition; omitted or blank retains global diagnostics.
 * @returns The integrity report with the same shape as the SQLite version.
 */
export async function detectTaskIdIntegrityAnomaliesAsync(
  db: DrizzleDb,
  options?: { projectId?: string },
): Promise<TaskIdIntegrityReport> {
  const checkedAt = new Date().toISOString();
  const projectId = options?.projectId?.trim() || undefined;
  /*
  FNXC:TaskIdIntegrity 2026-09-23-01:47:
  Task IDs and allocator prefixes are project-partitioned, so all detector reads
  must use the same optional partition. An absent or blank scope intentionally
  remains a global diagnostic for single-project and administrative callers.
  */
  const projectFilter = projectId ? sql` WHERE project_id = ${projectId}` : sql``;

  try {
    const anomalies: TaskIdIntegrityAnomaly[] = [];

    // Read all active and archived task IDs. We intentionally do not filter
    // deletedAt on tasks (FN-5105). Use raw SQL for direct column access
    // without needing full Drizzle row-type mapping.
    const activeRows = (await db.execute(
      sql`SELECT id FROM ${sql.raw(`${PROJECT_SCHEMA}.tasks`)}${projectFilter}`,
    )) as unknown as Array<{ id: string }>;
    const archivedRows = (await db.execute(
      sql`SELECT id FROM ${sql.raw(`${PROJECT_SCHEMA}.archived_tasks`)}${projectFilter}`,
    )) as unknown as Array<{ id: string }>;

    const activeIds = activeRows.map((r) => String(r.id ?? ""));
    const archivedIds = archivedRows.map((r) => String(r.id ?? ""));
    const allIds = [...activeIds, ...archivedIds];

    // 1. Duplicate active IDs.
    const idCounts = new Map<string, number>();
    for (const id of activeIds) {
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
    for (const [id, count] of idCounts) {
      if (count > 1) {
        const parsed = parseTaskId(id);
        anomalies.push({
          kind: "duplicate_active_id",
          prefix: parsed?.prefix ?? "unknown",
          affectedIds: [id],
          details: `Active tasks contains ${count} rows for ${id}.`,
        });
      }
    }

    // 2. IDs in both active and archived (cross-table collision).
    const archivedIdSet = new Set(archivedIds);
    const activeAndArchived = uniqueSorted(activeIds.filter((id) => archivedIdSet.has(id)));
    if (activeAndArchived.length > 0) {
      const byPrefix = new Map<string, string[]>();
      for (const taskId of activeAndArchived) {
        const prefix = parseTaskId(taskId)?.prefix ?? "unknown";
        byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), taskId]);
      }
      for (const [prefix, affectedIds] of byPrefix) {
        anomalies.push({
          kind: "id_in_active_and_archived",
          prefix,
          affectedIds,
          details: `Task IDs exist in both active and archived storage for prefix ${prefix}.`,
        });
      }
    }

    // 3. Compute max used sequence per prefix.
    const maxUsedSequenceByPrefix = new Map<string, { maxSequence: number; taskIds: string[] }>();
    for (const taskId of allIds) {
      const parsed = parseTaskId(taskId);
      if (!parsed) continue;
      const existing = maxUsedSequenceByPrefix.get(parsed.prefix);
      if (!existing || parsed.sequence > existing.maxSequence) {
        maxUsedSequenceByPrefix.set(parsed.prefix, { maxSequence: parsed.sequence, taskIds: [taskId] });
        continue;
      }
      if (parsed.sequence === existing.maxSequence) {
        existing.taskIds.push(taskId);
      }
    }

    // Read allocator state rows.
    const stateRows = (await db.execute(
      sql`SELECT prefix, next_sequence FROM ${sql.raw(`${PROJECT_SCHEMA}.distributed_task_id_state`)}${projectFilter}`,
    )) as unknown as Array<{ prefix: string; next_sequence: string | number }>;

    // 4. Sequence drift: next_sequence at or below a used suffix.
    for (const stateRow of stateRows) {
      const prefix = String(stateRow.prefix).trim().toUpperCase();
      const nextSequence = Number(stateRow.next_sequence);
      const maxUsed = maxUsedSequenceByPrefix.get(prefix);
      if (!maxUsed) continue;
      if (nextSequence <= maxUsed.maxSequence) {
        anomalies.push({
          kind: "next_sequence_at_or_below_used",
          prefix,
          affectedIds: uniqueSorted(maxUsed.taskIds),
          details: `distributed_task_id_state.next_sequence=${nextSequence} is at or below existing sequence ${maxUsed.maxSequence} for prefix ${prefix}.`,
        });
      }
    }

    // 5. Active task rows with a prefix outside known allocator prefixes.
    if (stateRows.length > 0) {
      const knownPrefixes = new Set(
        stateRows
          .map((row) => String(row.prefix).trim().toUpperCase())
          .filter((prefix) => prefix.length > 0),
      );
      if (knownPrefixes.size > 0) {
        const outsideKnownPrefix = new Map<string, string[]>();
        for (const taskId of activeIds) {
          const parsed = parseTaskId(taskId);
          const prefix = parsed?.prefix ?? "unknown";
          if (!parsed || !knownPrefixes.has(prefix)) {
            outsideKnownPrefix.set(prefix, [...(outsideKnownPrefix.get(prefix) ?? []), taskId]);
          }
        }
        for (const [prefix, affectedIds] of outsideKnownPrefix) {
          anomalies.push({
            kind: "task_row_outside_known_prefix",
            prefix,
            affectedIds: uniqueSorted(affectedIds),
            details:
              prefix === "unknown"
                ? "Active task rows contain IDs that do not match the expected PREFIX-123 format."
                : `Active task rows use prefix ${prefix}, which is not declared in distributed_task_id_state.`,
          });
        }
      }
    }

    /*
    6. A row whose id string a SIBLING project also owns -- informational, never an anomaly.

    FNXC:TaskIdGlobalUniqueness 2026-11-08-10:45 (RUFU-320):
    `project.tasks` is keyed `(project_id, id)`, so none of the checks above can see a sibling project's
    copy of the same address -- that is the state RUFU-320 fixed forward, and migration 0096 deliberately
    never renumbered the rows it predates. `central.global_task_id_claim` is keyed on the id string alone,
    so joining a partition's own rows to the claim names the owner exactly. The partition filter is written
    on the task side as well as the claim side so the answer is the same whether this read runs under
    row-level security or on a bypassing admin connection.

    FNXC:TaskIdClaimScope 2026-11-09-08:57 (RUFU-904):
    RUFU-320 pushed this into `anomalies`, which made it a blocking operator-facing anomaly forever. That
    was the wrong verdict: a claim asserted database-wide over (prefix, sequence) while id uniqueness is
    per project means ANY second project minting its own `RUFU-001` trips it. Measured 2026-11-08: 74 such
    ids, created 2026-07-04..2026-09-27, across RunFusion (proj_9326d74a133b421a), alfawise
    (proj_87bc5b3f35624449) and vllm-rocm (proj_ab8b3ac6277e43a0) -- and `project.distributed_task_id_reservations`
    holds three independent `RUFU-001` rows, i.e. each project minted its own sequence 1 honestly. Nothing
    was overwritten and no bound-store read is confused, because forced RLS (`fusion_project_isolation`) is
    what actually protects an id-only read -- not the claim registry. So this stays reported and becomes
    `crossProjectDuplicates`, while `status: "anomaly"` is reserved for the same-partition classes above,
    where a duplicate CAN alias a live card in the partition that mints it. No data was mutated to quiet
    the count; only the verdict changed.
    */
    if (projectId) {
      const foreignOwnedRows = (await db.execute(
        sql`SELECT t.id AS id, c.project_id AS owner FROM ${sql.raw(`${PROJECT_SCHEMA}.tasks`)} t
              JOIN central.global_task_id_claim c ON c.task_id = t.id
             WHERE t.project_id = ${projectId} AND c.project_id <> ${projectId}
            UNION ALL
            SELECT a.id AS id, c.project_id AS owner FROM ${sql.raw(`${ARCHIVE_SCHEMA}.archived_tasks`)} a
              JOIN central.global_task_id_claim c ON c.task_id = a.id
             WHERE a.project_id = ${projectId} AND c.project_id <> ${projectId}`,
      )) as unknown as Array<{ id: string; owner: string }>;

      const foreignByPrefix = new Map<string, { ids: string[]; owners: Set<string> }>();
      for (const row of foreignOwnedRows) {
        const taskId = String(row.id ?? "").trim();
        if (!taskId) continue;
        const prefix = parseTaskId(taskId)?.prefix ?? "unknown";
        const bucket = foreignByPrefix.get(prefix) ?? { ids: [], owners: new Set<string>() };
        bucket.ids.push(taskId);
        bucket.owners.add(String(row.owner ?? "unknown"));
        foreignByPrefix.set(prefix, bucket);
      }
      const crossProjectDuplicates: TaskIdCrossProjectDuplicate[] = [];
      for (const [prefix, bucket] of foreignByPrefix) {
        const ownerProjectIds = [...bucket.owners].sort();
        crossProjectDuplicates.push({
          prefix,
          affectedIds: uniqueSorted(bucket.ids),
          ownerProjectIds,
          /*
          FNXC:TaskIdClaimScope 2026-11-09-08:57 (RUFU-904):
          The operator-facing sentence. The old copy read "Rename the affected cards or archive the
          duplicate", which aimed the operator's repair at cards in projects that are not his and were
          never wrong. Task ids are unique per project, so this is a coincidence of numbering, not damage:
          the copy states the pair and stops there.
          */
          note:
            `Task IDs in this project share their id strings with ${ownerProjectIds.join(", ")}. `
            + `Task IDs are unique per project, so each card resolves inside its own project and nothing needs renaming.`,
        });
      }

      return buildReport(checkedAt, anomalies, crossProjectDuplicates);
    }

    return buildReport(checkedAt, anomalies);
  } catch (error) {
    // FNXC:TaskIdIntegrityCanary 2026-09-26-00:50 (RUFU-301): never fail open.
    // Rewrapping (not swallowing) keeps the driver's reason — statement timeout,
    // connection loss, permission denial — visible to the health surface.
    if (error instanceof TaskIdIntegrityMeasurementError) throw error;
    throw new TaskIdIntegrityMeasurementError(error);
  }
}
