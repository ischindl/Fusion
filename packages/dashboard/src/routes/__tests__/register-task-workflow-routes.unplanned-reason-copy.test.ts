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

const {
  registerTaskWorkflowRoutes,
  RELEASE_ADMISSION_MESSAGE_KEYS,
  UNPLANNED_FOR_EXECUTION_MESSAGE_KEY,
  UNPLANNED_ADMISSION_MESSAGE_KEYS,
  releaseAdmissionWire,
} = await import("../register-task-workflow-routes.js");

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

/*
FNXC:ReleaseAdmissionWire 2026-11-18-07:17 (RUFU-727 Steps 4 and 8):
The same 409 shape failed the other way for refusals that are NOT about planning. `retryable` was a
two-member equality and `messageKey` fell into an `else` that named PLANNING for every rejection that was
not literally `unplanned-for-execution`. Measured on the second reported card: its History reads
`Plan premise invalidated by the card's own delivery` and then, in the same minute,
`Execution dispatch refused — task is still unplanned` — a premise-class refusal wearing the planning
sentence, with `retryable: true` attached to a condition that never changed across attempts. Its row
carries a `premise-invalidated` document and NO refusal episode, the signature of that `else` mapping:
whatever it returned, the board had one sentence for it, and it named planning.

These cases extend the closed-set guard above to the whole release-admission vocabulary, holding two
properties and no prose:
  - EXHAUSTIVENESS — every value of the engine's rejection union resolves a code, a key and a retryable
    flag from ONE table, so a code added at the door cannot land on a catch-all;
  - OWNERSHIP — a refusal whose subject is a plan premise never resolves the unplanned-for-execution copy,
    and `retryable` is true only where the next attempt genuinely re-derives.
Both routes are covered because the RUFU-718 defect was exactly a disagreement between them.
*/

/** The engine's release-admission rejection vocabulary, spelled here so an added value fails to compile. */
const REJECTIONS = [
  "unplanned-for-execution",
  "plan-premise-stale",
  "plan-premise-invalid",
  "plan-premise-unavailable",
  "plan-premise-exhausted",
  "capacity-exhausted-or-no-slot",
  "source-changed",
] as const satisfies readonly string[];

describe("release admission wire — one closed table for the whole 409 vocabulary", () => {
  it("resolves a code, a messageKey and a retryable flag for every rejection the door can return", () => {
    for (const rejection of REJECTIONS) {
      const wire = releaseAdmissionWire(rejection);
      expect(wire.code, `${rejection} must keep its own wire code`).toBe(rejection);
      expect(wire.messageKey.length).toBeGreaterThan(0);
      expect(typeof wire.retryable).toBe("boolean");
    }
    // Exactly one entry per non-unplanned rejection — no dead rows, no missing key.
    expect(Object.keys(RELEASE_ADMISSION_MESSAGE_KEYS).sort()).toEqual(
      REJECTIONS.filter((rejection) => rejection !== "unplanned-for-execution").sort(),
    );
  });

  it("never resolves the planning sentence for a refusal whose subject is a plan premise or a lost race", () => {
    const premiseClass = ["plan-premise-stale", "plan-premise-invalid", "plan-premise-unavailable", "plan-premise-exhausted", "source-changed"] as const;
    const unplannedKeys = new Set<string>([UNPLANNED_FOR_EXECUTION_MESSAGE_KEY, ...Object.values(UNPLANNED_ADMISSION_MESSAGE_KEYS)]);
    for (const rejection of premiseClass) {
      const { messageKey } = releaseAdmissionWire(rejection);
      expect(unplannedKeys.has(messageKey), `${rejection} must not borrow the unplanned-for-execution copy`).toBe(false);
    }
  });

  it("keeps retryable as the promise that the next attempt re-derives something different", () => {
    // Re-derivable: git did not answer, or the card changed under the check.
    expect(releaseAdmissionWire("plan-premise-unavailable").retryable).toBe(true);
    expect(releaseAdmissionWire("source-changed").retryable).toBe(true);
    // Deterministic: the plan is wrong, malformed, terminally parked, or the column is full. The dashboard
    // reads this field to withhold a Retry affordance, so promising here is the bug, not the omission.
    expect(releaseAdmissionWire("plan-premise-stale").retryable).toBe(false);
    expect(releaseAdmissionWire("plan-premise-invalid").retryable).toBe(false);
    expect(releaseAdmissionWire("plan-premise-exhausted").retryable).toBe(false);
    expect(releaseAdmissionWire("capacity-exhausted-or-no-slot").retryable).toBe(false);
    // Unplanned keeps its pre-existing classification: re-trying a move cannot make a pending gate report.
    expect(releaseAdmissionWire("unplanned-for-execution", "plan-review-pending").retryable).toBe(false);
  });

  it("keeps the reason-keyed copy for the one code that is about planning readiness", () => {
    expect(releaseAdmissionWire("unplanned-for-execution", "plan-review-pending").messageKey)
      .toBe(UNPLANNED_ADMISSION_MESSAGE_KEYS["plan-review-pending"]);
    expect(releaseAdmissionWire("unplanned-for-execution", "seed-prompt").messageKey)
      .toBe(UNPLANNED_ADMISSION_MESSAGE_KEYS["seed-prompt"]);
    expect(releaseAdmissionWire("unplanned-for-execution").messageKey).toBe(UNPLANNED_FOR_EXECUTION_MESSAGE_KEY);
  });

  it("gives a declined attempt its own honest wire shape instead of the planning sentence", () => {
    /*
    A door that declines a pass asserts NO refusal (`rejection` absent): the card is paused, left the
    column, or its premises were consumed by its own delivery while the move was lost. That arrived as
    `release-gate-refused` wearing the unplanned key — the same mislabel in a different wrapper.
    */
    const wire = releaseAdmissionWire(undefined);
    expect(wire.code).toBe("release-deferred");
    expect(wire.messageKey).toBe("board.rejection.releaseDeferred");
    expect(wire.retryable).toBe(true);
  });

  it("carries a premise refusal to both routes with the same code, key and retryable flag", async () => {
    const refusal = { released: false as const, rejection: "plan-premise-exhausted" as const, detail: "Premises stayed false across 2 re-derivations." };
    admitTaskToWip.mockResolvedValue(refusal);
    promoteHeldTask.mockResolvedValue({ ...refusal, toColumn: "in-progress" });

    const { app } = buildApp(createTask());
    const move = await post(app, "/api/tasks/RUFU-718/move", { column: "in-progress" });
    const promote = await post(app, "/api/tasks/RUFU-718/promote", {});
    const moveBody = move.body as { error: string; details: Record<string, unknown> };
    const promoteBody = promote.body as { error: string; details: Record<string, unknown> };

    expect(move.status).toBe(409);
    expect(promote.status).toBe(409);
    expect(moveBody.details).toMatchObject({
      code: "plan-premise-exhausted",
      messageKey: "board.rejection.planPremiseExhausted",
      retryable: false,
    });
    // Same refusal, same wire shape — the RUFU-718 failure mode was the two routes disagreeing.
    expect(promoteBody.details).toEqual(moveBody.details);
    // The premise key owns the whole wire shape: the planning field cannot ride alongside it either.
    expect(JSON.stringify(moveBody.details)).not.toContain("unplannedForExecution");
    expect(moveBody.details).not.toHaveProperty("reason");
    // The engine's own sentence is what the operator reads.
    expect(moveBody.error).toContain("Premises stayed false");
  });
});
