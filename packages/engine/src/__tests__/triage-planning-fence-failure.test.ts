import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { PlanningLifecycleLockTransportError } from "@fusion/core";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/*
FNXC:PlanningFenceRecovery 2026-10-02-01:20 (RUFU-288):
RUFU-287 proved the cost of the class being unclassified: the same 5 s `pg_advisory_lock` grant
timeout the plan-capture seam already retries with backoff was re-wrapped by the durable planning
fence as `workflow-principal-fence-unavailable:triage`, fell through every classifier in triage's
catch, and terminalized the card as `PLANNING_FAILED_EXHAUSTED` — an authoring verdict for an
infrastructure refusal, with the planner's reasoning attached as if the spec were the problem.

These cases pin the three contracts that make the class recoverable:
1. a fence refusal holds for a bounded retry and NEVER writes an authoring verdict;
2. exhaustion names the park (`PLANNING_FENCE_UNAVAILABLE:`) and keeps the evidence a human and the
   `reconcile-planning-fence-park` sweep both select on;
3. a genuine authoring failure cannot inherit a stale fence marker.
*/

const { mockCreateFnAgent, mockPromptWithFallback } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn(),
}));

vi.mock("../pi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pi.js")>();
  return {
    ...actual,
    createFnAgent: mockCreateFnAgent,
    promptWithFallback: mockPromptWithFallback,
  };
});

import { TriageProcessor } from "../triage.js";
import { PLANNING_FENCE_PARK_ERROR_PREFIX, isPlanningFenceTerminalPark } from "../planning-handoff-recovery.js";

const LOCK_TIMEOUT_DETAIL = "Planning lifecycle lock acquisition timed out after 5000ms";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-288-FENCE",
    description: "Plan a fenced deployment",
    column: "triage",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    customFields: { unrelated: "preserve-me" },
    ...overrides,
  };
}

/**
 * The fence refusal as triage actually receives it: RUFU-318's rewrap keeps the stable
 * `workflow-principal-fence-unavailable:<role>` prefix, appends the cause in parentheses, and
 * preserves `cause`. `shape` selects which availability requirement the refusal carries.
 */
function fenceRefusal(shape: "lock-transport" | "store-unavailable" | "cause-unknown"): Error {
  const message = shape === "cause-unknown"
    ? "workflow-principal-fence-unavailable:triage"
    : shape === "store-unavailable"
      ? "workflow-principal-fence-unavailable:triage (store write behind the fence failed)"
      : `workflow-principal-fence-unavailable:triage (${LOCK_TIMEOUT_DETAIL})`;
  const error = new Error(message) as Error & { cause?: unknown };
  if (shape === "lock-transport") {
    error.cause = new PlanningLifecycleLockTransportError(LOCK_TIMEOUT_DETAIL);
  } else if (shape === "store-unavailable") {
    error.cause = new Error("store write behind the fence failed");
  }
  return error;
}

/** A fence episode from an earlier life of the card: evidence that must not drive a later verdict. */
function priorFenceEpisode() {
  return {
    role: "triage",
    requirement: "cause-unknown" as const,
    detail: null,
    firstAt: "2026-10-01T00:00:00.000Z",
    at: "2026-10-01T00:00:00.000Z",
    attempt: 3,
  };
}

function createFixture(initialTask: Task, refusal: () => Error) {
  let persisted = initialTask;
  const logs: string[] = [];
  const update = async (_id: string, patch: Partial<Task>) => {
    persisted = { ...persisted, ...patch };
    return persisted;
  };
  const store = {
    getTask: vi.fn(async () => ({ ...persisted, attachments: [], comments: [] })),
    isBackendMode: vi.fn(() => true),
    getSettings: vi.fn(async () => ({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 10_000,
      groupOverlappingFiles: false,
      autoMerge: true,
    } as Settings)),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    updateTask: vi.fn(update),
    updateTaskUnlocked: vi.fn(update),
    updateTaskAtomic: vi.fn(async (_id: string, patcher: (live: Task) => Partial<Task> | null) => {
      const patch = patcher(persisted);
      if (patch) await update(_id, patch);
      return persisted;
    }),
    withPlanningLifecycleLock: vi.fn(async (_id: string, operation: () => Promise<unknown>) => operation()),
    withTaskLock: vi.fn(async (_id: string, operation: () => Promise<unknown>) => operation()),
    readTaskForMove: vi.fn(async () => persisted),
    // The fenced seam that raised in RUFU-287: a plan-capture write behind the planning fence.
    lockCurrentPlanWhilePlanningLocked: vi.fn(async () => {
      throw refusal();
    }),
    reconcileSpecDriftWhilePlanningLocked: vi.fn(async () => undefined),
    captureCurrentPlanEvidenceWhilePlanningLocked: vi.fn(async () => undefined),
    logEntry: vi.fn(async (_id: string, message: string) => { logs.push(message); }),
    appendAgentLog: vi.fn(async () => undefined),
    getAgentLogs: vi.fn(async () => []),
    listTasks: vi.fn(async () => []),
    findRecentTasksBySourceParentTaskId: vi.fn(async () => []),
    recordActivity: vi.fn(async () => undefined),
    parseDependenciesFromPrompt: vi.fn(async () => []),
    parseStepsFromPrompt: vi.fn(async () => []),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    on: vi.fn(),
    emit: vi.fn(),
  } as unknown as TaskStore;
  return { store, task: () => persisted, logs };
}

describe("triage workflow-principal fence refusals (RUFU-288)", () => {
  let root: string;
  let promptPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fusion-triage-fence-"));
    promptPath = join(root, ".fusion", "tasks", "FN-288-FENCE", "PROMPT.md");
    await mkdir(join(root, ".fusion", "tasks", "FN-288-FENCE"), { recursive: true });
    mockCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn(),
        dispose: vi.fn(),
        sessionManager: { getLeafId: vi.fn(() => null), navigateTree: vi.fn() },
      },
    });
  });

  afterEach(async () => {
    mockCreateFnAgent.mockReset();
    mockPromptWithFallback.mockReset();
    await rm(root, { recursive: true, force: true });
  });

  /** One planning attempt; the planner writes a spec, then the fenced seam refuses. */
  async function attemptOnce(store: TaskStore, task: Task, wrotePrompt: boolean) {
    mockPromptWithFallback.mockImplementationOnce(async () => {
      if (wrotePrompt) await writeFile(promptPath, "# Fenced plan\n\nAuthoritative spec body.\n", "utf8");
    });
    await new TriageProcessor(store, root).specifyTask(task);
  }

  it.each<[string, "lock-transport" | "store-unavailable" | "cause-unknown"]>([
    ["a lock transport cause", "lock-transport"],
    ["a store-write cause", "store-unavailable"],
    ["no carried cause", "cause-unknown"],
  ])("holds %s for retry without writing an authoring verdict", async (_label, shape) => {
    const fixture = createFixture(createTask(), () => fenceRefusal(shape));
    await attemptOnce(fixture.store, fixture.task(), true);

    const task = fixture.task();
    const allLogs = fixture.logs.join("\n");
    // Never an authoring verdict, and never a terminal park.
    expect(allLogs).not.toContain("PLANNING_FAILED_EXHAUSTED");
    expect(task.error).toBeNull();
    expect(task.status).not.toBe("failed");
    // A bounded retry owns the card: the shared recovery counter pair, not the authoring budget.
    expect(task.recoveryRetryCount).toBe(1);
    expect(Number.isFinite(Date.parse(task.nextRecoveryAt ?? ""))).toBe(true);
    expect(task.planningFailure?.principalFence).toMatchObject({
      role: "triage",
      requirement: shape,
      firstAt: expect.any(String),
      at: expect.any(String),
      attempt: 1,
    });
    expect(task.customFields).toEqual({ unrelated: "preserve-me" });
    if (shape === "lock-transport") {
      expect(task.planningFailure?.principalFence?.detail).toContain("Planning lifecycle lock acquisition timed out");
    }
    if (shape === "cause-unknown") {
      expect(task.planningFailure?.principalFence?.detail).toBeNull();
    }
  });

  it("names the terminal park and keeps its evidence once the fence budget is exhausted", async () => {
    const fixture = createFixture(createTask(), () => fenceRefusal("lock-transport"));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await attemptOnce(fixture.store, fixture.task(), true);
    }

    const task = fixture.task();
    const allLogs = fixture.logs.join("\n");
    expect(allLogs).not.toContain("PLANNING_FAILED_EXHAUSTED");
    expect(task.status).toBe("failed");
    expect(task.error?.startsWith(PLANNING_FENCE_PARK_ERROR_PREFIX)).toBe(true);
    // The sentence names the availability requirement that refused, not the planner's reasoning.
    expect(task.error).toContain("planning lifecycle lock unavailable");
    expect(task.error).toContain("reconcile-planning-fence-park");
    // The park must be selectable by the sweep and the wedge classifier: counters cleared, evidence kept.
    expect(task.recoveryRetryCount).toBeNull();
    expect(task.nextRecoveryAt).toBeNull();
    expect(task.planningFailure?.principalFence?.requirement).toBe("lock-transport");
    expect(task.planningFailure?.principalFence?.firstAt).toBeTruthy();
  });

  it("keeps a stale fence marker from re-classifying an unchanged-PROMPT authoring failure as a fence park", async () => {
    const fixture = createFixture(
      createTask({
        planningFailure: { principalFence: priorFenceEpisode() },
        recoveryRetryCount: 3,
        nextRecoveryAt: "2026-10-01T00:00:00.000Z",
      }),
      () => new Error("planner produced nothing usable"),
    );
    // The spec exists and the planner leaves it untouched: the unchanged-PROMPT authoring failure.
    await writeFile(promptPath, "# Pre-existing plan\n\nAuthoritative spec body.\n", "utf8");
    await attemptOnce(fixture.store, fixture.task(), false);

    const task = fixture.task();
    expect(task.status).toBe("failed");
    expect(task.error).toContain("Planner did not update the authoritative PROMPT.md");
    expect(task.error?.startsWith(PLANNING_FENCE_PARK_ERROR_PREFIX)).toBe(false);
    // The retained evidence must stay inert: no sweep selection and no named planning wedge.
    expect(isPlanningFenceTerminalPark(task)).toBe(false);
  });

  it("clears a stale fence marker when the generic authoring budget is what exhausts", async () => {
    const fixture = createFixture(
      createTask({
        planningFailure: { principalFence: priorFenceEpisode() },
        recoveryRetryCount: 3,
        nextRecoveryAt: "2026-10-01T00:00:00.000Z",
      }),
      () => new Error("planner produced nothing usable"),
    );
    // The planner authors a spec, so the only failure left is the generic planning refusal.
    await attemptOnce(fixture.store, fixture.task(), true);

    const task = fixture.task();
    expect(task.status).toBe("failed");
    expect(task.error).toContain("PLANNING_FAILED_EXHAUSTED");
    expect(task.error?.startsWith(PLANNING_FENCE_PARK_ERROR_PREFIX)).toBe(false);
    // An authoring verdict must never carry infrastructure evidence forward.
    expect(task.planningFailure).toBeNull();
  });
});
