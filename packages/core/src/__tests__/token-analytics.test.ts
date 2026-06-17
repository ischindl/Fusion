import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "../db.js";
import { aggregateTokenAnalytics } from "../token-analytics.js";

interface TaskSeed {
  id: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number | null;
  lastUsedAt: string | null;
  modelProvider?: string | null;
  modelId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
}

function insertTask(db: Database, t: TaskSeed): void {
  db.prepare(
    `INSERT INTO tasks
       (id, description, "column", createdAt, updatedAt,
        tokenUsageInputTokens, tokenUsageOutputTokens, tokenUsageCachedTokens,
        tokenUsageCacheWriteTokens, tokenUsageTotalTokens, tokenUsageLastUsedAt,
        modelProvider, modelId, checkoutNodeId, assignedAgentId)
     VALUES (?, 'desc', 'todo', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id,
    t.inputTokens ?? null,
    t.outputTokens ?? null,
    t.cachedTokens ?? null,
    t.cacheWriteTokens ?? null,
    t.totalTokens === undefined ? null : t.totalTokens,
    t.lastUsedAt,
    t.modelProvider ?? null,
    t.modelId ?? null,
    t.nodeId ?? null,
    t.agentId ?? null,
  );
}

describe("token-analytics", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-token-analytics-"));
    db = new Database(join(tmpDir, ".fusion"));
    db.init();
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns correct per-model token totals for 5 tasks across 2 models", () => {
    // 3 tasks on model-A, 2 on model-B, all within range.
    insertTask(db, { id: "t1", inputTokens: 100, outputTokens: 50, totalTokens: 150, lastUsedAt: "2026-03-01T00:00:00.000Z", modelId: "model-A", modelProvider: "anthropic" });
    insertTask(db, { id: "t2", inputTokens: 200, outputTokens: 80, totalTokens: 280, lastUsedAt: "2026-03-02T00:00:00.000Z", modelId: "model-A", modelProvider: "anthropic" });
    insertTask(db, { id: "t3", inputTokens: 300, outputTokens: 20, totalTokens: 320, lastUsedAt: "2026-03-03T00:00:00.000Z", modelId: "model-A", modelProvider: "anthropic" });
    insertTask(db, { id: "t4", inputTokens: 10, outputTokens: 5, totalTokens: 15, lastUsedAt: "2026-03-04T00:00:00.000Z", modelId: "model-B", modelProvider: "openai" });
    insertTask(db, { id: "t5", inputTokens: 40, outputTokens: 60, totalTokens: 100, lastUsedAt: "2026-03-05T00:00:00.000Z", modelId: "model-B", modelProvider: "openai" });

    const result = aggregateTokenAnalytics(db, {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-31T00:00:00.000Z",
      groupBy: "model",
    });

    expect(result.totals.inputTokens).toBe(650);
    expect(result.totals.outputTokens).toBe(215);
    expect(result.totals.totalTokens).toBe(865);
    expect(result.totals.nTasks).toBe(5);

    const groups = new Map(result.groups.map((g) => [g.key, g]));
    expect(groups.get("model-A")!.inputTokens).toBe(600);
    expect(groups.get("model-A")!.totalTokens).toBe(750);
    expect(groups.get("model-A")!.nTasks).toBe(3);
    expect(groups.get("model-B")!.inputTokens).toBe(50);
    expect(groups.get("model-B")!.totalTokens).toBe(115);
    expect(groups.get("model-B")!.nTasks).toBe(2);
    // groups sorted descending by totalTokens
    expect(result.groups[0].key).toBe("model-A");
  });

  it("groups by provider, node, and agent", () => {
    insertTask(db, { id: "t1", inputTokens: 100, totalTokens: 100, lastUsedAt: "2026-03-01T00:00:00.000Z", modelProvider: "anthropic", nodeId: "node-1", agentId: "agent-x" });
    insertTask(db, { id: "t2", inputTokens: 200, totalTokens: 200, lastUsedAt: "2026-03-02T00:00:00.000Z", modelProvider: "openai", nodeId: "node-1", agentId: "agent-y" });

    const byProvider = aggregateTokenAnalytics(db, { groupBy: "provider" });
    expect(new Map(byProvider.groups.map((g) => [g.key, g.totalTokens]))).toEqual(
      new Map([["anthropic", 100], ["openai", 200]]),
    );

    const byNode = aggregateTokenAnalytics(db, { groupBy: "node" });
    expect(byNode.groups).toHaveLength(1);
    expect(byNode.groups[0].key).toBe("node-1");
    expect(byNode.groups[0].totalTokens).toBe(300);

    const byAgent = aggregateTokenAnalytics(db, { groupBy: "agent" });
    expect(new Map(byAgent.groups.map((g) => [g.key, g.totalTokens]))).toEqual(
      new Map([["agent-x", 100], ["agent-y", 200]]),
    );
  });

  it("empty range returns zeroed structures, not nulls", () => {
    insertTask(db, { id: "t1", inputTokens: 100, totalTokens: 100, lastUsedAt: "2026-03-01T00:00:00.000Z", modelId: "model-A" });

    const result = aggregateTokenAnalytics(db, {
      from: "2027-01-01T00:00:00.000Z",
      to: "2027-12-31T00:00:00.000Z",
      groupBy: "model",
    });
    expect(result.totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      nTasks: 0,
    });
    expect(result.groups).toEqual([]);
  });

  it("includes a boundary task exactly at `from` (inclusive lower bound)", () => {
    insertTask(db, { id: "boundary", inputTokens: 42, totalTokens: 42, lastUsedAt: "2026-03-01T00:00:00.000Z", modelId: "model-A" });

    const result = aggregateTokenAnalytics(db, {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-31T00:00:00.000Z",
    });
    expect(result.totals.nTasks).toBe(1);
    expect(result.totals.inputTokens).toBe(42);
  });

  it("excludes tasks with no token usage (lastUsedAt null)", () => {
    insertTask(db, { id: "no-usage", lastUsedAt: null, modelId: "model-A" });
    insertTask(db, { id: "has-usage", inputTokens: 5, totalTokens: 5, lastUsedAt: "2026-03-01T00:00:00.000Z", modelId: "model-A" });

    const result = aggregateTokenAnalytics(db, {});
    expect(result.totals.nTasks).toBe(1);
    expect(result.totals.inputTokens).toBe(5);
  });

  it("derives totalTokens from parts when the persisted total is null", () => {
    insertTask(db, { id: "t1", inputTokens: 10, outputTokens: 20, cachedTokens: 5, cacheWriteTokens: 1, totalTokens: null, lastUsedAt: "2026-03-01T00:00:00.000Z", modelId: "model-A" });
    const result = aggregateTokenAnalytics(db, {});
    expect(result.totals.totalTokens).toBe(36);
  });
});
