/**
 * FNXC:PlanReplanSessionBudget 2026-09-21-10:45 (RUFU-251):
 * Board-behavior proof for a planner session that ends without revising PROMPT.md while a Plan
 * Review `REVISE` request is live. Before RUFU-251 every such session rebound through the
 * filesystem-twin recovery budget only, so the plan → Plan Review → replan loop never terminated.
 * These cases pin BOTH halves of the contract: the REVISE episode is now bounded, and a card with
 * no live REVISE request keeps the exact behavior it had before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskLogEntry, TaskStore, WorkflowStepResult } from "@fusion/core";
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

import { TriageProcessor, describeExhaustedPlanningBudgetAttribution } from "../triage.js";
import {
  PLANNING_RESEED_CYCLE_EXHAUSTED_PREFIX,
  PLANNING_RESEED_CYCLE_LIMIT,
  PLANNING_RESEED_CYCLE_METADATA_KEY,
} from "../executor/planning-reseed-cycle-budget.js";

const VALID_SPEC = "# Plan\n\n## What This Delivers\n\nShip the bound.\n";
/*
FNXC:StepDependencyValidation 2026-10-01-22:44 (RUFU-545 made heading labels display-only):
`### Step 1:` as the first heading used to be this file's engine-provable structural damage, but a
heading LABEL is prose now, so a lone mis-numbered heading parses cleanly and every case that leans on
this fixture silently stops exercising its failure branch. The damage has to be an impossible PARSED
position instead: this `(depends: 2)` token names a step the document does not have, which
`parseStepHeadings` refuses deterministically, without any reviewer judgement. Same shape as the
shared fixture in `triage-planning-retry-hold.test.ts`.
*/
const INVALID_SPEC = "# Plan\n\n### Step 24 (depends: 2): Uses an absent prerequisite\n\nShip the bound.\n";

const planReviewReviseRow = (overrides: Record<string, unknown> = {}) => ({
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  status: "failed",
  verdict: "REVISE",
  startedAt: "2026-09-21T00:00:00.000Z",
  completedAt: "2026-09-21T00:01:00.000Z",
  ...overrides,
}) as unknown as WorkflowStepResult;

const graphAttemptMarker = (attempt: number) => ({
  action: `Plan Review requested a plan revision — task stays in 'triage' (attempt ${attempt}/unbounded (absolute cap 8))`,
  outcome: "Revise the step list.\nWorkflow revision key: plan-review",
  timestamp: "2026-09-21T00:02:00.000Z",
});

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-2511",
    description: "Bound the plan-replan loop against planner-session failures",
    column: "triage",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function createPersistedStore(initialTask: Task, settings: Partial<Settings> = {}): {
  store: TaskStore;
  task: () => Task;
  logs: string[];
  entries: Array<{ action: string; outcome?: string }>;
  audits: Array<{ mutationType: string; metadata: Record<string, unknown> }>;
  moveTask: ReturnType<typeof vi.fn>;
} {
  let persisted = initialTask;
  const logs: string[] = [];
  const entries: Array<{ action: string; outcome?: string }> = [];
  const audits: Array<{ mutationType: string; metadata: Record<string, unknown> }> = [];
  const update = async (_id: string, patch: Partial<Task>) => {
    persisted = { ...persisted, ...patch };
    return persisted;
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
    updateTask: vi.fn(update),
    updateTaskUnlocked: vi.fn(update),
    updateTaskAtomic: vi.fn(async (...args: unknown[]) => {
      const [id, patcher] = args as [string, (live: Task) => Partial<Task> | null];
      const patch = patcher(persisted);
      if (patch) await update(id, patch);
      return persisted;
    }),
    withPlanningLifecycleLock: vi.fn(async (_id: string, operation: () => Promise<unknown>) => operation()),
    withTaskLock: vi.fn(async (_id: string, operation: () => Promise<unknown>) => operation()),
    readTaskForMove: vi.fn(async () => persisted),
    lockCurrentPlanWhilePlanningLocked: vi.fn(async () => undefined),
    reconcileSpecDriftWhilePlanningLocked: vi.fn(async () => undefined),
    captureCurrentPlanEvidenceWhilePlanningLocked: vi.fn(async () => undefined),
    /*
    FNXC:PlanReplanSessionBudget 2026-09-21-12:19 (RUFU-251):
    The ledger has to ADVANCE between sessions, or a loop test cannot exist. The real store persists
    `logEntry` onto the task's append-only log, and `countOptionalStepRevisionAttempts` counts the
    revision-keyed attempt markers back out of that log, so a fixture that drops them leaves the
    charge arithmetic frozen at its seeded value. Multi-session drives need real ledger fidelity.
    */
    logEntry: vi.fn(async (_id: string, action: string, outcome?: string) => {
      logs.push(action);
      entries.push({ action, outcome });
      persisted = {
        ...persisted,
        log: [...(persisted.log ?? []), { action, outcome, timestamp: new Date().toISOString() } as TaskLogEntry],
      };
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
  return {
    store,
    task: () => persisted,
    logs,
    entries,
    audits,
    moveTask: store.moveTask as unknown as ReturnType<typeof vi.fn>,
    moveTaskInternal: store.moveTaskInternal as unknown as ReturnType<typeof vi.fn>,
  };
}

/*
FNXC:PlanReplanSessionBudget 2026-09-21-12:19 (RUFU-251):
Drives the real loop shape — one `specifyTask` call per planner session, over the SAME persisted
row, with the spec left unchanged-and-invalid (RUFU-224's shape: the planner session dies instead
of revising). Nothing here accelerates the clock or pre-seeds the answer: each session reads the
ledger the previous session wrote, which is exactly what RUFU-224's 61 dispatches never did.
*/
async function drivePlannerSessions(triage: TriageProcessor, fixture: ReturnType<typeof createPersistedStore>, sessions: number): Promise<void> {
  for (let session = 0; session < sessions; session += 1) {
    await triage.specifyTask(fixture.task());
  }
}

const chargedTurnNumbers = (entries: Array<{ action: string; outcome?: string }>) =>
  chargedMarkers(entries).map((entry) => entry.action.match(/attempt (\d+)\//)?.[1]);

const budgetEvents = (audits: Array<{ mutationType: string; metadata: Record<string, unknown> }>) =>
  audits.filter((event) => event.mutationType === "task:plan-replan-session-failure-budget");

const chargedMarkers = (entries: Array<{ action: string; outcome?: string }>) =>
  entries.filter((entry) =>
    /attempt \d+\//.test(entry.action) && (entry.outcome ?? "").includes("Workflow revision key: plan-review"),
  );

describe("triage planner-session failures inside a Plan Review REVISE episode (RUFU-251)", () => {
  let root: string;
  let promptPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fusion-plan-review-session-budget-"));
    promptPath = join(root, ".fusion", "tasks", "FN-2511", "PROMPT.md");
    await mkdir(join(root, ".fusion", "tasks", "FN-2511"), { recursive: true });
    mockCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn(),
        dispose: vi.fn(),
        sessionManager: { getLeafId: vi.fn(() => null), navigateTree: vi.fn() },
      },
    });
    // The planner session ends without touching the authoritative artifact.
    mockPromptWithFallback.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    mockCreateFnAgent.mockReset();
    mockPromptWithFallback.mockReset();
    await rm(root, { recursive: true, force: true });
  });

  /*
  FNXC:PlannerNoopRelease 2026-11-11-22:54 (RUFU-527 — the case this file used to expect to fail):
  Before RUFU-527 this was the wedge: a complete, valid spec with an empty `workflowStepResults` was
  reported as a failed planner session and burned a recovery unit, forever, because the release
  predicate demanded a `REVISE` projection that this card never had. The card's own merits are now the
  release condition, so the case keeps its RUFU-251 assertion (the Plan Review session-failure budget
  is never charged outside a live REVISE episode) and gains the release assertions. The withhold half
  of the same shape lives in `triage-planner-noop-release.test.ts`.
  */
  it("releases a complete unchanged spec with no Plan Review REVISE request live, and charges nothing", async () => {
    await writeFile(promptPath, VALID_SPEC, "utf8");
    const fixture = createPersistedStore(createTask());

    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());

    expect(fixture.logs.join("\n")).not.toContain("Planner did not update the authoritative PROMPT.md");
    expect(fixture.task().recoveryRetryCount ?? null).toBeNull();
    expect(chargedMarkers(fixture.entries)).toHaveLength(0);
    expect(budgetEvents(fixture.audits)).toHaveLength(0);
  });

  it("charges the Plan Review replan budget for a session that rewrote the spec into invalid structure", async () => {
    await writeFile(promptPath, VALID_SPEC, "utf8");
    const fixture = createPersistedStore(
      createTask({ workflowStepResults: [planReviewReviseRow({ planReviewAttemptCount: 2 })] }),
    );
    mockPromptWithFallback.mockImplementation(async () => {
      await writeFile(promptPath, INVALID_SPEC, "utf8");
    });

    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());

    const markers = chargedMarkers(fixture.entries);
    expect(markers).toHaveLength(1);
    expect(markers[0]?.action).toContain("attempt 2/8");
    expect(fixture.logs.join("\n")).toContain("Generated plan failed deterministic validation");
    expect(fixture.task().status).not.toBe("failed");
    expect(budgetEvents(fixture.audits).map((event) => event.metadata.outcome)).toEqual(["consumed"]);
  });

  it("charges an unchanged spec that fails deterministic validation instead of recycling it", async () => {
    await writeFile(promptPath, INVALID_SPEC, "utf8");
    const fixture = createPersistedStore(
      createTask({ workflowStepResults: [planReviewReviseRow({ planReviewAttemptCount: 1 })] }),
    );

    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());

    const markers = chargedMarkers(fixture.entries);
    expect(markers).toHaveLength(1);
    expect(markers[0]?.action).toContain("attempt 1/8");
    expect(budgetEvents(fixture.audits).map((event) => event.metadata.outcome)).toEqual(["consumed"]);
    expect(fixture.logs.join("\n")).not.toContain("found nothing to change");
  });

  it("releases an unchanged but valid spec back to the gate instead of treating it as a session failure", async () => {
    await writeFile(promptPath, VALID_SPEC, "utf8");
    const fixture = createPersistedStore(
      createTask({ workflowStepResults: [planReviewReviseRow({ planReviewAttemptCount: 2 })] }),
    );

    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());

    const recycled = budgetEvents(fixture.audits);
    expect(recycled.map((event) => event.metadata.outcome)).toEqual(["spec-complete-recycled"]);
    expect(fixture.logs.join("\n")).toContain("found nothing to change");
    expect(fixture.logs.join("\n")).not.toContain("Planner did not update the authoritative PROMPT.md");
    // Releasing the spec must not spend a replan turn: the gate re-decides with a real verdict.
    expect(chargedMarkers(fixture.entries)).toHaveLength(0);
    expect(fixture.task().status).not.toBe("failed");
  });

  it("parks through the plan-review-replan-cap operator surface once the shared ceiling is spent", async () => {
    await writeFile(promptPath, INVALID_SPEC, "utf8");
    const fixture = createPersistedStore(
      createTask({
        status: "needs-replan",
        workflowStepResults: [planReviewReviseRow({ planReviewAttemptCount: 9 })],
        log: Array.from({ length: 8 }, (_unused, index) => graphAttemptMarker(index + 1)),
      }),
    );

    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());

    expect(fixture.task().status).toBe("awaiting-approval");
    // `awaitingApprovalReason` is written through a loose record by the park seam, not typed on Task.
    expect((fixture.task() as unknown as Record<string, unknown>).awaitingApprovalReason).toBe("plan-review-replan-cap");
    expect(fixture.task().error).toBeNull();
    expect(fixture.logs.join("\n")).toContain("Plan Review replan cap reached");
    // The exhausted turn is never granted, so no further marker is appended to the ledger.
    expect(chargedMarkers(fixture.entries)).toHaveLength(0);
    expect(budgetEvents(fixture.audits).map((event) => event.metadata.outcome)).toEqual(["exhausted"]);
  });

  /*
  FNXC:PlanReplanSessionBudget 2026-09-21-12:19 (RUFU-251 — the loop-shape regression the acceptance
  names): every earlier guard in this file is a single-session assertion over a pre-seeded ledger, so
  none of them could fail the way RUFU-224 failed. These cases drive the loop repeatedly and assert
  where it stops, that the stop sticks on the NEXT pass, and that stopping is an in-place park that
  the admission seam then refuses to re-plan.
  */
  it("charges every dead planner session and parks the card on the turn past the shared ceiling", async () => {
    await writeFile(promptPath, INVALID_SPEC, "utf8");
    const fixture = createPersistedStore(
      createTask({
        status: "needs-replan",
        workflowStepResults: [planReviewReviseRow({ planReviewAttemptCount: 7 })],
        log: Array.from({ length: 6 }, (_unused, index) => graphAttemptMarker(index + 1)),
      }),
    );
    const triage = new TriageProcessor(fixture.store, root);

    // Six of eight turns are gone; the next two dead sessions consume the rest, one marker each.
    await drivePlannerSessions(triage, fixture, 2);
    expect(chargedTurnNumbers(fixture.entries)).toEqual(["7", "8"]);
    expect(fixture.task().status).toBe("needs-replan");
    expect(fixture.task().column).toBe("triage");

    // Session three would be turn 9: the card parks instead of rebounding into planning again.
    await triage.specifyTask(fixture.task());

    expect(fixture.task().status).toBe("awaiting-approval");
    expect((fixture.task() as unknown as Record<string, unknown>).awaitingApprovalReason).toBe("plan-review-replan-cap");
    expect(fixture.task().error).toBeNull();
    // The exhausted turn is never granted, so the ledger stops at the cap.
    expect(chargedTurnNumbers(fixture.entries)).toEqual(["7", "8"]);
    expect(budgetEvents(fixture.audits).map((event) => event.metadata.outcome)).toEqual([
      "consumed",
      "consumed",
      "exhausted",
    ]);
  });

  it("leaves the parked card parked on the next pass through the planner instead of re-planning it", async () => {
    await writeFile(promptPath, INVALID_SPEC, "utf8");
    const fixture = createPersistedStore(
      createTask({
        status: "needs-replan",
        workflowStepResults: [planReviewReviseRow({ planReviewAttemptCount: 7 })],
        log: Array.from({ length: 6 }, (_unused, index) => graphAttemptMarker(index + 1)),
      }),
    );
    const triage = new TriageProcessor(fixture.store, root);
    await drivePlannerSessions(triage, fixture, 3);
    expect(fixture.task().status).toBe("awaiting-approval");

    // N+1: the same card reaches the failure branch again. It must not be re-planned, must not
    // regain a retry counter, and must not spend another ledger turn.
    await triage.specifyTask(fixture.task());

    expect(fixture.task().status).toBe("awaiting-approval");
    expect((fixture.task() as unknown as Record<string, unknown>).awaitingApprovalReason).toBe("plan-review-replan-cap");
    expect(fixture.task().recoveryRetryCount ?? null).toBeNull();
    expect(chargedTurnNumbers(fixture.entries)).toEqual(["7", "8"]);
  });

  it("parks in place: no column move, for a card whose project auto-merge is off", async () => {
    await writeFile(promptPath, INVALID_SPEC, "utf8");
    const fixture = createPersistedStore(
      createTask({
        status: "needs-replan",
        workflowStepResults: [planReviewReviseRow({ planReviewAttemptCount: 7 })],
        log: Array.from({ length: 6 }, (_unused, index) => graphAttemptMarker(index + 1)),
      }),
      { autoMerge: false },
    );

    await drivePlannerSessions(new TriageProcessor(fixture.store, root), fixture, 3);

    expect(fixture.task().status).toBe("awaiting-approval");
    // Lifecycle containment: the park is an in-place status write, never a move — not to intake,
    // not backward out of a terminal lane, and not a `done`-lane eviction.
    expect(fixture.task().column).toBe("triage");
    expect(fixture.moveTask).not.toHaveBeenCalled();
    expect(fixture.moveTaskInternal).not.toHaveBeenCalled();
    expect((fixture.task().workflowStepResults ?? [])[0]?.verdict).toBe("REVISE");
  });

  it("does not plan or park a user-paused card at all: planning discovery excludes it", async () => {
    await writeFile(promptPath, INVALID_SPEC, "utf8");
    const base = {
      status: "needs-replan" as const,
      workflowStepResults: [planReviewReviseRow({ planReviewAttemptCount: 7 })],
      log: Array.from({ length: 6 }, (_unused, index) => graphAttemptMarker(index + 1)),
    };
    // The planning lane for the default workflow is the merged intake+hold column; discovery admits
    // a `needs-replan` card there unconditionally, so the control proves the seam is live.
    const eligible = createPersistedStore(createTask({ ...base, column: "todo" }));
    const triage = new TriageProcessor(eligible.store, root);
    const discover = (task: Task) => (triage as unknown as {
      discoverReadyPlanningTasks(tasks: Task[], now: number): Promise<Task[]>;
    }).discoverReadyPlanningTasks([task], Date.now());

    await expect(discover(eligible.task())).resolves.toContainEqual(
      expect.objectContaining({ id: "FN-2511" }),
    );

    // A paused card's lifecycle state is nobody else's to mutate: not planned, not park-moved.
    const paused = createPersistedStore(createTask({ ...base, column: "todo", paused: true, userPaused: true }));
    await expect(discover(paused.task())).resolves.toEqual([]);

    // And the park itself is sticky through the same admission seam — an awaiting-approval card is
    // never handed a planner again, which is what makes the park terminal rather than a pause.
    const parkedTask = createTask({ ...base, column: "todo", status: "awaiting-approval" });
    (parkedTask as unknown as Record<string, unknown>).awaitingApprovalReason = "plan-review-replan-cap";
    const parked = createPersistedStore(parkedTask);
    await expect(discover(parked.task())).resolves.toEqual([]);
  });

  /*
  FNXC:PlannerNoopRelease 2026-11-11-22:54 (RUFU-527): an APPROVE satisfies the gate, so RUFU-251's
  two budget branches stay out exactly as before — but the release no longer needs either of them.
  A superseded or approving projection is simply "no live REVISE episode", which is the same row shape
  as the empty case above, so the unchanged-and-complete spec releases on its merits. That is the
  monotone half of this change: a card that used to fail here now moves.
  */
  it("releases RUFU-244's approved-plan variant on its merits (no recycle, no charge)", async () => {
    await writeFile(promptPath, VALID_SPEC, "utf8");
    const fixture = createPersistedStore(
      createTask({
        workflowStepResults: [planReviewReviseRow({
          verdict: "APPROVE",
          status: "passed",
          planReviewAttemptCount: undefined,
        })],
      }),
    );

    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());

    // An APPROVE satisfies the gate, so neither budget branch may fire: the release is proved by the
    // artifact alone and writes no ledger row of either kind.
    expect(fixture.logs.join("\n")).not.toContain("Planner did not update the authoritative PROMPT.md");
    expect(fixture.logs.join("\n")).not.toContain("Plan Review revision request found nothing to change");
    expect(chargedMarkers(fixture.entries)).toHaveLength(0);
    expect(budgetEvents(fixture.audits)).toHaveLength(0);
    expect(fixture.task().status).not.toBe("awaiting-approval");
    expect(fixture.task().recoveryRetryCount ?? null).toBeNull();
  });

  /*
  FNXC:PlanReplanSessionBudget 2026-09-21-12:19 (RUFU-251 acceptance — the control for the other half
  of the contract): the bound this change leans on must still terminate a no-REVISE planning failure.
  The drive spends the filesystem-twin budget in real sequence; the only liberty taken is moving the
  stored backoff timestamp into the past between sessions, which stands in for the operator's clock
  waiting it out — the engine's own retry arithmetic and its 3-retry ceiling are untouched.
  */
  /*
  FNXC:PlanningReseedCycleBudget 2026-10-22-11:08 (RUFU-768 — the contract this fixture must state):
  Cadence exhaustion no longer ends the card: it GRANTS a re-seed cycle, and only the card-level cycle
  ceiling parks it. The three cadence turns below are unchanged, so the terminal pass is reached with
  the cycle counter stamped at its ceiling — the state three earlier granted cycles leave behind —
  instead of driving twelve more planner sessions to arrive at the same row.
  */
  it("still terminates a no-REVISE planning failure through the filesystem recovery budget", async () => {
    await writeFile(promptPath, INVALID_SPEC, "utf8");
    const fixture = createPersistedStore(createTask({ status: "needs-replan" }));
    const triage = new TriageProcessor(fixture.store, root);

    for (let session = 1; session <= 4; session += 1) {
      // Let the previous session's backoff elapse so the next pass is a real recovery turn.
      await fixture.store.updateTask("FN-2511", { nextRecoveryAt: new Date(Date.now() - 1_000).toISOString() });
      if (session === 4) {
        // The fixture store patches fields literally, so the episode marker is written in its own
        // container rather than through the production key-level `sourceMetadataPatch` seam.
        await fixture.store.updateTask("FN-2511", {
          sourceMetadata: {
            ...(fixture.task().sourceMetadata ?? {}),
            [PLANNING_RESEED_CYCLE_METADATA_KEY]: PLANNING_RESEED_CYCLE_LIMIT,
          },
        } as Partial<Task>);
      }
      await triage.specifyTask(fixture.task());
      if (session < 4) {
        expect(fixture.task().status).toBe("needs-replan");
        expect(fixture.task().recoveryRetryCount).toBe(session);
      }
    }

    expect(fixture.task().status).toBe("failed");
    expect(fixture.task().error).toContain(PLANNING_RESEED_CYCLE_EXHAUSTED_PREFIX);
    /*
    FNXC:PlanningBudgetAttribution 2026-11-11-22:54 (RUFU-527): the exhausted-cadence sentence names
    the shape of the verdict, so the card must also carry the accounting truth beside it — this pass
    spent no new unit (the shared counter was already at its ceiling) and the ceiling that ended the
    card is the reseed ceiling, not that cadence.
    */
    expect(fixture.logs.join("\n")).toContain("this pass consumed no new unit of it");
    expect(fixture.logs.join("\n")).toContain("planning reseed ceiling");
    // The sentinel the sentence is built from stays intact — attribution is additive, never a rewrite.
    expect(fixture.logs.join("\n")).toContain("Planner did not update the authoritative PROMPT.md");
    // The Plan Review budget never entered: no live REVISE request existed to charge.
    expect(chargedMarkers(fixture.entries)).toHaveLength(0);
    expect(budgetEvents(fixture.audits)).toHaveLength(0);
    expect((fixture.task() as unknown as Record<string, unknown>).awaitingApprovalReason).toBeUndefined();
  });

  /*
  FNXC:PlanningBudgetAttribution 2026-11-11-22:54 (RUFU-527): the attribution must never appear for a
  pass that is escalating with a still-fresh counter — that pass DID spend its own unit, and telling
  an operator otherwise would send them to the wrong ledger.
  */
  it("withholds the attribution while the shared counter still has units of its own", () => {
    expect(describeExhaustedPlanningBudgetAttribution(
      { recoveryRetryCount: 1 },
      { retryCadence: 3, reseedCycleLimit: PLANNING_RESEED_CYCLE_LIMIT, reseedCyclesGranted: 0 },
    )).toBeNull();
    expect(describeExhaustedPlanningBudgetAttribution(
      { recoveryRetryCount: null },
      { retryCadence: 3, reseedCycleLimit: PLANNING_RESEED_CYCLE_LIMIT, reseedCyclesGranted: 0 },
    )).toBeNull();
  });

  it("leaves a non-REVISE card whose rewritten spec is invalid on the filesystem recovery budget", async () => {
    await writeFile(promptPath, VALID_SPEC, "utf8");
    const fixture = createPersistedStore(createTask());
    mockPromptWithFallback.mockImplementation(async () => {
      await writeFile(promptPath, INVALID_SPEC, "utf8");
    });

    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());

    expect(fixture.logs.join("\n")).toContain("Generated plan failed deterministic validation");
    expect(fixture.task().recoveryRetryCount).toBe(1);
    expect(chargedMarkers(fixture.entries)).toHaveLength(0);
    expect(budgetEvents(fixture.audits)).toHaveLength(0);
  });
});
