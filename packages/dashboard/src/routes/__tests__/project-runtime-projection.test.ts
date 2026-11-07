// @vitest-environment node

import express from "express";
import { describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { registerProjectRoutes } from "../register-project-routes.js";

/*
FNXC:ProjectRuntimeOff 2026-11-07-20:26 (RUFU-871):
The projects projection answers "is this project's runtime loaded?" from the PERSISTED central
settings in ONE batched read per request.

Two production failures are pinned here, and they are independent:
1. COST. The first implementation resolved the flag per project through `getOrCreateProjectStore`, so
   a `GET /api/projects` opened up to 25 TaskStores — a side-effecting `store:open` write inside a
   read route. Pinned by: with 25 projects and one central read available, the central seam is called
   EXACTLY ONCE and no per-project store is touched at all.
2. TRUTH. That per-store read was also wrong: a store that will not open says nothing about the
   setting, yet it decided the answer. 14 of 25 projects reported `runtimeState: "unknown"` — each
   wearing a "Runtime off" label the operator never applied — while `project.config.settings` held the
   real value for all 25, including 5 projects genuinely turned off. Pinned by: every project whose
   persisted flag is false comes back `disabled`, never `unknown`.

`status` is still NOT repurposed: production `status` reads `active` (11) / `paused` (14) and names the
project-row lifecycle, a different axis from the runtime gate.
*/

type FakeProject = {
  id: string;
  name: string;
  path: string;
  status: string;
  isolationMode: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  runtimeEnabled?: boolean;
};

const PROJECT_ROWS = [
  {
    id: "p-live",
    name: "Live Project",
    path: "/p/live",
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-02T00:00:00.000Z",
  },
  {
    id: "p-off",
    name: "Turned Off Project",
    path: "/p/off",
    status: "paused",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

/*
The production shape: 25 registered projects, 5 of them turned off by the operator. Ids are ordered so
the off ones are interleaved with the live ones — a projection that answered by position rather than by
project id cannot pass this.
*/
const BOARD_SIZE = 25;
const OFF_PROJECT_IDS = new Set(["p-2", "p-7", "p-11", "p-18", "p-24"]);
const BOARD_ROWS: FakeProject[] = Array.from({ length: BOARD_SIZE }, (_, index) => {
  const id = `p-${index}`;
  return {
    id,
    name: `Project ${index}`,
    path: `/p/${index}`,
    status: OFF_PROJECT_IDS.has(id) ? "paused" : "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
});

/** One fake store per project, each counting how often the projection read it. */
function storesByProject(settingsByProject: Record<string, { runtimeEnabled?: boolean }>) {
  const stores: Record<string, { getSettingsFast: ReturnType<typeof vi.fn>; listTasks: ReturnType<typeof vi.fn> }> = {};
  for (const [projectId, settings] of Object.entries(settingsByProject)) {
    stores[projectId] = {
      getSettingsFast: vi.fn(async () => settings),
      // A per-card read would show up here; the projection must never touch tasks.
      listTasks: vi.fn(async () => []),
    };
  }
  return stores;
}

type CentralRuntimeSeam = { getProjectRuntimeEnabledFlags?: () => Promise<Record<string, boolean> | null> };

function buildApp(
  stores: Record<string, { getSettingsFast: ReturnType<typeof vi.fn>; listTasks: ReturnType<typeof vi.fn> }>,
  centralRuntime: {
    flags: Record<string, boolean> | null;
    /** When true the fake omits the seam entirely: a CentralCore older than this change. */
    seamMissing?: boolean;
    /** When set the seam throws: a central database that cannot answer. */
    throws?: boolean;
  },
  rows: FakeProject[] = PROJECT_ROWS,
  remoteNodes: Array<{ id: string; type: string; status: string; url: string; name: string; apiKey: string }> = [],
) {
  const getStore = vi.fn((projectId: string) => stores[projectId] ?? null);
  const runtimeSeam: CentralRuntimeSeam = centralRuntime.seamMissing
    ? {}
    : {
        getProjectRuntimeEnabledFlags: vi.fn(async () => {
          if (centralRuntime.throws) throw new Error("central settings read unavailable");
          return centralRuntime.flags;
        }),
      };

  const router = express.Router();
  registerProjectRoutes({
    router,
    options: {
      centralCore: {
        isInitialized: () => true,
        reconcileProjectStatuses: vi.fn(async () => undefined),
        listProjects: vi.fn(async () => rows.filter((row) => !row.id.startsWith("remote"))),
        // No remote nodes by default: /projects/across-nodes must then answer exactly like /projects.
        listNodes: vi.fn(async () => remoteNodes),
        ...runtimeSeam,
      },
      engineManager: { getStore },
    },
    runtimeLogger: { child: () => ({ warn: vi.fn() }) },
    prioritizeProjectsForCurrentDirectory: vi.fn((projects: unknown[]) => projects),
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never);
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode ?? 500).json({ error: error.message }));
  return { app, getStore, runtimeSeam };
}

async function getJson(app: express.Express, path: string) {
  const response = await request(app, "GET", path);
  expect(response.status).toBe(200);
  return response.body as Array<Record<string, unknown>>;
}

/** The persisted truth the central read is expected to hand back for a set of rows. */
function persistedFlags(rows: FakeProject[], offIds: Set<string>): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const row of rows) flags[row.id] = !offIds.has(row.id);
  return flags;
}

describe("GET /api/projects runtime projection", () => {
  it("reads every project's flag from ONE central read and opens no per-project store", async () => {
    const stores = storesByProject(Object.fromEntries(
      BOARD_ROWS.map((row) => [row.id, OFF_PROJECT_IDS.has(row.id) ? { runtimeEnabled: false } : {}]),
    ));
    const { app, getStore, runtimeSeam } = buildApp(
      stores,
      { flags: persistedFlags(BOARD_ROWS, OFF_PROJECT_IDS) },
      BOARD_ROWS,
    );
    const rows = await getJson(app, "/api/projects");

    expect(rows).toHaveLength(BOARD_SIZE);
    // The whole point of the batched read: one query for 25 projects, not 25 store opens.
    expect(runtimeSeam.getProjectRuntimeEnabledFlags).toHaveBeenCalledTimes(1);
    expect(getStore).not.toHaveBeenCalled();
    for (const store of Object.values(stores)) {
      expect(store.getSettingsFast).not.toHaveBeenCalled();
      expect(store.listTasks).not.toHaveBeenCalled();
    }
  });

  it("returns disabled — never unknown — for every project whose persisted flag is false", async () => {
    const stores = storesByProject(Object.fromEntries(
      BOARD_ROWS.map((row) => [row.id, OFF_PROJECT_IDS.has(row.id) ? { runtimeEnabled: false } : {}]),
    ));
    const { app } = buildApp(
      stores,
      { flags: persistedFlags(BOARD_ROWS, OFF_PROJECT_IDS) },
      BOARD_ROWS,
    );
    const rows = await getJson(app, "/api/projects");

    for (const expected of BOARD_ROWS) {
      const row = rows.find((candidate) => candidate.id === expected.id)!;
      if (OFF_PROJECT_IDS.has(expected.id)) {
        expect(row.runtimeState).toBe("disabled");
        expect(row.runtimeEnabled).toBe(false);
      } else {
        expect(row.runtimeState).toBe("enabled");
        expect(row.runtimeEnabled).toBe(true);
      }
      expect(row.runtimeState).not.toBe("unknown");
    }
  });

  it("reports runtimeEnabled true for a loaded project and false for a turned-off one", async () => {
    const { app } = buildApp({}, { flags: { "p-live": true, "p-off": false } });
    const rows = await getJson(app, "/api/projects");

    expect(rows.find((row) => row.id === "p-live")?.runtimeEnabled).toBe(true);
    expect(rows.find((row) => row.id === "p-off")?.runtimeEnabled).toBe(false);
  });

  it("answers unknown for a project with no persisted settings row, still without opening a store", async () => {
    // The central read succeeded; this project simply has no `project.config` row. Absence of a row is
    // the absence of an answer, not a failed one — and it must not re-open the per-store path while the
    // central read is healthy.
    const stores = storesByProject({ "p-live": {}, "p-off": { runtimeEnabled: false } });
    const { app, getStore } = buildApp(stores, { flags: { "p-live": true } });
    const rows = await getJson(app, "/api/projects");

    expect(rows.find((row) => row.id === "p-off")?.runtimeEnabled).toBe(false);
    expect(rows.find((row) => row.id === "p-off")?.runtimeState).toBe("unknown");
    expect(getStore).not.toHaveBeenCalled();
    expect(stores["p-off"].getSettingsFast).not.toHaveBeenCalled();
  });

  it("adds the new keys without changing the keys a client already reads", async () => {
    const { app } = buildApp({}, { flags: { "p-live": true, "p-off": false } });
    const rows = await getJson(app, "/api/projects");

    for (const expected of PROJECT_ROWS) {
      const row = rows.find((candidate) => candidate.id === expected.id);
      expect(row).toMatchObject(expected);
      expect(Object.keys(row!)).toEqual([...Object.keys(expected), "runtimeEnabled", "runtimeState"]);
    }
  });

  it("does NOT repurpose status: a turned-off project keeps its own project-row status", async () => {
    const { app } = buildApp({}, { flags: { "p-live": true, "p-off": false } });
    const rows = await getJson(app, "/api/projects");

    const off = rows.find((row) => row.id === "p-off")!;
    expect(off.status).toBe("paused");
    expect(off.runtimeEnabled).toBe(false);
    expect(rows.find((row) => row.id === "p-live")!.status).toBe("active");
  });

  it("carries the same field on /api/projects/across-nodes, the route the combo actually reads", async () => {
    const stores = storesByProject({ "p-live": {}, "p-off": { runtimeEnabled: false } });
    const { app, getStore, runtimeSeam } = buildApp(stores, { flags: { "p-live": true, "p-off": false } });
    const rows = await getJson(app, "/api/projects/across-nodes");

    expect(rows.find((row) => row.id === "p-off")?.runtimeEnabled).toBe(false);
    expect(rows.find((row) => row.id === "p-live")?.runtimeEnabled).toBe(true);
    // The local-only short circuit is the same one-read projection, not a second per-store loop.
    expect(runtimeSeam.getProjectRuntimeEnabledFlags).toHaveBeenCalledTimes(1);
    expect(getStore).not.toHaveBeenCalled();
  });

  it("keeps a remote project's own runtime answer instead of calling it unknown", async () => {
    /*
    FNXC:ProjectRuntimeOff 2026-11-07-20:26 (RUFU-871):
    A remote row carries the answer its own node gave on `GET /api/projects`. This server has no
    `project.config` row for another node's project, so projecting locally would answer `unknown` and
    the UI would label a running project "Runtime off — unloaded, nothing runs" — the exact false label
    this change exists to remove.
    */
    const remote = {
      id: "remote-1",
      name: "Remote Project",
      path: "/p/remote",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      runtimeEnabled: true,
    };
    const rows: FakeProject[] = [...PROJECT_ROWS, remote];
    const { app } = buildApp(
      {},
      { flags: { "p-live": true, "p-off": false } },
      rows,
      [{ id: "n-1", type: "remote", status: "online", url: "http://127.0.0.1:1", name: "node-1", apiKey: "k" }],
    );

    // The route fetches remote projects over HTTP; that node is unreachable here, so serve the
    // already-merged shape by asserting on the local rows plus the remote row's untouched answer.
    const projected = await withRemoteFetched(app, remote);
    expect(projected.runtimeState).toBe("enabled");
    expect(projected.runtimeEnabled).toBe(true);
  });

  /*
  FNXC:ProjectRuntimeOff 2026-11-07-20:26 (RUFU-871):
  The legacy per-store path survives ONLY as the fallback for a deployment whose central read cannot
  answer. Both shapes of unavailable are pinned, and in both the answer stays honest — a turned-off
  project is still `disabled`, an unreadable one is still `unknown`, never `enabled`.
  */
  it("falls back to the per-project store when the central seam is absent (older CentralCore)", async () => {
    const stores = storesByProject({ "p-live": {}, "p-off": { runtimeEnabled: false } });
    const { app } = buildApp(stores, { flags: null, seamMissing: true });
    const rows = await getJson(app, "/api/projects");

    expect(rows.find((row) => row.id === "p-live")?.runtimeState).toBe("enabled");
    expect(rows.find((row) => row.id === "p-off")?.runtimeState).toBe("disabled");
    expect(stores["p-live"].getSettingsFast).toHaveBeenCalledTimes(1);
    expect(stores["p-off"].getSettingsFast).toHaveBeenCalledTimes(1);
    expect(stores["p-live"].listTasks).not.toHaveBeenCalled();
  });

  it("falls back to the per-project store when the central read throws", async () => {
    const stores = storesByProject({ "p-live": {}, "p-off": { runtimeEnabled: false } });
    const { app } = buildApp(stores, { flags: null, throws: true });
    const rows = await getJson(app, "/api/projects");

    expect(rows.find((row) => row.id === "p-live")?.runtimeState).toBe("enabled");
    expect(rows.find((row) => row.id === "p-off")?.runtimeEnabled).toBe(false);
    expect(rows.find((row) => row.id === "p-off")?.runtimeState).toBe("disabled");
  });

  it("never reports a project as loaded when its fallback settings read throws", async () => {
    const stores = storesByProject({ "p-live": {}, "p-off": { runtimeEnabled: false } });
    stores["p-live"].getSettingsFast = vi.fn(async () => {
      throw new Error("project store unavailable");
    });
    const { app } = buildApp(stores, { flags: null, seamMissing: true });
    const rows = await getJson(app, "/api/projects");

    expect(rows.find((row) => row.id === "p-live")?.runtimeEnabled).toBe(false);
    expect(rows.find((row) => row.id === "p-live")?.runtimeState).toBe("unknown");
  });

  it("never reports a project as loaded when its store cannot answer the runtime question", async () => {
    const stores = storesByProject({ "p-live": {}, "p-off": { runtimeEnabled: false } });
    delete (stores["p-off"] as Partial<typeof stores["p-off"]>).getSettingsFast;
    const { app } = buildApp(stores, { flags: null, seamMissing: true });
    const rows = await getJson(app, "/api/projects");

    expect(rows.find((row) => row.id === "p-off")?.runtimeEnabled).toBe(false);
    expect(rows.find((row) => row.id === "p-off")?.runtimeState).toBe("unknown");
    expect(rows.find((row) => row.id === "p-live")?.runtimeState).toBe("enabled");
  });
});

/**
 * Serves the merged across-nodes response by stubbing the remote fetch the route performs, then returns
 * the projected row for that remote project.
 */
async function withRemoteFetched(app: express.Express, remote: FakeProject) {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([remote]), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  try {
    const rows = await getJson(app, "/api/projects/across-nodes");
    const row = rows.find((candidate) => candidate.id === remote.id);
    expect(row).toBeDefined();
    return row!;
  } finally {
    globalThis.fetch = previous;
  }
}
