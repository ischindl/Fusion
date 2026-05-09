import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { get, request } from "../test-request.js";

const state = {
  requests: new Map<string, any>(),
  audits: new Map<string, any[]>(),
  task: { id: "FN-1", paused: true, pausedByAgentId: "agent-1" },
  agent: { id: "agent-1", state: "paused", pauseReason: "awaiting-approval" },
};

class MockApprovalRequestStore {
  constructor(_: unknown) {}
  list(input: any = {}) {
    let rows = [...state.requests.values()];
    if (input.status) rows = rows.filter((r) => r.status === input.status);
    const offset = input.offset ?? 0;
    const limit = input.limit ?? rows.length;
    return rows.slice(offset, offset + limit);
  }
  get(id: string) {
    return state.requests.get(id) ?? null;
  }
  decide(id: string, status: "approved" | "denied", input?: { actor?: any; note?: string }) {
    const req = state.requests.get(id);
    if (!req) throw new Error("Approval request not found");
    if (req.status !== "pending") throw new Error(`Invalid approval request transition: ${req.status} -> ${status}`);
    req.status = status;
    req.decidedAt = new Date().toISOString();
    req.updatedAt = req.decidedAt;
    state.audits.set(id, [...(state.audits.get(id) ?? []), {
      id: `evt-${status}`,
      eventType: status,
      actor: input?.actor ?? { actorId: "user", actorType: "user", actorName: "User" },
      note: input?.note,
      createdAt: req.decidedAt,
    }]);
    return req;
  }
  getAuditHistory(id: string) {
    return state.audits.get(id) ?? [];
  }
}

const updateAgent = vi.fn(async (_id: string, updates: any) => ({ ...state.agent, ...updates }));

class MockAgentStore {
  constructor(_: unknown) {}
  async init() {}
  async getAgent(id: string) {
    return id === state.agent.id ? state.agent : null;
  }
  async updateAgentState(id: string, nextState: string) {
    if (id === state.agent.id) state.agent = { ...state.agent, state: nextState };
  }
  async updateAgent(id: string, updates: any) {
    if (id === state.agent.id) state.agent = { ...state.agent, ...updates };
    return updateAgent(id, updates);
  }
}

vi.mock("@fusion/core", () => ({
  ApprovalRequestStore: MockApprovalRequestStore,
  AgentStore: MockAgentStore,
}));

describe("approval routes", async () => {
  const { registerApprovalRoutes } = await import("../routes/register-approval-routes.js");

  function createApp() {
    const router = express.Router();
    router.use(express.json());
    registerApprovalRoutes({
      router,
      runtimeLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
      getProjectContext: async () => ({
        store: {
          getDatabase: () => ({}),
          getFusionDir: () => "/tmp/fusion",
          getTask: async () => state.task,
          pauseTask: async (_id: string, paused: boolean) => {
            state.task = { ...state.task, paused, pausedByAgentId: paused ? state.task.pausedByAgentId : undefined };
          },
        },
        engine: undefined,
        projectId: "p1",
      }),
      rethrowAsApiError: (e: unknown) => {
        throw e;
      },
    } as any);
    const app = express();
    app.use("/api", router);
    app.use((err: any, _req: any, res: any, _next: any) => {
      const status = err?.statusCode ?? 500;
      res.status(status).json({ error: err?.message ?? String(err) });
    });
    return app;
  }

  beforeEach(() => {
    updateAgent.mockClear();
    const now = new Date().toISOString();
    state.task = { id: "FN-1", paused: true, pausedByAgentId: "agent-1" };
    state.agent = { id: "agent-1", state: "paused", pauseReason: "awaiting-approval" };
    state.requests = new Map([
      ["apr-1", {
        id: "apr-1",
        status: "pending",
        requester: { actorId: "agent-1", actorType: "agent", actorName: "Agent 1" },
        targetAction: { category: "command_execution", summary: "Run command", action: "bash", resourceType: "command", resourceId: "cmd-1" },
        taskId: "FN-1",
        createdAt: now,
        updatedAt: now,
        requestedAt: now,
      }],
      ["apr-2", {
        id: "apr-2",
        status: "denied",
        requester: { actorId: "agent-1", actorType: "agent", actorName: "Agent 1" },
        targetAction: { category: "network_api", summary: "Fetch URL", action: "web_fetch", resourceType: "url", resourceId: "https://example.com" },
        taskId: "FN-1",
        createdAt: now,
        updatedAt: now,
        requestedAt: now,
      }],
    ]);
    state.audits = new Map([
      ["apr-1", [{ id: "evt-created", eventType: "created", actor: { actorId: "agent-1", actorType: "agent", actorName: "Agent 1" }, createdAt: now }]],
      ["apr-2", [{ id: "evt-denied", eventType: "denied", actor: { actorId: "dashboard", actorType: "user", actorName: "User" }, createdAt: now }]],
    ]);
  });

  it("lists with status filtering and pendingCount", async () => {
    const app = createApp();
    const res = await get(app, "/api/approvals?status=pending");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.pendingCount).toBe(1);
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0]).toMatchObject({
      id: "apr-1",
      actionCategory: "command_execution",
      actionSummary: "Run command",
      agentId: "agent-1",
    });
  });

  it("returns detail with history", async () => {
    const app = createApp();
    const res = await get(app, "/api/approvals/apr-1");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("apr-1");
    expect(res.body.history).toHaveLength(1);
    expect(res.body.targetAction.summary).toBe("Run command");
  });

  it("returns 404 for missing request", async () => {
    const app = createApp();
    const res = await get(app, "/api/approvals/missing");
    expect(res.status).toBe(404);
  });

  it("decides approval and unpauses task/agent", async () => {
    const app = createApp();
    const res = await request(
      app,
      "POST",
      "/api/approvals/apr-1/decision",
      JSON.stringify({ decision: "approve", comment: "looks good" }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.history.at(-1)?.eventType).toBe("approved");
    expect(res.body.history.at(-1)?.note).toBe("looks good");
    expect(state.task.paused).toBe(false);
    expect(updateAgent).toHaveBeenCalledWith("agent-1", { pauseReason: undefined });
  });

  it("supports deny decision", async () => {
    const app = createApp();
    const res = await request(
      app,
      "POST",
      "/api/approvals/apr-1/decision",
      JSON.stringify({ decision: "deny" }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("denied");
  });

  it("returns 409 for invalid transition", async () => {
    const app = createApp();
    const res = await request(
      app,
      "POST",
      "/api/approvals/apr-2/decision",
      JSON.stringify({ decision: "approve" }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(409);
  });
});
