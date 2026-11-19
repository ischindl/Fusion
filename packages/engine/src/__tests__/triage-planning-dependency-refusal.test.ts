import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { DependencyCycleError } from "@fusion/core";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/*
FNXC:DependencyRefusal 2026-11-19-00:45 (RUFU-552):
The measured cost of leaving a dependency refusal unclassified in this catch: SANE-480 proposed an edge the
board's own guard refuses, the throw escaped the tool and killed the planning turn, and three identical
deaths drained `recoveryRetryCount` into a park that reads `PLANNING_FAILED_EXHAUSTED: specification failed
3 times` — a specification verdict on a card whose only defect was an impossible dependency. The tools now
refuse in band, so this catch is the residual path; what it must still never do is invent an authoring
verdict or a new terminal park. RUFU-768 is why the disposition is the SHARED re-seed ceiling: a card
returned to `needs-replan` always has an automatic planning claimant, so the only honest stop is the ceiling
that parks, and the only honest counter is the one that ceiling already owns.
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
import { PLANNING_RESEED_CYCLE_EXHAUSTED_PREFIX } from "../executor/planning-reseed-cycle-budget.js";

const TASK_ID = "RUFU-553";
const BLOCKER = "RUFU-554";
const REFUSED_EDGE = `${TASK_ID} -> ${BLOCKER} -> ${TASK_ID}`;

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    description: "Plan a plugin sync queue reconciliation",
    column: "triage",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z",
    ...overrides,
  };
}

/** The refusal the store raises, delivered through the planner turn that called the tool. */
function cycleRefusal(): Error {
  return new DependencyCycleError(TASK_ID, [TASK_ID, BLOCKER, TASK_ID]);
}

/** Same contract, different class identity: the shape a re-built or re-wrapped carrier arrives as. */
function shapedRefusal(code: "DEPENDENCY_CYCLE" | "SELF_SPAWNED_DEPENDENCY"): Error {
  const error = code === "DEPENDENCY_CYCLE"
    ? new Error(`Dependency cycle detected for ${TASK_ID}: ${TASK_ID} → ${BLOCKER} → ${TASK_ID}`)
    : new Error(`Task ${TASK_ID} cannot depend on self-spawned task ${BLOCKER}`);
  Object.assign(error, { code, taskId: TASK_ID, dependencyId: BLOCKER, cyclePath: [TASK_ID, BLOCKER, TASK_ID] });
  Object.setPrototypeOf(error, Error.prototype);
  return error;
}

function createFixture(initialTask: Task) {
  let persisted = initialTask;
  const logs: string[] = [];
  const auditRows: Array<{ mutationType: string; metadata?: Record<string, unknown> }> = [];
  const update = async (_id: string, patch: Partial<Task> & { sourceMetadataPatch?: Record<string, unknown> }) => {
    const { sourceMetadataPatch, ...rest } = patch;
    persisted = {
      ...persisted,
      ...rest,
      ...(sourceMetadataPatch
        ? { sourceMetadata: { ...(persisted.sourceMetadata ?? {}), ...sourceMetadataPatch } }
        : {}),
    };
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
    lockCurrentPlanWhilePlanningLocked: vi.fn(async () => undefined),
    reconcileSpecDriftWhilePlanningLocked: vi.fn(async () => undefined),
    captureCurrentPlanEvidenceWhilePlanningLocked: vi.fn(async () => undefined),
    logEntry: vi.fn(async (_id: string, message: string) => { logs.push(message); }),
    recordRunAuditEvent: vi.fn(async (input: { mutationType: string; metadata?: Record<string, unknown> }) => {
      auditRows.push(input);
    }),
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
  return { store, task: () => persisted, logs, auditRows };
}

describe("triage refuses to turn a dependency rule into a planning failure (RUFU-552 Step 6)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fusion-triage-deprefusal-"));
    await mkdir(join(root, ".fusion", "tasks", TASK_ID), { recursive: true });
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

  /** One planning attempt whose planner turn dies on the board's dependency guard. */
  async function run(task: Task, rejection: () => unknown) {
    const fixture = createFixture(task);
    mockPromptWithFallback.mockRejectedValueOnce(rejection());
    await new TriageProcessor(fixture.store, root).specifyTask(task);
    return fixture;
  }

  it("charges the shared re-seed ceiling and leaves the authoring budget untouched", async () => {
    const fixture = await run(createTask(), cycleRefusal);

    const task = fixture.task();
    const allLogs = fixture.logs.join("\n");
    // No authoring verdict, and no error at all: the card was never a specification problem.
    expect(task.error).toBeNull();
    expect(task.status).not.toBe("failed");
    // The three authoring retries are NOT what pays for this.
    expect(task.recoveryRetryCount).toBeNull();
    expect(task.nextRecoveryAt).toBeNull();
    // The counter that IS charged is the existing ceiling's own, written through the existing seam.
    expect(task.sourceMetadata?.planningReseedCycles).toBe(1);
    expect(task.recoveryDisposition).toBe("escalated-reseed");
    expect(allLogs).toContain(REFUSED_EDGE);
    expect(allLogs).toContain("dependency the board refuses");
    // The generic branch's attribution: an authoring crash. This arm names the board rule instead.
    expect(allLogs).not.toContain("Specification failed:");
    expect(allLogs).not.toContain("PLANNING_FAILED_EXHAUSTED");
    expect(reseedRows(fixture)).toEqual([expect.objectContaining({ outcome: "re-seeded", cycles: 1 })]);
  });

  it("parks through the existing ceiling sentence once its cycles are spent", async () => {
    const fixture = await run(
      createTask({ sourceMetadata: { planningReseedCycles: 3 } }),
      cycleRefusal,
    );

    const task = fixture.task();
    const allLogs = fixture.logs.join("\n");
    expect(task.status).toBe("failed");
    expect(String(task.error).startsWith(PLANNING_RESEED_CYCLE_EXHAUSTED_PREFIX)).toBe(true);
    // The name this card exists to stop producing is not written anywhere.
    expect(allLogs).not.toContain("PLANNING_FAILED_EXHAUSTED");
    expect(String(task.error)).not.toContain("PLANNING_FAILED_EXHAUSTED");
    // A parked card keeps no retry state.
    expect(task.recoveryRetryCount).toBeNull();
    expect(task.nextRecoveryAt).toBeNull();
    // The ceiling's own durable proof, not a new disposition.
    expect(reseedRows(fixture)).toEqual([expect.objectContaining({ outcome: "parked", cycles: 3 })]);
  });

  it.each([
    ["a cycle carried only by its `code`", () => shapedRefusal("DEPENDENCY_CYCLE")],
    ["a self-spawn refusal", () => shapedRefusal("SELF_SPAWNED_DEPENDENCY")],
    ["a refusal a wrapper re-threw", () => new Error("planning session terminated", { cause: cycleRefusal() })],
  ])("routes %s through the same arm", async (_label, rejection) => {
    const fixture = await run(createTask(), rejection);

    const task = fixture.task();
    expect(task.sourceMetadata?.planningReseedCycles).toBe(1);
    expect(task.recoveryRetryCount).toBeNull();
    expect(task.error).toBeNull();
    expect(fixture.logs.join("\n")).not.toContain("PLANNING_FAILED_EXHAUSTED");
  });

  it("leaves an unrelated rejection that merely mentions a cycle on its own path", async () => {
    const fixture = await run(createTask(), () => new Error("cyclic provider failover exhausted the endpoint pool"));

    const task = fixture.task();
    // Prose is not a code: the re-seed ceiling is not charged and the ordinary path keeps the card.
    expect(task.sourceMetadata?.planningReseedCycles).toBeUndefined();
    expect(task.recoveryDisposition).not.toBe("escalated-reseed");
    expect(reseedRows(fixture)).toEqual([]);
    // The 1/2/3 cadence with backoff is untouched - the ordinary unclassified branch still owns it.
    expect(task.recoveryRetryCount).toBe(1);
    expect(Number.isFinite(Date.parse(task.nextRecoveryAt ?? ""))).toBe(true);
    expect(fixture.logs.join("\n")).not.toContain("dependency the board refuses");
  });
});

/** The ceiling's own rows, read out of the fixture's audit sink. */
function reseedRows(fixture: { auditRows: Array<{ mutationType: string; metadata?: Record<string, unknown> }> }) {
  return fixture.auditRows
    .filter((row) => row.mutationType === "task:planning-reseed-cycle")
    .map((row) => row.metadata ?? {});
}
