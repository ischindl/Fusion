/**
 * FNXC:DeterministicSpecRejection 2026-11-08-03:20 (RUFU-485):
 * Board-behavior proof for a planner whose own output the deterministic checker refuses.
 *
 * RUFU-482 is the measured shape: the planner wrote a scanned-section note whose path token ended in
 * U+2026, the dangling-reference checker refused it, and the planner regenerated the same sentence -
 * three sessions (02:18Z, 02:39Z, 02:49Z), one diagnostic, zero information gained, then a park that
 * named an on-disk edit as its only remedy.
 *
 * The shape therefore ALWAYS arrives with the artifact rewritten (the deterministic branch is reached
 * only when `artifactChangedByAttempt` is true, and `baseline` is the PROMPT.md read immediately before
 * the attempt), so every case here drives real planner sessions that WRITE a refused spec. Nothing
 * pre-seeds the answer: a bound that holds only because the fixture stopped counting is the bound that
 * failed on RUFU-482.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskLogEntry, TaskStore } from "@fusion/core";
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
import { DETERMINISTIC_SPEC_VALIDATION_EXHAUSTED } from "../healing/deterministic-spec-rejection.js";

/** A spec that clears the deterministic checker, so a session that wrote nothing is not also refused. */
const ACCEPTED_SPEC = "# Plan\n\n## Original Description\n\nShip the bound.\n\n## Steps\n\n### Step 0: Preflight\n\n- read the spec\n";

const stepsWith = (note: string, preamble: string) => `# Plan

## Original Description

${preamble}

## Steps

### Step 0: Preflight

- read the spec

### Step 1: Work

- ${note}
`;

/**
 * RUFU-482's own defect: a scanned-section note citing a path inside the card's own task directory.
 * The checker refuses it (the token is not a file name), and the refusal names the token, so the
 * diagnostic below is a pure function of these bytes.
 */
const REFUSED_DANGLING_A = stepsWith("see .fusion/tasks/RUFU-482/notes.md for the earlier attempt", "Ship the bound.");
/**
 * The SAME deterministic verdict over provably DIFFERENT bytes - the planner reworded unrelated prose
 * and reproduced the refused token. Short-circuiting here is the whole point of the card; a fingerprint
 * of the whole spec would call this a new episode and the bound would never bite.
 */
const REFUSED_DANGLING_B = stepsWith("see .fusion/tasks/RUFU-482/notes.md for the earlier attempt", "Ship a different bound entirely, with other prose.");
/** A genuinely different defect: a different deterministic verdict earns a fresh full budget. */
const REFUSED_BAD_DEPENDENCY = "# Plan\n\n## Original Description\n\nShip the bound.\n\n## Steps\n\n### Step 0: Preflight (depends: 7)\n\n- read the spec\n";

const EPISODE_KEY = "deterministicSpecRejection";
const RESEED_KEY = "planningReseedCycles";
const PARK_MUTATION = "task:deterministic-spec-rejection-parked";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-4850",
    description: "Stop planning from re-refusing its own unchanged output",
    column: "triage",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
    ...overrides,
  } as Task;
}

/**
 * A store faithful enough to run the loop. `updateTask` merges the key-level `sourceMetadataPatch` the
 * way the real store does: a fixture that replaced `sourceMetadata` wholesale would hide the
 * marker-clobbering the episode contract forbids, and one that ignored the patch would never see the
 * episode the next session has to read.
 */
function createPersistedStore(initialTask: Task, settings: Partial<Settings> = {}) {
  let persisted = initialTask;
  const logs: string[] = [];
  const entries: Array<{ action: string; outcome?: string }> = [];
  const audits: Array<{ mutationType: string; metadata: Record<string, unknown> }> = [];
  const onceKeys = new Map<string, number>();

  const applyPatch = (patch: Partial<Task>) => {
    const { sourceMetadataPatch, ...rest } = patch as Partial<Task> & {
      sourceMetadataPatch?: Record<string, unknown> | null;
    };
    let next: Task = { ...persisted, ...rest };
    if (sourceMetadataPatch && typeof sourceMetadataPatch === "object") {
      const merged = { ...(persisted.sourceMetadata ?? {}) } as Record<string, unknown>;
      for (const [key, value] of Object.entries(sourceMetadataPatch)) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      next = { ...next, sourceMetadata: merged };
    }
    persisted = next;
    return persisted;
  };

  const appendLog = (action: string, outcome?: string) => {
    logs.push(action);
    entries.push({ action, outcome });
    persisted = {
      ...persisted,
      log: [...(persisted.log ?? []), { action, outcome, timestamp: new Date().toISOString() } as TaskLogEntry],
    };
  };

  const store = {
    getTask: vi.fn(async () => ({ ...persisted })),
    isBackendMode: vi.fn(() => true),
    getSettings: vi.fn(async () => ({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 10_000,
      groupOverlappingFiles: false,
      autoMerge: true,
      planReviewReplanCap: 8,
      ...settings,
    } as Settings)),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => applyPatch(patch)),
    updateTaskUnlocked: vi.fn(async (_id: string, patch: Partial<Task>) => applyPatch(patch)),
    updateTaskAtomic: vi.fn(async (...args: unknown[]) => {
      const [id, patcher] = args as [string, (live: Task) => Partial<Task> | null];
      const patch = patcher(persisted);
      if (patch) applyPatch(patch);
      return persisted;
    }),
    withPlanningLifecycleLock: vi.fn(async (_id: string, operation: () => Promise<unknown>) => operation()),
    withTaskLock: vi.fn(async (_id: string, operation: () => Promise<unknown>) => operation()),
    readTaskForMove: vi.fn(async () => persisted),
    lockCurrentPlanWhilePlanningLocked: vi.fn(async () => undefined),
    reconcileSpecDriftWhilePlanningLocked: vi.fn(async () => undefined),
    captureCurrentPlanEvidenceWhilePlanningLocked: vi.fn(async () => undefined),
    logEntry: vi.fn(async (_id: string, action: string, outcome?: string) => appendLog(action, outcome)),
    logEntryOnce: vi.fn(async (_id: string, input: { action: string; outcome?: string; dedupeKey: string }) => {
      if (onceKeys.has(input.dedupeKey)) return false;
      onceKeys.set(input.dedupeKey, 1);
      appendLog(input.action, input.outcome);
      return true;
    }),
    moveTask: vi.fn(async (_id: string, column: string) => {
      persisted = { ...persisted, column };
      return persisted;
    }),
    moveTaskInternal: vi.fn(async (_id: string, column: string) => {
      persisted = { ...persisted, column };
      return persisted;
    }),
    appendAgentLog: vi.fn(async () => undefined),
    getAgentLogs: vi.fn(async () => []),
    listTasks: vi.fn(async () => []),
    findRecentTasksBySourceParentTaskId: vi.fn(async () => []),
    recordActivity: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async (input: { mutationType: string; metadata: Record<string, unknown> }) => {
      audits.push({ mutationType: input.mutationType, metadata: input.metadata });
    }),
    parseDependenciesFromPrompt: vi.fn(async () => []),
    parseStepsFromPrompt: vi.fn(async () => []),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    on: vi.fn(),
    emit: vi.fn(),
  } as unknown as TaskStore;

  const metadata = (key: string) => (persisted.sourceMetadata as Record<string, unknown> | undefined)?.[key];

  return {
    store,
    task: () => persisted,
    logs,
    entries,
    audits,
    episode: () => metadata(EPISODE_KEY) as Record<string, unknown> | undefined,
    reseedCycles: () => metadata(RESEED_KEY),
    mutationCount: (mutationType: string) => audits.filter((row) => row.mutationType === mutationType).length,
  };
}

type Fixture = ReturnType<typeof createPersistedStore>;

/** One planner session = one `specifyTask`, over the same persisted row, exactly as the lane runs it. */
async function driveSession(triage: TriageProcessor, fixture: Fixture, spec: string): Promise<void> {
  mockPromptWithFallback.mockImplementation(async () => {
    await writeFile(promptPathOf(fixture), spec, "utf8");
  });
  await triage.specifyTask(fixture.task());
}

let promptPathOf: (fixture: Fixture) => string;

describe("triage rejection-identity short-circuit (RUFU-485)", () => {
  let root: string;
  let promptPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fusion-deterministic-spec-identity-"));
    promptPath = join(root, ".fusion", "tasks", "FN-4850", "PROMPT.md");
    await mkdir(join(root, ".fusion", "tasks", "FN-4850"), { recursive: true });
    promptPathOf = () => promptPath;
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

  it("parks on the second identical verdict instead of spending the cadence", async () => {
    await writeFile(promptPath, ACCEPTED_SPEC, "utf8");
    const fixture = createPersistedStore(createTask());
    const triage = new TriageProcessor(fixture.store, root);

    // Session 1: the first refusal of this verdict - today's bounded hold, plus the episode.
    await driveSession(triage, fixture, REFUSED_DANGLING_A);
    expect(fixture.task().status).not.toBe("failed");
    expect(fixture.task().recoveryRetryCount).toBe(1);
    expect(fixture.episode()).toMatchObject({ rejectionCount: 1, escalation: "hold" });

    // Session 2: the same verdict over different bytes. The checker cannot change its answer while the
    // token it named is still there, so this is the terminal park, not a third attempt.
    await driveSession(triage, fixture, REFUSED_DANGLING_B);

    expect(fixture.task().status).toBe("failed");
    expect(fixture.task().error ?? "").toContain(DETERMINISTIC_SPEC_VALIDATION_EXHAUSTED);
    expect(fixture.episode()).toMatchObject({ escalation: "park", rejectionCount: 2 });
    // The bound is a SESSION bound: two planner sessions, never the cadence-plus-reseed nine.
    expect(mockPromptWithFallback).toHaveBeenCalledTimes(2);
  });

  it("names only remedies an actor can perform and clears the borrowed counter", async () => {
    await writeFile(promptPath, ACCEPTED_SPEC, "utf8");
    const fixture = createPersistedStore(createTask());
    const triage = new TriageProcessor(fixture.store, root);
    await driveSession(triage, fixture, REFUSED_DANGLING_A);
    await driveSession(triage, fixture, REFUSED_DANGLING_B);

    const error = fixture.task().error ?? "";
    // The retired sentence demanded an action no lane could take, which is why RUFU-482's author and
    // reviewer each waited for the other.
    expect(error).not.toMatch(/retry\s+after\s+adjusting/i);
    expect(error).toContain("fn_task_prompt_write");
    expect(error).toContain("fn_task_update");
    // An operator must see that a repair re-admits the card, or the park reads as a dead end and Retry
    // gets pressed on input that cannot change.
    expect(error).toContain("re-admitted automatically once its spec changes");
    // RUFU-395's pairing rule: a number the park reads must not survive the park as an inherited value.
    expect(fixture.task().recoveryRetryCount).toBeNull();
    expect(fixture.task().nextRecoveryAt).toBeNull();
    // Lifecycle containment: an in-place terminal write, never a move out of the planning lane.
    expect(fixture.task().column).toBe("triage");
  });

  it("records one park row and one History sentence and consumes no re-seed cycle", async () => {
    await writeFile(promptPath, ACCEPTED_SPEC, "utf8");
    const fixture = createPersistedStore(createTask());
    const triage = new TriageProcessor(fixture.store, root);
    await driveSession(triage, fixture, REFUSED_DANGLING_A);
    await driveSession(triage, fixture, REFUSED_DANGLING_B);

    expect(fixture.mutationCount(PARK_MUTATION)).toBe(1);
    const parkRow = fixture.audits.find((row) => row.mutationType === PARK_MUTATION);
    expect(parkRow?.metadata).toMatchObject({ taskId: "FN-4850", rejectionCount: 2, outcome: "parked" });
    // The row names WHICH verdict it recognised, as a digest an operator can join parks on - and nothing
    // else: the diagnostic sentence and the spec content stay on the card.
    expect(String(parkRow?.metadata?.rejectionIdentity)).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(parkRow?.metadata ?? {}).sort()).toEqual(["outcome", "rejectionCount", "rejectionIdentity", "taskId"]);

    expect(fixture.entries.filter((entry) => entry.action.includes("refused the same deterministic defect twice")))
      .toHaveLength(1);

    // RUFU-768 owns drifting failures; this park must not touch its budget or impersonate its sentinel.
    expect(fixture.reseedCycles()).toBeUndefined();
    expect(fixture.mutationCount("task:planning-reseed-cycle")).toBe(0);
    expect(fixture.task().error ?? "").not.toContain("PLANNING_RESEED_CYCLE_EXHAUSTED");
  });

  it("keeps the full budget when the deterministic verdict itself changes", async () => {
    await writeFile(promptPath, ACCEPTED_SPEC, "utf8");
    const fixture = createPersistedStore(createTask());
    const triage = new TriageProcessor(fixture.store, root);

    await driveSession(triage, fixture, REFUSED_DANGLING_A);
    const firstIdentity = fixture.episode()?.rejectionIdentity;
    expect(fixture.episode()).toMatchObject({ rejectionCount: 1, escalation: "hold" });

    // A different refusal is a different defect: short-circuiting it would delete the legitimate replan.
    await driveSession(triage, fixture, REFUSED_BAD_DEPENDENCY);

    expect(fixture.task().error ?? "").not.toContain(DETERMINISTIC_SPEC_VALIDATION_EXHAUSTED);
    expect(fixture.task().status).not.toBe("failed");
    expect(fixture.episode()).toMatchObject({ rejectionCount: 1, escalation: "hold" });
    expect(fixture.episode()?.rejectionIdentity).not.toBe(firstIdentity);
    // The cadence continues on its own terms: attempt 2 of 3, not a terminal write.
    expect(fixture.task().recoveryRetryCount).toBe(2);
  });

  it("stamps the episode beside a re-seed escalation so the next identical verdict parks", async () => {
    await writeFile(promptPath, ACCEPTED_SPEC, "utf8");
    // The cadence is already at its ceiling, so this pass reaches the shared re-seed seam.
    const fixture = createPersistedStore(createTask({ recoveryRetryCount: 3 }));
    const triage = new TriageProcessor(fixture.store, root);

    await driveSession(triage, fixture, REFUSED_DANGLING_A);

    expect(fixture.reseedCycles()).toBe(1);
    expect(fixture.episode()).toMatchObject({ rejectionCount: 1, escalation: "hold" });

    // The point of stamping there: the escalation zeroed the cadence, so without the episode the new
    // cycle would pay three more identical sessions before stopping.
    await driveSession(triage, fixture, REFUSED_DANGLING_B);
    expect(fixture.task().status).toBe("failed");
    expect(fixture.task().error ?? "").toContain(DETERMINISTIC_SPEC_VALIDATION_EXHAUSTED);
    expect(mockPromptWithFallback).toHaveBeenCalledTimes(2);
  });

  it("fails open on a malformed episode instead of parking on a corrupt read", async () => {
    await writeFile(promptPath, ACCEPTED_SPEC, "utf8");
    const fixture = createPersistedStore(createTask({
      sourceMetadata: { [EPISODE_KEY]: { rejectionCount: "lots", escalation: "maybe" } },
    }));
    const triage = new TriageProcessor(fixture.store, root);

    await driveSession(triage, fixture, REFUSED_DANGLING_A);

    // An unreadable episode proves nothing about the input, so the card keeps today's ladder.
    expect(fixture.task().status).not.toBe("failed");
    expect(fixture.task().recoveryRetryCount).toBe(1);
    // The unreadable value is replaced by a well-formed episode, not carried forward.
    expect(fixture.episode()).toMatchObject({ rejectionCount: 1, escalation: "hold" });
  });

  it("leaves the RUFU-251 REVISE-episode lane decided first and writes no episode of its own", async () => {
    await writeFile(promptPath, ACCEPTED_SPEC, "utf8");
    const graphAttemptMarker = (attempt: number) => ({
      action: `Plan Review requested a plan revision — task stays in 'triage' (attempt ${attempt}/unbounded (absolute cap 8))`,
      outcome: "Revise the step list.\nWorkflow revision key: plan-review",
      timestamp: "2026-11-07T00:02:00.000Z",
    });
    const fixture = createPersistedStore(createTask({
      status: "needs-replan",
      workflowStepResults: [{
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
        status: "failed",
        verdict: "REVISE",
        planReviewAttemptCount: 9,
        startedAt: "2026-11-07T00:00:00.000Z",
        completedAt: "2026-11-07T00:01:00.000Z",
      } as unknown as TaskLogEntry],
      log: Array.from({ length: 8 }, (_unused, index) => graphAttemptMarker(index + 1)) as TaskLogEntry[],
    }));
    const triage = new TriageProcessor(fixture.store, root);

    await driveSession(triage, fixture, REFUSED_DANGLING_A);
    await driveSession(triage, fixture, REFUSED_DANGLING_B);

    // Two identical refusals, and the live REVISE episode's own cap park is still the disposition.
    expect(fixture.task().status).toBe("awaiting-approval");
    expect((fixture.task() as unknown as Record<string, unknown>).awaitingApprovalReason)
      .toBe("plan-review-replan-cap");
    expect(fixture.task().error ?? "").not.toContain(DETERMINISTIC_SPEC_VALIDATION_EXHAUSTED);
    expect(fixture.mutationCount(PARK_MUTATION)).toBe(0);
    expect(fixture.episode()).toBeUndefined();
  });
});
