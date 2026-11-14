import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import multer from "multer";

/*
FNXC:Agents 2026-06-27-19:16 (RUFU-591 extension):
The Agents listing derives zero/absent token totals from task links while durable agents keep their
non-zero cumulative heartbeat totals. RUFU-591 moved the PostgreSQL leg from a full board scan to a
single grouped SQL query; this suite pins the ROUTE dispatch of that swap — the merge rule itself —
against the real `aggregateTaskTokenTotalsByAgentLinkAsync` driven by a stubbed `db.execute`:
  - an agent with stored non-zero totals keeps them (the aggregate row for it is ignored);
  - an agent with only task-derived totals receives the aggregate — as NUMBERS, because
    node-postgres returns bigint SUMs as strings and `withTaskDerivedTokenTotals` guards with
    `inputTokens <= 0` (a string "10" would flip that guard);
  - an agent with neither stays at zero.
*/

interface FakeState {
  agents: Array<Record<string, unknown>>;
}
const globalThisWithState = globalThis as typeof globalThis & { __fakeAgentStoreState?: FakeState };
globalThisWithState.__fakeAgentStoreState ??= { agents: [] };

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  // The mock factory runs lazily (at first @fusion/core import), after this file's module body —
  // so the fixture state lives on globalThis and both sides attach to the SAME object.
  const state = (globalThis as typeof globalThis & { __fakeAgentStoreState?: FakeState }).__fakeAgentStoreState!;
  class FakeAgentStore {
    agents = state.agents;
    async init() { return this; }
    async close() {}
    async listAgents() { return this.agents; }
  }
  return { ...actual, AgentStore: FakeAgentStore };
});

const agentStoreState = globalThisWithState.__fakeAgentStoreState!;

function baseAgent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    role: "executor",
    state: "idle",
    totalInputTokens: 0,
    totalCachedTokens: 0,
    totalCacheWriteTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    linkedTaskCount: 0,
    ...overrides,
  };
}

// Exactly the one-row-per-agent shape the rewritten SQL leg returns — note the STRING numerics,
// which is the real node-postgres wire shape for bigint SUMs.
const AGGREGATE_ROWS = [
  { agentId: "agent-stored", inputTokens: "7", cachedTokens: "0", cacheWriteTokens: "0", outputTokens: "1", totalTokens: "8", nTasks: "1" },
  { agentId: "agent-task-only", inputTokens: "10", cachedTokens: "2", cacheWriteTokens: "1", outputTokens: "5", totalTokens: "18", nTasks: "2" },
];

async function requestAgents(): Promise<Response> {
  const { createApiRoutes } = await import("../routes.js");
  const { registerAgentCoreListCreateRoutes } = await import("../routes/register-agent-core-routes.js");
  const layer = {
    projectId: "p",
    db: {
      execute: async () => AGGREGATE_ROWS,
    },
  };
  const scopedStore = {
    getFusionDir: () => "/tmp/rufu591-aggregate-store",
    getTaskColumns: async () => [],
    getAsyncLayer: () => layer,
    asyncLayer: layer,
  };
  const routerHandlers = new Map<string, (req: Request, res: Response) => Promise<void>>();
  const router = {
    get: (path: string, handler: (req: Request, res: Response) => Promise<void>) => routerHandlers.set(`GET ${path}`, handler),
    post: (path: string, handler: (req: Request, res: Response) => Promise<void>) => routerHandlers.set(`POST ${path}`, handler),
    patch: (path: string, handler: (req: Request, res: Response) => Promise<void>) => routerHandlers.set(`PATCH ${path}`, handler),
    delete: (path: string, handler: (req: Request, res: Response) => Promise<void>) => routerHandlers.set(`DELETE ${path}`, handler),
  };
  const ctx = {
    db: null,
    router,
    createMiddleware: () => async (_req: Request, _res: Response, next: () => void) => next(),
    appMiddleware: [],
    getProjectContext: async () => ({ store: scopedStore, projectId: "p" }),
    rethrowAsApiError: (err: unknown) => { throw err; },
    resolveProjectForRequest: async () => ({ projectId: "p", nodeId: "n", project: { id: "p", name: "p" } }),
    getScopedStore: async () => scopedStore,
  } as never;
  // The task-link sanitizer has its own behavioral suite; this file isolates token-total dispatch.
  registerAgentCoreListCreateRoutes(ctx, {
    upload: multer(),
    sanitizeAgentTaskLinks: async (agents) => agents,
    validateAgentInstructionsPayload: async () => {},
    validateAgentCapabilities: () => undefined,
  });

  const handler = routerHandlers.get("GET /agents");
  if (!handler) throw new Error("GET /agents route was not registered");

  const req = {
    params: {},
    query: {},
    body: {},
    get: () => undefined,
  } as unknown as Request;
  const response: Response = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json(_body: unknown) { (this as Record<string, unknown>).__body = _body; return this; },
  } as unknown as Response;
  await handler(req, response);
  return response;
}

describe("GET /api/agents token-total dispatch (RUFU-591 aggregate swap)", () => {
  beforeEach(() => {
    vi.resetModules();
    agentStoreState.agents = [
      baseAgent("agent-stored", {
        totalInputTokens: 500,
        totalCachedTokens: 40,
        totalCacheWriteTokens: 5,
        totalOutputTokens: 250,
        totalTokens: 795,
      }),
      baseAgent("agent-task-only"),
      baseAgent("agent-none"),
    ];
  });

  it("keeps stored non-zero totals, merges the aggregate for task-only agents, leaves neither at zero", { timeout: 90_000 }, async () => {
    const res = await requestAgents();
    const body = (res as unknown as { __body: Array<Record<string, unknown>> }).__body;
    const byId = Object.fromEntries(body.map((row) => [row.id as string, row]));

    // Stored heartbeat totals win even though the aggregate has a row for this agent.
    expect(byId["agent-stored"].totalInputTokens).toBe(500);
    expect(byId["agent-stored"].totalCachedTokens).toBe(40);
    expect(byId["agent-stored"].totalOutputTokens).toBe(250);

    // Task-only agent receives the aggregate — numbers, not the driver's bigint strings.
    expect(byId["agent-task-only"].totalInputTokens).toBe(10);
    expect(byId["agent-task-only"].totalOutputTokens).toBe(5);
    // The pre-existing merge rule writes only input/output totals onto the list row —
    // cached/cache-write stay at the agent's stored value (pinning, not aspiration).
    expect(byId["agent-task-only"].totalCachedTokens).toBe(0);
    expect(byId["agent-task-only"].totalCacheWriteTokens).toBe(0);
    expect(typeof byId["agent-task-only"].totalInputTokens).toBe("number");
    expect(typeof byId["agent-task-only"].totalOutputTokens).toBe("number");

    // Neither stored nor task-derived stays honestly zero.
    expect(byId["agent-none"].totalInputTokens).toBe(0);
    expect(byId["agent-none"].totalOutputTokens).toBe(0);
  });

  it("preserves the row's key set plus pendingApprovalCount (response shape unchanged)", { timeout: 90_000 }, async () => {
    const res = await requestAgents();
    const body = (res as unknown as { __body: Array<Record<string, unknown>> }).__body;
    const seededKeys = Object.keys(baseAgent("probe")).sort();
    for (const row of body) {
      const rowKeys = Object.keys(row).sort();
      // Every seeded field survives; the only additions are the pending-approval counter the
      // route always appends. No aggregate internals (nTasks etc.) leak into the row.
      for (const key of seededKeys) expect(rowKeys).toContain(key);
      expect(rowKeys).toContain("pendingApprovalCount");
      expect(rowKeys).not.toContain("nTasks");
      expect(rowKeys).not.toContain("agentId");
    }
  });
});
