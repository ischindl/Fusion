import type { Database } from "./db.js";
import { costFor, type CostResult } from "./model-pricing.js";

/**
 * Token-consumption analytics over the `tasks` table, generalizing the fixed
 * 24h/7d/all-time windows of `agent-token-usage.ts` to an arbitrary `(from, to)`
 * range. Sums the `tokenUsage*` columns filtered by `tokenUsageLastUsedAt` and
 * groups by model / provider / node / agent.
 *
 * Inclusivity: `from`/`to` bounds are **inclusive** (`>= from AND <= to`),
 * matching `usage-events.ts` and the range-scan house style. A task whose
 * `tokenUsageLastUsedAt` is exactly equal to `from` is therefore included.
 *
 * Pure read-only aggregation: takes a `Database` handle and returns plain data.
 */

/** Dimension to group token totals by. */
export type TokenGroupBy = "model" | "provider" | "node" | "agent";

/** Summed token counts for a group (or the grand total). */
export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Number of tasks that contributed to these totals. */
  nTasks: number;
}

/** One group's token totals, keyed by the grouped dimension value. */
export interface TokenGroupSummary extends TokenTotals {
  /** The group key (model id, provider, nodeId, or agentId); null when unset. */
  key: string | null;
  /**
   * Derived USD cost for this group (U3). Each contributing task is priced at
   * its own model's rates and summed, so the cost is meaningful for any
   * `groupBy`. `usd` is null when none of the group's tasks had a known price;
   * `unavailable` is true when at least one task's model was unpriced.
   */
  cost: CostResult;
}

/** Result of {@link aggregateTokenAnalytics}. */
export interface TokenAnalytics {
  from: string | null;
  to: string | null;
  groupBy: TokenGroupBy | null;
  /** Grand total across all matched tasks. */
  totals: TokenTotals;
  /**
   * Derived USD cost across all matched tasks (U3), each priced at its own
   * model's rates. `usd` is null when no task had a known price; `unavailable`
   * is true when at least one task's model had no pricing entry.
   */
  cost: CostResult;
  /** Per-group totals; empty array when no `groupBy` requested. */
  groups: TokenGroupSummary[];
}

export interface TokenAnalyticsQuery {
  /** ISO-8601 lower bound (inclusive) on `tokenUsageLastUsedAt`. */
  from?: string;
  /** ISO-8601 upper bound (inclusive) on `tokenUsageLastUsedAt`. */
  to?: string;
  groupBy?: TokenGroupBy;
  /**
   * Epoch ms "now" used only for pricing-staleness (U3). When omitted, derived
   * cost is never marked stale. Pure: the module never reads the clock itself.
   */
  now?: number;
}

function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    nTasks: 0,
  };
}

interface TaskTokenRow {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  modelProvider: string | null;
  modelId: string | null;
  checkoutNodeId: string | null;
  assignedAgentId: string | null;
}

function groupKeyFor(row: TaskTokenRow, groupBy: TokenGroupBy): string | null {
  switch (groupBy) {
    case "model":
      return row.modelId;
    case "provider":
      return row.modelProvider;
    case "node":
      return row.checkoutNodeId;
    case "agent":
      return row.assignedAgentId;
  }
}

/**
 * Running cost tally. Each task is priced at its own model, then summed: `usd`
 * accumulates priced tasks, `anyUnavailable` records whether any task's model
 * was unpriced, `anyStale` whether the pricing map was stale, and `anyPriced`
 * whether at least one task had a known price. {@link finalizeCost} converts
 * this to a {@link CostResult}.
 */
interface CostAccumulator {
  usd: number;
  anyPriced: boolean;
  anyUnavailable: boolean;
  anyStale: boolean;
}

function emptyCostAccumulator(): CostAccumulator {
  return { usd: 0, anyPriced: false, anyUnavailable: false, anyStale: false };
}

function addRowCost(acc: CostAccumulator, row: TaskTokenRow, now?: number): void {
  const result = costFor(
    {
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      cachedTokens: row.cachedTokens ?? 0,
      cacheWriteTokens: row.cacheWriteTokens ?? 0,
    },
    { provider: row.modelProvider, model: row.modelId },
    now,
  );
  if (result.stale) acc.anyStale = true;
  if (result.unavailable || result.usd === null) {
    acc.anyUnavailable = true;
  } else {
    acc.usd += result.usd;
    acc.anyPriced = true;
  }
}

function finalizeCost(acc: CostAccumulator): CostResult {
  return {
    usd: acc.anyPriced ? acc.usd : null,
    unavailable: acc.anyUnavailable,
    stale: acc.anyStale,
  };
}

function addRow(totals: TokenTotals, row: TaskTokenRow): void {
  totals.inputTokens += row.inputTokens ?? 0;
  totals.outputTokens += row.outputTokens ?? 0;
  totals.cachedTokens += row.cachedTokens ?? 0;
  totals.cacheWriteTokens += row.cacheWriteTokens ?? 0;
  // Prefer the persisted total when present; otherwise derive it from the parts
  // so callers always get a coherent `totalTokens` even on older rows.
  const persistedTotal = row.totalTokens;
  totals.totalTokens +=
    persistedTotal ??
    (row.inputTokens ?? 0) +
      (row.outputTokens ?? 0) +
      (row.cachedTokens ?? 0) +
      (row.cacheWriteTokens ?? 0);
  totals.nTasks += 1;
}

/**
 * Aggregate per-task token usage over a date range, optionally grouped.
 *
 * Tasks are matched by `tokenUsageLastUsedAt` within `[from, to]` (inclusive).
 * Tasks with no token usage (`tokenUsageLastUsedAt IS NULL`) are excluded. An
 * empty range yields zeroed `totals` and an empty `groups` array — never nulls.
 */
export function aggregateTokenAnalytics(
  db: Database,
  query: TokenAnalyticsQuery = {},
): TokenAnalytics {
  const clauses: string[] = ["tokenUsageLastUsedAt IS NOT NULL"];
  const params: string[] = [];
  if (query.from !== undefined) {
    clauses.push("tokenUsageLastUsedAt >= ?");
    params.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push("tokenUsageLastUsedAt <= ?");
    params.push(query.to);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;

  const rows = db
    .prepare(
      `SELECT
         tokenUsageInputTokens   AS inputTokens,
         tokenUsageOutputTokens  AS outputTokens,
         tokenUsageCachedTokens  AS cachedTokens,
         tokenUsageCacheWriteTokens AS cacheWriteTokens,
         tokenUsageTotalTokens   AS totalTokens,
         modelProvider,
         modelId,
         checkoutNodeId,
         assignedAgentId
       FROM tasks ${where}`,
    )
    .all(...params) as TaskTokenRow[];

  const totals = emptyTotals();
  const totalCost = emptyCostAccumulator();
  const groupMap = new Map<string | null, TokenGroupSummary>();
  const groupCostMap = new Map<string | null, CostAccumulator>();
  const groupBy = query.groupBy;
  const now = query.now;

  for (const row of rows) {
    addRow(totals, row);
    addRowCost(totalCost, row, now);
    if (groupBy) {
      const key = groupKeyFor(row, groupBy);
      let group = groupMap.get(key);
      if (!group) {
        group = { key, ...emptyTotals(), cost: { usd: null, unavailable: false, stale: false } };
        groupMap.set(key, group);
        groupCostMap.set(key, emptyCostAccumulator());
      }
      addRow(group, row);
      addRowCost(groupCostMap.get(key)!, row, now);
    }
  }

  // Finalize per-group cost from each group's accumulator.
  for (const [key, group] of groupMap) {
    group.cost = finalizeCost(groupCostMap.get(key)!);
  }

  const groups = [...groupMap.values()].sort(
    (a, b) => b.totalTokens - a.totalTokens,
  );

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    groupBy: groupBy ?? null,
    totals,
    cost: finalizeCost(totalCost),
    groups,
  };
}
