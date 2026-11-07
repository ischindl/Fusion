// @vitest-environment node

import express from "express";
import { describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { registerProjectRoutes } from "../register-project-routes.js";

/*
FNXC:ProjectRuntimeOff 2026-11-07-17:41 (RUFU-871):
The projects projection must answer "is this project's engine runtime loaded?" without the client
opening each project. Production had 25 rows with no runtime field at all, so the project combo could
not list a turned-off project at all — and 5 projects were turned off.

Two claims are pinned here, and they are independent:
1. `runtimeEnabled` is present and correct for an enabled and a disabled project, and it is resolved
   ONCE PER PROJECT PER REQUEST — one settings read per row, never a read per card, never a task scan.
2. `status` is NOT repurposed. Production `status` reads `active` (11) / `paused` (14) and names the
   project-row lifecycle; a runtime-off card that also paused must still report `paused`, or every
   existing consumer of `status` silently changes meaning.
*/

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

function buildApp(stores: Record<string, { getSettingsFast: ReturnType<typeof vi.fn>; listTasks: ReturnType<typeof vi.fn> }>) {
  const router = express.Router();
  registerProjectRoutes({
    router,
    options: {
      centralCore: {
        isInitialized: () => true,
        reconcileProjectStatuses: vi.fn(async () => undefined),
        listProjects: vi.fn(async () => PROJECT_ROWS),
        // No remote nodes: /projects/across-nodes must then answer exactly like /projects.
        listNodes: vi.fn(async () => []),
      },
      engineManager: {
        getStore: (projectId: string) => stores[projectId] ?? null,
      },
    },
    runtimeLogger: { child: () => ({ warn: vi.fn() }) },
    prioritizeProjectsForCurrentDirectory: vi.fn((projects: unknown[]) => projects),
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never);
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode ?? 500).json({ error: error.message }));
  return app;
}

async function getJson(app: express.Express, path: string) {
  const response = await request(app, "GET", path);
  expect(response.status).toBe(200);
  return response.body as Array<Record<string, unknown>>;
}

describe("GET /api/projects runtime projection", () => {
  it("reports runtimeEnabled true for a loaded project and false for a turned-off one", async () => {
    const stores = storesByProject({ "p-live": {}, "p-off": { runtimeEnabled: false } });
    const rows = await getJson(buildApp(stores), "/api/projects");

    expect(rows.find((row) => row.id === "p-live")?.runtimeEnabled).toBe(true);
    expect(rows.find((row) => row.id === "p-off")?.runtimeEnabled).toBe(false);
  });

  it("resolves one settings read per project per request and never lists tasks", async () => {
    const stores = storesByProject({ "p-live": {}, "p-off": { runtimeEnabled: false } });
    await getJson(buildApp(stores), "/api/projects");

    expect(stores["p-live"].getSettingsFast).toHaveBeenCalledTimes(1);
    expect(stores["p-off"].getSettingsFast).toHaveBeenCalledTimes(1);
    expect(stores["p-live"].listTasks).not.toHaveBeenCalled();
    expect(stores["p-off"].listTasks).not.toHaveBeenCalled();
  });

  it("adds the new key without changing the keys a client already reads", async () => {
    const stores = storesByProject({ "p-live": {}, "p-off": { runtimeEnabled: false } });
    const rows = await getJson(buildApp(stores), "/api/projects");

    for (const expected of PROJECT_ROWS) {
      const row = rows.find((candidate) => candidate.id === expected.id);
      expect(row).toMatchObject(expected);
      expect(Object.keys(row!)).toEqual([...Object.keys(expected), "runtimeEnabled"]);
    }
  });

  it("does NOT repurpose status: a turned-off project keeps its own project-row status", async () => {
    const stores = storesByProject({ "p-live": {}, "p-off": { runtimeEnabled: false } });
    const rows = await getJson(buildApp(stores), "/api/projects");

    const off = rows.find((row) => row.id === "p-off")!;
    expect(off.status).toBe("paused");
    expect(off.runtimeEnabled).toBe(false);
    expect(rows.find((row) => row.id === "p-live")!.status).toBe("active");
  });

  it("carries the same field on /api/projects/across-nodes, the route the combo actually reads", async () => {
    const stores = storesByProject({ "p-live": {}, "p-off": { runtimeEnabled: false } });
    const rows = await getJson(buildApp(stores), "/api/projects/across-nodes");

    expect(rows.find((row) => row.id === "p-off")?.runtimeEnabled).toBe(false);
    expect(rows.find((row) => row.id === "p-live")?.runtimeEnabled).toBe(true);
  });
});
