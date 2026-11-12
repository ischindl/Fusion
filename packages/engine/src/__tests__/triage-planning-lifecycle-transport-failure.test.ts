import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { PlanningLifecycleLockTransportError } from "@fusion/core";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-8911",
    description: "Plan a direct PostgreSQL deployment",
    column: "triage",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    customFields: { unrelated: "preserve-me" },
    ...overrides,
  };
}

function createPersistedStore(initialTask: Task): { store: TaskStore; task: () => Task; logs: string[] } {
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
    lockCurrentPlanWhilePlanningLocked: vi.fn(async () => {
      throw new PlanningLifecycleLockTransportError("direct PostgreSQL session endpoint is unavailable");
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

describe("triage planning lifecycle lock transport failures (FN-8911)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fusion-triage-lock-transport-"));
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

  it("persists transport failures across a fresh triage owner instead of laundering them into unchanged-PROMPT failures", async () => {
    const fixture = createPersistedStore(createTask());
    const promptPath = join(root, ".fusion", "tasks", "FN-8911", "PROMPT.md");
    await mkdir(join(root, ".fusion", "tasks", "FN-8911"), { recursive: true });

    mockPromptWithFallback.mockImplementationOnce(async () => {
      await writeFile(promptPath, "# Direct PostgreSQL plan\n", "utf8");
    });
    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());

    expect(fixture.task().error).toBeNull();
    expect(fixture.task().recoveryRetryCount).toBe(1);
    expect(fixture.task().customFields).toEqual({ unrelated: "preserve-me" });
    expect(fixture.task().planningFailure?.lifecycleLockTransport).toMatchObject({
      message: "direct PostgreSQL session endpoint is unavailable",
      attempt: 1,
      at: expect.any(String),
    });
    expect(fixture.logs.join("\n")).toContain("Planning lifecycle lock transport failure");

    // A new processor models a retry claimed after an engine restart or ownership change.
    mockPromptWithFallback.mockResolvedValueOnce(undefined);
    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());

    const retryLog = fixture.logs.at(-1) ?? "";
    /*
    FNXC:PlannerNoopRelease 2026-11-11-22:54 (RUFU-527 — monotone consequence, asserted not hidden):
    This pass now reaches the handoff instead of stopping at the unchanged-spec failure branch, so the
    infrastructure refusal arrives from the fenced plan-capture write rather than from the persisted
    marker read. Both sentences begin with the same shipped prefix, and the subject of this case is
    unchanged: the retry names a transport failure and never a planner that left the spec alone.
    */
    expect(retryLog).toContain("Planning lifecycle lock transport failure");
    expect(retryLog).not.toContain("did not update the authoritative PROMPT.md");
    expect(fixture.task().recoveryRetryCount).toBe(2);

    mockPromptWithFallback.mockResolvedValueOnce(undefined);
    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());
    mockPromptWithFallback.mockResolvedValueOnce(undefined);
    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());

    expect(fixture.task()).toMatchObject({
      /*
      FNXC:PlannerNoopRelease 2026-11-11-22:54 (RUFU-527 — the one consequence that is NOT monotone, stated):
      With the release door widened, this card's passes now reach the handoff, so the fenced plan-capture
      write is where the outage surfaces and FN-8911's transport lane is what stops the loop: after its
      own bounded retries it parks the card `failed` naming the endpoint, instead of the earlier shape
      where the unchanged-spec branch short-circuited every pass and the generic cadence reseeded forever.
      The specification stays on disk and the verdict names infrastructure, so the operator's Retry is a
      real exit; giving that park its own reconciliation sweep, the way RUFU-288 did for the fence park,
      is recorded as follow-up work rather than folded into this change.
      */
      status: "failed",
      recoveryRetryCount: null,
      nextRecoveryAt: null,
      planningFailure: null,
      customFields: { unrelated: "preserve-me" },
    });
    expect(fixture.task().error ?? "").toContain("Planning lifecycle lock transport failure");
    expect(fixture.logs.at(-1)).not.toContain("did not update the authoritative PROMPT.md");
  });

  it("keeps the ordinary unchanged-PROMPT verdict when no persisted transport marker exists", async () => {
    const fixture = createPersistedStore(createTask({ customFields: { unrelated: "preserve-me" } }));
    const promptPath = join(root, ".fusion", "tasks", "FN-8911", "PROMPT.md");
    await mkdir(join(root, ".fusion", "tasks", "FN-8911"), { recursive: true });
    /*
    FNXC:PlannerNoopRelease 2026-11-11-22:54 (RUFU-527):
    This case owns the UNCLASSIFIED unchanged-spec verdict, so its retained spec must not be one the
    widened release door would let go. Prose-only content now releases on its own merits; the
    out-of-range `(depends:)` token keeps the card on the ordinary failure verdict deterministically.
    */
    await writeFile(promptPath, "# Existing plan\n\n### Step 24 (depends: 2): Uses an absent prerequisite\n", "utf8");

    mockPromptWithFallback.mockResolvedValue(undefined);
    (fixture.store.lockCurrentPlanWhilePlanningLocked as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());

    expect(fixture.logs.join("\n")).toContain("Planner did not update the authoritative PROMPT.md");
    expect(fixture.logs.join("\n")).not.toContain("Planning lifecycle lock transport failure recorded at");
  });
});
