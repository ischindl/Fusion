// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { Task, TaskStore } from "@fusion/core";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";
import { request as performRequest } from "../test-request.js";
import { ApiError, sendErrorResponse } from "../api-error.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function mkTask(overrides: Partial<Task> & { id: string }): Task {
  const now = "2026-07-15T09:00:00.000Z";
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    description: overrides.description ?? overrides.id,
    column: overrides.column ?? "todo",
    dependencies: [],
    createdAt: now,
    updatedAt: now,
    size: "M",
    subtasks: [],
    log: [],
    tags: [],
    blockedBy: [],
    source: { sourceType: "api" },
    ...overrides,
  } as Task;
}

function buildApp(input: {
  store: Partial<TaskStore>;
  engine?: { getAgentStore?: () => unknown };
  runtimeLogger?: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}) {
  const runtimeLogger = input.runtimeLogger ?? { warn: vi.fn(), error: vi.fn() };
  const router = express.Router();
  registerTaskWorkflowRoutes({
    router,
    store: input.store as TaskStore,
    options: {},
    runtimeLogger: runtimeLogger as never,
    planningLogger: runtimeLogger as never,
    chatLogger: runtimeLogger as never,
    getProjectIdFromRequest: () => undefined,
    getScopedStore: async () => input.store as TaskStore,
    getProjectContext: async () => ({ store: input.store as TaskStore, engine: input.engine as never, projectId: "p-1" }),
    prioritizeProjectsForCurrentDirectory: (projects) => projects,
    emitRemoteRouteDiagnostic: () => {},
    emitAuthSyncAuditLog: () => {},
    parseScopeParam: () => undefined,
    resolveAutomationStore: () => ({}) as never,
    resolveRoutineStore: () => ({}) as never,
    resolveRoutineRunner: () => ({}) as never,
    registerDispose: () => {},
    dispose: () => {},
    rethrowAsApiError: (error: unknown): never => {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, error instanceof Error ? error.message : "Internal server error");
    },
  }, {
    runtimeLogger,
    upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
    taskDetailActivityLogLimit: 100,
    validateOptionalModelField: (value) => (typeof value === "string" ? value : undefined),
    normalizeModelSelectionPair: (provider, modelId) => ({ provider: provider ?? null, modelId: modelId ?? null }),
    runGitCommand: async () => "",
    isGitRepo: async () => true,
    resolveIntegrationBranch: async () => "main",
    trimTaskDetailActivityLog: (task) => task,
    triggerCommentWakeForAssignedAgent: async () => {},
    resolveSelfHealingManager: () => undefined,
  });

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) {
      sendErrorResponse(res, error.statusCode, error.message, { details: error.details });
      return;
    }
    sendErrorResponse(res, 500, error instanceof Error ? error.message : "Internal server error");
  });
  return app;
}

describe("DELETE /api/tasks/:id", () => {
  it("responds after soft-delete without waiting for delayed agent-binding release", async () => {
    const deletedTask = mkTask({
      id: "FN-7968",
      column: "archived",
      deletedAt: "2026-07-15T09:02:00.000Z",
    });
    const store: Partial<TaskStore> = {
      deleteTask: vi.fn().mockResolvedValue(deletedTask),
    };
    const listAgents = deferred<Array<{ id: string; name: string; role: string; reportsTo: string; taskId: string }>>();
    const agentStore = {
      listAgents: vi.fn(() => listAgents.promise),
      syncExecutionTaskLink: vi.fn().mockResolvedValue(undefined),
      deleteAgent: vi.fn().mockResolvedValue(undefined),
    };
    const app = buildApp({
      store,
      engine: { getAgentStore: () => agentStore },
    });

    let responseResolved = false;
    const responsePromise = performRequest(app, "DELETE", "/api/tasks/FN-7968").then((response) => {
      responseResolved = true;
      return response;
    });

    await vi.waitFor(() => expect(responseResolved).toBe(true), { timeout: 100 });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: "FN-7968", deletedAt: "2026-07-15T09:02:00.000Z" });
    expect(store.deleteTask).toHaveBeenCalledWith("FN-7968", expect.objectContaining({
      auditContext: expect.objectContaining({ agentId: "system" }),
    }));
    expect(agentStore.listAgents).toHaveBeenCalledWith({ includeEphemeral: true });
    expect(agentStore.syncExecutionTaskLink).not.toHaveBeenCalled();

    listAgents.resolve([{ id: "agent-1", name: "durable", role: "executor", reportsTo: "manager", taskId: "FN-7968" }]);

    await vi.waitFor(() => {
      expect(agentStore.syncExecutionTaskLink).toHaveBeenCalledWith("agent-1", undefined);
    });
    expect(agentStore.deleteAgent).not.toHaveBeenCalled();
  });

  /*
  FNXC:RefusedDeleteEnvelope 2026-11-17-16:16 (RUFU-583):
  These are PINS, not rewrites. The 409 bodies and their codes are pre-existing behavior; they are
  asserted here because the refusal is the ONE delete outcome that leaves the row live, and RUFU-583
  changes what a live row looks like over the wire. Pair them with the pg case in
  `task-list-lifecycle-projection.pg.test.ts`, which proves the row really does survive the refusal with
  no `deletedAt` and keeps its real lane: the envelope proves the operator is TOLD, the pg case proves
  the board is NOT lying. Neither claim belongs to the other file.
  */
  it("reports a lineage refusal as a 409 naming the children, so the row is not silently dropped", async () => {
    const lineageError = Object.assign(new Error("Task FN-583P has live lineage children"), {
      name: "TaskHasLineageChildrenError",
      childIds: ["FN-583C"],
    });
    const store: Partial<TaskStore> = { deleteTask: vi.fn().mockRejectedValue(lineageError) };
    const app = buildApp({ store });

    const response = await performRequest(app, "DELETE", "/api/tasks/FN-583P");

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: "Task FN-583P has live lineage children",
      details: {
        code: "TASK_HAS_LINEAGE_CHILDREN",
        taskId: "FN-583P",
        lineageChildIds: ["FN-583C"],
      },
    });
  });

  it("reports a dependents refusal as a 409 naming the dependents", async () => {
    const dependentsError = Object.assign(new Error("Task FN-583P has dependents"), {
      name: "TaskHasDependentsError",
      dependentIds: ["FN-583D"],
    });
    const store: Partial<TaskStore> = { deleteTask: vi.fn().mockRejectedValue(dependentsError) };
    const app = buildApp({ store });

    const response = await performRequest(app, "DELETE", "/api/tasks/FN-583P");

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      details: {
        code: "TASK_HAS_DEPENDENTS",
        taskId: "FN-583P",
        dependentIds: ["FN-583D"],
      },
    });
  });
});
