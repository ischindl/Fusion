// @vitest-environment node

import express from "express";
import { CentralCore } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { registerProjectRoutes } from "../register-project-routes.js";

/*
FNXC:ProjectRuntimeOff 2026-11-07-22:35 (RUFU-871): The cold-process contract, against the real class.

The previous slice's test passed a hand-made central object of its own shape:
`{ getProjectRuntimeEnabledFlags: async () => theAnswerICalculatedInThisTest }`. That asserted the
assumption "the server's central object has this seam and answers what I expect", so it stayed green
while production served `24 unknown / 1 enabled / 0 disabled` against a database holding 6 disabled
projects. The real `CentralCore` the dashboard holds is built from the cwd project's own TaskStore
layer (`dashboardLayer = store.getAsyncLayer()`, `packages/cli/src/commands/dashboard.ts:1064`), whose
pool is bound to ONE `fusion.project_id`, and `project.config` has FORCED row-level security — so the
batched read it performs answers for exactly one project unless it takes a transaction-local bypass.

Here the route is exercised end-to-end with a real `CentralCore` instance (its own
`getProjectRuntimeEnabledFlags` runs, unstubbed) over a fake PostgreSQL backend that enforces the real
RLS predicate. The contract pinned is the one the operator was denied:

- COLD. No per-project TaskStore is opened, by any path, on the first request.
- TRUTH. Every project whose persisted flag is `false` comes back `disabled`, on the first request,
  in a process that has opened nothing.
- HONEST FALLBACK. When the central read cannot obtain the cross-project view it reports "could not
  answer", the per-store fallback runs, and the log says so. A truncated central record must never be
  trusted, and a failed read must never report `enabled`.
*/

const BOUND_PROJECT_ID = "local-64dc6e191dfdd44c99728880";

/** The production shape: 28 `project.config` rows for 25 registered projects, 6 turned off. */
const OFF_IDS = new Set(["p-2", "p-7", "p-11", "p-13", "p-18", "p-24"]);
const CONFIG_ROWS = Array.from({ length: 28 }, (_, index) => ({
  projectId: `p-${index}`,
  runtimeEnabled: OFF_IDS.has(`p-${index}`) ? "false" : null,
}));

const REGISTERED_IDS = Array.from({ length: 25 }, (_, index) => `p-${index}`);

const PROJECT_ROWS = REGISTERED_IDS.map((id) => ({
  id,
  name: `Project ${id}`,
  path: `/p/${id}`,
  status: OFF_IDS.has(id) ? "paused" : "active",
  isolationMode: "in-process",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}));

/** Flattens a drizzle `SQL` node to statement text; mirrors the core contract test's extractor. */
function sqlText(query: unknown, depth = 0): string {
  if (depth > 8 || query == null) return "";
  if (typeof query === "string") return query;
  const node = query as { queryChunks?: unknown; value?: unknown };
  const raw = Array.isArray(node.value) && node.value.length === 1 ? node.value[0] : node.value;
  if (typeof raw === "string") return raw;
  const chunks = node.queryChunks;
  if (chunks === query || chunks === undefined) return "";
  if (Array.isArray(chunks)) return chunks.map((chunk) => sqlText(chunk, depth + 1)).join("");
  return sqlText(chunks, depth + 1);
}

/**
 * A PostgreSQL backend with forced RLS on `project.config`, bound to one project the way every
 * project TaskStore pool is. Visibility is computed from the policy's own USING clause, so the only
 * way any code under test sees more than the bound project is by obtaining the bypass the way the
 * product does.
 */
function fakeIsolatedLayer(options: { boundProjectId: string; bypassAvailable?: boolean }) {
  const bypassAvailable = options.bypassAvailable ?? true;
  let txBypass = false;

  const visible = (bypass: boolean) =>
    bypass ? CONFIG_ROWS : CONFIG_ROWS.filter((row) => row.projectId === options.boundProjectId);
  const makeSelect = (isBypassed: () => boolean) => vi.fn(() => ({
    from: vi.fn(async () => visible(isBypassed())),
  }));

  const db = { select: makeSelect(() => false) };

  return {
    projectId: options.boundProjectId,
    db,
    transactionImmediate: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      txBypass = false;
      const tx = {
        select: makeSelect(() => txBypass),
        execute: vi.fn(async (query: unknown) => {
          const text = sqlText(query);
          if (text.includes("set_config('fusion.project_bypass'")) {
            if (/true\s*\)/.test(text) && bypassAvailable) txBypass = true;
            return [];
          }
          if (text.includes("current_setting('fusion.project_bypass'")) {
            return [{ bypass: txBypass ? "on" : null }];
          }
          throw new Error(`unexpected statement: ${text}`);
        }),
      };
      try {
        return await fn(tx);
      } finally {
        txBypass = false;
      }
    }),
  };
}

/**
 * A central object carrying the REAL `CentralCore` prototype — real `getProjectRuntimeEnabledFlags`,
 * real `ensureInitialized` — over a given data layer. A full `init()` would bootstrap the central
 * schema against a fake database, so only the fields the read path reads are installed and the three
 * registry reads the route performs are supplied. The runtime-flag method itself is never stubbed:
 * that is the seam the previous slice's hand-made fake replaced with its own assumption.
 */
function centralOverLayer(
  layer: unknown,
  registry: { listProjects: unknown[]; listNodes: unknown[] },
) {
  return Object.assign(Object.create(CentralCore.prototype) as object, {
    asyncLayer: layer,
    initialized: true,
    isInitialized: () => true,
    reconcileProjectStatuses: vi.fn(async () => undefined),
    listProjects: vi.fn(async () => registry.listProjects),
    listNodes: vi.fn(async () => registry.listNodes),
  }) as unknown as CentralCore;
}

function buildApp(options: {
  layer: unknown;
  /** Store factory the route must NOT call on the healthy path; counts every call. */
  getStore: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  /** When true the backend refuses the bypass, as a restricted role/pool would. */
  bypassAvailable?: boolean;
}) {
  const central = centralOverLayer(options.layer, {
    listProjects: PROJECT_ROWS,
    listNodes: [],
  });

  const router = express.Router();
  registerProjectRoutes({
    router,
    options: {
      centralCore: central,
      engineManager: { getStore: options.getStore },
    },
    runtimeLogger: { child: () => ({ warn: options.warn }) },
    prioritizeProjectsForCurrentDirectory: vi.fn((projects: unknown[]) => projects),
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never);

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  return app;
}

describe("GET /api/projects runtime state, cold process", () => {
  it("reports the persisted truth for every project with NO project store opened", async () => {
    const getStore = vi.fn(() => null);
    const warn = vi.fn();
    const app = buildApp({
      layer: fakeIsolatedLayer({ boundProjectId: BOUND_PROJECT_ID }),
      getStore,
      warn,
    });

    const response = await request(app, "GET", "/api/projects");
    expect(response.status).toBe(200);
    const body = response.body as Array<{ id: string; runtimeEnabled: boolean; runtimeState: string }>;
    expect(body).toHaveLength(REGISTERED_IDS.length);

    // THE decisive assertion: the answer never depends on which stores this process happens to hold.
    expect(getStore).not.toHaveBeenCalled();

    for (const row of body) {
      if (OFF_IDS.has(row.id)) {
        expect([row.runtimeState, row.runtimeEnabled]).toEqual(["disabled", false]);
      } else {
        expect([row.runtimeState, row.runtimeEnabled]).toEqual(["enabled", true]);
      }
    }
    // The old reading, reproduced from a truncated read, is impossible here.
    expect(body.filter((row) => row.runtimeState === "unknown")).toHaveLength(0);
    expect(body.filter((row) => row.runtimeState === "disabled")).toHaveLength(OFF_IDS.size);
    expect(warn).not.toHaveBeenCalled();
  });

  it("answers identically on /projects/across-nodes with zero remote nodes", async () => {
    const getStore = vi.fn(() => null);
    const app = buildApp({
      layer: fakeIsolatedLayer({ boundProjectId: BOUND_PROJECT_ID }),
      getStore,
      warn: vi.fn(),
    });

    const response = await request(app, "GET", "/api/projects/across-nodes");
    expect(response.status).toBe(200);
    const body = response.body as Array<{ id: string; runtimeState: string }>;

    expect(getStore).not.toHaveBeenCalled();
    expect(body.filter((row) => row.runtimeState === "disabled")).toHaveLength(OFF_IDS.size);
  });

  it("falls back to the stores it already holds AND LOGS when the bypass cannot be obtained", async () => {
    const settingsReads: string[] = [];
    const getStore = vi.fn((projectId: string) => {
      settingsReads.push(projectId);
      return OFF_IDS.has(projectId)
        ? { getSettingsFast: async () => ({ runtimeEnabled: false }) }
        : { getSettingsFast: async () => ({}) };
    });
    const warn = vi.fn();
    const app = buildApp({
      layer: fakeIsolatedLayer({ boundProjectId: BOUND_PROJECT_ID, bypassAvailable: false }),
      getStore,
      warn,
    });

    const response = await request(app, "GET", "/api/projects");
    expect(response.status).toBe(200);
    const body = response.body as Array<{ id: string; runtimeEnabled: boolean; runtimeState: string }>;

    // A one-project record was the old lie; `null` is what must reach the fallback.
    expect(body.filter((row) => row.runtimeState === "unknown" && row.runtimeEnabled)).toHaveLength(0);
    expect(body.filter((row) => row.runtimeState === "disabled")).toHaveLength(OFF_IDS.size);
    expect(getStore).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/could not answer for 25 project/);
  });
});
