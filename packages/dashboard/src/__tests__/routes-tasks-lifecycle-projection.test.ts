// @vitest-environment node
/*
FNXC:TaskLifecycleProjection 2026-11-17-16:16 (RUFU-583):
HTTP-boundary half of the lifecycle-projection contract.

WHAT THIS FILE PROVES AND WHAT IT DELIBERATELY CANNOT. The operator's symptom was a consumer reading a
tombstone as alive: five soft-deleted cards came back from `GET /api/tasks` with live-looking columns,
no key whose name contains 'deleted' or 'archived' existed anywhere on the row, and the reflex filter
`deletedAt is falsy` therefore reported "0 of the deleted cards still present" while one of those five
had never been deleted at all. The fix is that every projected row STATES its lifecycle, so the
question is answerable from the list itself and no consumer has to keep an id set of tombstones.

This suite asserts the projection over a fake store: every row `GET /api/tasks`, `GET /api/tasks/page`
and `GET /api/tasks/:id` serializes carries `lifecycle`, in every arm (default, column-scoped,
`excludeDone`, `q`-searched, forensic). A fake cannot prove the SQL reaches a tombstone — that proof is
`packages/core/src/__tests__/postgres/task-list-lifecycle-projection.pg.test.ts`, which is load-bearing
and must not be replaced by this file. The fake's own lane/deletion filters mirror what the real read
does today so an accidental route-level widening (e.g. someone passing `includeArchived: true` to dodge
the bug) still shows up here as a changed row set rather than silently staying green.
*/
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { Task, TaskStore } from "@fusion/core";
import { TaskNotFoundError } from "@fusion/core";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";
import { request as performRequest } from "../test-request.js";
import { ApiError, sendErrorResponse } from "../api-error.js";

const NOW = "2026-10-06T09:00:00.000Z";

function mkTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    description: overrides.description ?? overrides.id,
    column: overrides.column ?? "todo",
    dependencies: [],
    createdAt: NOW,
    updatedAt: NOW,
    size: "M",
    subtasks: [],
    log: [],
    tags: [],
    blockedBy: [],
    source: { sourceType: "api" },
    ...overrides,
  } as Task;
}

/** Seeded board: one live card, one completed card, one tombstone resting in the sentinel lane. */
function seedBoard(): Task[] {
  return [
    mkTask({ id: "FN-583A", column: "todo" }),
    mkTask({ id: "FN-583B", column: "done" }),
    mkTask({
      id: "FN-583DEL",
      // A soft delete stamps the sentinel lane alongside deletedAt; it is not a workflow move.
      column: "archived",
      deletedAt: "2026-10-06T09:02:00.000Z",
    }),
  ];
}

/**
 * Mirrors the store's documented list filters: `includeArchived: false` hides the sentinel lane, and
 * (after RUFU-583) `includeDeleted: true` reaches the tombstone that lane would otherwise hide.
 */
function filterBoard(rows: Task[], options: { includeDeleted?: boolean; includeArchived?: boolean; excludeColumns?: string[]; column?: string } = {}): Task[] {
  let out = rows;
  if (options.column) out = out.filter((row) => row.column === options.column);
  if (options.excludeColumns?.length) out = out.filter((row) => !options.excludeColumns!.includes(row.column));
  if (!options.includeArchived && !options.includeDeleted) out = out.filter((row) => row.column !== "archived");
  if (!options.includeDeleted) out = out.filter((row) => !row.deletedAt);
  return out.map((row) => ({ ...row }));
}

function buildApp(input: { store: Partial<TaskStore>; engine?: Record<string, unknown> }) {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const router = express.Router();
  registerTaskWorkflowRoutes({
    router,
    store: input.store as TaskStore,
    options: {},
    runtimeLogger: logger as never,
    planningLogger: logger as never,
    chatLogger: logger as never,
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
    runtimeLogger: logger,
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

function listStore(rows: Task[]): Partial<TaskStore> {
  type LaneFilter = Parameters<typeof filterBoard>[1];
  return {
    listTasks: vi.fn(async (options?: unknown) => filterBoard(rows, options as LaneFilter)),
    searchTasks: vi.fn(async (_query: string, options?: unknown) => filterBoard(rows, options as LaneFilter).map((row) => ({ ...row }))),
    getBranchProgressByTask: vi.fn(async () => new Map()),
  } as Partial<TaskStore>;
}

type Row = Record<string, unknown> & { id: string };
function rowsOf(body: unknown): Row[] {
  return body as Row[];
}

describe("GET /api/tasks lifecycle projection (RUFU-583)", () => {
  it("states lifecycle on every row of a default board read and carries no non-live row", async () => {
    const app = buildApp({ store: listStore(seedBoard()) });
    const response = await performRequest(app, "GET", "/api/tasks");

    expect(response.status).toBe(200);
    const rows = rowsOf(response.body);
    expect(rows.map((row) => row.id).sort()).toEqual(["FN-583A", "FN-583B"]);
    // The contract is per-row and universal, not "the tombstone is absent so nothing else matters".
    for (const row of rows) {
      expect(row.lifecycle).toBe("live");
    }
    expect(rows.some((row) => row.id === "FN-583DEL")).toBe(false);
  });

  it("returns the tombstone on a forensic read and marks it deleted with its timestamp in the JSON", async () => {
    const store = listStore(seedBoard());
    const app = buildApp({ store });
    const response = await performRequest(app, "GET", "/api/tasks?includeDeleted=1");

    expect(response.status).toBe(200);
    const rows = rowsOf(response.body);
    const tombstone = rows.find((row) => row.id === "FN-583DEL");
    expect(tombstone).toBeDefined();
    expect(tombstone!.lifecycle).toBe("deleted");
    expect(tombstone!.deletedAt).toBe("2026-10-06T09:02:00.000Z");
    // A forensic read is not a wall of tombstones: the live rows stay and stay labelled.
    expect(rows.find((row) => row.id === "FN-583A")!.lifecycle).toBe("live");
    expect(store.listTasks).toHaveBeenCalledWith(expect.objectContaining({ includeDeleted: true }));
  });

  it("self-marks every row an excludeDone-scoped forensic read returns, with no membership surprise", async () => {
    const app = buildApp({ store: listStore(seedBoard()) });
    const response = await performRequest(app, "GET", "/api/tasks?excludeDone=1&includeDeleted=1");

    expect(response.status).toBe(200);
    const rows = rowsOf(response.body);
    expect(rows.length).toBeGreaterThan(0);
    // `excludeDone` drops the complete lanes, never a tombstone; the tombstone's own lane is the
    // sentinel `archived`, which is not a member of the complete-lane set.
    expect(rows.map((row) => row.id)).toContain("FN-583DEL");
    for (const row of rows) {
      expect(["live", "deleted", "archived"]).toContain(row.lifecycle as string);
    }
    expect(rows.find((row) => row.id === "FN-583DEL")!.lifecycle).toBe("deleted");
    expect(rows.find((row) => row.id === "FN-583B")).toBeUndefined();
  });

  it("stamps the searched branch too, so the q path cannot answer without the field", async () => {
    const store = listStore(seedBoard());
    const app = buildApp({ store });
    const response = await performRequest(app, "GET", "/api/tasks?q=FN-583");

    expect(response.status).toBe(200);
    const rows = rowsOf(response.body);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.lifecycle).toBeDefined();
    }
    expect(store.searchTasks).toHaveBeenCalled();
  });

  it("stamps both page arms while leaving the store's total untouched", async () => {
    const rows = seedBoard();
    const store = {
      listCurrentTasksPage: vi.fn(async () => ({ tasks: filterBoard(rows).map((row) => ({ ...row })), total: rows.length, hasMore: false, nextCursor: null })),
      listTaskQueuePage: vi.fn(async () => ({ tasks: filterBoard(rows, { column: "todo" }).map((row) => ({ ...row })), total: 1, hasMore: false, nextCursor: null })),
    } as unknown as Partial<TaskStore>;
    const app = buildApp({ store });

    const board = await performRequest(app, "GET", "/api/tasks/page");
    expect(board.status).toBe(200);
    const boardBody = board.body as { tasks: Row[]; total: number };
    expect(boardBody.total).toBe(rows.length);
    expect(boardBody.tasks.length).toBeGreaterThan(0);
    for (const row of boardBody.tasks) {
      expect(row.lifecycle).toBe("live");
    }

    const queue = await performRequest(app, "GET", "/api/tasks/page?columns=todo");
    expect(queue.status).toBe(200);
    const queueBody = queue.body as { tasks: Row[]; total: number };
    expect(queueBody.total).toBe(1);
    expect(queueBody.tasks[0].lifecycle).toBe("live");
  });
});

/*
FNXC:SoftDeleteDisclosure 2026-11-17-16:16 (RUFU-583):
The single-task route is where the operator's "did my delete take?" question has to be answered, so
these cases are the four states that must not be conflated: tombstone, never-existed, forensic hit, and
a probe that itself faulted. The pre-fix pair (tombstone vs never-existed) was byte-identical, which is
exactly the defect; the assertion that keeps it fixed is that one of the two 404s carries the code and
the other provably does not.
*/
describe("GET /api/tasks/:id single-request decision (RUFU-583)", () => {
  const DELETED_ID = "FN-583DEL";
  const LIVE_ID = "FN-583A";

  function detailStore(behavior: "normal" | "probe-faults" = "normal"): Partial<TaskStore> {
    return {
      getTask: vi.fn(async (id: string, options?: { includeDeleted?: boolean }) => {
        const row = seedBoard().find((task) => task.id === id);
        if (!row) throw new TaskNotFoundError(id);
        if (row.deletedAt && !options?.includeDeleted) throw new TaskNotFoundError(id);
        if (row.deletedAt && behavior === "probe-faults") throw new Error("storage unavailable");
        return { ...row };
      }),
    } as unknown as Partial<TaskStore>;
  }

  it("answers a tombstone with 404 that discloses the soft delete and its timestamp", async () => {
    const app = buildApp({ store: detailStore() });
    const response = await performRequest(app, "GET", `/api/tasks/${DELETED_ID}`);

    expect(response.status).toBe(404);
    const body = response.body as { error: string; details?: Record<string, unknown> };
    expect(body.error).toBe(`Task ${DELETED_ID} not found`);
    expect(body.details).toMatchObject({
      code: "TASK_SOFT_DELETED",
      taskId: DELETED_ID,
      deletedAt: "2026-10-06T09:02:00.000Z",
      lifecycle: "deleted",
    });
  });

  it("keeps a never-existed id a plain 404 with no soft-delete code", async () => {
    const app = buildApp({ store: detailStore() });
    const response = await performRequest(app, "GET", "/api/tasks/NOPE-999");

    expect(response.status).toBe(404);
    const body = response.body as { error: string; details?: Record<string, unknown> };
    expect(body.error).toBe("Task NOPE-999 not found");
    expect(body.details?.code).not.toBe("TASK_SOFT_DELETED");
  });

  it("returns the tombstone itself when the caller asks forensically, self-marked deleted", async () => {
    const store = detailStore();
    const app = buildApp({ store });
    const response = await performRequest(app, "GET", `/api/tasks/${DELETED_ID}?includeDeleted=1`);

    expect(response.status).toBe(200);
    const body = response.body as Row;
    expect(body.lifecycle).toBe("deleted");
    expect(body.deletedAt).toBe("2026-10-06T09:02:00.000Z");
    expect(store.getTask).toHaveBeenCalledWith(DELETED_ID, expect.objectContaining({ includeDeleted: true }));
  });

  it("marks a live detail read live, so the single route states the field like the list does", async () => {
    const app = buildApp({ store: detailStore() });
    const response = await performRequest(app, "GET", `/api/tasks/${LIVE_ID}`);

    expect(response.status).toBe(200);
    expect((response.body as Row).lifecycle).toBe("live");
  });

  it("falls back to the plain 404 when the forensic probe itself faults, never a 500", async () => {
    const app = buildApp({ store: detailStore("probe-faults") });
    const response = await performRequest(app, "GET", `/api/tasks/${DELETED_ID}`);

    expect(response.status).toBe(404);
    const body = response.body as { error: string; details?: Record<string, unknown> };
    expect(body.error).toBe(`Task ${DELETED_ID} not found`);
    expect(body.details?.code).not.toBe("TASK_SOFT_DELETED");
  });

  it("does not re-probe when the read was already forensic", async () => {
    const store = detailStore();
    const app = buildApp({ store });
    const response = await performRequest(app, "GET", "/api/tasks/NOPE-999?includeDeleted=1");

    expect(response.status).toBe(404);
    expect((response.body as { details?: Record<string, unknown> }).details?.code).not.toBe("TASK_SOFT_DELETED");
    // One store call: the forensic miss is itself the answer, so no second read is spent.
    expect(store.getTask).toHaveBeenCalledTimes(1);
  });
});
