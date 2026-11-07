/**
 * FNXC:TaskListReadProjectScope 2026-11-07-05:20 (RUFU-871 slice 2):
 * The record-only guard for an unbound task LIST read.
 *
 * `project.tasks` is ONE table shared by every project and partitioned by `project_id`, and
 * task identity is project-local. Slice 1 made the partition a property of every list QUERY;
 * this slice makes the illegal shape — a shared-PostgreSQL layer with no bound project doing a
 * LIST read — VISIBLE instead of silent, because the measured failure was quiet: a dashboard
 * serving one project retained other projects' task/log/steering strings (84.6% of heap,
 * 72 341 copies of a single foreign sentence).
 *
 * It records rather than throws, deliberately and for a stated reason: the violating call-site
 * set has been enumerated by hand only for the three reads slice 1 fixed, and a throw with an
 * unmeasurable blast radius on a process that already gets watchdog-killed is a new outage
 * class, not a diagnostic. The row this module writes IS the enumeration — flipping
 * {@link TASK_LIST_READ_SCOPE_ENFORCEMENT} is the promotion, and it is justified only once
 * production traffic shows the violating call-site set is empty or every site is bound.
 *
 * Legal and unchanged: a layer with no `backend` descriptor (the legacy SQLite store, which
 * isolates by file, or an own-database/compatibility reader) keeps `taskProjectScope`'s
 * documented no-op cross-project read and emits nothing, and so does every BY-ID read and
 * every write on a shared layer — only LIST reads are watched here.
 */
import type { SQL } from "drizzle-orm";

import { createLogger } from "../process/logger.js";
import { emitBoundedRunAudit } from "../run-audit/emit-bounded-run-audit.js";
import type { RunAuditMutationType } from "../types.js";
import { recordRunAuditEvent, taskProjectScope, type AsyncDataLayer } from "./data-layer.js";

/** Where the guard stands today. See the module note for the promotion condition. */
export const TASK_LIST_READ_SCOPE_ENFORCEMENT: "record-only" | "throw" = "record-only";

/** The audit row this guard writes. Declared in `RunAuditMutationType` beside its meaning. */
export const UNBOUND_TASK_LIST_READ_MUTATION: RunAuditMutationType = "task:unbound-list-read";

/*
One row per violating READ SITE per window, not per call and never per row. The lesson is
RUFU-393's: a bound whose key grows every cycle (or that fires per poll) is 16 536 rows for
one card, so the window — not the counter — is the bound, and the counter must never enter
the dedupe key.
*/
export const UNBOUND_TASK_LIST_READ_NOTICE_FLOOR_MS = 15 * 60_000;

const log = createLogger("task-list-scope");
const lastNoticeAtByReader = new Map<string, number>();

/**
 * Raised only when {@link TASK_LIST_READ_SCOPE_ENFORCEMENT} is promoted to `"throw"`.
 * It exists now so the promotion is a one-word config change at one site, with its message
 * already written, rather than a redesign under an incident.
 */
export class UnscopedTaskListReadError extends Error {
  constructor(reader: string) {
    super(
      `Unscoped task list read (${reader}): the PostgreSQL backend keeps every project's cards ` +
        `in ONE shared "project"."tasks" table partitioned by "project_id", and task ids are ` +
        `project-local, so a list read with no bound project returns every project's rows into a ` +
        `process that serves one project. Bind the store to its project — ` +
        `createTaskStoreForBackend({ rootDir, projectId }) from ` +
        `packages/core/src/postgres/startup-factory.ts — and perform the read through that store.`,
    );
    this.name = "UnscopedTaskListReadError";
  }
}

/**
 * The discriminator for "this layer talks to the shared, project-partitioned task table".
 *
 * It reuses the field the backend already publishes rather than a new config flag:
 * `AsyncDataLayer.backend` is populated ONLY by `createAsyncDataLayer` from a
 * `PostgresConnections` set, so its presence means the layer came off the PostgreSQL boot
 * path (`createTaskStoreForBackend` → `createConnectionSet*`). A legacy SQLite-mode store has
 * no async layer at all (`TaskStore.asyncLayer === null`, `isBackendMode() === false`) and
 * isolates by file; `store.ts` already uses this same `asyncLayer && backend` shape to decide
 * "PG backend" for its session advisory locks.
 */
export function usesSharedPostgresTaskTable(layer: Pick<AsyncDataLayer, "backend">): boolean {
  return layer.backend !== undefined;
}

/**
 * Watch one task LIST read. Returns nothing and never throws: on the illegal combination it
 * hands one audit row to the bounded seam (`emitBoundedRunAudit`, so an absent, throwing, or
 * hanging sink cannot alter the read) and logs the same fact once, naming the read site and
 * the remedy.
 *
 * @param reader The `module:export` performing the read, so the row and the log line point at
 *   a bindable call site rather than at a symptom.
 */
export function noteTaskListProjectScope(
  layer: AsyncDataLayer | null | undefined,
  reader: string,
): void {
  if (layer?.projectId?.trim()) return;
  if (!layer || !usesSharedPostgresTaskTable(layer)) return;

  if (TASK_LIST_READ_SCOPE_ENFORCEMENT === "throw") {
    throw new UnscopedTaskListReadError(reader);
  }

  const nowMs = Date.now();
  const prior = lastNoticeAtByReader.get(reader) ?? 0;
  const withinWindow = prior + UNBOUND_TASK_LIST_READ_NOTICE_FLOOR_MS > nowMs;
  if (withinWindow) return;
  lastNoticeAtByReader.set(reader, nowMs);

  // The remedy belongs where an operator will actually read it, not only in a queryable row.
  log.warn(
    `[task-list-scope] unbound task list read at ${reader} on the shared-PostgreSQL ` +
      `"project"."tasks" table — other projects' rows are being read into a process that ` +
      `serves one. Bind the store: createTaskStoreForBackend({ rootDir, projectId }) ` +
      `(packages/core/src/postgres/startup-factory.ts).`,
  );

  /*
   * ids/counts/fixed enums only. No row content, no task ids, no payload text: the whole
   * defect is that this read pulls other projects' content, and a diagnostic that copies it
   * into the audit store doubles the leak it is reporting.
   */
  void emitBoundedRunAudit(
    { recordRunAuditEvent: (input) => recordRunAuditEvent(layer, input) },
    {
      agentId: "task-list-read-scope",
      runId: `task-list-read-scope:${reader}`,
      domain: "task",
      mutationType: UNBOUND_TASK_LIST_READ_MUTATION,
      target: "unscoped",
      metadata: {
        reader,
        backendMode: layer.backend?.mode ?? null,
        enforcement: TASK_LIST_READ_SCOPE_ENFORCEMENT,
      },
    },
  );
}

/**
 * {@link taskProjectScope} for LIST reads: the same operand, watched by
 * {@link noteTaskListProjectScope} first, so the read still runs and still says so.
 */
export function taskListProjectScope(layer: AsyncDataLayer, reader: string): SQL | undefined {
  noteTaskListProjectScope(layer, reader);
  return taskProjectScope(layer);
}

/** Test seam: forget the per-reader window so a suite can observe more than one notice. */
export function resetTaskListScopeNoticesForTests(): void {
  lastNoticeAtByReader.clear();
}
