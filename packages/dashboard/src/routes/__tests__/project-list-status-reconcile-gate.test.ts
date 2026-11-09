// @vitest-environment node

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import {
  INITIALIZING_STATUS_RECONCILE_REARM_MS,
  hasInitializingProjectStatus,
  registerProjectRoutes,
  setProjectStatusReconcileClockForTests,
} from "../register-project-routes.js";

/*
FNXC:ProjectListReadCost 2026-11-09-17:02 (RUFU-910):
`GET /api/projects` repaired pre-cutover `initializing` project rows by running
`central.reconcileProjectStatuses()` — a `transactionImmediate` write sweep — on EVERY request. The
dashboard polls this route every 5 s per open tab, so an 8-tab board paid ~1.6 write transactions per
second to repair a population production reports as empty (25 projects: 11 `active`, 14 `paused`,
0 `initializing`).

These tests assert WORK COUNTS on the read seam, never wall time: with the premise absent the sweep
runs zero times and the list is read once per request; with the premise present it runs exactly once
and the list is re-read so the response still reports the repaired status; and a row that stays
`initializing` after a sweep is re-repaired no more often than the stated staleness bound.
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
};

function projectRow(id: string, status = "active"): FakeProject {
  return {
    id,
    name: `Project ${id}`,
    path: `/p/${id}`,
    status,
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Production-shaped board: 25 rows, none stuck in the legacy `initializing` status. */
const HEALTHY_ROWS: FakeProject[] = Array.from({ length: 25 }, (_, index) =>
  projectRow(`p-${index}`, index % 3 === 0 ? "paused" : "active"),
);

/** Flags for every board row, so the runtime projection never needs the per-store fallback. */
const BOARD_FLAGS: Record<string, boolean> = Object.fromEntries(
  HEALTHY_ROWS.map((row, index) => [row.id, index % 4 !== 0]),
);

/** Deterministic clock: the re-arm bound is proven by moving time, never by waiting for it. */
function fakeClock(startMs: number) {
  let at = startMs;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

type FakeStore = { getSettingsFast: () => Promise<Record<string, unknown> | undefined> };

type CentralState = {
  rows: FakeProject[];
  flags: Record<string, boolean> | null;
  /** When true the fake omits the runtime seam: an older CentralCore, which forces the store fallback. */
  seamMissing?: boolean;
  /** Stores this process already holds open, which is what the legacy fallback reads. */
  stores?: Record<string, FakeStore>;
};

function buildApp(state: CentralState) {
  const reads = {
    reconcile: vi.fn(async () => [{ projectId: "stale", previousStatus: "initializing" }]),
    listProjects: vi.fn(async () => state.rows),
    listNodes: vi.fn(async () => []),
    runtimeFlags: vi.fn(async () => state.flags),
    getStore: vi.fn((projectId: string) => state.stores?.[projectId] ?? null),
  };
  const centralCore: Record<string, unknown> = {
    isInitialized: () => true,
    reconcileProjectStatuses: reads.reconcile,
    listProjects: reads.listProjects,
    listNodes: reads.listNodes,
  };
  if (!state.seamMissing) centralCore.getProjectRuntimeEnabledFlags = reads.runtimeFlags;

  const router = express.Router();
  registerProjectRoutes({
    router,
    options: { centralCore, engineManager: { getStore: reads.getStore } },
    runtimeLogger: { child: () => ({ warn: vi.fn() }) },
    prioritizeProjectsForCurrentDirectory: vi.fn((projects: unknown[]) => projects),
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never);

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(error.statusCode ?? 500).json({ error: error.message }),
  );
  return { app, reads, state };
}

async function getResponse(app: express.Express, path: string) {
  const response = await request(app, "GET", path);
  expect(response.status).toBe(200);
  return response;
}

afterEach(() => {
  setProjectStatusReconcileClockForTests(Date.now);
});

describe("GET /api/projects stale-status reconciliation gate", () => {
  it("performs no write transaction when the listed rows name no initializing project", async () => {
    const { app, reads } = buildApp({ rows: HEALTHY_ROWS, flags: BOARD_FLAGS });

    for (let poll = 0; poll < 3; poll += 1) {
      const response = await getResponse(app, "/api/projects");
      expect((response.body as unknown[]).length).toBe(25);
    }

    // The measured cost being removed: one write sweep per poll. Now: none, for healthy rows.
    expect(reads.reconcile).not.toHaveBeenCalled();
    // One list read per request — the gate must not re-read speculatively.
    expect(reads.listProjects).toHaveBeenCalledTimes(3);
    // The batched runtime read stays exactly one per request, whatever the project count.
    expect(reads.runtimeFlags).toHaveBeenCalledTimes(3);
    expect(reads.getStore).not.toHaveBeenCalled();
  });

  it("repairs the row the list itself names and reports the repaired status", async () => {
    const staleRow = projectRow("p-7", "initializing");
    const state: CentralState = { rows: [...HEALTHY_ROWS.slice(0, 7), staleRow, ...HEALTHY_ROWS.slice(8)], flags: BOARD_FLAGS };
    const { app, reads } = buildApp(state);
    // The sweep repairs it, so the authoritative table answers `active` from then on.
    let listCalls = 0;
    reads.listProjects.mockImplementation(async () => {
      listCalls += 1;
      return listCalls === 1 ? state.rows : state.rows.map((row) => (row.id === "p-7" ? { ...row, status: "active" } : row));
    });

    const response = await getResponse(app, "/api/projects");
    const body = response.body as Array<Record<string, unknown>>;

    expect(reads.reconcile).toHaveBeenCalledTimes(1);
    // Sweep-then-re-read: the response must carry the repaired status, as the old order did.
    expect(reads.listProjects).toHaveBeenCalledTimes(2);
    expect(body.find((row) => row.id === "p-7")?.status).toBe("active");

    // The next poll sees healthy rows again and pays nothing.
    await getResponse(app, "/api/projects");
    expect(reads.reconcile).toHaveBeenCalledTimes(1);
    expect(reads.listProjects).toHaveBeenCalledTimes(3);
  });

  it("bounds a repeated repair to one write transaction per re-arm window", async () => {
    const clock = fakeClock(1_700_000_000_000);
    setProjectStatusReconcileClockForTests(clock.now);
    // A row that stays `initializing` after the sweep: the pathological case the bound exists for.
    const { app, reads } = buildApp({ rows: [projectRow("stuck", "initializing"), ...HEALTHY_ROWS.slice(1)], flags: BOARD_FLAGS });

    await getResponse(app, "/api/projects");
    expect(reads.reconcile).toHaveBeenCalledTimes(1);

    // Four polls strictly inside the bound buy no additional write transaction.
    for (let poll = 0; poll < 4; poll += 1) {
      clock.advance(INITIALIZING_STATUS_RECONCILE_REARM_MS / 5);
      await getResponse(app, "/api/projects");
    }
    expect(reads.reconcile).toHaveBeenCalledTimes(1);

    clock.advance(INITIALIZING_STATUS_RECONCILE_REARM_MS);
    await getResponse(app, "/api/projects");
    expect(reads.reconcile).toHaveBeenCalledTimes(2);
  });

  it("gates the coalesced sibling too, which is the route the board actually polls", async () => {
    const { app, reads } = buildApp({ rows: HEALTHY_ROWS, flags: BOARD_FLAGS });
    await getResponse(app, "/api/projects/across-nodes");
    expect(reads.reconcile).not.toHaveBeenCalled();
    expect(reads.listProjects).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/projects response parity", () => {
  /** The projection's own expected bytes: spread the row, then append the runtime fields in order. */
  const expectedBody = (rows: FakeProject[], flags: Record<string, boolean> | null) =>
    JSON.stringify(
      rows.map((row) => {
        const flag = flags?.[row.id];
        const runtimeState = flag === true ? "enabled" : flag === false ? "disabled" : "unknown";
        return { ...row, runtimeEnabled: runtimeState === "enabled", runtimeState };
      }),
    );

  it("answers byte-identically for a populated board", async () => {
    const { app } = buildApp({ rows: HEALTHY_ROWS, flags: BOARD_FLAGS });
    const response = await getResponse(app, "/api/projects");
    expect(response.bodyBuffer.toString("utf8")).toBe(expectedBody(HEALTHY_ROWS, BOARD_FLAGS));
  });

  it("answers byte-identically for an empty registry", async () => {
    const { app } = buildApp({ rows: [], flags: {} });
    const response = await getResponse(app, "/api/projects");
    expect(response.bodyBuffer.toString("utf8")).toBe("[]");
  });

  it("keeps the no-runtimeEnabled projection honest when the central seam cannot answer", async () => {
    // Seam missing ⇒ the logged per-store fallback: a persisted `false` stays `disabled`, while a store
    // this process cannot read answers `unknown` rather than the optimistic `enabled`.
    const rows = HEALTHY_ROWS.slice(0, 2);
    const { app, reads } = buildApp({
      rows,
      flags: null,
      seamMissing: true,
      stores: {
        [rows[0].id]: { getSettingsFast: async () => ({ runtimeEnabled: false }) },
        [rows[1].id]: { getSettingsFast: async () => { throw new Error("project store unavailable"); } },
      },
    });
    const response = await getResponse(app, "/api/projects");
    expect(response.bodyBuffer.toString("utf8")).toBe(JSON.stringify([
      { ...rows[0], runtimeEnabled: false, runtimeState: "disabled" },
      { ...rows[1], runtimeEnabled: false, runtimeState: "unknown" },
    ]));
    // The fallback is store reads, not a write sweep, and it does not reconcile either.
    expect(reads.reconcile).not.toHaveBeenCalled();
    expect(reads.getStore).toHaveBeenCalledTimes(2);
  });

  it("reports the premise helper on the exact status the sweep repairs", () => {
    expect(hasInitializingProjectStatus([projectRow("a", "paused"), projectRow("b", "active")])).toBe(false);
    expect(hasInitializingProjectStatus([projectRow("a", "paused"), projectRow("b", "initializing")])).toBe(true);
    expect(hasInitializingProjectStatus([])).toBe(false);
  });
});
