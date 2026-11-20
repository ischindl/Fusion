import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";
import {
  DEFAULT_WORKFLOW_REVIEW_STEP_TIMEOUT_MS,
  DEFAULT_WORKFLOW_STEP_TIMEOUT_MS,
  WORKFLOW_STEP_TIMEOUT_FLOOR_MS,
} from "@fusion/core";
import {
  WORKFLOW_STEP_NOTES_REPAIR_TIMEOUT_MS,
  WORKFLOW_STEP_VERDICT_REPAIR_TIMEOUT_MS,
} from "../executor/execute-workflow-step.js";

/*
FNXC:WorkflowStepTimeoutLane 2026-11-19-06:45 (RUFU-684):
Every prompt-mode lane shared one per-session-attempt ceiling, so the lanes whose real work is longest
were disposed as the COMMON case (measured: 5.0 % of persisted review gate episodes needed more than one
armed 900 s budget, and the surviving single-budget distribution ends 60 s below the cut with its maximum
ON the cut). The fix is a lane-scoped knob, and the property that matters is not "the number got bigger" --
it is WHERE each lane's number comes from:

- a review-type lane resolves `workflowReviewStepTimeoutMs`; every other prompt step keeps
  `workflowStepTimeoutMs` byte-for-byte, so a wider review budget cannot delay hang detection anywhere else;
- an unset knob falls back to the code-owned declaration default of ITS OWN lane, and the shared default
  is still exactly 900 s (the anti-appeasement clause: the global number is not the fix);
- a value an operator stored on the workflow wins over the declaration default, which only holds because
  the read site resolves through the MERGED effective settings (`effectiveReviewSettings`) and not the raw
  graph-supplied map the executor is called with;
- the 60 s floor still clamps the new knob;
- the notes/verdict repair windows keep their own caps, so a wider step budget does not widen them.

The armed budget is observed, not inferred from source text: the `task:workflow-step-timeout` row carries
`budgetMs`, and the disposal happens when the armed timer fires, so each case pins the budget the seam
actually put on the clock. Fake timers throughout -- the 60 s floor makes any real-time version of this
file a two-minute-per-case test.
*/

/*
 * Code Review refuses dispatch before any session exists when its review input cannot be proved, so the
 * fingerprint seams are pinned the way the sibling review harnesses pin them. Without this the Code
 * Review cases would assert an early refusal instead of the budget they are here to measure.
 */
vi.mock("../worktree/review-diff-fingerprint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree/review-diff-fingerprint.js")>();
  return {
    ...actual,
    resolveContentReviewInputProof: vi.fn(async () => ({
      kind: "fingerprint" as const,
      fingerprint: "sha256:rufu-684-budget-reviewed-input",
    })),
  };
});

vi.mock("../worktree/review-inline-fix-recapture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree/review-inline-fix-recapture.js")>();
  return {
    ...actual,
    readHeadSha: vi.fn(async () => undefined),
    isFastForwardAdvance: vi.fn(async () => false),
  };
});

const TASK_ID = "RUFU-684-BUDGET";
const WORKTREE = "/tmp/rufu-684-budget-wt";
/** Above the floor, so a case that resolves the wrong knob is distinguishable from a clamped one. */
const REVIEW_KNOB_MS = 120_000;
const SHARED_KNOB_MS = 60_000;

type LaneStep = {
  lane: string;
  reviewType: boolean;
  step: Record<string, unknown>;
};

/** One entry per prompt-mode lane of the Surface Enumeration, spelled the way the built-ins author them. */
const LANE_STEPS: LaneStep[] = [
  {
    lane: "code-review",
    reviewType: true,
    step: {
      id: "graph:code-review-step",
      name: "Code Review",
      optionalGroupId: "code-review",
      reviewKind: "code",
      phase: "pre-merge",
      gateMode: "gate",
    },
  },
  {
    lane: "plan-review",
    reviewType: true,
    step: {
      id: "graph:plan-review-step",
      name: "Plan Review",
      optionalGroupId: "plan-review",
      reviewKind: "plan",
      phase: "pre-merge",
      gateMode: "gate",
    },
  },
  {
    lane: "post-merge-verification",
    reviewType: true,
    step: {
      id: "graph:post-merge-verification-step",
      name: "Post-merge verification",
      optionalGroupId: "post-merge-verification",
      phase: "post-merge",
      gateMode: "gate",
    },
  },
  {
    lane: "completion-summary",
    reviewType: false,
    step: {
      id: "graph:completion-summary",
      name: "Completion Summary",
      phase: "pre-merge",
      gateMode: "advisory",
    },
  },
  {
    lane: "other-prompt-step",
    reviewType: false,
    step: {
      id: "graph:custom-decision",
      name: "Custom Decision",
      phase: "pre-merge",
      gateMode: "advisory",
    },
  },
];

function baseTask() {
  const now = new Date().toISOString();
  return {
    id: TASK_ID,
    title: "Workflow step lane budget resolution",
    description: "Verify which timeout knob each prompt-mode lane resolves",
    column: "in-review" as const,
    worktree: WORKTREE,
    branch: `fusion/${TASK_ID.toLowerCase()}`,
    baseCommitSha: "abc123",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" as const }],
    currentStep: 0,
    log: [],
    workflowStepResults: [],
    createdAt: now,
    updatedAt: now,
  };
}

function promptStep(laneStep: LaneStep) {
  return {
    description: "",
    prompt: "Evaluate the delivered work.",
    toolMode: "readonly" as const,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...laneStep.step,
  };
}

/** Sessions whose prompt never settles: the only condition under which a budget is observable at all. */
function installNeverSettlingSessions() {
  const sessions: Array<{ prompt: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = [];
  mockedCreateFnAgent.mockImplementation(async () => {
    const session = {
      state: {},
      subscribe: () => () => {},
      prompt: vi.fn(() => new Promise<void>(() => undefined)),
      dispose: vi.fn(),
    };
    sessions.push(session as any);
    return { session } as any;
  });
  return sessions;
}

type DriveInput = {
  laneStep: LaneStep;
  /** The RAW settings map the graph hands the executor -- deliberately not the merged one. */
  settings?: Record<string, unknown>;
  /** Values an operator stored on the workflow, served through the effective-settings seam. */
  stored?: Record<string, unknown>;
};

/**
 * Drives one step through both permitted attempts and reports what the seam armed. `expectedBudgetMs`
 * only sizes the clock ceiling and the pump granularity -- no assertion reads it, so a wrong expectation
 * surfaces as a failure rather than as a pass that never measured anything.
 */
async function driveLaneToTimeout(input: DriveInput, expectedBudgetMs: number) {
  const store = createMockStore();
  const logs: string[] = [];
  /*
   * The card-facing sentence written at exhaustion is the behavioral witness that the two-attempt DECISION
   * -- not the width of a budget -- closed the episode, so the fail-closed case can assert it. The mock
   * store's own logEntry is a no-op; capturing the messages here keeps that behavior.
   */
  (store as any).logEntry = vi.fn(async (_taskId: string, message: unknown) => {
    logs.push(String(message));
  });
  const capture: Array<Record<string, unknown>> = [];
  (store as any).recordRunAuditEvent = vi.fn(async (event: Record<string, unknown>) => {
    capture.push(event);
    return undefined;
  });
  if (input.stored !== undefined) {
    // The same two seams `review-unchanged-tree-loop.test.ts` uses to make a stored workflow value real.
    (store as any).getWorkflowSettingsProjectId = vi.fn(() => "test-project");
    (store as any).getWorkflowSettingValues = vi.fn(() => input.stored);
  }
  const sessions = installNeverSettlingSessions();
  const executor = new TaskExecutor(store as any, "/tmp/test", {
    agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
  } as any);

  const pending = (executor as any).executeWorkflowStep(
    baseTask(),
    promptStep(input.laneStep),
    WORKTREE,
    input.settings ?? {},
    undefined,
    undefined,
  );

  let outcome: any;
  let settled = false;
  pending.then((value: unknown) => { outcome = value; settled = true; });
  const disposedCount = (index: number) => sessions[index]?.dispose.mock.calls.length ?? 0;
  const ceilingMs = expectedBudgetMs * 2 + 120_000;
  const stepMs = Math.max(1_000, Math.round(expectedBudgetMs / 60));
  const pump = async (label: string, until: () => boolean, limit = ceilingMs) => {
    for (let elapsed = 0; elapsed < limit; elapsed += stepMs) {
      if (until()) return;
      await vi.advanceTimersByTimeAsync(stepMs);
    }
    if (!until()) throw new Error(`lane ${input.laneStep.lane} never reached: ${label}`);
  };

  /*
   * Advances EXACTLY `ms` of fake clock in bounded chunks. The budget-bracketing cases need an exact
   * total: a chunked loop that rounds its last chunk up would step past the budget and report a session as
   * disposed when the open question was whether the armed budget is the review default or the old 900 s.
   */
  const advanceExactly = async (ms: number) => {
    let remaining = ms;
    while (remaining > 0) {
      const chunk = Math.min(stepMs, remaining);
      remaining -= chunk;
      await vi.advanceTimersByTimeAsync(chunk);
    }
  };

  await pump("primary session", () => sessions.length >= 1, expectedBudgetMs + 120_000);
  return {
    sessions,
    disposedCount,
    pump,
    advanceExactly,
    settle: async () => {
      await pump("secondary disposal", () => disposedCount(1) >= 1);
      await pump("closed episode", () => settled);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(0);
    },
    rows: () => capture.filter((event) => event.mutationType === "task:workflow-step-timeout"),
    logs: () => logs,
    outcome: () => outcome,
  };
}

beforeEach(() => {
  resetExecutorMocks();
  mockedExecSync.mockImplementation(() => Buffer.from(""));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("prompt-mode step budgets resolve per lane (RUFU-684)", () => {
  it.each(LANE_STEPS)(
    "arms the review knob for $lane and leaves the shared knob to the non-review lanes",
    async (laneStep) => {
      const drive = await driveLaneToTimeout(
        { laneStep, settings: { workflowStepTimeoutMs: SHARED_KNOB_MS, workflowReviewStepTimeoutMs: REVIEW_KNOB_MS } },
        laneStep.reviewType ? REVIEW_KNOB_MS : SHARED_KNOB_MS,
      );
      await drive.settle();

      const expected = laneStep.reviewType ? REVIEW_KNOB_MS : SHARED_KNOB_MS;
      const rows = drive.rows();
      expect(rows.length).toBe(2);
      for (const row of rows) {
        expect((row.metadata as Record<string, unknown>).budgetMs).toBe(expected);
      }
      // Both attempts ran on the SAME lane budget; the failure stays closed at two sessions.
      expect(drive.sessions.length).toBe(2);
      expect(drive.outcome().timedOut).toBe(true);
      expect(drive.outcome().verdict).toBeUndefined();
    },
  );

  it("arms the review lane's own declaration default when nothing is configured, not the shared 900 s", async () => {
    expect(DEFAULT_WORKFLOW_REVIEW_STEP_TIMEOUT_MS).toBeGreaterThan(DEFAULT_WORKFLOW_STEP_TIMEOUT_MS);
    const drive = await driveLaneToTimeout(
      { laneStep: LANE_STEPS[0]! },
      DEFAULT_WORKFLOW_REVIEW_STEP_TIMEOUT_MS,
    );

    /*
     * Bracket the armed budget with a minute of slack on each side rather than to the second: the lanes
     * consume some clock before the timer is armed (Plan Review re-reads its spec, every lane resolves a
     * model first), so an exact bracket would measure that preamble too. A minute of slack still decides
     * the only question this case asks -- a 900 s budget would already be disposed here, 1 800 s is not.
     */
    await drive.advanceExactly(DEFAULT_WORKFLOW_REVIEW_STEP_TIMEOUT_MS - 60_000);
    expect(drive.disposedCount(0)).toBe(0);
    // ...and disposed a minute past it. The pair brackets the armed budget, whose exact value the row names.
    await drive.advanceExactly(120_000);
    expect(drive.disposedCount(0)).toBe(1);

    await drive.settle();
    const rows = drive.rows();
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect((row.metadata as Record<string, unknown>).budgetMs).toBe(DEFAULT_WORKFLOW_REVIEW_STEP_TIMEOUT_MS);
    }
  });

  it("keeps the untouched 900 s default on the completion-summary lane, so a wider review budget buys no slack for it", async () => {
    const summaryLane = LANE_STEPS.find((lane) => lane.lane === "completion-summary")!;
    const drive = await driveLaneToTimeout({ laneStep: summaryLane }, DEFAULT_WORKFLOW_STEP_TIMEOUT_MS);

    await drive.advanceExactly(DEFAULT_WORKFLOW_STEP_TIMEOUT_MS - 60_000);
    expect(drive.disposedCount(0)).toBe(0);
    await drive.advanceExactly(120_000);
    expect(drive.disposedCount(0)).toBe(1);

    await drive.settle();
    for (const row of drive.rows()) {
      expect((row.metadata as Record<string, unknown>).budgetMs).toBe(DEFAULT_WORKFLOW_STEP_TIMEOUT_MS);
    }
  });

  it("honours a value the operator stored on the workflow, which only the merged effective settings carry", async () => {
    const storedBudgetMs = 75_000;
    const drive = await driveLaneToTimeout({
      laneStep: LANE_STEPS[0]!,
      // The shared knob is armed BELOW the stored review value on purpose: a review lane takes the larger
      // of the two, so an unset shared number (the 900 s default) would answer here and the row would name
      // a budget this case never configured. 60 s shared vs 75 s stored keeps the question sharp -- only a
      // read site that actually consulted the stored workflow value can produce 75 s.
      settings: { workflowStepTimeoutMs: 60_000 },
      stored: { workflowReviewStepTimeoutMs: storedBudgetMs },
    }, storedBudgetMs);
    await drive.settle();

    // The raw map this call was handed carries only the shared knob, so a read site consulting the raw map
    // for the review budget would have armed the 30-minute declaration default and this episode would
    // still be running.
    for (const row of drive.rows()) {
      expect((row.metadata as Record<string, unknown>).budgetMs).toBe(storedBudgetMs);
    }
    expect(drive.sessions.length).toBe(2);
  });

  /*
   * FNXC:WorkflowStepTimeoutLane 2026-11-19-07:10 (RUFU-684):
   * The no-downgrade rule at the engine seam, not just in the resolver unit test. Two live boards had
   * already raised the SHARED knob -- one to 2 700 s, one to 1 800 s -- to rescue their reviews before this
   * knob existed. The 1 800 s board is already covered by the 30-minute review default; the 2 700 s board is
   * the case the rule exists for: a review lane reading only its own number would arm it 15 minutes SHORTER
   * than it runs today, turning a fix for unreviewed merges into a new cause of them. So the number under
   * test is a shared budget ABOVE the review default, and what must expire is that number.
   */
  it("keeps bounding a review lane by a shared budget the operator raised, so no board is downgraded", async () => {
    const raisedSharedMs = 2_700_000;
    const drive = await driveLaneToTimeout(
      { laneStep: LANE_STEPS[0]!, settings: { workflowStepTimeoutMs: raisedSharedMs } },
      raisedSharedMs,
    );
    await drive.settle();

    expect(drive.rows().length).toBe(2);
    for (const row of drive.rows()) {
      expect((row.metadata as Record<string, unknown>).budgetMs).toBe(raisedSharedMs);
    }
    // The review knob was never configured, yet the review lane still ran on the operator's raised number.
    expect(drive.sessions.length).toBe(2);
  });

  it("clamps the review knob at the 60 s floor, so a misconfigured value cannot become no bound", async () => {
    /*
     * The absurd value arrives through the RAW settings map on purpose. A STORED workflow value below the
     * declaration's `minimum` is refused by the settings validator before it reaches the seam -- observed:
     * a stored `1` never arrives and the lane keeps its declaration default (that validator bound is
     * asserted in `builtin-workflow-settings-triage.test.ts`, where the catalog is in scope) -- so the
     * engine's own floor is what protects every path that can hand the seam an unvalidated number (a
     * hand-built map, a resumed run, a non-graph caller). Both guards matter; dropping either reopens the
     * same hole, and a step whose budget could fall to 1 ms is a step that never gets to run at all.
     */
    const drive = await driveLaneToTimeout(
      // Both knobs absurd: a review lane arms the larger of the two, so a lone absurd review value would
      // otherwise be out-voted by the 900 s shared default and the floor would never be exercised.
      { laneStep: LANE_STEPS[1]!, settings: { workflowReviewStepTimeoutMs: 1, workflowStepTimeoutMs: 1 } },
      WORKFLOW_STEP_TIMEOUT_FLOOR_MS,
    );
    await drive.settle();

    expect(WORKFLOW_STEP_TIMEOUT_FLOOR_MS).toBe(60_000);
    expect(drive.rows().length).toBe(2);
    for (const row of drive.rows()) {
      expect((row.metadata as Record<string, unknown>).budgetMs).toBe(WORKFLOW_STEP_TIMEOUT_FLOOR_MS);
    }
  });

  it("leaves the verdict/notes repair windows capped below the widened review budget", () => {
    /*
     * The repair continuations run on an ALREADY-LIVE session and take `Math.min(timeoutMs, CAP)`. This
     * invariant is what keeps a wider step budget from widening a window whose whole purpose is a short
     * bounded wait for output that should already be arriving.
     */
    expect(Math.min(DEFAULT_WORKFLOW_REVIEW_STEP_TIMEOUT_MS, WORKFLOW_STEP_VERDICT_REPAIR_TIMEOUT_MS))
      .toBe(WORKFLOW_STEP_VERDICT_REPAIR_TIMEOUT_MS);
    expect(Math.min(DEFAULT_WORKFLOW_REVIEW_STEP_TIMEOUT_MS, WORKFLOW_STEP_NOTES_REPAIR_TIMEOUT_MS))
      .toBe(WORKFLOW_STEP_NOTES_REPAIR_TIMEOUT_MS);
  });

  /*
   * FNXC:WorkflowStepTimeoutLane 2026-11-19-06:50 (RUFU-684) -- the gate this card exists to keep.
   * The review budget doubled, so the question the change has to answer is whether a wider attempt bought
   * an extra attempt. It must not: `workflow-step-timeout-retry.test.ts` establishes the two-attempt
   * contract at a small budget, and this case re-proves it AT the widened review default, where the whole
   * episode costs an hour of clock -- the setting that failed closed at the smaller budget has to fail
   * closed at the larger one too. Three things decide it: the durable rows name exactly one primary and
   * exactly one secondary whose outcome is `budget-exhausted`; no third session is ever created, even
   * after advancing a full further budget; and the closed episode carries no verdict to route, so the
   * merge gate has nothing to consume. A third attempt, a fabricated approval, or an auto-replan would
   * each fail this case, and all three are the failure modes reviewers are told to expect from a doubled
   * budget (Step 4 of the contract in PROMPT.md).
   */
  it("doubles the review time and still closes at two attempts with no verdict to route", async () => {
    const drive = await driveLaneToTimeout(
      { laneStep: LANE_STEPS[0]! },
      DEFAULT_WORKFLOW_REVIEW_STEP_TIMEOUT_MS,
    );
    await drive.settle();

    expect(drive.rows().map((row) => (row.metadata as Record<string, unknown>).attemptKind))
      .toEqual(["primary", "same-model-retry"]);
    expect(drive.rows().map((row) => (row.metadata as Record<string, unknown>).outcome))
      .toEqual(["attempt-remaining", "budget-exhausted"]);

    // One further whole budget of clock: exhaustion is a decision, not a deadline that keeps buying time.
    await drive.advanceExactly(DEFAULT_WORKFLOW_REVIEW_STEP_TIMEOUT_MS);
    expect(drive.sessions.length).toBe(2);

    const outcome = drive.outcome();
    expect(outcome.timedOut).toBe(true);
    expect(outcome.verdict).toBeUndefined();
    expect(outcome.approved).toBeUndefined();
    // The card carries the exhaustion sentence itself: a closed two-attempt budget, never an approval.
    expect(drive.logs().some((line) => line.includes("exhausted its two-attempt budget"))).toBe(true);
  });
});
