import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

/*
FNXC:WorkflowStepTimeoutLane 2026-11-19-05:38 (RUFU-684):
A prompt-mode step that ran out of its budget used to leave one artifact: a task-log line. `tasks.log` is
capped and the overflow is deleted, so the class was uncountable after retention — the census behind this
card found 456 surviving timeout lines against ZERO durable rows, a lower bound wearing the costume of a
rate. `task:workflow-step-timeout` is the durable row, and this file pins the three properties that make
it worth having:

1. one row per timed-out attempt, in EVERY prompt-mode lane (Code Review, Plan Review, Post-merge
   verification, the completion summary, an author-declared step), with the closed ids/counts/enums
   metadata key set and no free text;
2. the row lands even with NO run context available, because a dropped row is the exact gap being closed;
3. a hostile audit sink — absent, throwing, rejecting, hanging, late-resolving, late-rejecting — cannot
   change the timeout disposition, the session disposal, or the secondary-attempt decision.

Fake timers throughout: the 60 s budget floor makes a real-time timeout a two-minute test, so every case
here advances the clock instead of waiting on it.
*/

/*
 * The Code Review lane refuses dispatch before any session exists when its review input cannot be
 * proved, so the fingerprint seams are pinned the way the other review-executor harnesses pin them.
 * Without this the Code Review case would assert an early refusal instead of the timeout it is here for.
 */
vi.mock("../worktree/review-diff-fingerprint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree/review-diff-fingerprint.js")>();
  return {
    ...actual,
    resolveContentReviewInputProof: vi.fn(async () => ({
      kind: "fingerprint" as const,
      fingerprint: "sha256:rufu-684-reviewed-input",
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

const TASK_ID = "RUFU-684-AUDIT";
const WORKTREE = "/tmp/rufu-684-audit-wt";
/** The 60 s floor is the lowest budget the seam can hold, so it is also the fastest testable one. */
const BUDGET_MS = 60_000;

/** The closed metadata key set the event documents, plus the per-repository key it grows. */
const CLOSED_METADATA_KEYS = [
  "attemptKind",
  "budgetMs",
  "lane",
  "outcome",
  "phase",
  "taskId",
  "workflowStepId",
] as const;

type LaneStep = {
  lane: string;
  stepId: string;
  phase: "pre-merge" | "post-merge";
  step: Record<string, unknown>;
};

/** One entry per prompt-mode lane in the Surface Enumeration, spelled the way the built-ins author them. */
const LANE_STEPS: LaneStep[] = [
  {
    lane: "code-review",
    stepId: "code-review",
    phase: "pre-merge",
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
    stepId: "plan-review",
    phase: "pre-merge",
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
    stepId: "post-merge-verification",
    phase: "post-merge",
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
    stepId: "completion-summary",
    phase: "pre-merge",
    step: {
      id: "graph:completion-summary",
      name: "Completion Summary",
      phase: "pre-merge",
      gateMode: "advisory",
    },
  },
  {
    lane: "other-prompt-step",
    stepId: "custom-decision",
    phase: "pre-merge",
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
    title: "Workflow step timeout run-audit",
    description: "Verify the durable timeout row",
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

/** `null` is the genuinely-absent sink: the store carries no `recordRunAuditEvent` at all. */
type Sink = ((input: unknown) => unknown) | null;

/** Sessions whose prompt never settles: the condition under which every timeout row is written. */
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

type RunInput = {
  laneStep: LaneStep;
  settings?: Record<string, unknown>;
  stepOptions?: Record<string, unknown>;
  runContext?: Record<string, unknown> | null;
  sink?: Sink;
};

/**
 * Drives one step until BOTH permitted attempts have timed out, which is what makes the episode
 * terminate on its own and exposes the whole row set for one timeout episode.
 */
async function runUntilBothAttemptsExpire(input: RunInput) {
  const store = createMockStore();
  const capture: Array<Record<string, unknown>> = [];
  if (input.sink === null) {
    delete (store as any).recordRunAuditEvent;
  } else {
    const sink = input.sink ?? (async () => undefined);
    (store as any).recordRunAuditEvent = vi.fn(async (event: Record<string, unknown>) => {
      capture.push(event);
      return sink(event);
    });
  }
  const sessions = installNeverSettlingSessions();
  const executor = new TaskExecutor(store as any, "/tmp/test", {
    agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
  } as any);
  if (input.runContext !== undefined) {
    vi.spyOn(executor as any, "getRunContextFor").mockReturnValue(input.runContext ?? undefined);
  }

  const pending = (executor as any).executeWorkflowStep(
    baseTask(),
    promptStep(input.laneStep),
    WORKTREE,
    /*
     * Both knobs are armed at the same 60 s on purpose. Since RUFU-684 Step 3 a review-type step reads
     * `workflowReviewStepTimeoutMs`, so a fixture arming only the shared `workflowStepTimeoutMs` would
     * quietly stop timing out for exactly the lanes this file exists to measure. Arming both keeps the
     * fixture intent readable: a 60-second budget is in force for whatever knob this lane resolves.
     */
    { workflowStepTimeoutMs: BUDGET_MS, workflowReviewStepTimeoutMs: BUDGET_MS, ...input.settings },
    undefined,
    input.stepOptions,
  );
  /*
   * The clock is pumped until each stage of the episode actually happens rather than assuming a fixed
   * number of ticks: lanes differ in what they await before dispatch (Plan Review re-reads its spec and
   * planning segment first), so a fixed `advance(2 x budget)` script closes some lanes and leaves others
   * open. 1 s steps with a generous ceiling keep the pump honest -- no stage here takes real time, and the
   * 60 s floor is far too large to be crossed by accident.
   */
  let outcome: any;
  let settled = false;
  pending.then((value: unknown) => { outcome = value; settled = true; });
  const disposedCount = (index: number) => sessions[index]?.dispose.mock.calls.length ?? 0;
  const pump = async (label: string, until: () => boolean, ceilingMs = 300_000) => {
    for (let elapsed = 0; elapsed < ceilingMs; elapsed += 1_000) {
      if (until()) return;
      await vi.advanceTimersByTimeAsync(1_000);
    }
    if (!until()) throw new Error(`lane ${input.laneStep.lane} never reached: ${label}`);
  };

  /*
   * Staged on session and disposal facts, never on the captured rows: the absent-sink case records
   * nothing at all, so a pump keyed on captured rows would time out on exactly the case that proves a
   * missing sink cannot change the disposition.
   */
  await pump("primary session", () => sessions.length >= 1);
  // Attempt 1 expires and its session is disposed, which is what arms exactly one secondary.
  await pump("primary disposal", () => disposedCount(0) >= 1);
  await pump("secondary session", () => sessions.length >= 2);
  // Attempt 2 expires too, which closes the episode and fails it closed.
  await pump("secondary disposal", () => disposedCount(1) >= 1);
  await pump("closed episode", () => settled);
  // Bound of the detached audit emit, so a case that installed a hostile sink observes it settling.
  await vi.advanceTimersByTimeAsync(2_000);
  await vi.advanceTimersByTimeAsync(0);

  return {
    outcome,
    sessions,
    rows: capture.filter((event) => event.mutationType === "task:workflow-step-timeout"),
  };
}

function metadataOf(row: Record<string, unknown>) {
  return row.metadata as Record<string, unknown>;
}

/** Both timed-out attempts must have had their own session disposed, whatever else the lane spawns. */
function expectTimedOutSessionsDisposed(sessions: ReturnType<typeof installNeverSettlingSessions>) {
  expect(sessions.length).toBeGreaterThanOrEqual(2);
  expect(sessions[0]!.dispose).toHaveBeenCalledTimes(1);
  expect(sessions[1]!.dispose).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
  resetExecutorMocks();
  mockedExecSync.mockImplementation(() => Buffer.from(""));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("task:workflow-step-timeout durable countability (RUFU-684)", () => {
  it.each(LANE_STEPS)("writes one row per timed-out attempt for the $lane lane", async (laneStep) => {
    const { outcome, sessions, rows } = await runUntilBothAttemptsExpire({ laneStep });

    // Fail-closed disposition: no verdict authored, and the budget spent on both permitted attempts.
    expect(outcome).toMatchObject({ success: false, timedOut: true });
    expect(outcome.verdict).toBeUndefined();
    expectTimedOutSessionsDisposed(sessions);

    expect(rows).toHaveLength(2);
    expect(rows.map(metadataOf)).toEqual([
      {
        taskId: TASK_ID,
        lane: laneStep.lane,
        workflowStepId: laneStep.stepId,
        attemptKind: "primary",
        budgetMs: BUDGET_MS,
        phase: laneStep.phase,
        outcome: "attempt-remaining",
      },
      {
        taskId: TASK_ID,
        lane: laneStep.lane,
        workflowStepId: laneStep.stepId,
        attemptKind: "same-model-retry",
        budgetMs: BUDGET_MS,
        phase: laneStep.phase,
        outcome: "budget-exhausted",
      },
    ]);
  });

  it.each(LANE_STEPS)("keeps the $lane row inside the closed key set with no free text", async (laneStep) => {
    const { rows } = await runUntilBothAttemptsExpire({ laneStep });

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.keys(metadataOf(row)).sort()).toEqual([...CLOSED_METADATA_KEYS].sort());
      expect(row).toMatchObject({
        domain: "database",
        mutationType: "task:workflow-step-timeout",
        target: TASK_ID,
        taskId: TASK_ID,
      });
      // Every value is an id, a count, or a short fixed enum — never prompt text or an error sentence.
      for (const value of Object.values(metadataOf(row))) {
        if (typeof value === "string") {
          expect(value.length, `${laneStep.lane} row carries a free-text value`).toBeLessThanOrEqual(40);
        } else {
          expect(typeof value).toBe("number");
        }
      }
    }
  });

  it("still writes the row when no run context exists, under a synthetic identity", async () => {
    const { rows } = await runUntilBothAttemptsExpire({ laneStep: LANE_STEPS[0]!, runContext: null });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.agentId)).toEqual(["workflow-step-timeout", "workflow-step-timeout"]);
    expect(rows.map((row) => row.runId)).toEqual([
      `workflow-step-timeout:${TASK_ID}:code-review:primary`,
      `workflow-step-timeout:${TASK_ID}:code-review:same-model-retry`,
    ]);
  });

  it("attributes the row to the live run context when one exists", async () => {
    const { rows } = await runUntilBothAttemptsExpire({
      laneStep: LANE_STEPS[0]!,
      runContext: { taskId: TASK_ID, agentId: "executor", runId: "run-rufu-684", phase: "execute" },
    });

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.agentId === "executor")).toBe(true);
    expect(rows.every((row) => row.runId === "run-rufu-684")).toBe(true);
  });

  it("names the repository on the per-repository workspace review path", async () => {
    const { rows } = await runUntilBothAttemptsExpire({
      laneStep: LANE_STEPS[0]!,
      stepOptions: { dispatchLabel: "packages/dashboard" },
    });

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const metadata = metadataOf(row);
      expect(Object.keys(metadata).sort()).toEqual([...[...CLOSED_METADATA_KEYS, "repoRelPath"]].sort());
      expect(metadata.repoRelPath).toBe("packages/dashboard");
    }
  });

  it("records the distinct configured fallback as its own attempt kind", async () => {
    const { rows } = await runUntilBothAttemptsExpire({
      laneStep: LANE_STEPS[0]!,
      settings: {
        validatorFallbackProvider: "fallback-provider",
        validatorFallbackModelId: "fallback-model",
      },
    });

    expect(rows.map((row) => metadataOf(row).attemptKind)).toEqual(["primary", "configured-fallback"]);
    expect(metadataOf(rows[1]!).outcome).toBe("budget-exhausted");
  });

  /*
   * The row is telemetry; the timeout disposition is a lifecycle outcome. A sink that refuses to answer
   * may therefore never change what the step returned, how many sessions ran, or which was disposed.
   */
  it.each([
    ["absent", null],
    ["throwing", () => { throw new Error("audit throw"); }],
    ["rejecting", () => Promise.reject(new Error("audit reject"))],
    ["hanging", () => new Promise<void>(() => undefined)],
  ])("keeps the timeout disposition unchanged with a %s audit sink", async (_label, sink) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { outcome, sessions, rows } = await runUntilBothAttemptsExpire({
        laneStep: LANE_STEPS[0]!,
        sink: sink as Sink,
      });

      expect(outcome).toMatchObject({ success: false, timedOut: true });
      expect(outcome.verdict).toBeUndefined();
      expectTimedOutSessionsDisposed(sessions);
      // The absent sink records nothing anywhere; every hostile sink still received both submissions.
      expect(rows).toHaveLength(sink === null ? 0 : 2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps the disposition unchanged when the sink settles after its own bound", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const resolvers: Array<() => void> = [];
      const rejecters: Array<(error: Error) => void> = [];
      const resolveSink = vi.fn(() => new Promise<void>((resolve) => { resolvers.push(resolve); }));
      const rejectingSink = vi.fn(() => new Promise<void>((_resolve, reject) => { rejecters.push(reject); }));

      const first = await runUntilBothAttemptsExpire({ laneStep: LANE_STEPS[0]!, sink: resolveSink });
      // Both submissions are already past their bounded window; now they settle anyway.
      resolvers.forEach((resolve) => resolve());
      await vi.advanceTimersByTimeAsync(2_000);

      const second = await runUntilBothAttemptsExpire({ laneStep: LANE_STEPS[1]!, sink: rejectingSink });
      rejecters.forEach((reject) => reject(new Error("late audit rejection")));
      await vi.advanceTimersByTimeAsync(2_000);

      expect(resolveSink).toHaveBeenCalledTimes(2);
      expect(rejectingSink).toHaveBeenCalledTimes(2);
      expect(first.outcome).toMatchObject({ success: false, timedOut: true });
      expect(second.outcome).toMatchObject({ success: false, timedOut: true });
      expectTimedOutSessionsDisposed(first.sessions);
      expectTimedOutSessionsDisposed(second.sessions);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
