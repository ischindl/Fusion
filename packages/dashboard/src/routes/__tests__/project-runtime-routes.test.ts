// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { registerProjectRoutes } from "../register-project-routes.js";

/*
FNXC:ProjectRuntimeOff 2026-11-07-15:56:
The operator's runtime unload switch, pinned at the route that owns it.

Three things are asserted here because each is a separate promise the feature makes:
1. The persisted setting is the durable act — the route writes `runtimeEnabled` and nothing else
   (no pause flag, no engine stop), so a restart reads the same decision.
2. A live engine is told, so the switch takes effect from the NEXT pass without a restart, and
   telling it is idempotent.
3. One `project:runtime-toggled` run-audit row carries the closed metadata set — ids, two booleans
   and one fixed `source` enum — because a project that silently does nothing is indistinguishable
   from a dead engine, and a row holding the operator's reason text would put prose in the audit
   store. `rethrowAsApiError` and `badRequest` keep a non-boolean body a 400 rather than a silent
   no-op that the badge would cheerfully disagree with.
*/

const JSON_HEADERS = { "content-type": "application/json" };

function buildApp(input: {
  engine?: { applyRuntimeGate: ReturnType<typeof vi.fn> };
  store: { getSettings: ReturnType<typeof vi.fn>; updateSettings: ReturnType<typeof vi.fn>; recordRunAuditEvent: ReturnType<typeof vi.fn> };
}) {
  const router = express.Router();
  registerProjectRoutes({
    router,
    options: {
      centralCore: { isInitialized: () => true },
      engineManager: {
        getEngine: vi.fn(() => input.engine),
        getStore: vi.fn(() => input.store),
      },
    },
    runtimeLogger: { child: () => ({ warn: vi.fn() }) },
    prioritizeProjectsForCurrentDirectory: vi.fn((projects) => projects),
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never);
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode ?? 500).json({ error: error.message }));
  return app;
}

function storeFor(runtimeEnabled: boolean) {
  return {
    getSettings: vi.fn(async () => ({ runtimeEnabled })),
    updateSettings: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
  };
}

/** The audit emit is best-effort and lands on a later microtask; drain it before reading the row. */
async function drainAudit() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
}

describe("POST /api/projects/:id/runtime", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("persists the switch, tells the live engine, and answers with prior and new state", async () => {
    const store = storeFor(true);
    const engine = { applyRuntimeGate: vi.fn(async () => undefined) };
    const app = buildApp({ store, engine });

    const response = await request(app, "POST", "/api/projects/p-runtime/runtime", JSON.stringify({ enabled: false }), JSON_HEADERS);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ projectId: "p-runtime", runtimeEnabled: false, priorRuntimeEnabled: true });
    expect(store.updateSettings).toHaveBeenCalledWith({ runtimeEnabled: false });
    expect(engine.applyRuntimeGate).toHaveBeenCalledWith(false);
    // Not a pause: the two existing pause flags keep their own meaning.
    const written = store.updateSettings.mock.calls[0][0];
    expect(Object.keys(written)).toEqual(["runtimeEnabled"]);
  });

  it("records one project:runtime-toggled row with the closed metadata set", async () => {
    const store = storeFor(true);
    const app = buildApp({ store, engine: { applyRuntimeGate: vi.fn(async () => undefined) } });

    await request(app, "POST", "/api/projects/p-runtime/runtime", JSON.stringify({ enabled: false }), { ...JSON_HEADERS, "x-fusion-surface": "engine-control-menu" });
    await drainAudit();

    const rows = store.recordRunAuditEvent.mock.calls.map((call: unknown[]) => call[0] as Record<string, unknown>);
    const toggles = rows.filter((row) => row.mutationType === "project:runtime-toggled");
    expect(toggles).toHaveLength(1);
    const row = toggles[0];
    expect(row.target).toBe("p-runtime");
    expect(Object.keys(row.metadata as object).sort()).toEqual(
      ["priorRuntimeEnabled", "projectId", "runtimeEnabled", "source"],
    );
    expect(row.metadata).toMatchObject({
      projectId: "p-runtime",
      priorRuntimeEnabled: true,
      runtimeEnabled: false,
      source: "operator-ui",
    });
  });

  it("names the surface `operator-api` when no surface header declared itself", async () => {
    const store = storeFor(false);
    const app = buildApp({ store, engine: { applyRuntimeGate: vi.fn(async () => undefined) } });

    await request(app, "POST", "/api/projects/p-runtime/runtime", JSON.stringify({ enabled: true }), JSON_HEADERS);
    await drainAudit();

    const row = store.recordRunAuditEvent.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, unknown>)
      .find((r) => r.mutationType === "project:runtime-toggled");
    expect(row?.metadata).toMatchObject({ source: "operator-api", runtimeEnabled: true, priorRuntimeEnabled: false });
  });

  it("refuses a non-boolean body instead of quietly doing nothing", async () => {
    const store = storeFor(true);
    const app = buildApp({ store, engine: { applyRuntimeGate: vi.fn(async () => undefined) } });

    const response = await request(app, "POST", "/api/projects/p-runtime/runtime", JSON.stringify({ enabled: "off" }), JSON_HEADERS);

    expect(response.status).toBe(400);
    expect(store.updateSettings).not.toHaveBeenCalled();
  });

  it("still persists the switch when no engine is loaded, so the next start reads it", async () => {
    const store = storeFor(true);
    const app = buildApp({ store });

    const response = await request(app, "POST", "/api/projects/p-runtime/runtime", JSON.stringify({ enabled: false }), JSON_HEADERS);

    expect(response.status).toBe(200);
    expect(store.updateSettings).toHaveBeenCalledWith({ runtimeEnabled: false });
  });
});
