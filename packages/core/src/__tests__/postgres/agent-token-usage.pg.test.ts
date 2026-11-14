import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import {
  aggregateTaskTokenTotalsByAgentLink,
  aggregateTaskTokenTotalsByAgentLinkAsync,
} from "../../agents/agent-token-usage.js";

/*
FNXC:AggregateEndpointHydration 2026-11-11-16:35 (RUFU-591):
`GET /api/agents/stats` used to pay a full board scan per request because the PostgreSQL token-total
leg materialized every token-bearing task row (of every project reachable on the connection) and
folded it in JS. The rewritten leg returns ONE ROW PER AGENT from SQL and carries the same
`taskListProjectScope` operand `countLiveTasks` uses. This suite pins what makes the swap safe:
  (a) attribution parity — the fold oracle is `aggregateTaskTokenTotalsByAgentLink` fed the exact
      fixture rows through the shared accumulator's semantics (assigned/source/checkout all credit,
      a same-agent multi-column link credits ONCE, total falls back to the sum of parts);
  (b) project scoping — with a second project's rows present in the same database, only the
      caller's bound project contributes to the totals;
  (c) numeric shape — node-postgres returns bigint SUMs as strings, so every field must arrive as a
      JS number, and an agent with zero totals but a linked task keeps its honest zero;
  (d) statement shape — exactly one statement, schema-qualified `FROM project.tasks`, GROUP BY
      present, no LIMIT (a LIMIT would silently truncate the per-agent aggregate).
*/

const PROJECT_A = "token-proj-a";
const PROJECT_B = "token-proj-b";

interface FixtureTask {
  key: string;
  assignedAgentId: string | null;
  sourceAgentId: string | null;
  checkedOutBy: string | null;
  input: number | null;
  cached: number | null;
  cacheWrite: number | null;
  output: number | null;
  total: number | null;
}

/*
 * One fixture, six readings:
 *  - t1 links two DIFFERENT agents (assigned a, source b) — both credited once.
 *  - t2 links agent a through ALL THREE columns — a single credit, nTasks 1.
 *  - t3 has no total_tokens — the sum-of-parts fallback must engage (7, not 0).
 *  - t4 has no token columns set at all — excluded from both legs entirely.
 *  - t5 has tokens but no link — contributes no agent row.
 *  - t6 is all-zero tokens — an honest zero, NOT an absent row (nTasks 1).
 */
const FIXTURE: FixtureTask[] = [
  { key: "t1", assignedAgentId: "agent-a", sourceAgentId: "agent-b", checkedOutBy: null, input: 100, cached: 10, cacheWrite: 5, output: 20, total: 135 },
  { key: "t2", assignedAgentId: "agent-a", sourceAgentId: "agent-a", checkedOutBy: "agent-a", input: 1, cached: 0, cacheWrite: 0, output: 2, total: null },
  { key: "t3", assignedAgentId: "agent-b", sourceAgentId: null, checkedOutBy: "agent-c", input: 7, cached: null, cacheWrite: null, output: null, total: null },
  { key: "t4", assignedAgentId: "agent-a", sourceAgentId: null, checkedOutBy: null, input: null, cached: null, cacheWrite: null, output: null, total: null },
  { key: "t5", assignedAgentId: null, sourceAgentId: null, checkedOutBy: null, input: 9, cached: null, cacheWrite: null, output: 1, total: null },
  { key: "t6", assignedAgentId: "agent-c", sourceAgentId: null, checkedOutBy: null, input: 0, cached: 0, cacheWrite: 0, output: 0, total: 0 },
];

/*
 * Drizzle v1 `sql.raw()`/templates carry no plain `.query` string — the text sits in
 * `queryChunks`. Flatten it so the statement-shape assertions read the SQL a driver would
 * receive (bound parameters render their value, which is enough to see the operand's shape).
 */
function flattenDrizzleSql(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flattenDrizzleSql).join("");
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if ("queryChunks" in record) return flattenDrizzleSql(record.queryChunks);
    if ("value" in record) return flattenDrizzleSql(record.value);
    // Column / table identifier chunks expose their name directly.
    if (typeof record.name === "string") return record.name;
  }
  return "";
}

function foldOracleRows() {
  return FIXTURE
    // The SQLite aggregate filters server-side (`... IS NOT NULL OR ...`); the duck-typed oracle
    // skips that SQL, so it must apply the identical predicate or the fold over-credits a link-only
    // task with zero token rows - which is what the first run of this suite caught.
    .filter((t) => t.input !== null || t.cached !== null || t.cacheWrite !== null || t.output !== null || t.total !== null)
    .map((t) => ({
      taskId: t.key,
      assignedAgentId: t.assignedAgentId,
      sourceAgentId: t.sourceAgentId,
      checkedOutBy: t.checkedOutBy,
      inputTokens: t.input,
      cachedTokens: t.cached,
      cacheWriteTokens: t.cacheWrite,
      outputTokens: t.output,
      totalTokens: t.total,
    }));
}

describe("agent task-link token aggregation (SQLite fold oracle)", () => {
  it("credits every distinct linked agent once with the sum-of-parts fallback", () => {
    const db = { prepare: () => ({ all: () => foldOracleRows() }) } as never;
    const totals = aggregateTaskTokenTotalsByAgentLink(db);
    expect(Object.fromEntries(totals)).toEqual({
      "agent-a": { inputTokens: 101, cachedTokens: 10, cacheWriteTokens: 5, outputTokens: 22, totalTokens: 138, nTasks: 2 },
      "agent-b": { inputTokens: 107, cachedTokens: 10, cacheWriteTokens: 5, outputTokens: 20, totalTokens: 142, nTasks: 2 },
      // agent-c: t3 (input 7, total falls back to 7) plus t6 (all-zero tokens, +1 task).
      "agent-c": { inputTokens: 7, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 7, nTasks: 2 },
    });
    // An unlinked agent stays ABSENT — no fabricated empty totals.
    expect(totals.get("agent-missing")).toBeUndefined();
  });
});

pgDescribe("agent task-link token aggregation (PostgreSQL SQL aggregate)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_agent_token_usage",
    projectId: PROJECT_A,
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);

  async function seedFixture(): Promise<void> {
    const store = h.store();
    for (const task of FIXTURE) {
      const created = await store.createTask({ title: `token-aggregate ${task.key}`, description: "RUFU-591 fixture" });
      await h.adminDb().update(schema.project.tasks).set({
        assignedAgentId: task.assignedAgentId,
        sourceAgentId: task.sourceAgentId,
        checkedOutBy: task.checkedOutBy,
        tokenUsageInputTokens: task.input,
        tokenUsageCachedTokens: task.cached,
        tokenUsageCacheWriteTokens: task.cacheWrite,
        tokenUsageOutputTokens: task.output,
        tokenUsageTotalTokens: task.total,
      }).where(eq(schema.project.tasks.id, created.id));
    }
  }

  it("returns one row per agent, numerically identical to the SQLite fold on the same fixture", async () => {
    await seedFixture();

    const pgTotals = await aggregateTaskTokenTotalsByAgentLinkAsync(h.layer());
    const fold = aggregateTaskTokenTotalsByAgentLink({ prepare: () => ({ all: () => foldOracleRows() }) } as never);

    expect(Object.fromEntries(pgTotals)).toEqual(Object.fromEntries(fold));

    // bigint SUMs arrive as driver strings unless coerced — numbers are the wire shape the route
    // guards with `inputTokens <= 0`, so verify the primitive type, not just the value.
    for (const totals of pgTotals.values()) {
      for (const value of Object.values(totals)) {
        expect(typeof value).toBe("number");
      }
    }
    // Honest zero survives: agent-c's aggregate total is dominated by t3, but its linked-task
    // count includes the zero-token t6 — nTasks is a DISTINCT-task count, not a link-column sum.
    expect(pgTotals.get("agent-c")?.nTasks).toBe(2);
    // Unlinked agents (and unknown ids) are absent, not fabricated.
    expect(pgTotals.get("agent-missing")).toBeUndefined();
    expect(pgTotals.size).toBe(3);
  });

  it("in a two-project database only the caller's project contributes to the totals", async () => {
    await seedFixture();
    const foreignBefore = await aggregateTaskTokenTotalsByAgentLinkAsync(h.layer());

    // A second project's rows, written through the admin connection (the shape a shared
    // PostgreSQL cluster actually holds): same agent ids, far larger totals.
    const now = new Date().toISOString();
    await h.adminDb().insert(schema.project.tasks).values({
      projectId: PROJECT_B,
      id: "FOREIGN-B1",
      title: "foreign token task",
      description: "RUFU-591 cross-project fixture",
      column: "done",
      createdAt: now,
      updatedAt: now,
      assignedAgentId: "agent-a",
      tokenUsageInputTokens: 100_000,
      tokenUsageOutputTokens: 100_000,
      tokenUsageTotalTokens: 200_000,
    });

    const afterForeign = await aggregateTaskTokenTotalsByAgentLinkAsync(h.layer());
    expect(Object.fromEntries(afterForeign)).toEqual(Object.fromEntries(foreignBefore));
    expect(afterForeign.get("agent-a")?.inputTokens).toBe(101);
  });

  it("emits exactly one project-scoped aggregate statement: FROM project.tasks, GROUP BY, project_id operand, no LIMIT, no bare FROM tasks", async () => {
    const captured: unknown[] = [];
    const stubLayer = {
      projectId: PROJECT_A,
      db: {
        execute: async (query: unknown) => {
          captured.push(query);
          return [];
        },
      },
    } as unknown as AsyncDataLayer;

    await aggregateTaskTokenTotalsByAgentLinkAsync(stubLayer);

    expect(captured).toHaveLength(1);
    const statement = flattenDrizzleSql(captured[0]);
    expect(statement).toMatch(/FROM\s+project\.tasks/i);
    expect(statement).toMatch(/GROUP\s+BY/i);
    // The bound projectId enters as the taskListProjectScope operand — the column predicate must
    // be in the statement, with the value bound as a parameter (never concatenated text).
    expect(statement).toMatch(/project_id/i);
    expect(statement).not.toMatch(/LIMIT/i);
    // The hydration bug is precisely an unqualified board scan; it must not reappear.
    expect(statement).not.toMatch(/\bFROM\s+tasks\b/i);
  });
});
