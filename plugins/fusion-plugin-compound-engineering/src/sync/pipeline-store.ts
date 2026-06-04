import { randomUUID } from "node:crypto";
import type { Database, PluginContext } from "@fusion/core";
import { ensureCeSchema } from "../schema.js";

/**
 * Plugin-local store for CE pipeline LINK records (U7).
 *
 * A link record is the addressable, durable association between a board task and
 * the CE pipeline/stage/artifact that produced it. Per FN-5719 the back-reference
 * lives HERE (a plugin-local table) — NOT in task-row JSON — so board-task
 * ownership and CE-pipeline ownership remain separate state machines and cannot
 * oscillate. A convenience copy of the ids may also ride along in the task's
 * `source.sourceMetadata`, but THIS ROW is the authoritative link.
 *
 * U7 SURFACE (intentionally minimal): create a link, list links by pipeline, and
 * find the link by taskId. U8 will EXTEND this store with the full bidirectional
 * pipeline-STATE machine (state column, status transitions, enqueue/reconcile).
 * U7 deliberately does not add any state/status field or sync behaviour so U8 can
 * layer it on without reworking the link surface.
 */
export interface CePipelineLink {
  /** Stable link-record id. */
  id: string;
  /** The board task this link points at (1:1 for U7). */
  taskId: string;
  /** The CE pipeline this task was derived under (the originating run). */
  cePipelineId: string;
  /** The CE stage id within that pipeline (e.g. "work"). */
  ceStageId: string;
  /** Absolute path to the stage artifact that drove this task, if any. */
  ceArtifactPath: string | null;
  createdAt: string;
}

interface CePipelineLinkRow {
  id: string;
  taskId: string;
  cePipelineId: string;
  ceStageId: string;
  ceArtifactPath: string | null;
  createdAt: string;
}

export interface CreateCePipelineLinkInput {
  taskId: string;
  cePipelineId: string;
  ceStageId: string;
  ceArtifactPath?: string | null;
  id?: string;
}

/**
 * CE-pipeline STATUS — the pipeline's own lifecycle, DISTINCT from board-task
 * columns (KTD4 / FN-5719). The board owns task columns; this owns pipeline
 * progress. The two are never encoded in one shared column.
 *
 *   running        — pipeline is at `currentStage`, work in flight on the board.
 *   advancing      — a board signal arrived; reconciler is moving it on / feeding
 *                    the next stage (transient, set inside the reconciler sweep).
 *   awaiting_board — pipeline advanced and is waiting on board task(s) again.
 *   completed      — pipeline reached its terminal stage and finished.
 */
export type CePipelineStatus = "running" | "advancing" | "awaiting_board" | "completed";

/** The CE-pipeline's own state record (separate state machine from the board). */
export interface CePipelineState {
  cePipelineId: string;
  /** The CE stage the pipeline has reached (a stage id, e.g. "work"). */
  currentStage: string;
  status: CePipelineStatus;
  /** Last artifact the pipeline produced/propagated (CE-authoritative content). */
  lastArtifactPath: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CePipelineStateRow {
  cePipelineId: string;
  currentStage: string;
  status: CePipelineStatus;
  lastArtifactPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertCePipelineStateInput {
  cePipelineId: string;
  currentStage: string;
  status?: CePipelineStatus;
  lastArtifactPath?: string | null;
}

/** Why a board change was enqueued for the pipeline (audit + reconcile routing). */
export type CeSyncReason = "task_moved" | "task_completed" | "reconcile";

/** A pending (or drained) board→pipeline sync signal. */
export interface CeSyncQueueEntry {
  id: string;
  cePipelineId: string;
  taskId: string;
  reason: CeSyncReason;
  fromColumn: string | null;
  toColumn: string | null;
  enqueuedAt: string;
  processedAt: string | null;
}

interface CeSyncQueueRow {
  id: string;
  cePipelineId: string;
  taskId: string;
  reason: CeSyncReason;
  fromColumn: string | null;
  toColumn: string | null;
  enqueuedAt: string;
  processedAt: string | null;
}

export interface EnqueueSyncInput {
  cePipelineId: string;
  taskId: string;
  reason: CeSyncReason;
  fromColumn?: string | null;
  toColumn?: string | null;
  id?: string;
}

function rowToState(row: CePipelineStateRow): CePipelineState {
  return {
    cePipelineId: row.cePipelineId,
    currentStage: row.currentStage,
    status: row.status,
    lastArtifactPath: row.lastArtifactPath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToQueueEntry(row: CeSyncQueueRow): CeSyncQueueEntry {
  return {
    id: row.id,
    cePipelineId: row.cePipelineId,
    taskId: row.taskId,
    reason: row.reason,
    fromColumn: row.fromColumn,
    toColumn: row.toColumn,
    enqueuedAt: row.enqueuedAt,
    processedAt: row.processedAt,
  };
}

function rowToLink(row: CePipelineLinkRow): CePipelineLink {
  return {
    id: row.id,
    taskId: row.taskId,
    cePipelineId: row.cePipelineId,
    ceStageId: row.ceStageId,
    ceArtifactPath: row.ceArtifactPath,
    createdAt: row.createdAt,
  };
}

/**
 * CRUD for CE pipeline link records. Reaches the DB the same way the session
 * store / reports do (via `ctx.taskStore.getDatabase()`) and ensures its schema
 * defensively on construction so a store built before `onSchemaInit` ran (or in a
 * test) still works.
 */
export class CePipelineStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    ensureCeSchema(db);
  }

  /** Record a task→pipeline/artifact link. */
  createLink(input: CreateCePipelineLinkInput): CePipelineLink {
    const link: CePipelineLink = {
      id: input.id ?? randomUUID(),
      taskId: input.taskId,
      cePipelineId: input.cePipelineId,
      ceStageId: input.ceStageId,
      ceArtifactPath: input.ceArtifactPath ?? null,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO ce_pipeline_links
          (id, taskId, cePipelineId, ceStageId, ceArtifactPath, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(link.id, link.taskId, link.cePipelineId, link.ceStageId, link.ceArtifactPath, link.createdAt);
    return link;
  }

  /** All links produced by a given CE pipeline, newest first. */
  listByPipeline(cePipelineId: string): CePipelineLink[] {
    const rows = this.db
      .prepare(`SELECT * FROM ce_pipeline_links WHERE cePipelineId = ? ORDER BY createdAt DESC, id`)
      .all(cePipelineId) as CePipelineLinkRow[];
    return rows.map(rowToLink);
  }

  /** Resolve a board task back to its CE link (the back-reference). */
  findByTaskId(taskId: string): CePipelineLink | undefined {
    const row = this.db
      .prepare(`SELECT * FROM ce_pipeline_links WHERE taskId = ?`)
      .get(taskId) as CePipelineLinkRow | undefined;
    return row ? rowToLink(row) : undefined;
  }

  // ── CE-pipeline STATE machine (U8) ───────────────────────────────────
  // Separate from board-task columns: this table is the pipeline's OWN state.

  /** Read a pipeline's own state record. */
  getState(cePipelineId: string): CePipelineState | undefined {
    const row = this.db
      .prepare(`SELECT * FROM ce_pipeline_state WHERE cePipelineId = ?`)
      .get(cePipelineId) as CePipelineStateRow | undefined;
    return row ? rowToState(row) : undefined;
  }

  /** All pipeline state records (the reconciler sweeps every one). */
  listAllState(): CePipelineState[] {
    const rows = this.db
      .prepare(`SELECT * FROM ce_pipeline_state ORDER BY updatedAt DESC, cePipelineId`)
      .all() as CePipelineStateRow[];
    return rows.map(rowToState);
  }

  /**
   * Create or update a pipeline's state. Idempotent on `cePipelineId`. `status`
   * defaults to `running` on first write and is preserved on update unless given.
   */
  upsertState(input: UpsertCePipelineStateInput): CePipelineState {
    const now = new Date().toISOString();
    const existing = this.getState(input.cePipelineId);
    const status = input.status ?? existing?.status ?? "running";
    const lastArtifactPath =
      input.lastArtifactPath !== undefined ? input.lastArtifactPath : existing?.lastArtifactPath ?? null;
    if (existing) {
      this.db
        .prepare(
          `UPDATE ce_pipeline_state
             SET currentStage = ?, status = ?, lastArtifactPath = ?, updatedAt = ?
           WHERE cePipelineId = ?`,
        )
        .run(input.currentStage, status, lastArtifactPath, now, input.cePipelineId);
    } else {
      this.db
        .prepare(
          `INSERT INTO ce_pipeline_state
             (cePipelineId, currentStage, status, lastArtifactPath, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.cePipelineId, input.currentStage, status, lastArtifactPath, now, now);
    }
    return this.getState(input.cePipelineId)!;
  }

  /**
   * Transition a pipeline to a new stage/status. Returns the updated state, or
   * `undefined` if the pipeline has no state row yet (caller should seed first).
   */
  transitionState(
    cePipelineId: string,
    next: { currentStage?: string; status?: CePipelineStatus; lastArtifactPath?: string | null },
  ): CePipelineState | undefined {
    const existing = this.getState(cePipelineId);
    if (!existing) return undefined;
    return this.upsertState({
      cePipelineId,
      currentStage: next.currentStage ?? existing.currentStage,
      status: next.status ?? existing.status,
      lastArtifactPath:
        next.lastArtifactPath !== undefined ? next.lastArtifactPath : existing.lastArtifactPath,
    });
  }

  // ── Event-enqueue seam (U8 / FN-5719) ────────────────────────────────
  // Hooks write here FAST and return; the reconciler drains. A missed enqueue is
  // still recovered because reconcile() re-derives from board state too.

  /** Append a pending board→pipeline sync signal. Fast, append-only. */
  enqueueSync(input: EnqueueSyncInput): CeSyncQueueEntry {
    const entry: CeSyncQueueEntry = {
      id: input.id ?? randomUUID(),
      cePipelineId: input.cePipelineId,
      taskId: input.taskId,
      reason: input.reason,
      fromColumn: input.fromColumn ?? null,
      toColumn: input.toColumn ?? null,
      enqueuedAt: new Date().toISOString(),
      processedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO ce_pipeline_sync_queue
           (id, cePipelineId, taskId, reason, fromColumn, toColumn, enqueuedAt, processedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(entry.id, entry.cePipelineId, entry.taskId, entry.reason, entry.fromColumn, entry.toColumn, entry.enqueuedAt);
    return entry;
  }

  /** All pending (un-drained) queue entries, oldest first. */
  listPendingSync(): CeSyncQueueEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM ce_pipeline_sync_queue WHERE processedAt IS NULL ORDER BY enqueuedAt, id`)
      .all() as CeSyncQueueRow[];
    return rows.map(rowToQueueEntry);
  }

  /** Mark a queue entry drained (idempotent). */
  markSyncProcessed(id: string): void {
    this.db
      .prepare(`UPDATE ce_pipeline_sync_queue SET processedAt = ? WHERE id = ? AND processedAt IS NULL`)
      .run(new Date().toISOString(), id);
  }
}

const storeCache = new WeakMap<object, CePipelineStore>();

/** WeakMap-cached store keyed by the TaskStore instance (mirrors the session store). */
export function getCePipelineStore(ctx: PluginContext): CePipelineStore {
  const key = ctx.taskStore as object;
  const cached = storeCache.get(key);
  if (cached) return cached;
  const store = new CePipelineStore(ctx.taskStore.getDatabase());
  storeCache.set(key, store);
  return store;
}
