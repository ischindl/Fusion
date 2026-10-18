// @vitest-environment node

/*
FNXC:ExecutionAdmissionReason 2026-10-18-10:00 (RUFU-718):
One wire code, six conditions. Before this change both unplanned refusals hard-coded
`board.rejection.unplannedForExecution` (the move route) or a fixed English sentence (promote), so an
operator dragging a card whose Plan Review had not reported could not tell it apart from a duplicate
redirect or a card that was never planned — and the two routes could disagree about the same refusal.

These cases pin the HTTP contract that closes that gap:
  - every closed reason reaches the client with `code` STILL exactly `unplanned-for-execution`
    (FN-8471: a new code with no client case prints a raw key), a `reason`, and its own `messageKey`;
  - the move route and the promote route resolve the SAME key for the SAME reason;
  - an unclassified unplanned refusal keeps the generic key and gains no `reason` field;
  - the retryable workflow-resolution 503 keeps the generic key — it has no reason to name.

The seam under test is the route's own mapping, so `admitTaskToWip` / `promoteHeldTask` are stubbed to
emit each closed reason exactly once; the reason itself is produced and held honest by
`packages/engine/src/__tests__/hold-release-unplanned-reason.test.ts`.
*/

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { request } from "../../test-request.js";
import { ApiError, sendErrorResponse } from "../../api-error.js";

const admitTaskToWip = vi.fn();
const promoteHeldTask = vi.fn();

vi.mock("@fusion/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/engine")>()),
  admitTaskToWip: (...args: unknown[]) => admitTaskToWip(...args),
  promoteHeldTask: (...args: unknown[]) => promoteHeldTask(...args),
}));

const { registerTaskWorkflowRoutes } = await import("../register-task-workflow-routes.js");

function workflow(): WorkflowIr {
  return {
    version: "v2",
    name: "unplanned-reason-copy",
    columns: [
      { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [{ from: "start", to: "end" }],
  };
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-718",
    title: "A ready card cannot leave todo",
    description: "Move this card into in-progress",
    column: "todo",
    status: null,
    prompt: "# A ready card cannot leave todo\n\n## Mission\nShip the admission-reason fix.\n",
    dependencies: [],
    steps: [],
    log: [],
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
    columnMovedAt: "2026-10-17T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function buildApp(task: Task, options: { failWorkflowResolution?: boolean } = {}) {
  const store: Partial<TaskStore> = {
    getTask: vi.fn(async (id: string) => (id === task.id ? task : null)),
    getTaskById: vi.fn(async (id: string) => (id === task.id ? task : null)),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
    moveTaskIf: vi.fn(async () => ({ task, moved: false })),
    moveTask: vi.fn(async () => task),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(async () => {
      if (options.failWorkflowResolution) throw new Error('workflow-store-unavailable');
      return { workflowId: 'custom', stepIds: [] };
    }),
    getWorkflowDefinition: vi.fn(async () => {
      if (options.failWorkflowResolution) throw new Error('workflow-store-unavailable');
      return { ir: workflow() };
    }),
    getSettingsFast: vi.fn(async () => ({})),
    getSettings: vi.fn(async () => ({})),
    getRootDir: vi.fn(() => process.cwd()),
  };
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const router = express.Router();
  registerTaskWorkflowRoutes({
    router,
    store: store as TaskStore,
    options: {},
    runtimeLogger: logger as never,
    planningLogger: logger as never,
    chatLogger: logger as never,
    getProjectIdFromRequest: () => undefined,
    getScopedStore: async () => store as TaskStore,
    getProjectContext: async () => ({ store: store as TaskStore, engine: undefined, projectId: undefined }),
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
      throw error instanceof ApiError ? error : new ApiError(500, String(error));
    },
  }, {
    runtimeLogger: logger as never,
    upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
    taskDetailActivityLogLimit: 100,
    validateOptionalModelField: () => undefined,
    normalizeModelSelectionPair: () => ({ provider: null, modelId: null }),
    runGitCommand: async () => "",
    trimTaskDetailActivityLog: (candidate) => candidate,
    triggerCommentWakeForAssignedAgent: async () => {},
  });

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const apiError = error instanceof ApiError ? error : new ApiError(500, String(error));
    sendErrorResponse(res, apiError.statusCode, apiError.message, { details: apiError.details, error: apiError });
  });
  return { app, store };
}

async function post(app: express.Express, path: string, body: Record<string, unknown>) {
  return request(app, "POST", path, JSON.stringify(body), { "content-type": "application/json" });
}

/** The closed reason set with the key each refusal must carry — mirrored client-side in `Column.rejection-copy.test.tsx`. */
const REASON_KEYS: Array<[string, string]> = [
  ["plan-review-pending", "board.rejection.unplannedForExecutionPlanReviewPending"],
  ["human-plan-approval-pending", "board.rejection.unplannedForExecutionHumanApprovalPending"],
  ["planning-status", "board.rejection.unplannedForExecutionPlanningInFlight"],
  ["needs-replan", "board.rejection.unplannedForExecutionNeedsReplan"],
  ["duplicate-prompt", "board.rejection.unplannedForExecutionDuplicateRedirect"],
  ["seed-prompt", "board.rejection.unplannedForExecutionSeedPrompt"],
];

const refusal = (reason?: string) => ({
  released: false as const,
  rejection: "unplanned-for-execution" as const,
  ...(reason ? { reason: reason as never } : {}),
  detail: `Refused because of ${reason ?? "an unclassified cause"} — next action named here.`,
});

beforeEach(() => {
  admitTaskToWip.mockReset();
  promoteHeldTask.mockReset();
});

describe("POST /tasks/:id/move — unplanned refusal copy", () => {
  it.each(REASON_KEYS)("%s refuses with the generic code plus that reason and its own key", async (reason, messageKey) => {
    admitTaskToWip.mockResolvedValue(refusal(reason));
    const { app } = buildApp(createTask());

    const response = await post(app, "/api/tasks/RUFU-718/move", { column: "in-progress" });
    const body = response.body as { error: string; details: Record<string, unknown> };

    expect(response.status).toBe(409);
    expect(body.details).toMatchObject({
      code: "unplanned-for-execution",
      reason,
      messageKey,
    });
    // The sentence the operator reads is the engine's reason-bearing detail, not a fixed line.
    expect(body.error).toContain("next action named here");
  });

  it("keeps the generic key and adds no reason field when the refusal is unclassified", async () => {
    admitTaskToWip.mockResolvedValue(refusal());
    const { app } = buildApp(createTask());

    const response = await post(app, "/api/tasks/RUFU-718/move", { column: "in-progress" });
    const body = response.body as { details: Record<string, unknown> };

    expect(response.status).toBe(409);
    expect(body.details).toMatchObject({
      code: "unplanned-for-execution",
      messageKey: "board.rejection.unplannedForExecution",
    });
    expect(body.details).not.toHaveProperty("reason");
  });

  it("leaves a non-unplanned rejection on the generic key so no other code gains a reason key", async () => {
    admitTaskToWip.mockResolvedValue({ released: false, rejection: "capacity-exhausted-or-no-slot" });
    const { app } = buildApp(createTask());

    const response = await post(app, "/api/tasks/RUFU-718/move", { column: "in-progress" });
    const body = response.body as { details: Record<string, unknown> };

    expect(response.status).toBe(409);
    expect(body.details).toMatchObject({ code: "capacity-exhausted-or-no-slot" });
    expect(body.details).not.toHaveProperty("reason");
  });
});

describe("POST /tasks/:id/promote — the same refusal resolves the same key", () => {
  it.each(REASON_KEYS)("%s promotes to the same key the move route emits", async (reason, messageKey) => {
    promoteHeldTask.mockResolvedValue({ ...refusal(reason), toColumn: "in-progress" });
    const { app, store } = buildApp(createTask());

    const response = await post(app, "/api/tasks/RUFU-718/promote", {});
    const body = response.body as { error: string; details: Record<string, unknown> };

    expect(response.status).toBe(409);
    expect(body.details).toMatchObject({
      code: "unplanned-for-execution",
      reason,
      messageKey,
    });
    expect(body.error).toContain("next action named here");
    // FN-245 stands: a refused promote never moves the card.
    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });
});

describe("Workflow-resolution 503 — retryable, and has no reason to name", () => {
  it("keeps the generic unplanned key instead of inventing a per-reason key", async () => {
    const { app } = buildApp(createTask(), { failWorkflowResolution: true });

    const response = await post(app, "/api/tasks/RUFU-718/move", { column: "in-progress" });
    const body = response.body as { details: Record<string, unknown> };

    expect(response.status).toBe(503);
    expect(body.details).toMatchObject({
      code: "workflow-resolution-unavailable",
      messageKey: "board.rejection.unplannedForExecution",
      retryable: true,
    });
    expect(body.details).not.toHaveProperty("reason");
  });
});
