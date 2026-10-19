import type { Database } from "../db/db.js";

const TASK_ID_PATTERN = /^([A-Z][A-Z0-9]*)-(\d+)$/;

export type TaskIdIntegrityAnomalyKind =
  | "duplicate_active_id"
  | "id_in_active_and_archived"
  | "next_sequence_at_or_below_used"
  | "task_row_outside_known_prefix";

export interface TaskIdIntegrityAnomaly {
  kind: TaskIdIntegrityAnomalyKind;
  prefix: string;
  affectedIds: string[];
  details: string;
}

export interface TaskIdIntegrityReport {
  status: "ok" | "anomaly";
  checkedAt: string;
  anomalies: TaskIdIntegrityAnomaly[];
}

/**
 * A task-ID integrity measurement that could not be taken.
 *
 * `TaskIdIntegrityReport.status` is deliberately NOT widened to carry this case: `"ok" | "anomaly"`
 * is a partition of *completed scans*, and RUFU-301's async proof test asserts `status` literally.
 * A failed measurement is therefore a separate union arm rather than a third value inside the verdict
 * enum, which also keeps every existing `TaskIdIntegrityReport` consumer compiling unchanged.
 *
 * FNXC:TaskIdIntegrityCanary 2026-10-18-22:31 (RUFU-333):
 * RUFU-301 fixed only the async arm, so this synchronous detector stayed fail-open: every read
 * failure — the removed-SQLite `db` stub throwing, the production `/api/health` route's
 * `:memory:`-stub path, a lock timeout — reached the outer `catch { return buildReport(checkedAt, []) }`
 * and was published as `status: "ok"` with zero anomalies, byte-identical to a scan that had
 * genuinely run. A canary that cannot fail is not a canary, and the false verdict came from the
 * store itself rather than from the probe, which is why it survived RUFU-301 untouched. This failure
 * shape is the shared answer both arms now return.
 */
export interface TaskIdIntegrityMeasurementFailure {
  status: "error";
  checkedAt: string;
  /** Empty by construction: an unfinished measurement examined nothing, so it may not allege anomalies either way. */
  anomalies: [];
  /** Human-readable cause for logs and operator surfaces. */
  error: string;
}

/**
 * Everything a task-ID integrity read path may legitimately hand back: a completed scan (either
 * verdict) or an explicit statement that the scan did not happen.
 *
 * FNXC:TaskIdIntegrityCanary 2026-10-18-22:31 (RUFU-333):
 * Declaring only the two report shapes let every cache, merge, and accessor in the store express
 * "we do not know" as `"ok"`, because nothing else was representable. This union makes the honest
 * answer the default-constructible one, and is the one vocabulary engine and dashboard share for
 * integrity health.
 */
export type TaskIdIntegrityState = TaskIdIntegrityReport | TaskIdIntegrityMeasurementFailure;

/*
FNXC:TaskIdIntegrityCanary 2026-10-18-22:31 (RUFU-333):
`checkedAt` has no absent form, so an unmeasured state still needs a timestamp. The POSIX epoch is
the one value a real scan can never produce, and `error` is a fixed marker rather than a cause, so a
surface can distinguish "never measured" from "measured and failed" without parsing prose.
Consumers compare with `===`, never a date parse, and must never treat this as healthy.
*/
/**
 * The frozen not-measured sentinel. Consumers compare it with `=== TASK_ID_INTEGRITY_NOT_MEASURED`, so
 * the object IDENTITY is the contract and it is exported as a value. It is therefore frozen: one writer
 * stamping a real `checkedAt` or a cause into this shared object would erase the ok / failed /
 * never-measured distinction for every reader at once, and would do it silently.
 *
 * `Object.freeze` is applied as a statement rather than wrapped around the literal on purpose: freezing in
 * the initializer makes the declared type `Readonly<TaskIdIntegrityMeasurementFailure>`, whose `anomalies`
 * widens to `readonly []` and no longer satisfies the interface's `[]`. The statement form keeps the
 * annotated type while still making the object immutably frozen at module-evaluation time.
 */
export const TASK_ID_INTEGRITY_NOT_MEASURED: TaskIdIntegrityMeasurementFailure = {
  status: "error",
  checkedAt: "1970-01-01T00:00:00.000Z",
  anomalies: [],
  error: "not measured",
};
Object.freeze(TASK_ID_INTEGRITY_NOT_MEASURED);

/**
 * A task-ID integrity measurement that could not complete.
 *
 * FNXC:TaskIdIntegrityCanary 2026-09-26-00:50 (RUFU-301):
 * This detector used to swallow every query failure and answer
 * `buildReport(checkedAt, [])`, i.e. `status: "ok"` with zero anomalies. A
 * cancelled, lock-blocked, or otherwise failed read therefore published the
 * same clean verdict as a completed scan, which is how the canary went blind
 * while `/api/health` kept reporting `status: "ok"`. An integrity check that
 * never finished is not a clean result, so no failure path may fabricate a
 * report: the measurement either returns rows it actually read or it raises.
 * Callers map this to an explicitly unmeasured verdict.
 *
 * FNXC:TaskIdIntegrityCanary 2026-10-18-22:31 (RUFU-333):
 * RUFU-301 homed this class in `postgres/async-task-id-integrity.ts`, which left the *sync* arm no
 * importable failure type — one of the reasons it stayed fail-open. It now lives here so both arms
 * import ONE class object; the old `@fusion/core/postgres` path keeps resolving via a re-export.
 * Both arms must keep throwing the same object: the surfaces catch it by identity, and a second
 * class of the same name would type-check while making every `instanceof` guard on one arm's error
 * false on the other arm's.
 */
export class TaskIdIntegrityMeasurementError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Task-ID integrity measurement did not complete: ${reason}`);
    this.name = "TaskIdIntegrityMeasurementError";
    this.cause = cause;
  }
}

type TaskRow = { id: string; source: "tasks" | "archivedTasks" };
type StateRow = { prefix: string; nextSequence: number };
type DuplicateRow = { id: string; duplicateCount: number };

function parseTaskId(taskId: string): { prefix: string; sequence: number } | null {
  const match = taskId.trim().toUpperCase().match(TASK_ID_PATTERN);
  if (!match) {
    return null;
  }

  const sequence = Number.parseInt(match[2], 10);
  if (!Number.isFinite(sequence)) {
    return null;
  }

  return { prefix: match[1], sequence };
}

/*
FNXC:TaskIdIntegrityCanary 2026-10-18-22:31 (RUFU-333):
This probe used to `catch { return false }`. That one line made a FAILED presence check
indistinguishable from a table that is legitimately absent, and because every downstream reader
short-circuits on "absent", the failure did not even stop the scan — it converted a broken
measurement into `status: "ok"` with zero anomalies. The error now propagates to the detector's one
outer catch, which rewraps it as `TaskIdIntegrityMeasurementError` exactly as the async arm does.

The FN-5105 boundary is unchanged and remains honest: a probe that SUCCEEDS and reports the table
absent is a measurement that ran, which is why "tables absent" still yields `ok` with no anomalies
rather than a failure.
*/
function hasTable(db: Database, table: string): boolean {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .all(table) as Array<{ name: string }>;
  return rows.length > 0;
}

function readTaskRows(db: Database, table: "tasks" | "archivedTasks"): TaskRow[] {
  if (!hasTable(db, table)) {
    return [];
  }

  // FNXC:TaskIdIntegrityCanary 2026-10-18-22:31 (RUFU-333): the old `catch { return [] }` here turned a
  // failed id read into "no ids exist", i.e. a clean verdict. Read failures propagate uncaught to the
  // detector's single outer rewrap.
  // FN-5105: intentionally do not filter deletedAt for `tasks`; soft-deleted IDs must remain visible to integrity checks.
  return db
    .prepare(`SELECT id FROM ${table}`)
    .all()
    .map((row) => ({ id: String((row as { id?: unknown }).id ?? ""), source: table }));
}

function readStateRows(db: Database): StateRow[] {
  if (!hasTable(db, "distributed_task_id_state")) {
    return [];
  }

  // FNXC:TaskIdIntegrityCanary 2026-10-18-22:31 (RUFU-333): no swallow-to-empty — an unreadable allocator
  // table is a measurement that did not finish, not a corpus with no allocator rows.
  return db.prepare("SELECT prefix, nextSequence FROM distributed_task_id_state").all() as StateRow[];
}

function readDuplicateActiveIds(db: Database): DuplicateRow[] {
  if (!hasTable(db, "tasks")) {
    return [];
  }

  // FNXC:TaskIdIntegrityCanary 2026-10-18-22:31 (RUFU-333): a failed duplicate GROUP BY used to return no
  // duplicates, which is the one answer a corruption canary must never invent about a query it did not run.
  return db.prepare("SELECT id, COUNT(*) AS duplicateCount FROM tasks GROUP BY id HAVING COUNT(*) > 1").all() as DuplicateRow[];
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function buildReport(checkedAt: string, anomalies: TaskIdIntegrityAnomaly[]): TaskIdIntegrityReport {
  return {
    status: anomalies.length > 0 ? "anomaly" : "ok",
    checkedAt,
    anomalies,
  };
}

/**
 * Scan active, archived, and allocator rows for task-id corruption.
 *
 * The result is a **verdict**, never an admission that the scan did not run: a returned
 * `TaskIdIntegrityReport` always means the measurement finished, and a measurement that did not
 * finish throws `TaskIdIntegrityMeasurementError` with the driver's reason as `cause`. Callers that
 * cache the answer therefore store a `TaskIdIntegrityState` — this report, or an explicit failure /
 * `TASK_ID_INTEGRITY_NOT_MEASURED` — and can never persist `status: "ok"` for work that never happened.
 *
 * FNXC:TaskIdIntegrityCanary 2026-10-18-22:31 (RUFU-333):
 * Three states are the whole contract, and they are not interchangeable:
 * - `"ok"` — the scan ran over the whole corpus and found nothing.
 * - `"anomaly"` — the scan ran and found corruption.
 * - thrown `TaskIdIntegrityMeasurementError` / a cached `status: "error"` — unmeasured. An unmeasured
 *   canary is NOT evidence of a healthy database, and an operator must be able to see it as its own
 *   outcome (RUFU-301 established this for the async arm; the sync arm had no way to say it at all).
 * A legitimately empty corpus (read succeeded, tables absent) stays `"ok"` with zero anomalies — the
 * FN-5105 boundary, deliberately unchanged.
 */
export function detectTaskIdIntegrityAnomalies(db: Database): TaskIdIntegrityReport {
  const checkedAt = new Date().toISOString();

  try {
    const anomalies: TaskIdIntegrityAnomaly[] = [];
    const activeRows = readTaskRows(db, "tasks");
    const archivedRows = readTaskRows(db, "archivedTasks");
    const allRows = [...activeRows, ...archivedRows];

    for (const row of readDuplicateActiveIds(db)) {
      const parsed = parseTaskId(row.id);
      anomalies.push({
        kind: "duplicate_active_id",
        prefix: parsed?.prefix ?? "unknown",
        affectedIds: [row.id],
        details: `Active tasks contains ${row.duplicateCount} rows for ${row.id}.`,
      });
    }

    const archivedIds = new Set(archivedRows.map((row) => row.id));
    const activeAndArchived = uniqueSorted(activeRows.map((row) => row.id).filter((id) => archivedIds.has(id)));
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

    const maxUsedSequenceByPrefix = new Map<string, { maxSequence: number; taskIds: string[] }>();
    for (const row of allRows) {
      const parsed = parseTaskId(row.id);
      if (!parsed) {
        continue;
      }
      const existing = maxUsedSequenceByPrefix.get(parsed.prefix);
      if (!existing || parsed.sequence > existing.maxSequence) {
        maxUsedSequenceByPrefix.set(parsed.prefix, { maxSequence: parsed.sequence, taskIds: [row.id] });
        continue;
      }
      if (parsed.sequence === existing.maxSequence) {
        existing.taskIds.push(row.id);
      }
    }

    for (const stateRow of readStateRows(db)) {
      const prefix = stateRow.prefix.trim().toUpperCase();
      const maxUsed = maxUsedSequenceByPrefix.get(prefix);
      if (!maxUsed) {
        continue;
      }
      if (stateRow.nextSequence <= maxUsed.maxSequence) {
        anomalies.push({
          kind: "next_sequence_at_or_below_used",
          prefix,
          affectedIds: uniqueSorted(maxUsed.taskIds),
          details: `distributed_task_id_state.nextSequence=${stateRow.nextSequence} is at or below existing sequence ${maxUsed.maxSequence} for prefix ${prefix}.`,
        });
      }
    }

    if (hasTable(db, "distributed_task_id_state")) {
      const knownPrefixes = new Set(
        readStateRows(db)
          .map((row) => row.prefix.trim().toUpperCase())
          .filter((prefix) => prefix.length > 0),
      );
      if (knownPrefixes.size > 0) {
        const outsideKnownPrefix = new Map<string, string[]>();
        for (const row of activeRows) {
          const parsed = parseTaskId(row.id);
          const prefix = parsed?.prefix ?? "unknown";
          if (!parsed || !knownPrefixes.has(prefix)) {
            outsideKnownPrefix.set(prefix, [...(outsideKnownPrefix.get(prefix) ?? []), row.id]);
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

    return buildReport(checkedAt, anomalies);
  } catch (error) {
    // FNXC:TaskIdIntegrityCanary 2026-10-18-22:31 (RUFU-333):
    // This was `catch { return buildReport(checkedAt, []) }` — the fail-open appeasement this card exists
    // to delete. An unfinished scan now raises with the driver's reason attached as `cause`, mirroring the
    // single rewrap the async arm has used since RUFU-301, so neither arm can answer "clean" about work it
    // did not do. An already-classified failure is re-thrown untouched rather than double-wrapped.
    if (error instanceof TaskIdIntegrityMeasurementError) {
      throw error;
    }
    throw new TaskIdIntegrityMeasurementError(error);
  }
}
