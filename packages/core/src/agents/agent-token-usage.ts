import { sql } from "drizzle-orm";
import type { AgentStore } from "./agent-store.js";
import type { Database } from "../db/db.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import { PROJECT_SCHEMA } from "../postgres/schema/_shared.js";
import { taskListProjectScope } from "../postgres/task-list-read-scope.js";
import type { TaskStore } from "../store.js";
import type { AgentRole } from "../types.js";

export interface AgentTokenUsageWindowSummary {
  totalInputTokens: number;
  totalCachedTokens: number;
  totalCacheWriteTokens: number;
  totalOutputTokens: number;
  nTasks: number;
  hitRatio: number;
}

export interface AgentTokenUsageSummary {
  agentId: string;
  role: AgentRole;
  last24h: AgentTokenUsageWindowSummary;
  last7d: AgentTokenUsageWindowSummary;
  allTime: AgentTokenUsageWindowSummary;
}

export interface AgentTaskTokenTotals {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
  nTasks: number;
}

interface TaskTokenLinkRow {
  taskId: string;
  assignedAgentId: string | null;
  sourceAgentId: string | null;
  checkedOutBy: string | null;
  inputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

/**
 * FNXC:PostgresCutover 2026-07-04:
 * Shared accumulation core for task-derived token totals by agent link.
 * Both the sync SQLite path and the async PostgreSQL path funnel the same
 * TaskTokenLinkRow[] through this so the assigned/source/checkout attribution
 * stays identical across backends (every linked agent is credited, no double
 * counting when a task links the same agent via multiple fields).
 */
function accumulateTaskTokenLinkRows(
  rows: TaskTokenLinkRow[],
  totalsByAgentId: Map<string, AgentTaskTokenTotals>,
): void {
  for (const row of rows) {
    const agentIds = new Set([row.assignedAgentId, row.sourceAgentId, row.checkedOutBy].filter((value): value is string => Boolean(value)));
    for (const agentId of agentIds) {
      const existing = totalsByAgentId.get(agentId) ?? createTaskTokenTotals();
      existing.inputTokens += row.inputTokens ?? 0;
      existing.cachedTokens += row.cachedTokens ?? 0;
      existing.cacheWriteTokens += row.cacheWriteTokens ?? 0;
      existing.outputTokens += row.outputTokens ?? 0;
      existing.totalTokens += row.totalTokens ?? (row.inputTokens ?? 0) + (row.cachedTokens ?? 0) + (row.cacheWriteTokens ?? 0) + (row.outputTokens ?? 0);
      existing.nTasks += 1;
      totalsByAgentId.set(agentId, existing);
    }
  }
}

export function aggregateTaskTokenTotalsByAgentLink(db: Database): Map<string, AgentTaskTokenTotals> {
  /*
  FNXC:AgentTokenUsage 2026-06-27-23:06:
  List-row token totals must use the same assigned/source/checkout attribution as Agent Detail so ephemeral task-worker agents do not report zero when they only sourced or checked out a task.
  */
  const rows = db.prepare(`
    SELECT
      id AS taskId,
      assignedAgentId,
      sourceAgentId,
      checkedOutBy,
      tokenUsageInputTokens AS inputTokens,
      tokenUsageCachedTokens AS cachedTokens,
      tokenUsageCacheWriteTokens AS cacheWriteTokens,
      tokenUsageOutputTokens AS outputTokens,
      tokenUsageTotalTokens AS totalTokens
    FROM tasks
    WHERE tokenUsageInputTokens IS NOT NULL
       OR tokenUsageCachedTokens IS NOT NULL
       OR tokenUsageCacheWriteTokens IS NOT NULL
       OR tokenUsageOutputTokens IS NOT NULL
       OR tokenUsageTotalTokens IS NOT NULL
  `).all() as TaskTokenLinkRow[];

  const totalsByAgentId = new Map<string, AgentTaskTokenTotals>();
  accumulateTaskTokenLinkRows(rows, totalsByAgentId);
  return totalsByAgentId;
}

/**
 * FNXC:PostgresCutover 2026-07-04:
 * Async PostgreSQL equivalent of {@link aggregateTaskTokenTotalsByAgentLink}.
 * Reads the same task-link token columns from the schema-qualified
 * project.tasks table (snake_case) so the Agents listing surfaces real task-derived totals in
 * backend (PostgreSQL) mode instead of silently degrading to zero. The route
 * dispatches to this when the scoped store carries an AsyncDataLayer.
 *
 * FNXC:AggregateEndpointHydration 2026-11-11-15:40 (RUFU-591):
 * The PostgreSQL leg is now a true SQL aggregate returning ONE ROW PER AGENT instead of materializing
 * every token-bearing task row and folding it through `accumulateTaskTokenLinkRows` in JS. Two facts
 * keep the attribution semantics byte-identical to the shared accumulator:
 *   - The LATERAL VALUES unpivot emits one row per (task, non-null link column); `DISTINCT ON
 *     (agent_id, task_id)` then collapses an agent linked via several columns of the SAME task into
 *     one credit — exactly what the accumulator's per-row `Set` of agent ids does, so no double
 *     counting and `nTasks` stays a distinct-task count.
 *   - `total_tokens` falls back to input+cached+cacheWrite+output per row (COALESCE), mirroring the
 *     accumulator's `row.totalTokens ?? sum-of-parts`; every SUM is COALESCEd to 0 so a null column
 *     contributes zero like `?? 0` does in JS.
 * Node-postgres returns bigint sums as STRINGS (the drizzle column mode parses only typed selects,
 * not raw `db.execute`), so every numeric field is coerced with Number() before it enters the Map —
 * without that the response would carry string token totals and break `inputTokens <= 0` guards
 * downstream (`withTaskDerivedTokenTotals`).
 * Project scoping takes the SAME operand `countLiveTasks` uses — `taskListProjectScope(layer, ...)`
 * — which (a) binds `project_id = $n` as a PARAMETER (never interpolated text) when the layer names
 * a project, and (b) records the RUFU-871 unbound-shared-layer guard instead of silently reading
 * across projects. The previous row-shipping query relied on the connection's `fusion.project_id`
 * session GUC alone; a bypass-mode connection therefore aggregated every project's rows. The SQLite
 * leg below keeps the shared accumulator unchanged (drizzle-free raw rows are already bounded
 * per-project there).
 */
export async function aggregateTaskTokenTotalsByAgentLinkAsync(
  layer: AsyncDataLayer,
): Promise<Map<string, AgentTaskTokenTotals>> {
  const projectScope = taskListProjectScope(layer, "agent-token-usage:aggregateTaskTokenTotalsByAgentLinkAsync");
  const rawRows = (await layer.db.execute(
    sql`
      SELECT
        agent_id AS "agentId",
        COALESCE(SUM(input_tokens), 0)::bigint AS "inputTokens",
        COALESCE(SUM(cached_tokens), 0)::bigint AS "cachedTokens",
        COALESCE(SUM(cache_write_tokens), 0)::bigint AS "cacheWriteTokens",
        COALESCE(SUM(output_tokens), 0)::bigint AS "outputTokens",
        COALESCE(SUM(total_tokens), 0)::bigint AS "totalTokens",
        COUNT(*)::bigint AS "nTasks"
      FROM (
        SELECT DISTINCT ON (link.agent_id, tasks.id)
          link.agent_id,
          tasks.token_usage_input_tokens AS input_tokens,
          tasks.token_usage_cached_tokens AS cached_tokens,
          tasks.token_usage_cache_write_tokens AS cache_write_tokens,
          tasks.token_usage_output_tokens AS output_tokens,
          COALESCE(
            tasks.token_usage_total_tokens,
            COALESCE(tasks.token_usage_input_tokens, 0)
              + COALESCE(tasks.token_usage_cached_tokens, 0)
              + COALESCE(tasks.token_usage_cache_write_tokens, 0)
              + COALESCE(tasks.token_usage_output_tokens, 0)
          ) AS total_tokens
        FROM ${sql.raw(PROJECT_SCHEMA)}.tasks
        CROSS JOIN LATERAL (VALUES
          (tasks.assigned_agent_id),
          (tasks.source_agent_id),
          (tasks.checked_out_by)
        ) AS link(agent_id)
        WHERE link.agent_id IS NOT NULL
          AND (
               tasks.token_usage_input_tokens IS NOT NULL
            OR tasks.token_usage_cached_tokens IS NOT NULL
            OR tasks.token_usage_cache_write_tokens IS NOT NULL
            OR tasks.token_usage_output_tokens IS NOT NULL
            OR tasks.token_usage_total_tokens IS NOT NULL
          )
          ${projectScope ? sql`AND ${projectScope}` : sql``}
      ) per_agent_task
      GROUP BY agent_id
    `,
  )) as unknown as Array<{
    agentId: string;
    inputTokens: number | string;
    cachedTokens: number | string;
    cacheWriteTokens: number | string;
    outputTokens: number | string;
    totalTokens: number | string;
    nTasks: number | string;
  }>;

  const totalsByAgentId = new Map<string, AgentTaskTokenTotals>();
  for (const row of rawRows) {
    totalsByAgentId.set(row.agentId, {
      inputTokens: Number(row.inputTokens),
      cachedTokens: Number(row.cachedTokens),
      cacheWriteTokens: Number(row.cacheWriteTokens),
      outputTokens: Number(row.outputTokens),
      totalTokens: Number(row.totalTokens),
      nTasks: Number(row.nTasks),
    });
  }
  return totalsByAgentId;
}

function createTaskTokenTotals(): AgentTaskTokenTotals {
  return {
    inputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    nTasks: 0,
  };
}

export async function aggregateAgentTokenUsage({
  taskStore,
  agentStore,
  agentId,
  now = new Date(),
}: {
  taskStore: TaskStore;
  agentStore: AgentStore;
  agentId: string;
  now?: Date;
}): Promise<AgentTokenUsageSummary | null> {
  const agent = await agentStore.getAgent(agentId);
  if (!agent) {
    return null;
  }

  /*
  FNXC:AgentTokenUsage 2026-06-27-19:10:
  Ephemeral/task-worker agents must surface task-derived token usage because their cumulative agent token fields are never accumulated by the durable-agent heartbeat path.
  */
  const tasks = await taskStore.listTasks({ slim: true, includeArchived: false });
  const nowMs = now.getTime();
  const last24hMs = nowMs - (24 * 60 * 60 * 1000);
  const last7dMs = nowMs - (7 * 24 * 60 * 60 * 1000);

  const allTime = createWindowSummary();
  const last24h = createWindowSummary();
  const last7d = createWindowSummary();

  for (const task of tasks) {
    if (!task.tokenUsage) continue;
    const matchesAgent = task.assignedAgentId === agentId || task.sourceAgentId === agentId || task.checkedOutBy === agentId;
    if (!matchesAgent) continue;

    const usage = task.tokenUsage;
    applyTaskUsage(allTime, usage.inputTokens ?? 0, usage.cachedTokens ?? 0, usage.outputTokens ?? 0, usage.cacheWriteTokens ?? 0);

    const lastUsedAtMs = Date.parse(usage.lastUsedAt ?? "");
    if (!Number.isFinite(lastUsedAtMs)) continue;

    if (lastUsedAtMs >= last24hMs) {
      applyTaskUsage(last24h, usage.inputTokens ?? 0, usage.cachedTokens ?? 0, usage.outputTokens ?? 0, usage.cacheWriteTokens ?? 0);
    }
    if (lastUsedAtMs >= last7dMs) {
      applyTaskUsage(last7d, usage.inputTokens ?? 0, usage.cachedTokens ?? 0, usage.outputTokens ?? 0, usage.cacheWriteTokens ?? 0);
    }
  }

  return {
    agentId,
    role: agent.role as AgentRole,
    last24h: finalizeWindowSummary(last24h),
    last7d: finalizeWindowSummary(last7d),
    allTime: finalizeWindowSummary(allTime),
  };
}

function createWindowSummary(): AgentTokenUsageWindowSummary {
  return {
    totalInputTokens: 0,
    totalCachedTokens: 0,
    totalCacheWriteTokens: 0,
    totalOutputTokens: 0,
    nTasks: 0,
    hitRatio: 0,
  };
}

function applyTaskUsage(
  summary: AgentTokenUsageWindowSummary,
  inputTokens: number,
  cachedTokens: number,
  outputTokens: number,
  cacheWriteTokens: number,
): void {
  summary.totalInputTokens += inputTokens;
  summary.totalCachedTokens += cachedTokens;
  summary.totalCacheWriteTokens += cacheWriteTokens;
  summary.totalOutputTokens += outputTokens;
  summary.nTasks += 1;
}

function finalizeWindowSummary(summary: AgentTokenUsageWindowSummary): AgentTokenUsageWindowSummary {
  const denominator = summary.totalInputTokens + summary.totalCachedTokens;
  return {
    ...summary,
    hitRatio: denominator > 0 ? summary.totalCachedTokens / denominator : 0,
  };
}
