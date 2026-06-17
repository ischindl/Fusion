import type { Database } from "./db.js";

/**
 * Queryable telemetry of agent activity (tool calls, messages, session
 * lifecycle), persisted to the `usage_events` table (db.ts schema). This is the
 * normalized source the Command Center analytics layer reads from, so it does
 * not have to parse per-task JSONL agent logs at query time.
 *
 * Events are appended via {@link emitUsageEvent} from the executor/session layer
 * where `model`/`provider`/`nodeId`/`category` are already in scope (see
 * KTD3/U1). The append helper is intentionally fail-soft: a malformed event or a
 * write error is swallowed so it never aborts the underlying agent-log write or
 * the agent hot path.
 */

/**
 * The kind of activity an event records.
 *
 * - `tool_call` — an agent invoked a tool (agent-log `type: "tool"` maps here;
 *   `AgentLogType` has no `tool_call` member).
 * - `tool_result` / `tool_error` — the tool completed / failed.
 * - `user_message` — a human-authored message (chat/CLI sessions).
 * - `session_start` / `session_stop` — session lifecycle.
 */
export type UsageEventKind =
  | "tool_call"
  | "tool_result"
  | "tool_error"
  | "user_message"
  | "session_start"
  | "session_stop";

const USAGE_EVENT_KINDS: ReadonlySet<string> = new Set<UsageEventKind>([
  "tool_call",
  "tool_result",
  "tool_error",
  "user_message",
  "session_start",
  "session_stop",
]);

/**
 * Maximum serialized byte size of a `meta` payload. Events whose `meta`
 * exceeds this cap are rejected at write (the whole event is skipped) rather
 * than truncated, so an oversized payload can never silently land partial data.
 */
export const USAGE_EVENT_META_MAX_BYTES = 4096;

/** An event to append to `usage_events`. */
export interface UsageEventInput {
  kind: UsageEventKind;
  /** ISO-8601 timestamp. Defaults to now when omitted. */
  ts?: string;
  taskId?: string | null;
  agentId?: string | null;
  /** Workflow/session node this event belongs to; null when no node context. */
  nodeId?: string | null;
  model?: string | null;
  provider?: string | null;
  toolName?: string | null;
  category?: string | null;
  /**
   * Non-sensitive descriptors only (error code, category, duration). NEVER tool
   * arguments/content or credential-class fields. Capped at
   * {@link USAGE_EVENT_META_MAX_BYTES}; over the cap, the event is rejected.
   */
  meta?: Record<string, unknown> | null;
}

/** A row read back from `usage_events`. */
export interface UsageEvent {
  id: number;
  ts: string;
  kind: UsageEventKind;
  taskId: string | null;
  agentId: string | null;
  nodeId: string | null;
  model: string | null;
  provider: string | null;
  toolName: string | null;
  category: string | null;
  meta: Record<string, unknown> | null;
}

interface UsageEventRow {
  id: number;
  ts: string;
  kind: string;
  taskId: string | null;
  agentId: string | null;
  nodeId: string | null;
  model: string | null;
  provider: string | null;
  toolName: string | null;
  category: string | null;
  meta: string | null;
}

/**
 * Coarse tool category derived from a tool name, for the Tools analytics area.
 * Pure and side-effect free; callers may also pass an explicit `category`.
 */
export function categorizeToolName(toolName: string | null | undefined): string {
  if (!toolName) return "other";
  const name = toolName.toLowerCase();
  if (name === "read" || name === "grep" || name === "glob" || name === "ls" || name.includes("search")) {
    return "read";
  }
  if (name === "edit" || name === "write" || name === "multiedit" || name.includes("notebook")) {
    return "edit";
  }
  if (name === "bash" || name.includes("exec") || name.includes("command") || name.includes("terminal")) {
    return "execute";
  }
  if (name.includes("web") || name.includes("fetch") || name.includes("http")) {
    return "network";
  }
  return "other";
}

/**
 * Validate and serialize a `meta` payload. Returns the serialized JSON string,
 * or throws if it exceeds the byte cap. `null`/`undefined` serialize to `null`.
 */
function serializeMeta(meta: Record<string, unknown> | null | undefined): string | null {
  if (meta === undefined || meta === null) return null;
  const serialized = JSON.stringify(meta);
  if (serialized === undefined) return null;
  if (Buffer.byteLength(serialized, "utf8") > USAGE_EVENT_META_MAX_BYTES) {
    throw new Error(
      `usage_events meta payload exceeds ${USAGE_EVENT_META_MAX_BYTES} bytes (got ${Buffer.byteLength(serialized, "utf8")})`,
    );
  }
  return serialized;
}

/**
 * Append a single usage event. **Fail-soft**: a malformed event (unknown kind),
 * an oversized `meta`, or any DB error is logged and swallowed — it must never
 * throw, so it cannot abort the underlying agent-log write or the hot path.
 *
 * @returns `true` if the row was inserted, `false` if the event was skipped.
 */
export function emitUsageEvent(db: Database, event: UsageEventInput): boolean {
  try {
    if (!event || !USAGE_EVENT_KINDS.has(event.kind)) {
      return false;
    }
    const ts = event.ts ?? new Date().toISOString();
    const meta = serializeMeta(event.meta);
    db.prepare(
      `INSERT INTO usage_events
         (ts, kind, taskId, agentId, nodeId, model, provider, toolName, category, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ts,
      event.kind,
      event.taskId ?? null,
      event.agentId ?? null,
      event.nodeId ?? null,
      event.model ?? null,
      event.provider ?? null,
      event.toolName ?? null,
      event.category ?? null,
      meta,
    );
    return true;
  } catch (err) {
    console.warn("[fusion] emitUsageEvent skipped a malformed/failed event:", err);
    return false;
  }
}

/** Filters for {@link queryUsageEvents}. All bounds are inclusive. */
export interface UsageEventRangeQuery {
  /** ISO-8601 lower bound (inclusive). */
  from?: string;
  /** ISO-8601 upper bound (inclusive). */
  to?: string;
  kind?: UsageEventKind;
  taskId?: string;
  agentId?: string;
}

function rowToUsageEvent(row: UsageEventRow): UsageEvent {
  let meta: Record<string, unknown> | null = null;
  if (row.meta) {
    try {
      meta = JSON.parse(row.meta) as Record<string, unknown>;
    } catch {
      meta = null;
    }
  }
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind as UsageEventKind,
    taskId: row.taskId,
    agentId: row.agentId,
    nodeId: row.nodeId,
    model: row.model,
    provider: row.provider,
    toolName: row.toolName,
    category: row.category,
    meta,
  };
}

/**
 * Range-scan `usage_events` ordered by timestamp ascending. Mirrors the
 * windowed-scan shape of `agent-token-usage.ts`, generalized to an arbitrary
 * `(from, to)` range with optional kind/task/agent filters.
 */
export function queryUsageEvents(db: Database, query: UsageEventRangeQuery = {}): UsageEvent[] {
  const clauses: string[] = [];
  const params: Array<string> = [];
  if (query.from !== undefined) {
    clauses.push("ts >= ?");
    params.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push("ts <= ?");
    params.push(query.to);
  }
  if (query.kind !== undefined) {
    clauses.push("kind = ?");
    params.push(query.kind);
  }
  if (query.taskId !== undefined) {
    clauses.push("taskId = ?");
    params.push(query.taskId);
  }
  if (query.agentId !== undefined) {
    clauses.push("agentId = ?");
    params.push(query.agentId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM usage_events ${where} ORDER BY ts ASC, id ASC`)
    .all(...params) as UsageEventRow[];
  return rows.map(rowToUsageEvent);
}

/**
 * Count `usage_events` grouped by a single column over a range. Convenience for
 * the analytics aggregators (e.g. tool calls by `category`).
 */
export function countUsageEventsBy(
  db: Database,
  column: "kind" | "category" | "toolName" | "model" | "provider" | "nodeId" | "agentId",
  query: UsageEventRangeQuery = {},
): Array<{ key: string | null; count: number }> {
  const clauses: string[] = [];
  const params: Array<string> = [];
  if (query.from !== undefined) {
    clauses.push("ts >= ?");
    params.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push("ts <= ?");
    params.push(query.to);
  }
  if (query.kind !== undefined) {
    clauses.push("kind = ?");
    params.push(query.kind);
  }
  if (query.taskId !== undefined) {
    clauses.push("taskId = ?");
    params.push(query.taskId);
  }
  if (query.agentId !== undefined) {
    clauses.push("agentId = ?");
    params.push(query.agentId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT ${column} AS key, COUNT(*) AS count FROM usage_events ${where} GROUP BY ${column}`)
    .all(...params) as Array<{ key: string | null; count: number }>;
  return rows;
}
