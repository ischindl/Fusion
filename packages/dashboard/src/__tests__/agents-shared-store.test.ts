// @vitest-environment node
/*
FNXC:SharedAgentStore 2026-11-11-14:05 (RUFU-591):
Every `GET /api/agents/stats` / `GET /api/agents` request used to construct AND `init()` its own
AgentStore, and `init()` re-lists every agent to provision the built-in workflow-role agents. A
157-byte response therefore paid the store-open tax per request (7.6 s measured). These tests pin
the shared-instance seams: one construct+init per distinct option shape across repeated AND
concurrent requests, identity-keyed isolation between distinct async layers and between bare and
checkout-shaped options, and the never-close/never-attach contract for request paths.
*/
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../test-request.js";

const storeState = vi.hoisted(() => ({
  instances: [] as Array<{
    initCount: number;
    closeCount: number;
    provisionPasses: number;
    listenerCountTotal: number;
    options: Record<string, unknown>;
  }>,
  initDelayMs: 0,
  failNextInit: false,
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  const { EventEmitter } = await import("node:events");
  class MockAgentStore extends EventEmitter {
    initCount = 0;
    closeCount = 0;
    provisionPasses = 0;
    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      storeState.instances.push(this as never);
    }
    async init(): Promise<void> {
      this.initCount += 1;
      if (storeState.initDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, storeState.initDelayMs));
      }
      if (storeState.failNextInit) {
        storeState.failNextInit = false;
        throw new Error("provisioning failed");
      }
      // Mirrors provisionBuiltinWorkflowRoleAgents(): the one roster read per real init().
      await this.listAgents({ includeEphemeral: true });
      this.provisionPasses += 1;
    }
    async listAgents(): Promise<unknown[]> {
      return [
        { id: "agent-active", name: "active-one", state: "active", taskId: undefined },
        { id: "agent-idle", name: "idle-one", state: "idle" },
      ];
    }
    async getRunStatusCounts(): Promise<{ completedRuns: number; failedRuns: number }> {
      return { completedRuns: 7, failedRuns: 3 };
    }
    async getOrgTree(): Promise<unknown> {
      return { nodes: [] };
    }
    async close(): Promise<void> {
      this.closeCount += 1;
    }
    stopWatching(): void {
      this.closeCount += 1;
    }
    get listenerCountTotal(): number {
      return this.eventNames().reduce((total, name) => total + this.listenerCount(name as string), 0);
    }
  }
  return {
    ...actual,
    AgentStore: MockAgentStore,
    countLiveTasks: async () => 42,
  };
});

const { getSharedAgentStore, resetSharedAgentStoreCacheForTests, sharedAgentStoreCacheSize } = await import(
  "../shared-agent-store.js"
);
const { registerAgentCoreRoutes, registerAgentCoreListCreateRoutes } = await import(
  "../routes/register-agent-core-routes.js"
);

function mountStore(layer: unknown) {
  const router = express.Router();
  const store = {
    getFusionDir: () => "/tmp/fusion-shared-store-test",
    getAsyncLayer: () => layer,
    listWorkflowDefinitions: vi.fn().mockResolvedValue([]),
    listTasks: vi.fn().mockResolvedValue([]),
  };
  const deps = {
    sanitizeAgentTaskLinks: async (agents: unknown[]) => agents,
    validateAgentInstructionsPayload: () => undefined,
    upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
  };
  registerAgentCoreListCreateRoutes(
    { router, getProjectContext: async () => ({ store }), rethrowAsApiError: (err: unknown) => { throw err; } } as never,
    deps as never,
  );
  registerAgentCoreRoutes(
    { router, getProjectContext: async () => ({ store }), rethrowAsApiError: (err: unknown) => { throw err; } } as never,
    deps as never,
  );
  const app = express();
  app.use("/api", router);
  app.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message });
  });
  return app;
}

beforeEach(() => {
  resetSharedAgentStoreCacheForTests();
  storeState.instances.length = 0;
  storeState.initDelayMs = 0;
  storeState.failNextInit = false;
});

describe("getSharedAgentStore option-identity cache", () => {
  it("returns one initialized instance for the same options and never re-inits", async () => {
    const layer = { projectId: "proj-a" };
    const first = await getSharedAgentStore({ rootDir: "/r", asyncLayer: layer });
    const second = await getSharedAgentStore({ rootDir: "/r", asyncLayer: layer });

    expect(second).toBe(first);
    expect(storeState.instances).toHaveLength(1);
    expect(storeState.instances[0]?.initCount).toBe(1);
    expect(storeState.instances[0]?.provisionPasses).toBe(1);
  });

  it("keys the async layer by object identity: a different layer at the same rootDir gets its own store", async () => {
    const layerA = { projectId: "proj-a" };
    const layerB = { projectId: "proj-b" };
    const a1 = await getSharedAgentStore({ rootDir: "/r", asyncLayer: layerA });
    const a2 = await getSharedAgentStore({ rootDir: "/r", asyncLayer: layerA });
    const b = await getSharedAgentStore({ rootDir: "/r", asyncLayer: layerB });

    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
    expect(storeState.instances).toHaveLength(2);
  });

  it("never serves the bare shared store to a construction carrying an extra option", async () => {
    const layer = { projectId: "proj-a" };
    const bare = await getSharedAgentStore({ rootDir: "/r", asyncLayer: layer });
    const checkout = await getSharedAgentStore({ rootDir: "/r", asyncLayer: layer, taskStore: {} as never });
    const claimed = await getSharedAgentStore({ rootDir: "/r", asyncLayer: layer, claimStore: {} as never, projectId: "p" });
    const otherRoot = await getSharedAgentStore({ rootDir: "/other", asyncLayer: layer });

    expect(checkout).not.toBe(bare);
    expect(claimed).not.toBe(bare);
    expect(otherRoot).not.toBe(bare);
    expect(storeState.instances).toHaveLength(4);
  });

  it("drops a failed init so the next caller rebuilds instead of serving a broken store", async () => {
    storeState.failNextInit = true;
    await expect(getSharedAgentStore({ rootDir: "/r", asyncLayer: { projectId: "p" } })).rejects.toThrow("provisioning failed");

    const retry = await getSharedAgentStore({ rootDir: "/r", asyncLayer: { projectId: "p" } });
    expect(storeState.instances).toHaveLength(2);
    expect(retry).toBe(storeState.instances[1]);
  });

  it("evicts by dropping the map reference only: an over-cap store is never closed", async () => {
    for (let i = 0; i < 10; i++) {
      await getSharedAgentStore({ rootDir: "/r", asyncLayer: { projectId: `proj-${i}` } });
    }
    expect(sharedAgentStoreCacheSize()).toBeLessThanOrEqual(8);
    expect(storeState.instances).toHaveLength(10);
    for (const instance of storeState.instances) {
      expect(instance.closeCount).toBe(0);
    }
  });
});

describe("converted /api/agents routes reuse the shared store", () => {
  it("answers two concurrent stats requests with exactly one construct+init pass", async () => {
    storeState.initDelayMs = 5;
    const app = mountStore({ projectId: "proj-a" });

    const [one, two] = await Promise.all([
      request(app, "GET", "/api/agents/stats"),
      request(app, "GET", "/api/agents/stats"),
    ]);

    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(storeState.instances).toHaveLength(1);
    expect(storeState.instances[0]?.provisionPasses).toBe(1);
  });

  it("reuses the instance across sequential stats and list requests without re-provisioning", async () => {
    const app = mountStore({ projectId: "proj-a" });

    await request(app, "GET", "/api/agents/stats");
    await request(app, "GET", "/api/agents");
    const third = await request(app, "GET", "/api/agents/stats");

    expect(third.status).toBe(200);
    expect(storeState.instances).toHaveLength(1);
    expect(storeState.instances[0]?.initCount).toBe(1);
    // The roster reads themselves still run per request — only the open/provision tax is shared.
    expect(storeState.instances[0]?.provisionPasses).toBe(1);
  });

  it("leaves no listeners attached and never closes the shared store from a request path", async () => {
    const app = mountStore({ projectId: "proj-a" });

    await request(app, "GET", "/api/agents/stats");
    await request(app, "GET", "/api/agents");
    await request(app, "GET", "/api/agents/org-tree");

    expect(storeState.instances).toHaveLength(1);
    const instance = storeState.instances[0]!;
    expect(instance.listenerCountTotal).toBe(0);
    expect(instance.closeCount).toBe(0);
  });

  it("a distinct project layer sharing the fusion dir gets its own initialized store", async () => {
    const appA = mountStore({ projectId: "proj-a" });
    const appB = mountStore({ projectId: "proj-b" });

    await request(appA, "GET", "/api/agents/stats");
    await request(appB, "GET", "/api/agents/stats");

    expect(storeState.instances).toHaveLength(2);
    expect(storeState.instances[0]).not.toBe(storeState.instances[1]);
  });
});
