// @vitest-environment node
/*
FNXC:PlanningStrandedRetry 2026-11-10-23:05 (RUFU-575, board surface of four):

## Symptom Verification

Original symptom: a card whose planning run exhausted with transient provider errors stays parked in its
planning lane, and `POST /api/tasks/:id/retry` — the operator's Retry button — had two answers, both
wrong. The `queued` half was refused outright:

  400 - "Retry cannot restart this stage (unavailable) and the task is not in a legacy retryable
         state (current status: queued)"

The `needs-replan` half was accepted, but this route's specification branch is DESTRUCTIVE: it stamps
`needs-replan`, empties `steps`, and unlinks `.fusion/tasks/<id>/PROMPT.md`. So pressing Retry on a card
that lost its spec to a timed-out provider call destroyed the specification to arrange a re-plan of it.

Exact reproduction: a card in its own planning column carrying
`Specification failed after 3 transient errors: Request timed out.` — with `status: "queued"` (SANE-282)
or `status: "needs-replan"` (SANE-524) — and a real PROMPT.md on disk. Retry it.

Assertion it is gone: both return 200, the row re-arms to `needs-replan`, and the PROMPT.md written
before the call is STILL THERE afterwards. The last case is the non-vacuous control that makes the file
assertion mean something: the same fixture with no exhaustion evidence still takes the destructive branch
and its specification really does disappear.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task, TaskStore } from "@fusion/core";
import { registerTaskWorkflowRoutes } from "../register-task-workflow-routes.js";
import { request as performRequest } from "../../test-request.js";
import { ApiError, sendErrorResponse } from "../../api-error.js";

const SPEC_TIMEOUT_ERROR = "Specification failed after 3 transient errors: Request timed out.";
const LEGACY_PARK_ERROR = "PLANNING_FAILED_EXHAUSTED: specification failed 3 times - last error: Request timed out.";
const SPEC_BODY = "# Task: Repair the lockfile drift\n\n## Steps\n\n- [ ] Step 0: Preflight\n- [ ] Step 1: Reproduce\n";
/*
FNXC:PlanningStrandedRetry 2026-11-10-23:58 (RUFU-575):
The bootstrap seed a card carries before any planner ever ran. It is here only as a fixture: admission
must NOT classify the residue, so the same row has to be accepted whether its PROMPT.md holds a real
plan, nothing at all (the normal residue of a provider timeout), or this seed body. Matching on
seed-ness would be the forbidden `no-durable-spec` leg.
*/
const SEED_ONLY_BODY = "## Original Description\n\nA card whose specification failed with transient provider errors.\n";

/** A workflow that plans in its own hold lane — the plan-in-place shape both incident cards sat in. */
const PLANS_IN_TODO = {
  version: "v2",
  id: "custom:plans-in-todo",
  name: "Plans In Todo",
  columns: [
    { id: "triage", traits: [{ trait: "intake" }] },
    { id: "todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent", countPending: true } }] },
    { id: "in-review", traits: [{ trait: "merge" }, { trait: "merge-blocker" }] },
    { id: "done", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "start", kind: "start", column: "triage" },
    { id: "planning", kind: "prompt", column: "todo", config: { seam: "planning", name: "Plan / specify" } },
    { id: "plan-review", kind: "gate", column: "todo", config: { workflowAction: "plan-review" } },
    { id: "execute", kind: "prompt", column: "in-progress", config: { seam: "execute" } },
  ],
  edges: [],
};

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "SANE-282",
    title: "specification timed out in the planning lane",
    description: "d",
    column: "todo",
    status: "queued",
    dependencies: [],
    createdAt: "2026-11-10T09:00:00.000Z",
    updatedAt: "2026-11-10T09:10:00.000Z",
    size: "M",
    subtasks: [],
    log: [],
    tags: [],
    blockedBy: [],
    mergeRetries: 2,
    steps: [{ name: "Preflight", status: "pending" }],
    currentStep: 0,
    source: { sourceType: "api" },
    ...overrides,
  } as unknown as Task;
}

/** Per-test scratch root so the route's real `unlink` of PROMPT.md is observable. */
let rootDir: string | null = null;

/** `body: null` models the specless residue: the directory exists, the file never was written. */
async function specSeed(taskId: string, body: string | null = SPEC_BODY): Promise<string> {
  rootDir = await mkdtemp(join(tmpdir(), "rufu575-board-retry-"));
  const dir = join(rootDir, ".fusion", "tasks", taskId);
  await mkdir(dir, { recursive: true });
  const promptPath = join(dir, "PROMPT.md");
  if (body !== null) await writeFile(promptPath, body, "utf-8");
  return promptPath;
}

function buildApp(input: { task: Task; rootDir: string }) {
  const updateTask = vi.fn(async (_taskId: string, patch: Partial<Task>) => Object.assign(input.task, patch));
  const moveTask = vi.fn(async () => input.task);
  const store = {
    getTask: async () => input.task,
    getTaskDetail: async () => input.task,
    updateTask,
    moveTask,
    logEntry: vi.fn(async () => {}),
    withPlanningLifecycleLock: async (_taskId: string, work: () => Promise<unknown>) => work(),
    updateTaskAtomic: async (_taskId: string, updater: (current: Task) => Partial<Task> | null | undefined | Promise<Partial<Task> | null | undefined>) => {
      const patch = await updater(structuredClone(input.task));
      if (patch) await updateTask(_taskId, patch);
      return input.task;
    },
    pauseTask: async (_taskId: string, paused: boolean, _context?: unknown, options?: { pausedReason?: string }) => {
      input.task.paused = paused || undefined;
      input.task.pausedReason = paused ? options?.pausedReason : undefined;
      return input.task;
    },
    cancelActiveWorkflowWorkItemsForTask: async () => {},
    listWorkflowWorkItemsForTask: async () => [],
    clearWorkflowRunStepInstancesAsync: async () => {},
    getSettings: async () => ({}),
    getSettingsFast: async () => ({}),
    /* The route deletes PROMPT.md under this root for real. Pointing it at a per-test scratch dir is
       what turns "the specification survived" from a mock-call assertion into a filesystem fact. */
    getRootDir: () => input.rootDir,
    listTasks: async () => [input.task],
    resetTerminalFailureAutoRecoveryBudget: async () => {},
    getTaskWorkflowSelectionAsync: async () => ({ workflowId: "custom:plans-in-todo" }),
    getWorkflowDefinition: async () => ({ ir: PLANS_IN_TODO }),
    getWorkflowSettingsProjectId: () => undefined,
    listTaskWorkflowStepResults: async () => [],
    getTaskWorkflowStepInstances: async () => [],
    deleteTaskWorkflowStepInstances: async () => {},
  } as unknown as TaskStore;

  const runtimeLogger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  const router = express.Router();
  registerTaskWorkflowRoutes({
    router,
    store,
    options: {},
    runtimeLogger: runtimeLogger as never,
    planningLogger: runtimeLogger as never,
    chatLogger: runtimeLogger as never,
    getProjectIdFromRequest: () => undefined,
    getScopedStore: async () => store,
    getProjectContext: async () => ({ store, engine: undefined as never, projectId: "p-1" }),
    prioritizeProjectsForCurrentDirectory: (projects: unknown) => projects,
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
  } as never, {
    runtimeLogger,
    upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
    taskDetailActivityLogLimit: 100,
    validateOptionalModelField: (value: unknown) => (typeof value === "string" ? value : undefined),
    normalizeModelSelectionPair: (provider: string | null, modelId: string | null) => ({ provider: provider ?? null, modelId: modelId ?? null }),
    runGitCommand: async () => "",
    isGitRepo: async () => true,
    resolveIntegrationBranch: async () => "main",
    trimTaskDetailActivityLog: (task: unknown) => task,
    triggerCommentWakeForAssignedAgent: async () => {},
    resolveSelfHealingManager: () => undefined,
  } as never);

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
  return { app, updateTask, moveTask };
}

async function retry(app: express.Express) {
  return performRequest(app, "POST", "/api/tasks/SANE-282/retry", "{}", { "content-type": "application/json" });
}

/** The status the route last wrote — `needs-replan` is the re-arm, `null` is a generic rebound. */
function statusPatchOf(updateTask: ReturnType<typeof vi.fn>): unknown {
  const calls = updateTask.mock.calls.filter((c) => c[1] && "status" in (c[1] as object));
  return (calls.at(-1)?.[1] as { status?: unknown } | undefined)?.status;
}

afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
  rootDir = null;
});

describe("POST /api/tasks/:id/retry — a planning run that exhausted re-arms without destroying the spec", () => {
  /*
  THE DEFECT, both shapes. Before this, the `queued` row answered 400 and the `needs-replan` row was
  accepted only by the branch that unlinks the card's specification. Reverting the short-circuit makes
  the first case read 400 and the second lose its file.
  */
  it.each([
    ["SANE-282, parked `queued` with the incident marker", { status: "queued", error: SPEC_TIMEOUT_ERROR }],
    ["SANE-524, parked `needs-replan` with the incident marker", { status: "needs-replan", error: SPEC_TIMEOUT_ERROR }],
    ["a legacy PLANNING_FAILED_EXHAUSTED park, which carries a `failed` status", { status: "failed", error: LEGACY_PARK_ERROR }],
    ["the post-FN-9512 shape: `queued`, no error, escalated-reseed disposition", { status: "queued", error: null, recoveryDisposition: "escalated-reseed" }],
  ])("re-arms planning in place for %s and leaves the specification on disk", async (_name, overrides) => {
    const task = mkTask(overrides as Partial<Task>);
    const promptPath = await specSeed(task.id);
    const { app, updateTask, moveTask } = buildApp({ task, rootDir: rootDir! });

    const res = await retry(app);

    expect(res.status).toBe(200);
    expect(statusPatchOf(updateTask)).toBe("needs-replan");
    /* The specification is the thing this retry exists to keep. */
    expect(existsSync(promptPath)).toBe(true);
    /* Nothing else the card owns was touched: it did not move, and its step list survived. */
    expect(moveTask).not.toHaveBeenCalled();
    expect(task.steps.map((step) => step.status)).toEqual(["pending"]);
    expect(task.column).toBe("todo");
    expect(task.error ?? null).toBeNull();
    expect(task.planningFailure ?? null).toBeNull();
    expect(task.mergeRetries).toBe(0);
  });

  /*
  FNXC:PlanningStrandedRetry 2026-11-10-23:58 (RUFU-575):
  F4 and F5 of `## Symptom Verification` on the one surface where the spec was actually in danger. The
  `needs-replan` row used to be ANSWERED, not refused: the specification branch of this route stamps the
  status AND unlinks `PROMPT.md`, so a retry of the seed-only or specless card used to destroy the only
  artifact the next planner pass would have needed. The three bodies below are the whole residue space of
  a provider timeout, and the verdict must not move across them - which is exactly what a `promptContent`
  or `isUnplannedSeedPrompt` gate would break. Reverting the short-circuit loses the seed-only and
  specless cases by DELETING their file, so this test cannot pass vacuously.
  */
  it.each([
    ["a real plan body, the F1-F3 spec state", SPEC_BODY],
    ["F4: no PROMPT.md at all, the normal residue of a spec timeout", null],
    ["F5: only the bootstrap seed body", SEED_ONLY_BODY],
  ])("re-arms the same stranded row whatever its specification holds - %s", async (_name, body) => {
    const task = mkTask({ status: "needs-replan", error: SPEC_TIMEOUT_ERROR });
    const promptPath = await specSeed(task.id, body as string | null);
    const { app, updateTask, moveTask } = buildApp({ task, rootDir: rootDir! });

    const res = await retry(app);

    expect(res.status).toBe(200);
    expect(statusPatchOf(updateTask)).toBe("needs-replan");
    if (body === null) {
      // A retry that decided to "help" by writing a spec would be as wrong as one that deletes it.
      expect(existsSync(promptPath)).toBe(false);
    } else {
      expect(await readFile(promptPath, "utf-8")).toBe(body);
    }
    expect(moveTask).not.toHaveBeenCalled();
    expect(task.column).toBe("todo");
  });

  it("still refuses a capacity-throttled queued card, which is progressing rather than stranded", async () => {
    /* This task's own card logged exactly this line while waiting for a WIP slot. Admitting it would be
       the global reclassification of every `queued` card that this task forbids. */
    const task = mkTask({ error: "maxConcurrent capacity exhausted: used=12/12" });
    const promptPath = await specSeed(task.id);
    const { app, updateTask } = buildApp({ task, rootDir: rootDir! });

    const res = await retry(app);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("not in a legacy retryable state");
    expect(updateTask).not.toHaveBeenCalled();
    expect(task.status).toBe("queued");
    expect(task.error).toBe("maxConcurrent capacity exhausted: used=12/12");
    expect(existsSync(promptPath)).toBe(true);
  });

  /*
  FNXC:ReseedLaneDiscriminator 2026-11-12-15:06 (RUFU-575 code review P0):
  This is the surface where the ambiguous diagnostic cost the most, because this route owns the branch
  that UNLINKS the card's specification. An execution reseed clears the error and the retry cadence and
  leaves its one-word marker behind, then the scheduler stamps `queued` — byte-identical to the accepted
  planning row above on every field this route reads. The card must be refused and its PROMPT.md must
  survive; a card that finished implementing must never be re-planned by a Retry meant for a dead spec run.
  */
  it("refuses an execution-reseeded card the scheduler queued and keeps its specification on disk", async () => {
    const task = mkTask({ status: "queued", error: null, recoveryDisposition: "escalated-execution-reseed" });
    const promptPath = await specSeed(task.id);
    const { app, updateTask, moveTask } = buildApp({ task, rootDir: rootDir! });

    const res = await retry(app);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("not in a legacy retryable state");
    /* The refusal must name the status the card really carries, exactly as the CLI, the extension tool and
       the chat tool do — "un-retryable" has to stay diagnosable from the message alone, and a refusal that
       hid `queued` would send the operator looking for a failed row that does not exist. */
    expect(JSON.stringify(res.body)).toContain("current status: queued");
    expect(statusPatchOf(updateTask)).not.toBe("needs-replan");
    expect(existsSync(promptPath)).toBe(true);
    expect(updateTask).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
    expect(task.status).toBe("queued");
    expect(task.recoveryDisposition).toBe("escalated-execution-reseed");
  });

  it("leaves the destructive specification branch standing for a planning card with no exhaustion evidence", async () => {
    /*
    THE NON-VACUOUS CONTROL for the file assertion above, and the half of the invariant that says this
    class is a class and not a widening. `needs-replan` in its planning column with no planning-exhaustion
    evidence is a card whose SPEC is the thing under review, so the operator's Retry still means
    "re-plan it" and the file still goes. If this case ever keeps its PROMPT.md, the class has grown past
    its evidence test — and if it ever LOSES its file, the assertion above is not measuring anything.
    */
    // `error: undefined` is the no-marker row: the classification reads `task.error ?? ""`, so both the
    // null a Postgres row carries and an absent key mean the same thing here - no planning evidence.
    const task = mkTask({ status: "needs-replan", error: undefined });
    const promptPath = await specSeed(task.id);
    const { app } = buildApp({ task, rootDir: rootDir! });

    const res = await retry(app);

    expect(res.status).toBe(200);
    expect(existsSync(promptPath)).toBe(false);
  });
});
