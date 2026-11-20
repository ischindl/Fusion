// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Task, TaskStore } from "@fusion/core";
import * as projectStoreResolver from "../../project-store-resolver.js";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

/*
FNXC:ProjectTenancy 2026-11-18-01:31 (RUFU-518):
A request that NAMES a project may only MUTATE inside that project.

Production evidence, measured at a restart window (new listener, so the window is observed and not
inferred), all within seconds of each other against the same card:
  GET  /api/tasks/SANE-463?projectId=proj_b   -> 200 (the card is readable)
  GET  /api/tasks?projectId=proj_b   (x2, 10 s apart, an intended warm-up)
  POST /api/tasks/SANE-463/retry?projectId=proj_b -> 200 (mutation resolved the project fine)
  POST /api/tasks/SANE-463/merge?projectId=proj_b -> 500 {"error":"Task SANE-463 not found"} in ~0.05 s
  ...the identical merge ~a minute later did 59 s of real merge work.

Two facts the harness below must therefore reproduce, because both are load-bearing:
1. A warm-up GET does NOT wire the target engine into the route context. `getProjectContext` re-derives
   everything per request and its lazy start is fire-and-forget, so EVERY assertion here is made AFTER
   preceding scoped reads. A test that only exercised a virgin mount would pass without the fix.
2. `/retry` and `/merge` diverge on the SAME cold project: retry mutates through the correctly-scoped
   store and only optional-chains the engine, while merge fell through to the LAUNCH project's
   `options.onMerge`, whose store is the launch project's. That asymmetry is the cheapest proof of the
   named mechanism, so it is pinned as a must-not-regress case rather than left as a footnote.

The tenancy bug is invisible from the status code alone: a wrong-project lookup produced a fast,
confident "not found" for a card the same request could read, which is the message that invites
destructive cleanup against the wrong project.
*/

const LAUNCH_ID = "proj-launch";
const FOREIGN_ID = "proj-b";
const TASK_ID = "SANE-463";
const LAUNCH_TASK_ID = "LAUNCH-001";
/** The launch project's public tunnel address - the value the three remote-URL sites used to borrow. */
const LAUNCH_TUNNEL_URL = "https://launch-tunnel.trycloudflare.com";

function launchTask(): Task {
  return {
    id: LAUNCH_TASK_ID,
    title: "A card that really belongs to the launch project",
    description: "Used by the carve-out cases, where the launch engine IS the right tenancy.",
    column: "in-review",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
  } as Task;
}

function foreignTask(): Task {
  return {
    id: TASK_ID,
    title: "Cold-engine repro card",
    description: "Exists the whole time; only the route's tenancy was wrong.",
    column: "in-review",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
  } as Task;
}

/** Every store double must answer this or `bindProjectScopedPluginMcpProvider` boots a real PluginLoader. */
function storeSurface() {
  return {
    getRootDir: vi.fn(() => "/srv/project"),
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
    getSettingsFast: vi.fn(async () => ({})),
    getSettings: vi.fn(async () => ({})),
    logEntry: vi.fn(async () => undefined),
    resetTerminalFailureAutoRecoveryBudget: vi.fn(async () => undefined),
  };
}

interface Harness {
  app: express.Express;
  engineManager: { getEngine: ReturnType<typeof vi.fn>; onProjectAccessed: ReturnType<typeof vi.fn> };
  launchStore: TaskStore & Record<string, ReturnType<typeof vi.fn>>;
  foreignStore: TaskStore & Record<string, ReturnType<typeof vi.fn>>;
  launchOnMerge: ReturnType<typeof vi.fn>;
  foreignOnMerge: ReturnType<typeof vi.fn>;
  foreignTaskRow: Task;
}

/**
 * Launch project `proj-launch` owns `launchOnMerge` (exactly how server.ts wires `options.onMerge` from
 * the LAUNCH engine) plus its own store. Project `proj-b` is foreign; `warmForeignEngine` decides whether
 * the manager has an engine for it, which is the only difference between the working and the broken call.
 */
function buildHarness(options: { warmForeignEngine: boolean; engineManager?: boolean } = { warmForeignEngine: false }): Harness {
  const foreignTaskRow = foreignTask();
  const foreignStore = {
    ...storeSurface(),
    getProjectId: vi.fn(() => FOREIGN_ID),
    getTask: vi.fn(async (id: string) => (id === TASK_ID ? foreignTaskRow : null)),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...foreignTaskRow, ...patch })),
    updateTaskAtomic: vi.fn(async (_id: string, mutate: (live: Task) => Task | null) =>
      mutate(foreignTaskRow) ?? foreignTaskRow),
    mergeTask: vi.fn(async () => ({ task: foreignTaskRow, merged: true, mergeConfirmed: true })),
    listTasks: vi.fn(async () => [foreignTaskRow]),
  };
  const launchRow = launchTask();
  const launchStore = {
    ...storeSurface(),
    getProjectId: vi.fn(() => LAUNCH_ID),
    // The launch project holds its own cards and NOT SANE-463. That miss is the whole defect:
    // ProjectEngine.onMerge resolves the id against THIS store, so a foreign id throws "not found".
    getTask: vi.fn(async (id: string) => (id === LAUNCH_TASK_ID ? launchRow : null)),
    mergeTask: vi.fn(async (id: string) => ({ task: { ...launchRow, id }, merged: true, mergeConfirmed: true })),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...launchRow, ...patch })),
    updateTaskAtomic: vi.fn(async (_id: string, mutate: (live: Task) => Task | null) => mutate(launchRow) ?? launchRow),
    listTasks: vi.fn(async () => [launchRow]),
  };

  /*
  Faithful to what `options.onMerge` actually is: `(taskId) => launchEngine.onMerge(taskId)`, and
  `ProjectEngine.onMerge` resolves the id against the LAUNCH engine's own TaskStore. It must therefore
  fail the way production did — `500 Task SANE-463 not found` in ~0.05 s — rather than accept any id
  handed to it. A permissive double here would hide the symptom behind a spurious green.
  */
  const launchOnMerge = vi.fn(async (id: string) => {
    const found = await launchStore.getTask(id);
    if (!found) throw new Error(`Task ${id} not found`);
    return { task: { ...found, column: "done" }, merged: true, mergeConfirmed: true };
  });
  const foreignOnMerge = vi.fn(async (id: string) => ({ task: { id, column: "done" }, merged: true }));

  const engineManager = options.engineManager === false
    ? undefined
    : {
      getEngine: vi.fn((projectId: string) => {
        if (projectId === FOREIGN_ID && options.warmForeignEngine) {
          return {
            getTaskStore: () => foreignStore,
            getProjectId: () => FOREIGN_ID,
            onMerge: foreignOnMerge,
            getAutomationStore: () => undefined,
            getRoutineStore: () => undefined,
          };
        }
        return undefined;
      }),
      onProjectAccessed: vi.fn(),
    };

  vi.spyOn(projectStoreResolver, "getOrCreateProjectStore").mockImplementation(
    async (projectId: string) => (projectId === FOREIGN_ID ? foreignStore : launchStore) as unknown as TaskStore,
  );

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(
    launchStore as unknown as TaskStore,
    {
      engineManager: engineManager as never,
      // Derived from the LAUNCH engine at server.ts:1326-1331. This is the object that made the
      // wrong-project 500 possible; a foreign cold request must never reach it.
      onMerge: launchOnMerge as never,
    } as never,
  ));

  return {
    app,
    engineManager: engineManager ?? { getEngine: vi.fn(() => undefined), onProjectAccessed: vi.fn() },
    launchStore: launchStore as unknown as TaskStore & Record<string, ReturnType<typeof vi.fn>>,
    foreignStore: foreignStore as unknown as TaskStore & Record<string, ReturnType<typeof vi.fn>>,
    launchOnMerge,
    foreignOnMerge,
    foreignTaskRow,
  };
}

/** The production read sequence. Reads must NOT change what the next mutation decides. */
async function readTheCardRepeatedly(harness: Harness) {
  expect((await REQUEST(harness.app, "GET", `/api/tasks/${TASK_ID}?projectId=${FOREIGN_ID}`)).status).toBe(200);
  expect((await REQUEST(harness.app, "GET", `/api/tasks?projectId=${FOREIGN_ID}`)).status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect((await REQUEST(harness.app, "GET", `/api/tasks?projectId=${FOREIGN_ID}`)).status).toBe(200);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("RUFU-518: a request that names a project mutates only that project", () => {
  describe("the five states the shared predicate answers", () => {
    it("foreign project, cold engine: refuses retryably and touches neither the launch callback nor a store-level merge", async () => {
      const harness = buildHarness({ warmForeignEngine: false });
      await readTheCardRepeatedly(harness);
      harness.foreignStore.mergeTask.mockClear();

      const res = await REQUEST(harness.app, "POST", `/api/tasks/${TASK_ID}/merge?projectId=${FOREIGN_ID}`);

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        error: "The project's engine is not running yet. Retry in a few seconds.",
        details: { code: "engine-starting", retryable: true, projectId: FOREIGN_ID },
      });
      // The sentence that made drains delete work must be structurally impossible here.
      expect(String((res.body as { error?: string }).error)).not.toMatch(/not found/i);
      // Both sanctioned legs stay unreachable; the store-level leg is the dangerous one, because it
      // answers 200 while landing the card with mergeConfirmed:false and no merge at all.
      expect(harness.launchOnMerge).not.toHaveBeenCalled();
      expect(harness.foreignStore.mergeTask).not.toHaveBeenCalled();
      // The smoking gun: pre-fix the foreign id was looked up in the LAUNCH project's store.
      expect(harness.launchStore.getTask).not.toHaveBeenCalledWith(TASK_ID);
      // The fire-and-forget lazy kick must survive: the refusal is "wait", not "give up".
      expect(harness.engineManager.onProjectAccessed).toHaveBeenCalledWith(FOREIGN_ID);
    });

    it("names a Retry-After header so a scripted drain can tell wait-a-few-seconds from gone", async () => {
      const harness = buildHarness({ warmForeignEngine: false });
      const res = await REQUEST(harness.app, "POST", `/api/tasks/${TASK_ID}/merge?projectId=${FOREIGN_ID}`);
      expect(res.status).toBe(503);
      expect(res.headers["retry-after"]).toBeDefined();
    });

    it("foreign project, WARM engine: routes to that engine's own onMerge, unchanged", async () => {
      const harness = buildHarness({ warmForeignEngine: true });
      const res = await REQUEST(harness.app, "POST", `/api/tasks/${TASK_ID}/merge?projectId=${FOREIGN_ID}`);

      expect(res.status).toBe(200);
      expect(harness.foreignOnMerge).toHaveBeenCalledWith(TASK_ID);
      expect(harness.launchOnMerge).not.toHaveBeenCalled();
      expect(harness.foreignStore.mergeTask).not.toHaveBeenCalled();
    });

    it("FOREIGN-but-cold is decided by tenancy, not by task existence: an unknown id on a WARM project keeps its honest non-503 answer", async () => {
      const harness = buildHarness({ warmForeignEngine: true });
      harness.foreignOnMerge.mockRejectedValueOnce(new Error("Task NOPE-999 not found"));

      const res = await REQUEST(harness.app, "POST", `/api/tasks/NOPE-999/merge?projectId=${FOREIGN_ID}`);

      // A genuinely missing card still reports the miss; the 503 is only ever about a cold engine.
      expect(res.status).toBe(500);
      expect(String((res.body as { error?: string }).error)).toMatch(/not found/i);
      expect((res.body as { details?: { code?: string } }).details?.code).not.toBe("engine-starting");
    });

    it("launch project's own id with no manager engine: keeps today's onMerge leg, no 503", async () => {
      // The predicate's load-bearing carve-out. options.onMerge IS launch-tenancy, so a request naming
      // the launch id is already correctly served; refusing it would be a fresh Automations/Routines-class
      // regression introduced by this very fix.
      const harness = buildHarness({ warmForeignEngine: false });
      const res = await REQUEST(harness.app, "POST", `/api/tasks/${LAUNCH_TASK_ID}/merge?projectId=${LAUNCH_ID}`);

      expect(res.status).toBe(200);
      expect(harness.launchOnMerge).toHaveBeenCalledWith(LAUNCH_TASK_ID);
      expect(harness.foreignStore.mergeTask).not.toHaveBeenCalled();
    });

    it("unscoped request (no project id at all): keeps today's onMerge leg, no 503", async () => {
      const harness = buildHarness({ warmForeignEngine: false });
      const res = await REQUEST(harness.app, "POST", `/api/tasks/${LAUNCH_TASK_ID}/merge`);

      expect(res.status).toBe(200);
      expect(harness.launchOnMerge).toHaveBeenCalledWith(LAUNCH_TASK_ID);
    });

    it("the --no-engine host (no engineManager at all) keeps uiOnlyOnMerge as its only merge path", async () => {
      // dashboard.ts passes NO engineManager on purpose (RUFU-938); its uiOnlyOnMerge is correct, so the
      // predicate's `!engineManager -> false` arm must stay. This is a contract, not a hole.
      const harness = buildHarness({ warmForeignEngine: false, engineManager: false });
      const res = await REQUEST(harness.app, "POST", `/api/tasks/${LAUNCH_TASK_ID}/merge?projectId=${FOREIGN_ID}`);

      expect(res.status).toBe(200);
      expect(harness.launchOnMerge).toHaveBeenCalledWith(LAUNCH_TASK_ID);
    });
  });

  /*
  FNXC:ProjectTenancy 2026-11-19-20:45 (RUFU-518):
  The read-side half of the same invariant. A remote login URL is a credential PLUS AN ADDRESS, and all
  three sites used `getCurrentTunnelUrl(engine ?? options?.engine)`: the token was minted from the FOREIGN
  project's store while the host came from the LAUNCH project's engine, producing a working-looking link
  that carried project B's credential to project A's public tunnel.

  The fixture makes the tunnel host the ONLY thing that can decide the answer: the foreign project runs
  Cloudflare in quick-tunnel mode with no `ingressUrl`, so `resolveRemoteBaseUrl` can only return the
  tunnel URL it is handed. A leaked launch address is therefore visible in `loginUrl`, and its absence is
  visible as the project's own honest 409 (`REMOTE_URL_NOT_READY`) rather than as a silent substitution.
  */
  describe("the read-side half: a remote login URL is addressed at its own project only", () => {
    const FOREIGN_TUNNEL = "https://foreign-tunnel.trycloudflare.com";

    function remoteAccessSettings() {
      return {
        activeProvider: "cloudflare" as const,
        providers: {
          tailscale: { enabled: false, hostname: "", targetPort: 4040, acceptRoutes: false },
          cloudflare: { enabled: true, quickTunnel: true, tunnelName: "", tunnelToken: "", ingressUrl: "" },
        },
        tokenStrategy: {
          persistent: { enabled: true, token: "frt_persistent_token" },
          shortLived: { enabled: true, ttlMs: 120000, maxTtlMs: 86400000 },
        },
        lifecycle: { rememberLastRunning: true, wasRunningOnShutdown: false, lastRunningProvider: null },
      };
    }

    function remoteStore(projectId: string) {
      return {
        ...storeSurface(),
        getProjectId: vi.fn(() => projectId),
        getSettings: vi.fn(async () => ({ remoteAccess: remoteAccessSettings() })),
        updateSettings: vi.fn(async (patch: Record<string, unknown>) => patch),
        updateGlobalSettings: vi.fn(async (patch: Record<string, unknown>) => patch),
      };
    }

    /** `warmForeignEngine` is the only difference between the misaddressed call and the correct one. */
    function buildRemoteHarness(input: { warmForeignEngine: boolean; withEngineManager?: boolean }) {
      const foreignStore = remoteStore(FOREIGN_ID);
      const launchStore = remoteStore(LAUNCH_ID);
      const withEngineManager = input.withEngineManager !== false;

      const engineManager = withEngineManager
        ? {
          getEngine: vi.fn((projectId: string) => (
            input.warmForeignEngine && projectId === FOREIGN_ID
              ? {
                getTaskStore: () => foreignStore,
                getProjectId: () => FOREIGN_ID,
                getRemoteTunnelManager: () => ({ getStatus: () => ({ url: FOREIGN_TUNNEL }) }),
              }
              : undefined
          )),
          onProjectAccessed: vi.fn(),
        }
        : undefined;

      vi.spyOn(projectStoreResolver, "getOrCreateProjectStore").mockImplementation(
        async (projectId: string) => (projectId === FOREIGN_ID ? foreignStore : launchStore) as unknown as TaskStore,
      );

      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(launchStore as unknown as TaskStore, {
        engineManager: engineManager as never,
        // The launch engine: exactly the object whose tunnel address used to be borrowed for foreign reads.
        engine: {
          getProjectId: () => LAUNCH_ID,
          getTaskStore: () => launchStore,
          getRemoteTunnelManager: () => ({ getStatus: () => ({ url: LAUNCH_TUNNEL_URL }) }),
        },
      } as never));

      return { app, foreignStore };
    }

    const URL_ROUTES: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [
      { method: "GET", path: "/api/remote/url?tokenType=persistent" },
      { method: "GET", path: "/api/remote/qr?format=text&tokenType=persistent" },
      { method: "POST", path: "/api/remote-access/auth/login-url", body: { mode: "persistent" } },
    ];

    for (const route of URL_ROUTES) {
      it(`${route.method} ${route.path.split("?")[0]} refuses a cold foreign project instead of addressing its token at the launch tunnel`, async () => {
        const harness = buildRemoteHarness({ warmForeignEngine: false });

        const separator = route.path.includes("?") ? "&" : "?";
        const res = await REQUEST(
          harness.app,
          route.method,
          `${route.path}${separator}projectId=${FOREIGN_ID}`,
          route.body ? JSON.stringify(route.body) : undefined,
          route.body ? { "Content-Type": "application/json" } : undefined,
        );

        expect(res.status).toBe(503);
        expect(res.body.details).toMatchObject({ code: "engine-starting", retryable: true, projectId: FOREIGN_ID });
        expect(res.headers["retry-after"]).toBeDefined();
        // The launch project's public address must never appear in another project's answer.
        expect(JSON.stringify(res.body)).not.toContain("launch-tunnel");
        // Refused BEFORE minting: not even the foreign store's token strategy was read.
        expect(harness.foreignStore.getSettings).not.toHaveBeenCalled();
      });
    }

    it("a WARM foreign engine still gets its OWN tunnel address in the login link", async () => {
      const harness = buildRemoteHarness({ warmForeignEngine: true });

      const res = await REQUEST(harness.app, "GET", `/api/remote/url?tokenType=persistent&projectId=${FOREIGN_ID}`);

      expect(res.status).toBe(200);
      expect(String(res.body.url)).toContain("foreign-tunnel");
      expect(String(res.body.url)).not.toContain("launch-tunnel");
    });

    it("the launch project's own id keeps today's launch tunnel address, byte for byte", async () => {
      const harness = buildRemoteHarness({ warmForeignEngine: false });

      const res = await REQUEST(harness.app, "GET", `/api/remote/url?tokenType=persistent&projectId=${LAUNCH_ID}`);

      expect(res.status).toBe(200);
      expect(String(res.body.url)).toContain("launch-tunnel");
    });

    it("an unscoped request keeps today's launch tunnel address too", async () => {
      const harness = buildRemoteHarness({ warmForeignEngine: false });

      const res = await REQUEST(harness.app, "GET", "/api/remote/url?tokenType=persistent");

      expect(res.status).toBe(200);
      expect(String(res.body.url)).toContain("launch-tunnel");
    });

    it("a foreign project on a host with no engineManager reads NO launch address either", async () => {
      // The predicate is false without an engineManager, yet the host still must not be borrowed: the
      // honest answer is that project's own 409 (quick tunnel not started), never another address.
      const harness = buildRemoteHarness({ warmForeignEngine: false, withEngineManager: false });

      const res = await REQUEST(harness.app, "GET", `/api/remote/url?tokenType=persistent&projectId=${FOREIGN_ID}`);

      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).not.toContain("launch-tunnel");
    });
  });

  describe("the must-not-regress sibling: /retry on the same cold project", () => {
    it("does not gain the engine-starting refusal and mutates the FOREIGN store, not the launch one", async () => {
      const harness = buildHarness({ warmForeignEngine: false });
      await readTheCardRepeatedly(harness);
      harness.foreignStore.getTask.mockClear();
      harness.launchStore.getTask.mockClear();

      const res = await REQUEST(harness.app, "POST", `/api/tasks/${TASK_ID}/retry?projectId=${FOREIGN_ID}`);

      // Production measured 200 here while merge 500'd seconds later on the same cold project.
      expect(res.status).not.toBe(503);
      expect((res.body as { details?: { code?: string } }).details?.code).not.toBe("engine-starting");
      expect(harness.foreignStore.getTask).toHaveBeenCalledWith(TASK_ID);
      expect(harness.launchStore.getTask).not.toHaveBeenCalled();
    });
  });
});