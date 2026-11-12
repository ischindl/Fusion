/**
 * FNXC:PlannerNoopRelease 2026-11-11-22:54 (RUFU-527):
 * Board-behavior proof for the release predicate that decides what happens when a planner session
 * finishes without touching PROMPT.md. RUFU-251 (see
 * `triage-plan-review-session-failure-loop.test.ts`) bounded the case where a Plan Review `REVISE`
 * request is live; this file owns the shape that change left open, measured on RUFU-519 and
 * RUFU-479: a card whose spec was authored but whose `workflowStepResults` is still empty has no
 * live `REVISE` projection at all, so a predicate that REQUIRES one can never be satisfied even
 * when the spec is complete and deterministically valid. The planner then correctly reports it found
 * nothing to change, that correct no-op is charged as a failed planner dispatch, and the card burns
 * the filesystem-twin recovery budget until it is parked `failed` — RUFU-519 took 10 planner
 * dispatches over ~6.5 hours to arrive at that verdict about a spec that was already finished.
 *
 * The invariant asserted here is two-sided, and both halves are required:
 * - an unchanged spec that is complete and valid ON ITS OWN MERITS releases through
 *   `finalizeApprovedTask` whether or not a `REVISE` projection exists;
 * - an unchanged spec that is NOT valid on its own merits (empty, engine seed, `DUPLICATE:`-only,
 *   deterministically invalid, dangling-reference) is still withheld and still burns exactly one
 *   recovery unit, so widening the release door did not weaken it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskLogEntry, TaskStore } from "@fusion/core";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { mockCreateFnAgent, mockPromptWithFallback, sessionVeto } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn(),
  /*
  FNXC:PlannerNoopRelease 2026-11-11-22:54 (RUFU-527): the two dispatch-shape vetoes live in the
  runtime boundary triage cannot fabricate — whether the runtime reported a fallback and whether it
  handed back a settlement boundary. This harness toggles ONLY those two signals and delegates every
  other part of the session to the real helper, so the veto rows are driven without mocking the world.
  */
  sessionVeto: { engageFallback: false, settleBoundary: null as null | boolean },
}));

vi.mock("../agents/agent-session-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/agent-session-helpers.js")>();
  return {
    ...actual,
    createResolvedAgentSession: vi.fn(async (options: { onFallbackModelUsed?: (payload: unknown) => Promise<void> }) => {
      if (sessionVeto.engageFallback) {
        await options.onFallbackModelUsed?.({
          primaryModel: "openai/gpt-4o",
          fallbackModel: "anthropic/claude-haiku",
          triggerPoint: "prompt-time",
        });
      }
      const real = await actual.createResolvedAgentSession(options as never);
      if (sessionVeto.settleBoundary === null) return real;
      return {
        ...real,
        settleFallbackDispatch: sessionVeto.settleBoundary ? async () => {} : undefined,
      };
    }),
  };
});

vi.mock("../pi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pi.js")>();
  return {
    ...actual,
    createFnAgent: mockCreateFnAgent,
    promptWithFallback: mockPromptWithFallback,
  };
});

import { PLANNER_NOOP_RELEASE_NO_PROJECTION_LOG, TriageProcessor } from "../triage.js";
import { PLAN_REVIEW_REVISION_KEY } from "../executor/plan-review-session-failure-budget.js";
import {
  buildBootstrapPrompt,
  buildRefinementSeedPrompt,
} from "@fusion/core";

const TASK_ID = "FN-5271";
const TASK_TITLE = "Release a planner no-op on the merits of its own spec";
const TASK_DESCRIPTION = "Stop charging a correct planner no-op as a session failure.";

const VALID_SPEC = "# Plan\n\n## What This Delivers\n\nShip the bound.\n";
/*
FNXC:StepDependencyValidation 2026-10-01-22:44 (shared with triage-planning-retry-hold.test.ts):
A heading LABEL is display-only, so a mis-numbered `### Step 1:` is prose and parses fine. The
deterministic damage has to be an impossible PARSED position: this `(depends: 2)` token names a step
the document does not have, which `parseStepHeadings` refuses without any reviewer judgement.
*/
const INVALID_SPEC = "# Plan\n\n### Step 24 (depends: 2): Uses an absent prerequisite\n\nShip the bound.\n";
/*
FNXC:PlannerNoopRelease 2026-11-11-22:54 (RUFU-527): the second veto family the widened door must keep
out — content that is non-empty but whose deterministic message is not null. A dangling-reference
reference is the shape a hand-authored or drifted spec actually has.
*/
const DANGLING_REFERENCE_SPEC = "# Plan\n\n## What This Delivers\n\nShip the bound.\n\n### Step 1 (depends: 7): Uses an absent prerequisite\n";

const planReviewRow = (overrides: Record<string, unknown> = {}) => ({
  workflowStepId: PLAN_REVIEW_REVISION_KEY,
  workflowStepName: "Plan Review",
  status: "failed",
  verdict: "REVISE",
  startedAt: "2026-11-11T00:00:00.000Z",
  completedAt: "2026-11-11T00:01:00.000Z",
  ...overrides,
}) as unknown as Task["workflowStepResults"][number];

/** Graph-side revision markers, so a budget fixture can state how many turns are already spent. */
const graphAttemptMarkers = (count: number) =>
  Array.from({ length: count }, (_unused, index) => ({
    action: `Plan Review requested a plan revision — task stays in 'triage' (attempt ${index + 1}/unbounded (absolute cap 8))`,
    outcome: `Revise the step list.\nWorkflow revision key: ${PLAN_REVIEW_REVISION_KEY}`,
    timestamp: "2026-11-11T00:02:00.000Z",
  }));

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: TASK_TITLE,
    description: TASK_DESCRIPTION,
    column: "triage",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
    ...overrides,
  } as Task;
}

/**
 * The same ledger-faithful fixture the RUFU-251 loop file uses, plus `moveTaskIf`: the release IS a
 * handoff through `finalizeApprovedTask`, and that body refuses to attempt the move when the store
 * does not expose the guard, reporting `withheld` instead. A fixture without it cannot tell
 * "released" apart from "spec finished but stuck in the planner lane".
 */
function createPersistedStore(initialTask: Task, settings: Partial<Settings> = {}): {
  store: TaskStore;
  task: () => Task;
  logs: string[];
  entries: Array<{ action: string; outcome?: string }>;
  audits: Array<{ mutationType: string; metadata: Record<string, unknown> }>;
  moveTaskIf: ReturnType<typeof vi.fn>;
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
    // The guarded release move: the planning-stage predicate is re-derived on the live row.
    moveTaskIf: vi.fn(async (_id: string, column: string, guard: (live: Task) => boolean) => {
      if (!guard(persisted)) return { moved: false, task: persisted };
      persisted = { ...persisted, column };
      return { moved: true, task: persisted };
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
    moveTaskIf: store.moveTaskIf as unknown as ReturnType<typeof vi.fn>,
    moveTask: store.moveTask as unknown as ReturnType<typeof vi.fn>,
  };
}

const UNCHANGED_SPEC_FAILURE = "Planner did not update the authoritative PROMPT.md";
const budgetEvents = (audits: Array<{ mutationType: string; metadata: Record<string, unknown> }>) =>
  audits.filter((event) => event.mutationType === "task:plan-replan-session-failure-budget");

let root: string;
let promptPath: string;

/** One planner session that writes nothing: exactly the shape RUFU-519 recorded ten times. */
async function runNoopPlannerSession(fixture: ReturnType<typeof createPersistedStore>): Promise<void> {
  await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());
}

beforeEach(async () => {
  sessionVeto.engageFallback = false;
  sessionVeto.settleBoundary = null;
  root = await mkdtemp(join(tmpdir(), "fusion-planner-noop-release-"));
  promptPath = join(root, ".fusion", "tasks", TASK_ID, "PROMPT.md");
  await mkdir(join(root, ".fusion", "tasks", TASK_ID), { recursive: true });
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
  sessionVeto.engageFallback = false;
  sessionVeto.settleBoundary = null;
  await rm(root, { recursive: true, force: true });
});

describe("triage planner no-op release on the merits of the spec itself (RUFU-527)", () => {
  it("releases a complete unchanged spec that has no Plan Review projection at all", async () => {
    await writeFile(promptPath, VALID_SPEC, "utf8");
    // RUFU-519's exact row shape: spec authored and valid, `workflowStepResults` still empty.
    const fixture = createPersistedStore(createTask({ workflowStepResults: [] }));

    await runNoopPlannerSession(fixture);

    // The wedge: this sentence is what turned a correct no-op into a burned planning attempt.
    expect(fixture.logs.join("\n")).not.toContain(UNCHANGED_SPEC_FAILURE);
    // Releasing on the merits consumes no retry unit and leaves no replan hold behind.
    expect(fixture.task().recoveryRetryCount ?? null).toBeNull();
    expect(fixture.task().status).not.toBe("needs-replan");
    expect(fixture.task().status).not.toBe("failed");
    // A no-op against a complete spec never touches the Plan Review session-failure budget.
    expect(budgetEvents(fixture.audits)).toHaveLength(0);
    // And the release is the real handoff, taken through finalizeApprovedTask's guarded move.
    expect(fixture.moveTaskIf).toHaveBeenCalledTimes(1);
    // The card explains its own release, through the SAME constant the source writes, so a missing
    // release notice cannot be hidden by an edited copy in this file.
    expect(fixture.logs.join("\n")).toContain(PLANNER_NOOP_RELEASE_NO_PROJECTION_LOG);
  });

  /*
  FNXC:PlannerNoopRelease 2026-11-11-22:54 (RUFU-527): the projection half of the invariant, asserted
  per STATE rather than per reported card. The release door reads the artifact, so none of these four
  review shapes may change the verdict, and the shapes are exactly the census the fix had to enumerate:
  the field absent (a row written before any step ever ran), the empty array RUFU-519 carried, a single
  approving row, and a `REVISE` the later `APPROVE` superseded. The live-`REVISE` shape of the same
  artifact is NOT in this table: it is the fifth state, it releases too, and it is pinned separately
  below with its recycled-audit outcome, because there the ledger does change what is written.
  */
  it.each([
    ["no workflowStepResults field at all", undefined],
    ["an empty workflowStepResults array", []],
    ["a single approving row", [planReviewRow({ status: "passed", verdict: "APPROVE" })]],
    [
      "a REVISE row superseded by a later APPROVE",
      [
        planReviewRow({ completedAt: "2026-11-11T00:01:00.000Z" }),
        planReviewRow({ status: "passed", verdict: "APPROVE", startedAt: "2026-11-11T00:05:00.000Z", completedAt: "2026-11-11T00:06:00.000Z" }),
      ],
    ],
  ] as const)("releases a complete unchanged spec over %s", async (_label, workflowStepResults) => {
    await writeFile(promptPath, VALID_SPEC, "utf8");
    const fixture = createPersistedStore(createTask({ workflowStepResults }));

    await runNoopPlannerSession(fixture);

    expect(fixture.logs.join("\n")).not.toContain(UNCHANGED_SPEC_FAILURE);
    expect(fixture.task().recoveryRetryCount ?? null).toBeNull();
    expect(fixture.task().status).not.toBe("needs-replan");
    expect(fixture.task().status).not.toBe("failed");
    // None of these shapes is a live revision episode, so the Plan Review ledger stays untouched.
    expect(budgetEvents(fixture.audits)).toHaveLength(0);
    expect(fixture.logs.join("\n")).toContain(PLANNER_NOOP_RELEASE_NO_PROJECTION_LOG);
    expect(fixture.moveTaskIf).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:PlannerNoopRelease 2026-11-11-22:54 (RUFU-527): a release must not manufacture a state the
  admission door then refuses. Project `autoMerge: false` is that door's own hold: the release still
  happens on the artifact's merits, but triage may not push the card forward on the assumption that an
  automatic merge will follow, and it must leave no `needs-replan` behind — that status is exactly what
  `AWAITING_PLANNING_STATUSES` re-admits to the planner, so a release that wrote it would recreate the
  loop the fix removes.
  */
  it("releases a human-merge card without leaving a replan hold or a burned unit behind", async () => {
    await writeFile(promptPath, VALID_SPEC, "utf8");
    const fixture = createPersistedStore(createTask({ workflowStepResults: [] }), { autoMerge: false });

    await runNoopPlannerSession(fixture);

    expect(fixture.logs.join("\n")).not.toContain(UNCHANGED_SPEC_FAILURE);
    expect(fixture.task().recoveryRetryCount ?? null).toBeNull();
    expect(fixture.task().status).not.toBe("needs-replan");
    expect(fixture.task().status).not.toBe("failed");
    expect(budgetEvents(fixture.audits)).toHaveLength(0);
    expect(fixture.logs.join("\n")).toContain(PLANNER_NOOP_RELEASE_NO_PROJECTION_LOG);
    // Whatever lane the handoff chose, it is a handoff and not an error: the card was never parked.
    expect(fixture.moveTaskIf).toHaveBeenCalledTimes(1);
    expect(fixture.task().column).not.toBe("triage");
    expect(fixture.task().error ?? null).toBeNull();
  });

  it("still withholds an unchanged spec that fails deterministic validation", async () => {
    await writeFile(promptPath, INVALID_SPEC, "utf8");
    const fixture = createPersistedStore(createTask({ workflowStepResults: [] }));

    await runNoopPlannerSession(fixture);

    expect(fixture.logs.join("\n")).toContain(UNCHANGED_SPEC_FAILURE);
    expect(fixture.task().recoveryRetryCount).toBe(1);
    expect(budgetEvents(fixture.audits)).toHaveLength(0);
    expect(fixture.moveTaskIf).not.toHaveBeenCalled();
  });

  it("still withholds an empty PROMPT.md instead of releasing it", async () => {
    await writeFile(promptPath, "   \n  ", "utf8");
    const fixture = createPersistedStore(createTask({ workflowStepResults: [] }));

    await runNoopPlannerSession(fixture);

    expect(fixture.logs.join("\n")).toContain(UNCHANGED_SPEC_FAILURE);
    expect(fixture.task().recoveryRetryCount).toBe(1);
    expect(budgetEvents(fixture.audits)).toHaveLength(0);
    expect(fixture.moveTaskIf).not.toHaveBeenCalled();
  });

  it("still withholds a PROMPT.md that does not exist at all", async () => {
    // No artifact is written: the planner session is asked to author the spec and returns empty.
    const fixture = createPersistedStore(createTask({ workflowStepResults: [] }));

    await runNoopPlannerSession(fixture);

    expect(fixture.task().column).toBe("triage");
    expect(fixture.moveTaskIf).not.toHaveBeenCalled();
    expect(fixture.task().recoveryRetryCount).toBe(1);
  });

  it("still withholds an unchanged spec whose deterministic message is non-empty", async () => {
    await writeFile(promptPath, DANGLING_REFERENCE_SPEC, "utf8");
    const fixture = createPersistedStore(createTask({ workflowStepResults: [] }));

    await runNoopPlannerSession(fixture);

    // The validator's own sentence, not the unchanged-artifact one, is what withholds this card.
    expect(fixture.logs.join("\n")).toContain("validation");
    expect(fixture.task().recoveryRetryCount).toBe(1);
    expect(budgetEvents(fixture.audits)).toHaveLength(0);
    expect(fixture.moveTaskIf).not.toHaveBeenCalled();
  });

  /*
  FNXC:PlannerNoopRelease 2026-11-11-22:54 (RUFU-527): the engine's own seed content and a
  `DUPLICATE:` redirect are the two artifacts triage wrote itself, so they can never satisfy a release
  predicate — releasing a seed prompt would credit an unplanned card with a finished plan, and releasing
  a redirect would close the admission door that `hold-release` and the board badge both enforce. What
  these cards must NOT collect is a Plan Review session-failure charge (they are not in a revision
  episode) and a release; they keep the ordinary bounded planning rebound.
  */
  it.each([
    ["the bootstrap seed prompt", (taskId: string, title: string, description: string) => buildBootstrapPrompt(taskId, title, description)],
    ["the refinement seed prompt", (_taskId: string, title: string, description: string) => buildRefinementSeedPrompt(title, description)],
    ["a DUPLICATE-only redirect", () => "DUPLICATE: FN-9999\n"],
  ] as const)("releases nothing and charges no Plan Review turn for %s", async (_label, build) => {
    await writeFile(promptPath, build(TASK_ID, TASK_TITLE, TASK_DESCRIPTION), "utf8");
    const fixture = createPersistedStore(createTask({ workflowStepResults: [] }));

    await runNoopPlannerSession(fixture);

    expect(fixture.moveTaskIf).not.toHaveBeenCalled();
    expect(fixture.task().column).toBe("triage");
    expect(budgetEvents(fixture.audits)).toHaveLength(0);
    // The rebound is the withhold: a planning unit is spent, the card stays in the planner lane.
    expect(fixture.task().recoveryRetryCount).toBe(1);
  });

  it("recycles a valid unchanged spec inside a live REVISE episode with its audit outcome and no charge", async () => {
    await writeFile(promptPath, VALID_SPEC, "utf8");
    const fixture = createPersistedStore(
      createTask({ workflowStepResults: [planReviewRow({ planReviewAttemptCount: 2 })] }),
    );

    await runNoopPlannerSession(fixture);

    // The episode path is untouched by the widening: same release, same recycled label, same audit.
    expect(fixture.logs.join("\n")).toContain("Plan Review revision request found nothing to change");
    expect(budgetEvents(fixture.audits).map((event) => event.metadata.outcome)).toEqual(["spec-complete-recycled"]);
    expect(fixture.task().recoveryRetryCount ?? null).toBeNull();
    expect(fixture.moveTaskIf).toHaveBeenCalledTimes(1);
  });

  it("keeps a fallback-engaged session out of the release door even over a complete spec", async () => {
    await writeFile(promptPath, VALID_SPEC, "utf8");
    const fixture = createPersistedStore(createTask({ workflowStepResults: [] }));
    sessionVeto.engageFallback = true;

    await runNoopPlannerSession(fixture);

    // A fallback that was engaged at all is a session failure whatever the artifact looks like, so
    // the perfect spec on disk must not be released through it.
    expect(fixture.moveTaskIf).not.toHaveBeenCalled();
    expect(fixture.logs.join("\n")).toContain("Planner fallback engaged");
    expect(fixture.task().recoveryRetryCount).toBe(1);
  });

  it("keeps an unsettled fallback-dispatch boundary out of the release door", async () => {
    await writeFile(promptPath, VALID_SPEC, "utf8");
    const fixture = createPersistedStore(createTask({ workflowStepResults: [] }));
    sessionVeto.settleBoundary = false;

    await runNoopPlannerSession(fixture);

    expect(fixture.moveTaskIf).not.toHaveBeenCalled();
    expect(fixture.logs.join("\n")).toContain("did not provide a fallback-dispatch settlement boundary");
    expect(fixture.task().recoveryRetryCount).toBe(1);
  });

  /*
  FNXC:PlannerNoopRelease 2026-11-11-22:54 (RUFU-527 matrix rows 4-6): inside a live `REVISE` episode a
  dispatch veto is a planner-session failure, so it must land on the Plan Review replan ledger — the
  ceiling that stops the loop — and not be mistaken for the artifact's problem.
  */
  it.each([
    ["a fallback the runtime engaged", () => { sessionVeto.engageFallback = true; }],
    ["a fallback dispatch that never settled", () => { sessionVeto.settleBoundary = false; }],
  ] as const)("charges %s to the Plan Review replan budget", async (_label, arm) => {
    await writeFile(promptPath, VALID_SPEC, "utf8");
    const fixture = createPersistedStore(
      createTask({ status: "needs-replan", workflowStepResults: [planReviewRow({ planReviewAttemptCount: 2 })] }),
    );
    arm();

    await runNoopPlannerSession(fixture);

    expect(budgetEvents(fixture.audits).map((event) => event.metadata.outcome)).toEqual(["consumed"]);
    // The turn number is read off the shared ledger, so it continues from the turns the card had
    // already spent rather than restarting at one (the arithmetic itself is pinned in the budget file).
    expect(Number(budgetEvents(fixture.audits)[0]?.metadata.attempt)).toBeGreaterThanOrEqual(2);
    expect(fixture.moveTaskIf).not.toHaveBeenCalled();
  });

  it("never terminalizes a complete spec on an exhausted Plan Review budget", async () => {
    await writeFile(promptPath, VALID_SPEC, "utf8");
    // The shared ceiling is already spent, and the planner still finds nothing to change in a spec
    // that is complete on its own merits.
    const fixture = createPersistedStore(
      createTask({
        status: "needs-replan",
        workflowStepResults: [planReviewRow({ planReviewAttemptCount: 9 })],
        log: graphAttemptMarkers(8) as unknown as Task["log"],
      }),
    );

    await runNoopPlannerSession(fixture);

    /*
    RUFU-288's rule in this shape: content that is already releasable must not be terminalized by an
    exhausted budget. The release is the recovery — the card moves, and no `exhausted` ledger row and
    no failed park is written for it.
    */
    expect(budgetEvents(fixture.audits).map((event) => event.metadata.outcome)).toEqual(["spec-complete-recycled"]);
    expect(fixture.task().status).not.toBe("failed");
    expect(fixture.task().status).not.toBe("awaiting-approval");
    expect(fixture.moveTaskIf).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:PlannerNoopRelease 2026-11-11-22:54 (RUFU-527 — the monotonicity invariant, stated as one row):
  The change is only safe if it moves cards in one direction. Every shape the old predicate withheld
  must STILL be withheld now, and only the complete-and-valid no-projection shape newly moves. If any
  shape below starts releasing, the widening leaked past its contract.
  */
  it.each([
    ["absent artifact", null],
    ["whitespace artifact", "   \n  "],
    ["structurally invalid artifact", INVALID_SPEC],
    ["dangling-reference artifact", DANGLING_REFERENCE_SPEC],
    ["bootstrap seed", (taskId: string, title: string, description: string) => buildBootstrapPrompt(taskId, title, description)],
    ["refinement seed", (_taskId: string, title: string, description: string) => buildRefinementSeedPrompt(title, description)],
    ["duplicate redirect", () => "DUPLICATE: FN-9999\n"],
  ] as const)("monotonicity: %s is still withheld after the widening", async (_label, content) => {
    if (typeof content === "string") await writeFile(promptPath, content, "utf8");
    else if (content) await writeFile(promptPath, content(TASK_ID, TASK_TITLE, TASK_DESCRIPTION), "utf8");
    const fixture = createPersistedStore(createTask({ workflowStepResults: [] }));

    await runNoopPlannerSession(fixture);

    expect(fixture.moveTaskIf).not.toHaveBeenCalled();
    expect(fixture.task().column).toBe("triage");
    expect(fixture.task().recoveryRetryCount).toBe(1);
  });
});
