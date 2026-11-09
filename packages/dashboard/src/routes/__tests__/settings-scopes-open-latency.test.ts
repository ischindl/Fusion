// @vitest-environment node

/**
 * FNXC:SettingsOpenLatency 2026-11-09-14:30 (RUFU-908):
 * `GET /api/settings/scopes` is the render gate for the Settings modal — `refreshSettingsForm` awaits
 * `Promise.all([fetchSettings, fetchSettingsByScope])` and the whole form stays a spinner until both
 * answer. Measured on the operator's live daemon (20 interleaved GETs, loadavg 16-22) it was the slowest
 * read on that gate at median 1.78 s, +0.43 s over `GET /api/settings` in a paired per-round comparison.
 * The excess was one extra `workflow_settings` DB read issued strictly AFTER the scoped-settings read had
 * settled, on a pool capped at `DEFAULT_POOL_MAX = 3`.
 *
 * The fix starts the two independent reads together. These cases pin both halves of that contract:
 * the overlap is now real (the ratchet below goes RED on the old sequential spelling), and the response
 * body — including JSON key order — plus the error precedence are unchanged.
 *
 * The overlap assertion is a call-interleave trace, never a wall-clock comparison: this repo forbids
 * real time waits in tests, and a timing assertion would prove only that the machine was busy.
 */

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSettingsMemoryRoutes } from "../register-settings-memory-routes.js";
import { request as performRequest } from "../../test-request.js";

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    readMemory: vi.fn(async () => ""),
    readInsightsMemory: vi.fn(async () => ""),
    buildInsightExtractionPrompt: vi.fn(() => ""),
    processAndAuditInsightExtraction: vi.fn(async () => {}),
    processMemoryDreams: vi.fn(async () => {}),
    processAgentMemoryDreams: vi.fn(async () => {}),
    resolvePlanningSettingsModel: vi.fn(() => undefined),
    AgentStore: class {
      async init() {}
      async listAgents() {
        return [];
      }
    },
  };
});

/**
 * Store whose two scoped-read methods each log `name:start` / `name:end` around a real microtask hop, so
 * "did the route await the second read after the first one finished?" is readable straight off the trace.
 */
function createApp(opts?: {
  scopes?: { global: Record<string, unknown>; project: Record<string, unknown> };
  workflowSettings?: Record<string, Record<string, unknown>>;
  scopesError?: Error;
  workflowSettingsError?: Error;
  /** Set when the reads must never run at all (an unauthenticated/refused project context). */
  contextError?: Error;
}) {
  const callTrace: string[] = [];
  const scopedStore = {
    getSettingsByScopeFast: vi.fn(async () => {
      callTrace.push("scopes:start");
      await Promise.resolve();
      if (opts?.scopesError) throw opts.scopesError;
      callTrace.push("scopes:end");
      return opts?.scopes ?? { global: { theme: "dark" }, project: { maxConcurrent: 3 } };
    }),
    listWorkflowSettingValuesForProject: vi.fn(async () => {
      callTrace.push("workflow:start");
      await Promise.resolve();
      if (opts?.workflowSettingsError) throw opts.workflowSettingsError;
      callTrace.push("workflow:end");
      return opts?.workflowSettings ?? { "builtin:coding": { maxConcurrent: 5 } };
    }),
    getRootDir: vi.fn(() => "/tmp/project"),
  };

  const router = express.Router();
  registerSettingsMemoryRoutes(
    {
      router,
      options: { pluginRunner: undefined },
      store: {} as never,
      runtimeLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
      getProjectContext: vi.fn(async () => {
        if (opts?.contextError) throw opts.contextError;
        return { store: scopedStore, engine: undefined, projectId: "p1" };
      }),
      rethrowAsApiError: (err: unknown) => {
        throw err;
      },
    },
    {
      githubToken: undefined,
      validateModelPresets: vi.fn(() => undefined),
      sanitizeBooleanSetting: vi.fn((_name: string, value: unknown) => value),
      sanitizeOverlapIgnorePaths: vi.fn(() => undefined),
      discoverDashboardPiExtensions: vi.fn(async () => ({ manifestPaths: [], disabledIds: [] })),
    },
  );

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((err as { statusCode?: number })?.statusCode ?? 500).json({
      error: (err as Error)?.message ?? String(err),
    });
  });

  return { app, scopedStore, callTrace };
}

async function getScopes(app: express.Express) {
  const res = await performRequest(app, "GET", "/api/settings/scopes");
  return { status: res.status, body: res.body, raw: res.bodyBuffer.toString("utf8") };
}

describe("GET /api/settings/scopes — independent reads overlap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts the workflow-settings read before the scoped-settings read finishes", async () => {
    const { app, callTrace, scopedStore } = createApp();

    const res = await getScopes(app);

    expect(res.status).toBe(200);
    expect(scopedStore.getSettingsByScopeFast).toHaveBeenCalledTimes(1);
    expect(scopedStore.listWorkflowSettingValuesForProject).toHaveBeenCalledTimes(1);
    // RUFU-908 ratchet: the second read must be *issued* while the first is still in flight. The old
    // sequential spelling produced scopes:start, scopes:end, workflow:start, workflow:end.
    expect(callTrace).toEqual([
      "scopes:start",
      "workflow:start",
      "scopes:end",
      "workflow:end",
    ]);
    expect(callTrace.indexOf("workflow:start")).toBeLessThan(callTrace.indexOf("scopes:end"));
  });

  it("returns the same body, with the same JSON key order, for a populated project", async () => {
    const res = await getScopes(
      createApp({
        scopes: { global: { theme: "dark", maxWorktrees: 4 }, project: { maxConcurrent: 2 } },
        workflowSettings: { "builtin:coding": { maxConcurrent: 7 }, "wf-x": { taskPrefix: "X" } },
      }).app,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      global: { theme: "dark", maxWorktrees: 4 },
      project: { maxConcurrent: 2 },
      workflowSettings: { "builtin:coding": { maxConcurrent: 7 }, "wf-x": { taskPrefix: "X" } },
    });
    // Key order is part of the shape contract: the body is `{ ...scopes, workflowSettings }` today and a
    // re-ordered rebuild would be a response-shape change even with identical members.
    expect(res.raw).toMatch(/^\{"global":/);
    expect(res.raw).toContain(',"workflowSettings":');
    expect(Object.keys(res.body as Record<string, unknown>)).toEqual([
      "global",
      "project",
      "workflowSettings",
    ]);
  });

  it("keeps the empty-workflow-settings shape rather than omitting or null-filling the key", async () => {
    const { app, callTrace } = createApp({ workflowSettings: {} });

    const res = await getScopes(app);

    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).workflowSettings).toEqual({});
    expect(Object.keys(res.body as Record<string, unknown>)).toContain("workflowSettings");
    // An empty answer still came from a real read issued in parallel, not from a stand-in.
    expect(callTrace.indexOf("workflow:start")).toBeLessThan(callTrace.indexOf("scopes:end"));
  });

  it("reports the project-context refusal before either read runs", async () => {
    const contextError = Object.assign(new Error("project not visible to this principal"), { statusCode: 403 });
    const { app, scopedStore } = createApp({ contextError });

    const res = await getScopes(app);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "project not visible to this principal" });
    expect(scopedStore.getSettingsByScopeFast).not.toHaveBeenCalled();
    expect(scopedStore.listWorkflowSettingValuesForProject).not.toHaveBeenCalled();
  });

  it("surfaces the scoped-settings failure even when the workflow-settings read fails first", async () => {
    // `Promise.all` would reject with whichever failure settled first. The ordered rethrow must keep the
    // pre-RUFU-908 precedence: the settings read's error is the request's error.
    const scopesError = new Error("settings read failed");
    const { app } = createApp({
      scopesError,
      workflowSettingsError: new Error("workflow settings read failed"),
    });

    const res = await getScopes(app);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "settings read failed" });
  });

  it("surfaces the workflow-settings failure when the scoped-settings read succeeds", async () => {
    const { app } = createApp({ workflowSettingsError: new Error("workflow settings read failed") });

    const res = await getScopes(app);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "workflow settings read failed" });
  });
});
