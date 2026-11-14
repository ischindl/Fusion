// @vitest-environment node
/*
FNXC:BoardOrdering 2026-11-13-10:37 (RUFU-526):
The HTTP boundary of the attention order. The route is a pass-through and must stay one: it decides
nothing about ranking, it only refuses to invent a fourth order mode or to launder a client's claim about
a lane into a decision.

Two properties are pinned here precisely because they are the cheap ones to break by accident:
- `columns cannot be combined with q` keeps its exact wording. It is the pre-existing refusal for a
  request that names both a lane scope and a search, and the client branches on that sentence; a fourth
  order mode is no reason to rewrite a message someone else is matching on.
- a lane request with no `reviewScope` sends NO claim at all rather than `reviewScope: false`, so the
  store's default-off rule stays the store's, and the "unknown order" refusal names every mode the
  route actually accepts, because a refusal that lists two of three teaches the next caller to send the
  third one wrong.
*/
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { registerTaskWorkflowRoutes } from "../register-task-workflow-routes.js";
import { request } from "../../test-request.js";
import { ApiError, sendErrorResponse } from "../../api-error.js";

function buildApp(store: TaskStore) {
  const router = express.Router();
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  registerTaskWorkflowRoutes({
    router,
    store,
    options: {},
    runtimeLogger: logger,
    planningLogger: logger,
    chatLogger: logger,
    getProjectIdFromRequest: () => undefined,
    getScopedStore: async () => store,
    getProjectContext: async () => ({ store, engine: undefined, projectId: "project-a" }),
    prioritizeProjectsForCurrentDirectory: (projects: unknown[]) => projects,
    emitRemoteRouteDiagnostic: () => {},
    emitAuthSyncAuditLog: () => {},
    parseScopeParam: () => undefined,
    resolveAutomationStore: () => ({}) as never,
    resolveRoutineStore: () => ({}) as never,
    resolveRoutineRunner: () => ({}) as never,
    registerDispose: () => {},
    dispose: () => {},
    rethrowAsApiError: (error: unknown): never => {
      throw error instanceof ApiError ? error : new ApiError(500, String(error));
    },
  } as never, {
    runtimeLogger: logger,
    upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
    taskDetailActivityLogLimit: 100,
    validateOptionalModelField: (value: unknown) => typeof value === "string" ? value : undefined,
    normalizeModelSelectionPair: (provider?: string, modelId?: string) => ({ provider: provider ?? null, modelId: modelId ?? null }),
    runGitCommand: async () => "",
    trimTaskDetailActivityLog: (item: unknown) => item,
    triggerCommentWakeForAssignedAgent: async () => {},
  } as never);

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const apiError = error instanceof ApiError ? error : new ApiError(500, String(error));
    sendErrorResponse(res, apiError.statusCode, apiError.message, { details: apiError.details });
  });
  return app;
}

const emptyPage = { tasks: [], total: 0, hasMore: false, nextCursor: null };

describe("GET /tasks/page attention order", () => {
  it("forwards the attention order and a claimed review scope to the lane read", async () => {
    const listTaskQueuePage = vi.fn(async () => emptyPage);
    const response = await request(
      buildApp({ listTaskQueuePage } as unknown as TaskStore),
      "GET",
      "/api/tasks/page?columns=in-review&order=attention&reviewScope=1&limit=25",
    );

    expect(response.status).toBe(200);
    expect(listTaskQueuePage).toHaveBeenCalledWith({
      columns: ["in-review"],
      limit: 25,
      order: "attention",
      reviewScope: true,
    });
  });

  it("sends no claim at all when the caller names no review scope", async () => {
    const listTaskQueuePage = vi.fn(async () => emptyPage);
    const response = await request(
      buildApp({ listTaskQueuePage } as unknown as TaskStore),
      "GET",
      "/api/tasks/page?columns=todo&order=attention",
    );

    expect(response.status).toBe(200);
    // Absent, not `false`: the store owns the default-off rule for the gate arm, and an explicit false
    // written here would be the route making that decision instead of reading it.
    expect(listTaskQueuePage.mock.calls[0]?.[0]).not.toHaveProperty("reviewScope");
    expect(listTaskQueuePage.mock.calls[0]?.[0]).toEqual({ columns: ["todo"], limit: 100, order: "attention" });
  });

  it("refuses an unknown order by naming every mode it accepts", async () => {
    const listTaskQueuePage = vi.fn(async () => emptyPage);
    const response = await request(
      buildApp({ listTaskQueuePage } as unknown as TaskStore),
      "GET",
      "/api/tasks/page?columns=todo&order=priority",
    );

    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toContain("attention");
    expect(listTaskQueuePage).not.toHaveBeenCalled();
  });

  it("keeps the pre-existing refusal for combining a lane scope with a search", async () => {
    const listTaskQueuePage = vi.fn(async () => emptyPage);
    const response = await request(
      buildApp({ listTaskQueuePage } as unknown as TaskStore),
      "GET",
      "/api/tasks/page?columns=in-review&order=attention&q=incident",
    );

    // Exact wording: a fourth order mode is no reason to rewrite a sentence a caller branches on.
    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toBe("columns cannot be combined with q");
    expect(listTaskQueuePage).not.toHaveBeenCalled();
  });

  it("turns the store's rejected cursor into a 400 rather than a 500", async () => {
    /*
    The lane cursor is bound to the order AND to the resolved gate, so a replay of a cursor minted under
    the other gate arrives here as a thrown `Invalid task queue cursor`. That is a client that has to
    restart at the head, not a server fault, and the attention mode is the mode most likely to produce
    it - which is why the mapping is asserted on this path and not only on the queue one.
    */
    const listTaskQueuePage = vi.fn(async () => {
      throw new TypeError("Invalid task queue cursor");
    });
    const response = await request(
      buildApp({ listTaskQueuePage } as unknown as TaskStore),
      "GET",
      "/api/tasks/page?columns=in-review&order=attention&reviewScope=1&cursor=opaque",
    );

    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toBe("Invalid task queue cursor");
  });

  it("answers an unscoped request exactly as it did before the fourth mode existed", async () => {
    const listCurrentTasksPage = vi.fn(async () => ({ tasks: [], total: 1_000, hasMore: true, nextCursor: "next" }));
    const listTaskQueuePage = vi.fn(async () => emptyPage);
    const response = await request(
      buildApp({ listCurrentTasksPage, listTaskQueuePage } as unknown as TaskStore),
      "GET",
      "/api/tasks/page?limit=50",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ tasks: [], total: 1_000, hasMore: true, nextCursor: "next" });
    expect(listTaskQueuePage).not.toHaveBeenCalled();
  });
});
