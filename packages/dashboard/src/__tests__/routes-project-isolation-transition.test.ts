// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createApiRoutes } from "../routes.js";
import { request } from "../test-request.js";
import type { TaskStore } from "@fusion/core";

const project = {
  id: "proj_1",
  name: "Project",
  path: "/tmp/project",
  status: "active",
  isolationMode: "in-process" as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const central = {
  isInitialized: () => true,
  getProject: vi.fn(),
  updateProject: vi.fn(),
  unassignProjectFromNode: vi.fn(),
  assignProjectToNode: vi.fn(),
};

function createStore(): TaskStore {
  return {
    listTasks: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    getRootDir: vi.fn().mockReturnValue("/tmp/test"),
    getFusionDir: vi.fn().mockReturnValue("/tmp/test/.fusion"),
    getPluginStore: vi.fn().mockReturnValue({ listPlugins: vi.fn().mockResolvedValue([]) }),
    getMissionStore: vi.fn().mockReturnValue({ listMissions: vi.fn().mockResolvedValue([]) }),
    getRoutineStore: vi.fn().mockReturnValue({ listRoutines: vi.fn().mockResolvedValue([]) }),
    getAutomationStore: vi.fn().mockReturnValue({ listScheduledTasks: vi.fn().mockResolvedValue([]) }),
  } as unknown as TaskStore;
}

/**
 * FNXC:HybridExecutorBoot 2026-09-26-03:10:
 * RUFU-322: the isolation route now gates on `HybridExecutor.whenReady()` before touching runtime
 * state, so every fixture that means "the executor is up and running" must state it. A fixture without
 * `whenReady` is a fixture for a broken executor — the route answers 500, which is the honest outcome
 * of calling a method the real class guarantees.
 */
function readyExecutor(
  transitionProjectIsolation = vi.fn().mockResolvedValue({ ok: true }),
): { transitionProjectIsolation: ReturnType<typeof vi.fn>; whenReady: ReturnType<typeof vi.fn> } {
  return { transitionProjectIsolation, whenReady: vi.fn().mockResolvedValue(undefined) };
}

function createApp(options?: Parameters<typeof createApiRoutes>[1]) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(createStore(), { ...options, centralCore: central as any }));
  return app;
}

describe("project isolation transition route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    central.getProject.mockResolvedValue(project);
    central.updateProject.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({ ...project, ...updates }));
  });

  it("uses hybrid executor transition path when available", async () => {
    const hybridExecutor = readyExecutor();
    const res = await request(
      createApp({ hybridExecutor: hybridExecutor as any }),
      "PATCH",
      "/api/projects/proj_1",
      JSON.stringify({ isolationMode: "child-process" }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(hybridExecutor.transitionProjectIsolation).toHaveBeenCalledWith("proj_1", "child-process", { force: false });
    expect((res.body as any).transitionDeferred).toBeUndefined();
  });

  it("returns 503 with clear remediation when no hybrid executor is configured (local-only)", async () => {
    // Previously this route silently set transitionDeferred=true and persisted
    // the new isolationMode without performing the live runtime transition —
    // confusing UX and active-task safety check was bypassed. The new
    // behavior throws 503 immediately so the user gets actionable guidance
    // (restart the dashboard or force-enable HybridExecutor) and the stored
    // isolationMode stays consistent with the live runtime.
    const res = await request(
      createApp(),
      "PATCH",
      "/api/projects/proj_1",
      JSON.stringify({ isolationMode: "child-process" }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(503);
    expect((res.body as { error?: string }).error).toBe("isolation_transition_unavailable");
  });

  it("returns 409 on active_tasks without force and succeeds with force", async () => {
    const hybridExecutor = readyExecutor(
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, reason: "active_tasks", activeTaskCount: 2 })
        .mockResolvedValueOnce({ ok: true }),
    );

    const blocked = await request(
      createApp({ hybridExecutor: hybridExecutor as any }),
      "PATCH",
      "/api/projects/proj_1",
      JSON.stringify({ isolationMode: "child-process" }),
      { "content-type": "application/json" },
    );
    expect(blocked.status).toBe(409);

    const forced = await request(
      createApp({ hybridExecutor: hybridExecutor as any }),
      "PATCH",
      "/api/projects/proj_1",
      JSON.stringify({ isolationMode: "child-process", force: true }),
      { "content-type": "application/json" },
    );
    expect(forced.status).toBe(200);
    expect(hybridExecutor.transitionProjectIsolation).toHaveBeenLastCalledWith("proj_1", "child-process", { force: true });
  });

  /*
  FNXC:IsolationTransitionBlockers 2026-10-15-06:45 (RUFU-328):
  The two shapes of the 409 body, pinned as a pair. A refusal the durable guard could name must hand the
  operator the card ids — the reported incident was a refusal that sat for hours naming nothing, because
  a count alone cannot be looked up. A refusal where the read could not answer must NOT grow an empty
  list: `blockingTaskIds: []` would tell the operator the board proved nothing blocks while the request
  was still refused, which is the false-release claim in payload form.
  */
  it("names the blocking cards in the 409 body when the guard named them", async () => {
    const hybridExecutor = readyExecutor(
      vi.fn().mockResolvedValue({
        ok: false,
        reason: "active_tasks",
        activeTaskCount: 2,
        blockingTaskIds: ["SANE-435", "SANE-453"],
      }),
    );

    const res = await request(
      createApp({ hybridExecutor: hybridExecutor as any }),
      "PATCH",
      "/api/projects/proj_1",
      JSON.stringify({ isolationMode: "child-process" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(409);
    // `ApiError` serialises as { error: <message>, details: <payload> } (see `sendErrorResponse`), so the
    // diagnostic payload the guard produced lands under `details`.
    expect(res.body).toMatchObject({
      error: "active_tasks",
      details: {
        activeTaskCount: 2,
        blockingTaskIds: ["SANE-435", "SANE-453"],
      },
    });
    // A refused transition persists nothing.
    expect(central.updateProject).not.toHaveBeenCalled();
  });

  it("omits blockingTaskIds from the 409 body when the durable read could not answer", async () => {
    const hybridExecutor = readyExecutor(
      vi.fn().mockResolvedValue({ ok: false, reason: "active_tasks", activeTaskCount: 3 }),
    );

    const res = await request(
      createApp({ hybridExecutor: hybridExecutor as any }),
      "PATCH",
      "/api/projects/proj_1",
      JSON.stringify({ isolationMode: "child-process" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(409);
    const details = (res.body as { details?: Record<string, unknown> }).details ?? {};
    expect(details.activeTaskCount).toBe(3);
    expect("blockingTaskIds" in details).toBe(false);
    /*
    FNXC:RuntimeInFlightProvenance 2026-10-18-11:21 (RUFU-332):
    A refusal with no ids is NOT automatically an unproven one — this shape is a guard that observed live
    work through a transport it trusts but could not cross-check against durable state. Pinning the ABSENCE
    here is what keeps the two flags from collapsing into one "we don't know" badge, which would make the
    provenance signal useless exactly when an operator most needs to trust the count.
    */
    expect("inFlightUnproven" in details).toBe(false);
  });

  /*
  FNXC:RuntimeInFlightProvenance 2026-10-18-11:21 (RUFU-332):
  The third shape of the 409 body: a refusal whose count came from a transport that could not prove the
  project idle. `activeTaskCount: 0` alone is the payload that sent an operator chasing cards that were
  already terminal; with the flag it reads truthfully as "we could not ask", and the remedy is to make the
  transport reachable rather than to move cards around.
  */
  it("flags inFlightUnproven in the 409 body when the transport could not prove idleness", async () => {
    const hybridExecutor = readyExecutor(
      vi.fn().mockResolvedValue({
        ok: false,
        reason: "active_tasks",
        activeTaskCount: 0,
        inFlightUnproven: true,
      }),
    );

    const res = await request(
      createApp({ hybridExecutor: hybridExecutor as any }),
      "PATCH",
      "/api/projects/proj_1",
      JSON.stringify({ isolationMode: "child-process" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "active_tasks",
      details: {
        activeTaskCount: 0,
        inFlightUnproven: true,
      },
    });
    expect(central.updateProject).not.toHaveBeenCalled();
  });

  /*
  FNXC:HybridExecutorBoot 2026-09-26-03:10:
  RUFU-322: because HTTP listen no longer waits for `HybridExecutor.initialize()`, a transition request
  can reach the route while project runtimes are still loading. The route must then answer with a
  bounded, retryable 503 naming the state truthfully, and must not persist the new isolationMode —
  otherwise the stored mode would disagree with the live runtime, which is the exact confusion the
  pre-existing `isolation_transition_unavailable` branch was added to remove.
  */
  it("answers 503 hybrid_executor_starting while project runtimes are still loading", async () => {
    const hybridExecutor = readyExecutor();
    hybridExecutor.whenReady.mockImplementation(() => new Promise(() => {}));

    const res = await request(
      createApp({ hybridExecutor: hybridExecutor as any, hybridExecutorReadyWaitMs: 20 }),
      "PATCH",
      "/api/projects/proj_1",
      JSON.stringify({ isolationMode: "child-process" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(503);
    expect((res.body as { error?: string }).error).toBe("hybrid_executor_starting");
    expect(hybridExecutor.transitionProjectIsolation).not.toHaveBeenCalled();
    // The transition was refused, so nothing may have been persisted about it.
    expect(central.updateProject).not.toHaveBeenCalled();
  });

  it("answers 503 hybrid_executor_failed when the executor boot never succeeded", async () => {
    const hybridExecutor = readyExecutor();
    hybridExecutor.whenReady.mockRejectedValue(new Error("project runtime loading has not completed"));

    const res = await request(
      createApp({ hybridExecutor: hybridExecutor as any, hybridExecutorReadyWaitMs: 20 }),
      "PATCH",
      "/api/projects/proj_1",
      JSON.stringify({ isolationMode: "child-process" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(503);
    expect((res.body as { error?: string }).error).toBe("hybrid_executor_failed");
    expect(hybridExecutor.transitionProjectIsolation).not.toHaveBeenCalled();
    expect(central.updateProject).not.toHaveBeenCalled();
  });

  it("transitions without a readiness delay when the executor is already initialized", async () => {
    const hybridExecutor = readyExecutor();

    // A generous bound proves the fast path returns from `whenReady()` itself rather than from the
    // deadline: a route that always waited the bound would take >= the bound here.
    const startedAt = Date.now();
    const res = await request(
      createApp({ hybridExecutor: hybridExecutor as any, hybridExecutorReadyWaitMs: 5_000 }),
      "PATCH",
      "/api/projects/proj_1",
      JSON.stringify({ isolationMode: "child-process" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(hybridExecutor.whenReady).toHaveBeenCalledTimes(1);
    expect(hybridExecutor.transitionProjectIsolation).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  /*
  FNXC:IsolationTransitionOutcomes 2026-11-18-05:42 (RUFU-729):
  The route reacted to exactly ONE refusal reason (`active_tasks`) and treated every other non-success
  outcome as success: the `if (transition.reason === "active_tasks")` arm fell through to
  `delete updates.isolationMode;` and then to `central.updateProject(...)`, so the request answered `200`
  with the OLD isolation mode in the body and no error anywhere. An operator who changed the mode kept
  believing the project ran under the mode they had just asked for. Reported while reviewing RUFU-332, and
  explicitly held out of RUFU-332's scope.

  The invariant these tests pin is total handling, not one more reason: EVERY non-success outcome must say
  (a) that the mode did not take effect, (b) why, and (c) what to do next. `noop` is the one non-success
  that is not a failure — the project already runs the requested mode — so it must stay a plain `200`,
  which is what guards this change against over-correcting into refusing a no-op.
  */
  describe("refuses every non-success transition reason instead of answering success", () => {
    /** The `error` code and the operator sentence of the standard dashboard error envelope. */
    const envelope = (body: unknown) => body as { error?: string; details?: { message?: unknown } };

    it("answers 503 isolation_transition_failed when the restart fails for a non-active_tasks reason", async () => {
      /*
      Defect observed on `main`: `200` whose body still said `isolationMode: "in-process"`, with
      `central.updateProject` still called. A refused transition may not reach the client as a success.
      */
      const hybridExecutor = readyExecutor(
        vi.fn().mockResolvedValue({
          ok: false,
          reason: "restart_failed",
          storedIsolationMode: "child-process",
          detail: "Runtime not found for project proj_1",
        }),
      );

      const res = await request(
        createApp({ hybridExecutor: hybridExecutor as any }),
        "PATCH",
        "/api/projects/proj_1",
        JSON.stringify({ isolationMode: "child-process" }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(503);
      expect(envelope(res.body).error).toBe("isolation_transition_failed");
      expect(typeof envelope(res.body).details?.message).toBe("string");
      // The requested mode must not be written by the route as if the transition had completed.
      expect(central.updateProject).not.toHaveBeenCalledWith(
        "proj_1",
        expect.objectContaining({ isolationMode: "child-process" }),
      );
    });

    it("keeps reason noop a non-error 200 — the project already runs the requested mode", async () => {
      // Guard against over-correction: `noop` is "no change needed", not a failure to report.
      const hybridExecutor = readyExecutor(vi.fn().mockResolvedValue({ ok: false, reason: "noop" }));

      const res = await request(
        createApp({ hybridExecutor: hybridExecutor as any }),
        "PATCH",
        "/api/projects/proj_1",
        JSON.stringify({ isolationMode: "child-process" }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect((res.body as { error?: string }).error).toBeUndefined();
    });

    it("answers a status error naming an unrecognised reason instead of answering success", async () => {
      /*
      The defensive arm: the executor's failure vocabulary is a closed union, but the route must not turn
      an unforeseen reason back into a silent success — that is the defect being removed. The sentence may
      not claim which mode is live, because for an unknown reason the route genuinely does not know.
      */
      const hybridExecutor = readyExecutor(
        vi.fn().mockResolvedValue({ ok: false, reason: "some_future_reason" }),
      );

      const res = await request(
        createApp({ hybridExecutor: hybridExecutor as any }),
        "PATCH",
        "/api/projects/proj_1",
        JSON.stringify({ isolationMode: "child-process" }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(503);
      const body = res.body as { error?: string; details?: { reason?: string; message?: unknown } };
      expect(body.error).toBe("isolation_transition_failed");
      expect(body.details?.reason).toBe("some_future_reason");
      expect(typeof body.details?.message).toBe("string");
      expect(central.updateProject).not.toHaveBeenCalledWith(
        "proj_1",
        expect.objectContaining({ isolationMode: "child-process" }),
      );
    });

    it("answers isolation_transition_failed when the transition call throws inside the runtime restart", async () => {
      /*
      `ProjectManager.restartProjectRuntime()` throws for reasons that are not busy-project refusals
      (`Runtime not found for project …`, a failed `stop()`, a failed re-add). On `main` that throw escaped
      to the route's outer catch, whose string match on `not found` turned a runtime lookup failure into a
      `404` claiming the PROJECT was missing — when the project was found and its row had already been
      updated. The body must not read as "project not found".
      */
      const hybridExecutor = readyExecutor(
        vi.fn().mockRejectedValue(new Error("Runtime not found for project proj_1")),
      );

      const res = await request(
        createApp({ hybridExecutor: hybridExecutor as any }),
        "PATCH",
        "/api/projects/proj_1",
        JSON.stringify({ isolationMode: "child-process" }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(503);
      const body = res.body as { error?: string; details?: { reason?: string; detail?: string; message?: unknown } };
      expect(body.error).toBe("isolation_transition_failed");
      expect(body.details?.reason).toBe("restart_failed");
      expect(body.details?.detail).toBe("Runtime not found for project proj_1");
      expect(typeof body.details?.message).toBe("string");
      expect(JSON.stringify(res.body)).not.toMatch(/project not found/i);
      expect(central.updateProject).not.toHaveBeenCalledWith(
        "proj_1",
        expect.objectContaining({ isolationMode: "child-process" }),
      );
    });

    it("still answers 404 when the project itself vanished mid-request", async () => {
      // `CentralCore.transitionProjectIsolation` throws `Project not found: <id>`; that race stays a 404.
      const hybridExecutor = readyExecutor(
        vi.fn().mockRejectedValue(new Error("Project not found: proj_1")),
      );

      const res = await request(
        createApp({ hybridExecutor: hybridExecutor as any }),
        "PATCH",
        "/api/projects/proj_1",
        JSON.stringify({ isolationMode: "child-process" }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(404);
      expect(central.updateProject).not.toHaveBeenCalled();
    });
  });
});
