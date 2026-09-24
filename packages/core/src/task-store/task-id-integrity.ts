/**
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * Domain rename from remaining-ops-5: task-id integrity reports, archive reads,
 * FTS write recovery, and related persistence helpers.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */

import { TaskStore } from "../store.js";
import { emitBoundedRunAudit } from "../run-audit/emit-bounded-run-audit.js";
/* FNXC:RunAudit 2026-08-20-05:49: FN-9177 bounds optional audit telemetry so synchronous store helpers remain non-blocking. */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { ArchiveDatabase } from "../db/archive-db.js";
import { CentralCore } from "../central/central-core.js";
import { Database, fromJson, toJsonNullable } from "../db/db.js";
import { reconcileTaskIdState, resolveLocalNodeId } from "../tasks/distributed-task-id.js";
import { getErrorMessage } from "../process/error-message.js";
import { buildSnippet, extractGoalCitations } from "../goals/goal-citation-extractor.js";
import * as schema from "../postgres/schema/index.js";
import { getTaskCreatedHook } from "../tasks/task-creation-hooks.js";
import { type TaskIdIntegrityReport, detectTaskIdIntegrityAnomalies } from "../tasks/task-id-integrity.js";
import { createBranchGroup as createBranchGroupAsync } from "./async/async-branch-groups.js";
import { findLiveLineageChildren as findLiveLineageChildrenAsync, projectPartition } from "./async/async-lifecycle.js";
import { recordRunAuditEvent as recordRunAuditEventAsync } from "./async/async-audit.js";
import { recordRunAuditEventWithinTransaction } from "../postgres/data-layer.js";
import { insertTaskRowInTransaction, isTaskIdConflictError, readTaskRow, readTaskRowInTransaction } from "./async/async-persistence.js";
import { TASK_PERSIST_SQL_COLUMNS, TASK_UPSERT_SQL_ASSIGNMENTS, type TaskRow } from "./persistence.js";
import { purgeTaskWorkflowSelectionRowsAsyncImpl } from "./workflow-definitions.js";

import { ConfigRow } from "./row-types.js";
import { ARCHIVE_AGENT_LOG_SNAPSHOT_LIMIT } from "./serialization.js";
import { ActivityLogEntry, ArchiveAgentLogMode, ArchivedTaskEntry, BoardConfig, BranchGroup, BranchGroupCreateInput, GoalCitationInput, GoalCitationSurface, RunAuditEventInput, Settings, Task, TaskCreateInput } from "../types.js";
import { resolveAllOptionalGroupIds } from "../workflows/workflow-optional-steps.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DependencyCycleError, TaskDeletedError, TombstonedTaskResurrectionError, TombstonePurgeUnauditedError, coreLog, detectDependencyCycle, storeLog } from "../store.js";
import { ARCHIVED_SENTINEL_LANES } from "../project-lane-vocabulary.js";

export function trackDeferredTaskCreatedWorkImpl(store: TaskStore, work: () => Promise<void>): Promise<void> {
    if (store.closing) return Promise.resolve();
    const promise = (async () => {
      if (store.closing) return;
      await work();
    })();
    store.deferredTaskCreatedWork.add(promise);
    return promise.finally(() => {
      store.deferredTaskCreatedWork.delete(promise);
    });
}

/*
FNXC:PostgresOnlyDataAccess 2026-07-16-10:20:
Backend mode intentionally has no synchronous SQLite escape hatch. Name the
AsyncDataLayer route and authoring guide in this failure so plugin authors fix
the durable-data boundary rather than adding a backend-specific fallback.
*/
export function dbImpl(_store: TaskStore): Database {
        throw new Error(
      "TaskStore.db: SQLite Database is not available in backend mode (PostgreSQL/AsyncDataLayer injected). Use ctx.taskStore.getAsyncLayer() / an async store — see docs/PLUGIN_AUTHORING.md",
    );
}

export function archiveDbImpl(_store: TaskStore): ArchiveDatabase {
        throw new Error(
      "TaskStore.archiveDb: SQLite ArchiveDatabase is not available in backend mode (AsyncDataLayer injected)",
    );
}

export function buildTaskIdIntegrityFallbackReportImpl(_store: TaskStore): TaskIdIntegrityReport {
    return {
      status: "ok",
      checkedAt: new Date().toISOString(),
      anomalies: [],
    };
}

export function detectAndCacheTaskIdIntegrityReportImpl(store: TaskStore): TaskIdIntegrityReport {
    const report = detectTaskIdIntegrityAnomalies(store.db);
    store.taskIdIntegrityReport = report;
    const signature = report.status === "anomaly" ? JSON.stringify(report.anomalies) : null;
    if (report.status === "anomaly" && signature !== store.lastTaskIdIntegrityLogSignature) {
      coreLog.error("[task-id-integrity] anomaly detected", { anomalies: report.anomalies });
    }
    store.lastTaskIdIntegrityLogSignature = signature;
    return report;
}

export function mergeTaskIdIntegrityReportsImpl(store: TaskStore, ...reports: TaskIdIntegrityReport[]): TaskIdIntegrityReport {
    const checkedAt = reports[reports.length - 1]?.checkedAt ?? new Date().toISOString();
    const seen = new Set<string>();
    const anomalies = reports.flatMap((report) => report.anomalies).filter((anomaly) => {
      const key = JSON.stringify(anomaly);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    return {
      status: anomalies.length > 0 ? "anomaly" : "ok",
      checkedAt,
      anomalies,
    };
}

export function refreshTaskIdIntegrityReportImpl(store: TaskStore): TaskIdIntegrityReport {
    try {
      return store.detectAndCacheTaskIdIntegrityReport();
    } catch (error) {
      const fallback = store.buildTaskIdIntegrityFallbackReport();
      store.taskIdIntegrityReport = fallback;
      store.lastTaskIdIntegrityLogSignature = null;
      coreLog.warn("[task-id-integrity] detector failed; degrading to healthy report", {
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
}

export function reconcileDistributedTaskIdStateOnOpenImpl(store: TaskStore): void {
    if (store.taskIdStateReconciled) {
      return;
    }
    const previousReport = store.taskIdIntegrityReport;
    const preReconcileReport = store.refreshTaskIdIntegrityReport();
    reconcileTaskIdState(store.db);
    const postReconcileReport = store.refreshTaskIdIntegrityReport();
    store.taskIdIntegrityReport = store.mergeTaskIdIntegrityReports(
      previousReport,
      preReconcileReport,
      postReconcileReport,
    );
    store.taskIdStateReconciled = true;
}

export async function readPromptForArchiveImpl(store: TaskStore, taskId: string): Promise<string | undefined> {
    const promptPath = join(store.taskDir(taskId), "PROMPT.md");
    if (!existsSync(promptPath)) {
      return undefined;
    }
    // FNXC:TaskDetailPromptResilience 2026-07-10-15:00 (merge port from main):
    // best-effort — an unreadable PROMPT.md must not fail archiving; the
    // archive entry simply omits the prompt text.
    try {
      return await readFile(promptPath, "utf-8");
    } catch (err) {
      storeLog.warn(`[task-detail] failed to read PROMPT.md for archive of ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
}

export async function buildArchivedAgentLogFieldsImpl(store: TaskStore,
    taskId: string,
    mode: ArchiveAgentLogMode,
  ): Promise<Pick<ArchivedTaskEntry, "agentLogMode" | "agentLogSummary" | "agentLogSnapshot" | "agentLogFull">> {
    if (mode === "none") {
      return { agentLogMode: mode };
    }

    if (mode === "full") {
      const entries = await store.getAgentLogs(taskId);
      return {
        agentLogMode: mode,
        agentLogSummary: store.summarizeAgentLog(entries, entries.length),
        agentLogFull: entries,
      };
    }

    const [totalCount, snapshot] = await Promise.all([
      store.getAgentLogCount(taskId),
      store.getAgentLogs(taskId, { limit: ARCHIVE_AGENT_LOG_SNAPSHOT_LIMIT }),
    ]);
    return {
      agentLogMode: mode,
      agentLogSummary: store.summarizeAgentLog(snapshot, totalCount),
      agentLogSnapshot: snapshot,
    };
}

export function scanAndRecordCitationsImpl(store: TaskStore,
    text: string,
    surface: GoalCitationSurface,
    sourceRef: string,
    agentId: string,
    taskId?: string,
    timestamp?: string,
  ): GoalCitationInput[] {
    const matches = extractGoalCitations(text);
    if (matches.length === 0) {
      return [];
    }

    return matches.map((match) => ({
      goalId: match.goalId,
      agentId,
      ...(taskId ? { taskId } : {}),
      surface,
      sourceRef,
      snippet: buildSnippet(text, match.index),
      ...(timestamp ? { timestamp } : {}),
    }));
}

export function insertTaskImpl(store: TaskStore, task: Task): void {
    const values = store.getTaskPersistValues(task);
    const placeholders = values.map(() => "?").join(", ");
    store.db.prepare(`
      INSERT INTO tasks (${TASK_PERSIST_SQL_COLUMNS})
      VALUES (${placeholders})
    `).run(...values);
    store.db.bumpLastModified();
}

export function upsertTaskImpl(store: TaskStore, task: Task): void {
    const values = store.getTaskPersistValues(task);
    const placeholders = values.map(() => "?").join(", ");
    store.db.prepare(`
      INSERT INTO tasks (${TASK_PERSIST_SQL_COLUMNS})
      VALUES (${placeholders})
      ON CONFLICT(id) DO UPDATE SET
${TASK_UPSERT_SQL_ASSIGNMENTS}
    `).run(...values);
    store.db.bumpLastModified();
}

export function logTaskCreateConflictImpl(store: TaskStore, task: Task, operation: string, error: unknown): void {
    storeLog.error("Refused colliding task create", {
      phase: "task-create:id-conflict",
      operation,
      taskId: task.id,
      column: task.column,
      sourceType: task.sourceType,
      error: error instanceof Error ? error.message : String(error),
    });
}

export function runTaskFtsWriteWithRecoveryImpl(store: TaskStore, taskId: string, operation: string, write: () => void): void {
    void store; void taskId; void operation;
    write();
  }

export function patchTaskRowInTransactionImpl(store: TaskStore,
    id: string,
    task: Task,
    changedColumns: Iterable<keyof TaskRow>,
    existingRow?: TaskRow,
  ): { deletedAt?: string; current?: Task } {
    const currentRow = existingRow ?? store.readTaskRowFromDb(id, { includeDeleted: true });
    const deletedAt = store.getSoftDeletedWriteConflict(id, task, currentRow);
    if (deletedAt) {
      return { deletedAt };
    }
    if (!currentRow || currentRow.deletedAt != null) {
      store.upsertTaskWithFtsRecovery(task);
      return { current: store.readTaskFromDb(id) };
    }

    const patchDescriptors = store.getTaskPatchDescriptors(changedColumns);
    const context = store.createTaskPersistSerializationContext(task, currentRow);
    const assignments = patchDescriptors.map((descriptor) => `${descriptor.sqlIdentifier} = ?`);
    assignments.push("updatedAt = ?");
    const values = patchDescriptors.map((descriptor) => descriptor.serialize(task, context));
    values.push(task.updatedAt, id);

    store.runTaskFtsWriteWithRecovery(id, "partial update", () => {
      store.db.prepare(`
        UPDATE tasks
        SET ${assignments.join(", ")}
        WHERE id = ? AND ${TaskStore.ACTIVE_TASKS_WHERE}
      `).run(...values);
    });
    store.db.bumpLastModified();
    return { current: store.readTaskFromDb(id) };
}

/*
FNXC:PostgresOnlyDataAccess 2026-07-17-15:10:
`applyTaskPatchImpl` (the low-level sync SQLite column-patch primitive) was
removed: it had zero callers in either mode, and its `store.db.transactionImmediate`
+ `patchTaskRowInTransaction` body only ran against the deleted SQLite runtime.
Task writes go through the async persistence helpers (upsertTaskRowInTransaction /
updateTaskColumns). The public `TaskStore.applyTaskPatch` facade was removed with it.
*/

export function readTaskFromDbImpl(store: TaskStore, id: string, options?: { activityLogLimit?: number; includeDeleted?: boolean }): Task | undefined {
    const selectClause = options?.activityLogLimit
      ? store.getTaskSelectClauseWithActivityLogLimit(options.activityLogLimit)
      : "*";
    const whereClause = options?.includeDeleted ? "id = ?" : `id = ? AND ${TaskStore.ACTIVE_TASKS_WHERE}`;
    const row = store.db.prepare(`SELECT ${selectClause} FROM tasks WHERE ${whereClause}`).get(id) as TaskRow | undefined;
    if (!row) return undefined;
    return store.rowToTask(row);
}

export async function getMergeQueuedTaskIdsAsyncImpl(store: TaskStore): Promise<Set<string>> {
    
    const layer = store.asyncLayer!;
    const rows = await layer.db
      .select({ taskId: schema.project.mergeQueue.taskId })
      .from(schema.project.mergeQueue);
    return new Set(rows.map((row) => row.taskId));
}

export function isTaskIdPresentInArchivedTasksTableImpl(_store: TaskStore, _id: string): boolean {
    /*
    FNXC:IncompletePgPorts 2026-07-26-20:30:
    Sync archive-table probe remains SQLite-only. PostgreSQL callers must use
    isTaskIdPresentInArchivedTasksTableAsyncImpl / taskIdExistsAnywhere (async).
    Returning false here avoids opening the removed SQLite Database stub.
    */
        return false;
}

/*
FNXC:IncompletePgPorts 2026-07-26-20:30:
PostgreSQL archive authority is project.archived_tasks (warm) and
archive.archived_tasks (cold). Both must reserve task IDs the same way the
legacy SQLite archivedTasks / archive.db tables did.
*/
export async function isTaskIdPresentInArchivedTasksTableAsyncImpl(store: TaskStore, id: string): Promise<boolean> {
    
    const layer = store.asyncLayer!;
    const partition = projectPartition(layer.projectId);
    const [projectArchive, coldArchive] = await Promise.all([
      layer.db
        .select({ id: schema.project.archivedTasks.id })
        .from(schema.project.archivedTasks)
        .where(and(
          eq(schema.project.archivedTasks.projectId, partition),
          eq(schema.project.archivedTasks.id, id),
        ))
        .limit(1),
      layer.db
        .select({ id: schema.archive.archivedTasks.id })
        .from(schema.archive.archivedTasks)
        .where(and(
          eq(schema.archive.archivedTasks.projectId, partition),
          eq(schema.archive.archivedTasks.id, id),
        ))
        .limit(1),
    ]);
    return projectArchive.length > 0 || coldArchive.length > 0;
}

export async function taskIdExistsAnywhereImpl(store: TaskStore, id: string): Promise<boolean> {
    /*
    FNXC:IncompletePgPorts 2026-07-26-20:30:
    Backend-mode: live/soft-deleted rows via readTaskRow, then warm+cold archive
    tables so IDs stay permanently reserved (FN-5105 parity with SQLite).
    */
        const row = await readTaskRow(store.asyncLayer!, id, { includeDeleted: true });
    if (row) return true;
    return isTaskIdPresentInArchivedTasksTableAsyncImpl(store, id);
}

/*
FNXC:VanishedTaskDetection 2026-09-23-21:28:
`taskIdExistsAnywhere` answers "is this id taken?" and therefore flattens three operationally
different states into one boolean: a live row, a soft-delete tombstone (id reserved, work never
removed), and an archive-table snapshot. An engine-side detector that has to explain *why* a card
is off every board cannot recover that distinction from a boolean, and re-deriving lane semantics
in the engine would duplicate core's read authority. This resolver is that missing branch: one
round trip that reports the presence shape, including the tombstone's `deletedAt`.

The tombstone branch is the one RUFU-225 needed. Its `task.json` mirror still read
`column: in-review` with a passed code-review verdict while no board query resolved the id; the
correct answer was "the row is a tombstone, its id is still reserved, only the disk mirror is
stale" — which is only sayable if the read exposes it.
*/

/** Presence shape of one task id across every table that can hold it. */
export interface TaskIdPresence {
  /** Present in `tasks` (including soft-deleted) or in either archive table. */
  rowExistsAnywhere: boolean;
  /** A `tasks` row exists with no `deletedAt` — the row is live. */
  liveRowExists: boolean;
  /** The `tasks` row exists with `deletedAt` set, so the id stays reserved. */
  tombstoned: boolean;
  /** ISO timestamp of the tombstone, when known. */
  tombstonedAt: string | null;
  /** The id is held only by the warm or cold archive table. */
  inArchive: boolean;
}

/** Normalize a `deletedAt` column value (string, Date, or epoch) to an ISO string or null. */
function normalizeDeletedAt(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number") return Number.isFinite(value) ? new Date(value).toISOString() : null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
  }
  return null;
}

/** Chunk size for the batched presence `IN` lists, well inside Postgres' parameter ceiling. */
const TASK_ID_PRESENCE_CHUNK_SIZE = 500;

/**
 * Batched form of {@link resolveTaskIdPresenceImpl}: three chunked reads (live+soft-deleted task
 * rows, warm archive, cold archive) instead of three reads per id. A maintenance sweep that must
 * classify every task directory on disk would otherwise issue thousands of point queries every
 * ~15 minutes for a result that is one hash join in the database.
 *
 * Ids absent from every table are simply missing from the returned map.
 */
export async function resolveTaskIdPresenceForIdsImpl(
  store: TaskStore,
  ids: string[],
): Promise<Map<string, TaskIdPresence>> {
  const presence = new Map<string, TaskIdPresence>();
  if (ids.length === 0) return presence;
  const layer = store.asyncLayer!;
  const partition = layer.projectId;

  for (let offset = 0; offset < ids.length; offset += TASK_ID_PRESENCE_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + TASK_ID_PRESENCE_CHUNK_SIZE);
    const taskConds = [inArray(schema.project.tasks.id, chunk)];
    if (partition) taskConds.push(eq(schema.project.tasks.projectId, partition));
    const taskRows = await layer.db
      .select({ id: schema.project.tasks.id, deletedAt: schema.project.tasks.deletedAt })
      .from(schema.project.tasks)
      .where(and(...taskConds));
    for (const row of taskRows) {
      const tombstonedAt = normalizeDeletedAt((row as { deletedAt?: unknown }).deletedAt);
      presence.set(row.id, tombstonedAt
        ? { rowExistsAnywhere: true, liveRowExists: false, tombstoned: true, tombstonedAt, inArchive: false }
        : { rowExistsAnywhere: true, liveRowExists: true, tombstoned: false, tombstonedAt: null, inArchive: false });
    }

    const archivedIds = new Set<string>();
    for (const table of [schema.project.archivedTasks, schema.archive.archivedTasks]) {
      const archiveConds = [inArray(table.id, chunk)];
      if (partition) archiveConds.push(eq(table.projectId, partition));
      const rows = await layer.db.select({ id: table.id }).from(table).where(and(...archiveConds));
      for (const row of rows) archivedIds.add(row.id);
    }
    for (const id of archivedIds) {
      if (!presence.has(id)) presence.set(id, { rowExistsAnywhere: true, liveRowExists: false, tombstoned: false, tombstonedAt: null, inArchive: true });
    }
  }

  return presence;
}

export async function resolveTaskIdPresenceImpl(store: TaskStore, id: string): Promise<TaskIdPresence> {
  const row = await readTaskRow(store.asyncLayer!, id, { includeDeleted: true });
  if (row) {
    const tombstonedAt = normalizeDeletedAt((row as { deletedAt?: unknown }).deletedAt);
    return tombstonedAt
      ? { rowExistsAnywhere: true, liveRowExists: false, tombstoned: true, tombstonedAt, inArchive: false }
      : { rowExistsAnywhere: true, liveRowExists: true, tombstoned: false, tombstonedAt: null, inArchive: false };
  }
  const inArchive = await isTaskIdPresentInArchivedTasksTableAsyncImpl(store, id);
  return { rowExistsAnywhere: inArchive, liveRowExists: false, tombstoned: false, tombstonedAt: null, inArchive };
}

/*
FNXC:TombstonePurgeAudit 2026-09-23-21:28:
The resurrection purge used to be the only path in the product that physically removed a task row
with no durable record of the removal: the audit row existed solely on the *blocked* branch, so a
successful purge left nothing behind and a later "where did this card go?" was unanswerable. The
`task:deleted` row cannot cover it either — a tombstone was already soft-deleted, and the
low-level row writer used by retention paths emits no outbox event at all.

The purge is now audit-and-delete in one transaction, which is what makes it fail closed: Drizzle
rolls the whole transaction back when the audit insert fails, so an unaudited physical removal is
not reachable by ordering. `run_audit_events.task_id` carries no foreign key, so writing the row
before deleting its task is safe, and `idxRunAuditEventsTaskIdTimestamp` keeps it findable.
This writer is deliberately awaited and unbounded (transactional audit, class C per
`docs/run-audit.md`): it shares the mutation transaction, so bounding it would either lose the
record or allow the delete it exists to gate.
*/

export async function maybeResolveTombstonedTaskIdImpl(store: TaskStore,
    id: string,
    input: Pick<TaskCreateInput, "forceResurrect">,
    operation: "createTask" | "duplicateTask" | "refineTask",
  ): Promise<void> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26-10:15:
     * Backend-mode: use async Drizzle readTaskRow (includeDeleted) instead of
     * sync readTaskFromDb, and hard-delete via the layer. This unblocks
     * createTaskWithReservedId in backend mode (VAL-DATA-005/006).
     */
    const row = await readTaskRow(store.asyncLayer!, id, { includeDeleted: true });
    const existing: { deletedAt?: string | null; allowResurrection?: boolean | number | null } | undefined = row
      ? {
          deletedAt: row.deletedAt as string | null | undefined,
          allowResurrection: row.allowResurrection as boolean | number | null | undefined,
        }
      : undefined;

    if (!existing?.deletedAt) return;

    const allowResurrection = existing.allowResurrection === true || existing.allowResurrection === 1;
    if (input.forceResurrect === true || allowResurrection) {
      /*
      FNXC:SqliteDualPathCleanup 2026-07-26-15:00:
      Project-scope hard-delete after tombstone resurrection so another project's matching id is untouched.
      */
      const layer = store.asyncLayer!;
      const delConds = [eq(schema.project.tasks.id, id)];
      if (layer.projectId) delConds.push(eq(schema.project.tasks.projectId, layer.projectId));
      const purgedStepCount = Array.isArray((row as { workflowStepResults?: unknown }).workflowStepResults)
        ? (row as { workflowStepResults: unknown[] }).workflowStepResults.length
        : 0;
      try {
        await layer.transactionImmediate(async (tx) => {
          await recordRunAuditEventWithinTransaction(tx, {
            taskId: id,
            agentId: "system",
            runId: "unknown",
            domain: "database",
            mutationType: "task:row-purged-for-resurrection",
            target: `task:${id}`,
            metadata: {
              taskId: id,
              operation,
              allowResurrection,
              forceResurrect: input.forceResurrect === true,
              deletedAtPresent: true,
              purgedWorkflowStepCount: purgedStepCount,
            },
          });
          await tx.delete(schema.project.tasks).where(and(...delConds));
        });
      } catch (error) {
        /*
        FNXC:TombstonePurgeAudit 2026-09-23-21:28:
        Any failure — including an audit-insert failure — rolled the transaction back, so the
        tombstone is intact and the id is still reserved. Surface it as a typed refusal instead of
        leaking a raw driver error: the caller's create/duplicate/refine simply does not proceed.
        */
        storeLog.warn(`[tombstone-purge-refused] ${id} audit write failed, tombstone preserved: ${getErrorMessage(error)}`);
        throw new TombstonePurgeUnauditedError(id, { cause: error });
      }

      /*
      FNXC:TombstonePurgeAudit 2026-09-24-00:12 (RUFU-283):
      The child purge moved to AFTER the committed audit+delete. It used to run first, which left a
      refused purge half-done: the tombstone survived (the transaction rolled back) but its
      `task_workflow_selection` row and materialized `workflow_steps` children were already gone, so
      the preserved card had a selection pointing at deleted steps. Reversing the order makes the
      refusal atomic instead — nothing is removed unless the audit row is durable — and the ordering
      is safe here specifically because neither child table declares a foreign key to `tasks`, so
      the parent delete cannot be blocked by them. A crash in the window between commit and child
      purge leaves orphaned child rows, which `cleanupOrphanedMaterializedSteps` already owns;
      orphaned children are strictly safer than an unaudited removal or a gutted tombstone.
      Best-effort because the row it described is already gone — a failure is logged, not thrown.
      */
      try {
        await purgeTaskWorkflowSelectionRowsAsyncImpl(store, id);
      } catch (error) {
        storeLog.warn(`[tombstone-purge-child-cleanup] ${id} selection/step children survived the purge: ${getErrorMessage(error)}`);
      }

      return;
    }

    storeLog.warn(`[tombstone-resurrection-blocked] ${id} deletedAt=${existing.deletedAt}`);
    // FNXC:FixPgTestsAndCi 2026-06-26-09:35:
    // insertRunAuditEventRow is sync and uses store.db (unavailable in backend
    // mode). Use the async recordRunAuditEvent helper so the resurrection-blocked
    // audit row is persisted against PostgreSQL (VAL-DATA-006 forensic surface).
        await recordRunAuditEventAsync(store.asyncLayer!, {
      taskId: id,
      agentId: "system",
      runId: "unknown",
      domain: "database",
      mutationType: "task:resurrection-blocked",
      target: id,
      metadata: {
        id,
        deletedAt: existing.deletedAt,
        allowResurrection,
        operation,
      },
    });

    throw new TombstonedTaskResurrectionError(id, existing.deletedAt, allowResurrection);
}

export function findLiveDependentsImpl(store: TaskStore, id: string): string[] {
    const rows = store.db
      .prepare(`SELECT id, dependencies FROM tasks WHERE dependencies LIKE ? AND id != ? AND ${TaskStore.ACTIVE_TASKS_WHERE}`)
      .all(`%${id}%`, id) as Array<{ id: string; dependencies: string | null }>;

    const dependents: string[] = [];
    for (const row of rows) {
      if (!row.dependencies) continue;
      try {
        const deps = JSON.parse(row.dependencies) as unknown;
        if (Array.isArray(deps) && deps.includes(id)) {
          dependents.push(row.id);
        }
      } catch {
        // Malformed JSON — skip; nothing we can verify.
      }
    }
    return dependents;
}

export async function findLiveLineageChildrenImpl(store: TaskStore, id: string): Promise<string[]> {
        const layer = store.asyncLayer!;
    /* FNXC:TaskArchiveRemoval 2026-09-04-18:25 DELIBERATE-LITERAL: historical-sentinel children are not live; archive is not a workflow role. */
    return findLiveLineageChildrenAsync(layer.db, id, layer.projectId, ARCHIVED_SENTINEL_LANES);
}

export function recordActivityFromListenerImpl(store: TaskStore,
    entry: Omit<ActivityLogEntry, "id" | "timestamp">,
    sourceEvent: string,
  ): void {
    store.recordActivity(entry).catch((err) => {
      storeLog.warn("Activity logging listener failed", {
        sourceEvent,
        type: entry.type,
        taskId: entry.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

export function withConfigLockImpl<T>(store: TaskStore, fn: () => Promise<T>): Promise<T> {
    let resolve: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    const prev = store.configLock;
    store.configLock = next;

    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        resolve!();
      }
    });
}

export function withWorktreeAllocationLockImpl<T>(store: TaskStore, fn: () => Promise<T>): Promise<T> {
    let resolve: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    const prev = store.worktreeAllocationLock;
    store.worktreeAllocationLock = next;

    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        resolve!();
      }
    });
}

export function withTaskLockImpl<T>(store: TaskStore, id: string, fn: () => Promise<T>): Promise<T> {
    const prev = store.taskLocks.get(id) ?? Promise.resolve();
    let resolve: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    store.taskLocks.set(id, next);

    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        if (store.taskLocks.get(id) === next) {
          store.taskLocks.delete(id);
        }
        resolve!();
      }
    });
}

export function insertRunAuditEventRowImpl(store: TaskStore, input: Omit<RunAuditEventInput, "agentId" | "runId"> & { agentId?: string; runId?: string }): void {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-25:
     * In backend mode, delegate to the async recordRunAuditEvent helper.
     * This fixes all 30+ call sites that use insertRunAuditEventRow in
     * sync code paths that need to work against PostgreSQL. The async
     * write is fire-and-forget (void) matching the sync semantics.
     */
    if (store.backendMode && store.asyncLayer) {
      const eventId = randomUUID();
      const agentId = input.agentId ?? "store";
      const runId = input.runId ?? `store:${input.mutationType}:${input.taskId ?? input.target}:${eventId}`;
      void emitBoundedRunAudit(
        { recordRunAuditEvent: (event) => recordRunAuditEventAsync(store.asyncLayer!, event) },
        {
          timestamp: input.timestamp,
          taskId: input.taskId,
          agentId,
          runId,
          domain: input.domain,
          mutationType: input.mutationType,
          target: input.target,
          metadata: input.metadata as Record<string, unknown> | undefined,
        },
        { log: { warn: (detail) => storeLog.warn(`[run-audit-event-failed] ${input.mutationType}:${input.taskId ?? input.target}`, { error: detail }) } },
      );
      return;
    }
    const eventId = randomUUID();
    const timestamp = input.timestamp ?? new Date().toISOString();
    const agentId = input.agentId ?? "store";
    const runId = input.runId ?? `store:${input.mutationType}:${input.taskId ?? input.target}:${eventId}`;
    store.db.prepare(`
      INSERT INTO runAuditEvents (
        id, timestamp, taskId, agentId, runId, domain, mutationType, target, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      timestamp,
      input.taskId ?? null,
      agentId,
      runId,
      input.domain,
      input.mutationType,
      input.target,
      toJsonNullable(input.metadata),
    );
}

export function throwSoftDeletedWriteBlockedImpl(store: TaskStore,
    id: string,
    deletedAt: string,
    operation: string,
    auditInput?: {
      agentId?: string;
      runId?: string;
      timestamp?: string;
    },
  ): never {
    storeLog.warn(`[soft-delete-resurrection-blocked] refusing ${operation} for ${id}`, {
      id,
      deletedAt,
      operation,
    });
    store.insertRunAuditEventRow({
      taskId: id,
      agentId: auditInput?.agentId,
      runId: auditInput?.runId,
      timestamp: auditInput?.timestamp,
      domain: "database",
      mutationType: "task:resurrection-blocked",
      target: id,
      metadata: {
        id,
        deletedAt,
        operation,
      },
    });
    throw new TaskDeletedError(id, deletedAt);
}

export function getMalformedTaskMetadataReasonImpl(store: TaskStore, task: Partial<Task>, expectedId: string): string | undefined {
    if (task.id !== expectedId) {
      return `task.json id ${typeof task.id === "string" ? task.id : "<missing>"} does not match directory ${expectedId}`;
    }
    if (typeof task.description !== "string") {
      return "task.json description must be a string";
    }
    if (typeof task.column !== "string") {
      return "task.json column must be a string";
    }
    if (typeof task.createdAt !== "string" || Number.isNaN(Date.parse(task.createdAt))) {
      return "task.json createdAt must be a valid ISO timestamp string";
    }
    if (typeof task.updatedAt !== "string" || Number.isNaN(Date.parse(task.updatedAt))) {
      return "task.json updatedAt must be a valid ISO timestamp string";
    }
    return undefined;
}

export async function atomicCreateTaskJsonImpl(store: TaskStore, dir: string, task: Task, operation: string): Promise<void> {
    const id = store.getTaskIdFromDir(dir);
    /*
    FNXC:PostgresOnlyDataAccess 2026-07-16-11:05:
    refineTask and duplicateTask create rows through this shared helper via their
    createTaskWithId callbacks, bypassing _createTaskInternal's backend routing, so
    creating a refinement in backend mode threw "SQLite Database is not available".
    This helper must route itself: soft-delete conflict check + non-destructive
    insert in one async transaction (parity with the sync transactionImmediate
    block below), with unique_violation normalized to "Task ID already exists".
    */
        const layer = store.asyncLayer!;
    const context = store.createTaskPersistSerializationContext(task);
    let backendDeletedAt: string | undefined;
    try {
      await layer.transactionImmediate(async (tx) => {
        const pgRow = await readTaskRowInTransaction(tx, id, { includeDeleted: true }, layer.projectId);
        if (pgRow) {
          backendDeletedAt = store.getSoftDeletedWriteConflict(id, task, store.pgRowToTaskRow(pgRow));
          if (backendDeletedAt) return;
        }
        await insertTaskRowInTransaction(tx, task as unknown as Record<string, unknown>, context, layer.projectId);
      });
    } catch (error) {
      if (isTaskIdConflictError(error)) {
        store.logTaskCreateConflict(task, operation, error);
        throw new Error(`Task ID already exists: ${task.id}`);
      }
      throw error;
    }
    if (backendDeletedAt) {
      store.throwSoftDeletedWriteBlocked(id, backendDeletedAt, operation);
    }
    await store.writeTaskJsonFile(dir, task);
    return;
}

export async function readConfigImpl(store: TaskStore): Promise<BoardConfig> {
    const row = store.db.prepare("SELECT * FROM config WHERE id = 1").get() as unknown as ConfigRow | undefined;
    if (!row) {
      return { nextId: 1 };
    }
    const config: BoardConfig = {
      nextId: row.nextId || 1,
      settings: fromJson<Settings>(row.settings),
    };

    // Backward-compatibility for internal callers/tests that still access these fields.
    // Keep them non-enumerable so config.json writes don't include workflow steps.
    const workflowSteps = store.listWorkflowSteps();
    Object.defineProperty(config, "workflowSteps", {
      value: await workflowSteps,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(config, "nextWorkflowStepId", {
      value: row.nextWorkflowStepId || 1,
      writable: true,
      configurable: true,
      enumerable: false,
    });

    return config;
}

export function readConfigFastImpl(store: TaskStore): BoardConfig {
    const row = store.db.prepare("SELECT * FROM config WHERE id = 1").get() as ConfigRow | undefined;
    if (!row) {
      return { nextId: 1 };
    }
    return {
      nextId: row.nextId || 1,
      settings: fromJson<Settings>(row.settings),
    };
}

export async function resolveLocalNodeIdForTaskAllocationImpl(_store: TaskStore): Promise<string> {
    if (process.env.VITEST === "true") {
      return "local";
    }
    const central = new CentralCore();
    await central.init();
    try {
      const nodes = await central.listNodes();
      return resolveLocalNodeId(nodes.map((node) => ({ id: node.id, type: node.type })));
    } catch {
      return "local";
    } finally {
      await central.close();
    }
}

export function toBuiltInWorkflowStepImpl(store: TaskStore, template: import("../types.js").WorkflowStepTemplate): import("../types.js").WorkflowStep {
    const now = new Date().toISOString();
    return {
      id: template.id,
      templateId: template.id,
      name: template.name,
      description: template.description,
      mode: "prompt",
      phase: "pre-merge",
      gateMode: "advisory",
      prompt: template.prompt,
      toolMode: template.toolMode || "readonly",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
}

export function getLegacyWorkflowStepSnapshotImpl(_store: TaskStore, _id: string, _templateId?: string): Record<string, unknown> | undefined {
    // FNXC:PostgresOnlyDataAccess 2026-07-16-12:55: the legacy snapshot lives
    // only in the pre-migration SQLite config.workflowSteps JSON blob; a
    // PostgreSQL deployment has no legacy snapshot, so overrides never apply.
        return undefined;
}

export function applyLegacyWorkflowStepOverridesImpl(store: TaskStore, step: import("../types.js").WorkflowStep): import("../types.js").WorkflowStep {
    const legacy = store.getLegacyWorkflowStepSnapshot(step.id, step.templateId);
    if (!legacy) {
      return step;
    }

    const normalized = { ...step };
    if (!Object.prototype.hasOwnProperty.call(legacy, "mode")) {
      normalized.mode = "prompt";
    }
    if (!Object.prototype.hasOwnProperty.call(legacy, "phase")) {
      normalized.phase = undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(legacy, "gateMode")) {
      normalized.gateMode = "advisory";
    }

    return normalized;
}

export async function optionalGroupIdSetImpl(store: TaskStore, workflowId?: string | null): Promise<Set<string>> {
    const wfId = workflowId ?? (await store.getDefaultWorkflowId());
    if (!wfId) return new Set();
    const def = await store.getWorkflowDefinition(wfId);
    if (!def || def.kind === "fragment") return new Set();
    return new Set(resolveAllOptionalGroupIds(def.ir));
}

export async function buildActiveTaskDependencyLookupImpl(store: TaskStore, overrides?: Map<string, readonly string[]>): Promise<Map<string, readonly string[]>> {
    const tasks = await store.listTasks({ includeArchived: false });
    const lookup = new Map<string, readonly string[]>();
    for (const task of tasks) {
      lookup.set(task.id, task.dependencies ?? []);
    }
    if (overrides) {
      for (const [taskId, deps] of overrides.entries()) {
        lookup.set(taskId, deps);
      }
    }
    return lookup;
}

export function recordDependencyCycleRejectedAuditImpl(store: TaskStore,
    taskId: string,
    cyclePath: readonly string[],
    source: "createTask" | "createTaskWithReservedId" | "updateTask" | "replication",
  ): void {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26:
     * In backend mode, delegate to async recordRunAuditEvent via the async layer
     * instead of the synchronous SQLite store.db path. This prevents "SQLite Database
     * is not available" errors when dependency cycles are detected in PG mode.
     */
    if (store.backendMode && store.asyncLayer) {
      const mutationType = source === "replication" ? "task:dependency-cycle-rejected-replication" : "task:dependency-cycle-rejected";
      void emitBoundedRunAudit(
        { recordRunAuditEvent: (event) => recordRunAuditEventAsync(store.asyncLayer!, event) },
        {
          taskId,
          agentId: "store",
          runId: `store:${mutationType}:${taskId}`,
          domain: "database",
          mutationType,
          target: taskId,
          metadata: { taskId, cyclePath, source } as Record<string, unknown>,
        },
        { log: { warn: (detail) => storeLog.warn(`[dependency-cycle-rejected-audit-failed] ${taskId}`, { error: detail }) } },
      );
      return;
    }
    store.insertRunAuditEventRow({
      taskId,
      domain: "database",
      mutationType: source === "replication" ? "task:dependency-cycle-rejected-replication" : "task:dependency-cycle-rejected",
      target: taskId,
      metadata: { taskId, cyclePath, source },
    });
}

export async function assertNoDependencyCycleImpl(store: TaskStore,
    taskId: string,
    dependencies: readonly string[],
    source: "createTask" | "createTaskWithReservedId" | "updateTask" | "replication",
    overrides?: Map<string, readonly string[]>,
  ): Promise<void> {
    if (dependencies.length === 0 && !overrides) return;
    const lookup = await store.buildActiveTaskDependencyLookup(overrides);
    const cyclePath = detectDependencyCycle(taskId, dependencies, (candidateId) => lookup.get(candidateId));
    if (!cyclePath) return;
    store.recordDependencyCycleRejectedAudit(taskId, cyclePath, source);
    if (source === "replication") {
      storeLog.warn("Skipping replicated task create due to dependency cycle", { taskId, cyclePath });
      return;
    }
    throw new DependencyCycleError(taskId, cyclePath);
}

export async function invokeTaskCreatedHookImpl(store: TaskStore, task: Task): Promise<void> {
    const taskCreatedHook = getTaskCreatedHook();
    if (!taskCreatedHook) return;
    try {
      await taskCreatedHook(task, store);
    } catch (error) {
      storeLog.warn(`[task-created-hook] ${task.id}: ${getErrorMessage(error)}`);
    }
}

export async function createBranchGroupImpl(store: TaskStore, input: BranchGroupCreateInput): Promise<BranchGroup> {
        const layer = store.asyncLayer!;
    return createBranchGroupAsync(layer.db, input, layer.projectId);
}
