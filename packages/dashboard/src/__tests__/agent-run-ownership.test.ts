import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { AgentStore } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";

/*
FNXC:HeartbeatRunOwnership 2026-11-11-00:07:
Two agent-run routes used to write rows they had no business writing. `POST /agents/:id/runs` on a host
with no executor wrote an `active` run and answered 201, so the agent never woke while the row stayed open
until some other host's reaper closed it; `POST /agents/:id/runs/stop` wrote `terminated` over a run
another live process was streaming, which neither stops the session nor leaves an honest record. Measured
2026-11-10/11 with a `--no-engine` dashboard process beside a `fn serve` engine host on one PostgreSQL:
six RunFusion agents were driven by both hosts in the same hour, and 10 of the dashboard process's 17 runs
ended `terminated`. The run row already names the process that opened it (`processPid`), so both routes now
ask who owns it before writing.

These cases need the REAL `@fusion/engine` ownership predicate, so they live in their own file — the big
routes suite mocks that barrel wholesale, and an auto-mock makes every classification `undefined`, which
reads as "withhold" and would make the 409 cases pass for the wrong reason.
*/

async function REQUEST(
  app: express.Express,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const res = await performRequest(app, method, path, body, headers);
  return { status: res.status, body: res.body };
}

/** The two routes only touch the store through `getProjectContext`, which needs a scoped root + backend. */
function createStore(): TaskStore {
  return {
    getFusionDir: () => "/fake/root/.fusion",
    getRootDir: () => "/fake/root",
    getAsyncLayer: () => undefined,
    /*
    getProjectContext binds a project-scoped plugin MCP provider off the store, so a store stub has to
    carry a PluginStore shaped enough for `init()` + a plugin scan to settle.
    */
    getPluginStore: () => ({
      init: async () => {},
      listPlugins: async () => [],
      getPlugin: async () => null,
    }),
    getSettings: async () => ({}),
    getSettingsFast: async () => ({}),
  } as unknown as TaskStore;
}

/** A fake process table: the ownership predicate is about the OS, and a fixture cannot fake the OS by picking a pid. */
function ownerDeps(isPidAlive: () => boolean) {
  return {
    currentPid: 1000,
    platform: "linux" as const,
    isKernelLinux: () => true,
    isPidAlive,
    readProcCmdline: () => "/usr/bin/node\0packages/cli/dist/bin.js\0serve\0",
  };
}

function agentStoreSpies(activeRun: unknown) {
  return {
    init: vi.spyOn(AgentStore.prototype, "init").mockResolvedValue(undefined as never),
    getAgent: vi
      .spyOn(AgentStore.prototype, "getAgent")
      .mockResolvedValue({ id: "agent-owner-1", name: "Owner Agent", role: "executor", state: "active" } as never),
    getActiveHeartbeatRun: vi.spyOn(AgentStore.prototype, "getActiveHeartbeatRun").mockResolvedValue(activeRun as never),
    getRunDetail: vi.spyOn(AgentStore.prototype, "getRunDetail").mockResolvedValue(activeRun as never),
    startHeartbeatRun: vi.spyOn(AgentStore.prototype, "startHeartbeatRun").mockResolvedValue({ id: "run-invented" } as never),
    saveRun: vi.spyOn(AgentStore.prototype, "saveRun").mockResolvedValue(undefined as never),
    endHeartbeatRun: vi.spyOn(AgentStore.prototype, "endHeartbeatRun").mockResolvedValue(undefined as never),
    updateAgentState: vi.spyOn(AgentStore.prototype, "updateAgentState").mockResolvedValue(undefined as never),
  };
}

const runOwnedBy = (processPid: number) => ({
  id: processPid === 4242 ? "run-peer" : "run-orphan",
  agentId: "agent-owner-1",
  startedAt: "2026-01-01T00:00:00.000Z",
  status: "active",
  processPid,
});

function mount(options?: Parameters<typeof createApiRoutes>[1]) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(createStore(), options));
  return app;
}

describe("Agent run routes respect the owning process", () => {
  it("refuses to invent a run on a host that hosts no agent runtime", async () => {
    const spies = agentStoreSpies(null);
    try {
      const res = await REQUEST(
        mount(),
        "POST",
        "/api/agents/agent-owner-1/runs",
        JSON.stringify({ source: "on_demand" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(501);
      expect(res.body.details.reason).toBe("agent-runtime-not-hosted-here");
      expect(res.body.error).toContain("does not run agents");
      // The old behaviour: an `active` run opened by a process that could never drive it.
      expect(spies.startHeartbeatRun).not.toHaveBeenCalled();
      expect(spies.saveRun).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("refuses to terminate a run whose owning process is still alive", async () => {
    const spies = agentStoreSpies(runOwnedBy(4242));
    try {
      const res = await REQUEST(
        mount({ heartbeatRunOwnerDeps: ownerDeps(() => true) }),
        "POST",
        "/api/agents/agent-owner-1/runs/stop",
        JSON.stringify({}),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(409);
      expect(res.body.details.reason).toBe("owner-live-peer");
      expect(spies.endHeartbeatRun).not.toHaveBeenCalled();
      expect(spies.saveRun).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("still stops a run whose owning process is gone", async () => {
    const spies = agentStoreSpies(runOwnedBy(4343));
    try {
      const res = await REQUEST(
        mount({ heartbeatRunOwnerDeps: ownerDeps(() => false) }),
        "POST",
        "/api/agents/agent-owner-1/runs/stop",
        JSON.stringify({}),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(spies.endHeartbeatRun).toHaveBeenCalledWith("run-orphan", "terminated");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
