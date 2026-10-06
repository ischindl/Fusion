// @vitest-environment node
/*
FNXC:AgentStatsQueuedCount 2026-09-27-20:52 (RUFU-378):
`GET /api/agents/stats` answered "how many cards are queued" by resolving the workflow IR of every
live card, i.e. one `getTaskWorkflowSelection*` read per card on top of a full board scan. Measured
live on the RunFusion board it did not answer within 45 s, and an unrelated 16 KB `GET /api/agents`
cost 13.55 s while it was in flight against 2.51 s on an idle server. The panel renders eight
counters, so the queued count now comes from one project-level lane-vocabulary read plus one
column-scoped task read that asks for no derived signal.
*/
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { request } from "../test-request.js";

const coreState = vi.hoisted(() => ({
  agents: [
    { id: "agent-active", name: "active-one", state: "active", taskId: "FN-10" },
    { id: "agent-idle", name: "idle-one", state: "idle" },
  ],
  queuedCount: 42,
  countLiveCalls: [] as Array<{ columns?: readonly string[] } | undefined>,
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  const AgentStore = class {
    async init(): Promise<void> {}
    async listAgents(): Promise<unknown[]> {
      return coreState.agents;
    }
    async getRunStatusCounts(): Promise<{ completedRuns: number; failedRuns: number }> {
      return { completedRuns: 7, failedRuns: 3 };
    }
  };
  return {
    ...actual,
    AgentStore,
    // The SQL COUNT(*) seam the board lane pager uses. Recording its scope is the RUFU-591 seam.
    countLiveTasks: async (_layer: unknown, options?: { columns?: readonly string[] }) => {
      coreState.countLiveCalls.push(options);
      return coreState.queuedCount;
    },
  };
});

const { registerAgentCoreRoutes } = await import("../routes/register-agent-core-routes.js");

function mount(options?: { asyncLayer?: unknown }) {
  const router = express.Router();
  const store = {
    getFusionDir: () => "/tmp/fusion-agents-stats-test",
    getAsyncLayer: () => options?.asyncLayer ?? null,
    // The project vocabulary walks definitions when the reader exists; reporting none keeps the
    // resolver on its legacy intake/hold vocabulary (todo + triage).
    listWorkflowDefinitions: vi.fn().mockResolvedValue([]),
    listTasks: vi.fn().mockResolvedValue([
      { id: "FN-10", column: "todo" },
      { id: "FN-11", column: "triage" },
    ]),
    // The reads the per-card workflow resolver performed. Counting them is the regression seam.
    getTaskWorkflowSelection: vi.fn().mockResolvedValue(null),
    getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue(null),
  };
  registerAgentCoreRoutes(
    {
      router,
      getProjectContext: async () => ({ store }),
      rethrowAsApiError: (err: unknown) => {
        throw err;
      },
    } as never,
    {
      sanitizeAgentTaskLinks: async (agents: Array<{ taskId?: string }>) => agents,
      validateAgentInstructionsPayload: () => undefined,
      upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
    } as never,
  );
  const server = express();
  server.use("/api", router);
  server.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message });
  });
  return { server, store };
}

describe("GET /api/agents/stats queued-count read shape", () => {
  it("reports the same eight counters while counting queued cards from the project lane vocabulary", async () => {
    const { server, store } = mount();

    const response = await request(server, "GET", "/api/agents/stats");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      activeCount: 1,
      assignedTaskCount: 1,
      completedRuns: 7,
      failedRuns: 3,
      successRate: 0.7,
      todoTaskCount: 2,
    });
    expect(store.listTasks).toHaveBeenCalledTimes(1);
    expect(store.listTasks).toHaveBeenCalledWith(expect.objectContaining({
      columns: expect.arrayContaining(["todo", "triage"]),
      includeArchived: false,
      derive: false,
      excludeLog: true,
    }));
  });

  it("does not resolve a workflow per card to answer a count", async () => {
    const { server, store } = mount();

    await request(server, "GET", "/api/agents/stats");

    expect(store.getTaskWorkflowSelection).not.toHaveBeenCalled();
    expect(store.getTaskWorkflowSelectionAsync).not.toHaveBeenCalled();
  });

  /*
  FNXC:AgentStatsQueuedCount 2026-10-06-13:17 (RUFU-591):
  RUFU-378 removed the per-card IR reads, but the counter still hydrated every queued row to produce
  `.length`: 157 bytes of response measured at 7.62 s, with `pg_stat_activity` showing two full
  `project.tasks` scans behind it (565 rows / 42 MB in the project). With the PostgreSQL async layer
  the count is one SQL COUNT over the same lane vocabulary, and `listTasks` must not run at all.
  */
  it("counts queued cards with one SQL count instead of hydrating every queued row", async () => {
    coreState.countLiveCalls.length = 0;
    const { server, store } = mount({ asyncLayer: { projectId: "proj-test" } });

    const response = await request(server, "GET", "/api/agents/stats");

    expect(response.status).toBe(200);
    expect(response.body.todoTaskCount).toBe(coreState.queuedCount);
    expect(store.listTasks).not.toHaveBeenCalled();
    expect(coreState.countLiveCalls).toHaveLength(1);
    expect(coreState.countLiveCalls[0]?.columns).toEqual(expect.arrayContaining(["todo", "triage"]));
  });

  it("keeps the row-scoped read only where no async layer exists (SQLite backend)", async () => {
    coreState.countLiveCalls.length = 0;
    const { server, store } = mount();

    await request(server, "GET", "/api/agents/stats");

    expect(store.listTasks).toHaveBeenCalledTimes(1);
    expect(coreState.countLiveCalls).toHaveLength(0);
  });
});
