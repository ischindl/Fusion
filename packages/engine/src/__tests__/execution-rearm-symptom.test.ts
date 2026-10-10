/**
 * RUFU-308 — `## Symptom Verification` (RUFU-291).
 *
 * Original symptom: after a stuck-session disposal the card carried `step-failed` at its step's node,
 * had no work item able to re-enter execution, and nothing re-ran it even though its worktree held
 * committed work.
 * Exact reproduction: a card in `in-progress` whose markers were cleared by the disposal, whose failed
 * `kind:"task"` work item is invisible to the due-poll (only `runnable`/`retrying` dispatch), and whose
 * checkout proves real step work.
 * Assertion that it is gone: the recovery pass itself must leave a work item the scheduler can claim,
 * and must never announce the same recovery twice.
 *
 * The authority-level detail this file exists for: the failed `kind:"task"` row is invisible to BOTH
 * recovery readers — the due-poll dispatches only `runnable`/`retrying`, and
 * `stranded-continuation-reclaim` skips exactly those two states, leaving a terminal row with no
 * dispatch owner. So "the card was left in its lane and its badges were cleared" is not the fix;
 * the fix is a newly installed runnable row. The negative-control test asserts the converse: badges
 * cleared with no continuation is still RUFU-291.
 */
import { describe, expect, it, vi } from "vitest";
import { routeGraphFailureToExecutionResume } from "../executor/route-graph-failure-to-execution-resume.js";
import { resetContainmentRefusalLogForTesting } from "../execution/lifecycle-move.js";
import {
  EXECUTION_REARM_EXHAUSTED_PREFIX,
  MAX_EXECUTION_REARM_REFUSALS,
  attemptExecutionRearm,
  readExecutionRarmMarker,
  resolveStrandedStepExecuteNode,
} from "../executor/execution-rearm.js";

const WIP = "in-progress";
const REVIEW = "in-review";
const OWNER_NODE = "steps#1:step-execute";
const STUCK_ERROR = "Task terminated due to stuck agent session (reason=inactivity, no progress for ~27min)";

/**
 * The exact state RUFU-291 was left in: Step 0 done and committed, Step 1 in progress, the stuck
 * sentence on `error`, and **`status: null`** — the disposal clears the badge, which is precisely why
 * the one in-place arm that predated this fix (FN-9359's `retryStep`, which requires
 * `status === "failed"`) could never fire on it.
 */
function strandedTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "RUFU-291-shape",
    title: "stranded after stuck-session disposal",
    description: "",
    prompt: "# task",
    column: WIP,
    status: null as string | null,
    error: STUCK_ERROR as string | null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    worktree: ".fusion/worktrees/rufu-291",
    branch: "fusion/rufu-291",
    baseCommitSha: "5b7cdd962b",
    steps: [
      { id: "0", title: "Preflight", status: "done" },
      { id: "1", title: "Implementation", status: "in-progress" },
      { id: "2", title: "Tests", status: "pending" },
    ],
    workflowStepResults: [
      { workflowStepId: "steps#0:step-execute", status: "passed", source: "node" },
      { workflowStepId: OWNER_NODE, status: "failed", source: "node" },
    ],
    dependencies: [],
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
    ...overrides,
  } as any;
}

/** A foreach template IR: the per-step instance is the node whose run just failed. */
const STEPWISE_IR = {
  version: "v2",
  columns: [],
  nodes: [
    { id: "steps", kind: "foreach", config: { source: "task-steps", template: { nodes: [
      { id: "step-execute", kind: "prompt", config: { seam: "step-execute" } },
      { id: "step-review", kind: "prompt", config: { seam: "step-review" } },
    ] } } },
    { id: "code-review", kind: "prompt", config: { seam: "code-review" } },
  ],
  edges: [],
} as any;

/**
 * A store faithful to the two API shapes this path actually calls: `updateTaskAtomic` takes a REDUCER
 * (the fenced claim re-validates the live row inside it), and `logEntryOnce` is the durable dedupe —
 * it answers false the second time for the same key, which is what makes "exactly one notice" provable
 * instead of merely asserted.
 */
function makeStore(task: any) {
  let current = task;
  const state = {
    get current() {
      return current;
    },
    set current(value: any) {
      current = value;
    },
    patches: [] as Array<Record<string, unknown>>,
  };
  const seenDedupeKeys = new Set<string>();
  const store = {
    getTask: vi.fn(async () => current),
    getRootDir: () => "/repo",
    getSettings: vi.fn(async () => ({ integrationBranch: "main" })),
    getTaskWorkflowSelection: () => ({ workflowId: "builtin:stepwise-coding", stepIds: [] }),
    getWorkflowDefinition: async () => ({ ir: STEPWISE_IR }),
    getWorkflowContinuationForItem: vi.fn(async () => undefined),
    replaceActiveTaskWorkflowContinuation: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    logEntryOnce: vi.fn(async (_id: string, opts: { dedupeKey: string }) => {
      if (seenDedupeKeys.has(opts.dedupeKey)) return false;
      seenDedupeKeys.add(opts.dedupeKey);
      return true;
    }),
    recordRunAuditEvent: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
    moveTaskIf: vi.fn(async () => ({ moved: false })),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      state.patches.push(patch);
      current = { ...current, ...patch };
      return current;
    }),
    updateTaskAtomic: vi.fn(async (_id: string, reducer: (value: any) => any) => {
      const patch = reducer(current);
      if (!patch) return null;
      state.patches.push(patch);
      current = { ...current, ...patch };
      return current;
    }),
  };
  return { store, state };
}

function makeDeps(store: any, prover: { proveTask: ReturnType<typeof vi.fn> }, extra: Record<string, unknown> = {}) {
  return {
    store,
    getRunContextFor: () => undefined,
    resolveResumeLanes: vi.fn(async () => ({ hold: "todo", wip: WIP, review: REVIEW, wipDeclared: true })),
    clearTerminalStepFailuresForRetry: vi.fn(async () => undefined),
    persistTokenUsage: vi.fn(async () => undefined),
    isRemediationGraphNode: vi.fn(async () => false),
    isLiveSharedBranchGroupMember: vi.fn(async () => false),
    hasLiveTaskSessionSurface: vi.fn(() => false),
    checkoutEmptinessProver: prover,
    ...extra,
  } as any;
}

/**
 * Prover stand-in keyed by the singular checkout's lookup key (`""`). The verdict enum is the entire
 * contract of the evidence gate, so no test here needs a real worktree or a real git call.
 */
function makeProver(...verdicts: string[]): { proveTask: ReturnType<typeof vi.fn> } {
  let index = 0;
  return {
    proveTask: vi.fn(async () => new Map([["", verdicts[Math.min(index++, verdicts.length - 1)]]])),
  };
}

/** One disposal cycle as the graph sees it. */
function runFailure(deps: any, task: any) {
  return routeGraphFailureToExecutionResume(deps, task, OWNER_NODE, "step-failed", undefined, undefined, STUCK_ERROR);
}

function auditRows(store: any) {
  return store.recordRunAuditEvent.mock.calls.map((call: any[]) => call[0]);
}

function refusalLines(store: any) {
  return store.logEntry.mock.calls.filter((call: any[]) => String(call[1]).includes("automatic recovery cannot move"));
}

describe("RUFU-308 symptom: stranded step re-entry (RUFU-291)", () => {
  it("re-arms the disposed step in place and leaves a work item the scheduler can claim", async () => {
    resetContainmentRefusalLogForTesting();
    const prover = makeProver("occupied");
    const { store, state } = makeStore(strandedTask());

    await expect(runFailure(makeDeps(store, prover), state.current)).resolves.toBe(true);

    // Symptom assertion, execution side: recovery left something dispatchable, at the SAME node.
    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(1);
    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledWith(expect.objectContaining({
      taskId: state.current.id,
      nodeId: OWNER_NODE,
      kind: "task",
      state: "runnable",
      onlyIfNoActiveTaskContinuation: true,
    }));

    // No lifecycle move: containment keeps its authority over lanes, and this task asked for none.
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.moveTaskIf).not.toHaveBeenCalled();

    // The card stays where it was, with its checkout intact.
    expect(state.current.column).toBe(WIP);
    expect(state.current.worktree).toBe(".fusion/worktrees/rufu-291");
    expect(state.current.branch).toBe("fusion/rufu-291");

    // No backward move, no plan mixing, no stranded-retry budget: RUFU-308 buys none of those.
    expect(state.current.steps.map((step: any) => step.status)).toEqual(["done", "in-progress", "pending"]);
    for (const patch of state.patches) {
      expect(patch).not.toHaveProperty("column");
      expect(patch).not.toHaveProperty("recoveryRetryCount");
      expect(patch.status).not.toBe("needs-replan");
    }

    // The refusal line that RUFU-291 emitted every ~45 s for 1h42m is gone from this path.
    expect(refusalLines(store)).toHaveLength(0);
    expect(auditRows(store).filter((row: any) => row.mutationType === "task:execution-rearmed")).toHaveLength(1);
  });

  /**
   * The negative control Step 5 demands: an implementation that only logs the resume, clears
   * `status`/`error`, and archives the failed step rows must FAIL here. It is written as the
   * store-shaped consequence of the rule rather than as a mock of that hypothetical branch, because
   * the rule is a property of the REAL seam: the seed is what earns the badge-clear, so a pass that
   * cannot install the seed must leave every marker exactly where the disposal left them. A version
   * that cleared the badges first would silently produce RUFU-291's badge-clean, undispatched card.
   */
  it("negative control: no seed means no badge-clear, so a state-clear-only branch is impossible", async () => {
    resetContainmentRefusalLogForTesting();
    const prover = makeProver("occupied");
    const { store, state } = makeStore(strandedTask());
    // The only capability removed is the sanctioned re-entry writer. Evidence, lane, and steps all
    // say "re-arm me", so this isolates the seed as the thing the branch stands on.
    store.replaceActiveTaskWorkflowContinuation = vi.fn(async () => {
      throw new Error("continuation store unavailable");
    });
    const clearTerminalStepFailuresForRetry = vi.fn(async () => undefined);
    const deps = makeDeps(store, prover, { clearTerminalStepFailuresForRetry });

    // Declined, so `handleGraphFailure` keeps its visible terminalize instead of being short-circuited.
    await expect(runFailure(deps, state.current)).resolves.toBe(false);

    // No silent state-clear of any kind: neither the marker write nor the step-failure archival ran.
    const clearingPatches = state.patches.filter(
      (patch) => patch.status === null || patch.error === null || "workflowStepResults" in patch,
    );
    expect(clearingPatches).toEqual([]);
    expect(clearTerminalStepFailuresForRetry).not.toHaveBeenCalled();
    expect(state.current.status).toBeNull();
    expect(state.current.error).toBe(STUCK_ERROR);

    // Nothing dispatchable was installed, and no lane moved — the refusal is the whole result.
    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(1);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.moveTaskIf).not.toHaveBeenCalled();
    expect(state.current.column).toBe(WIP);
    // The pass is still COUNTED, which is what keeps a permanently unseedable card from looping: the
    // next pass climbs the same ladder toward the one terminal park.
    expect(readExecutionRarmMarker(state.current)?.attempt).toBe(1);
    // And the operator still gets the refusal line this path has always written.
    expect(refusalLines(store)).toHaveLength(1);
  });

  it("holds one terminal notice and one refusal line across a full evidence-less recovery cycle", async () => {
    resetContainmentRefusalLogForTesting();
    const prover = makeProver("empty");
    const { store, state } = makeStore(strandedTask());
    const deps = makeDeps(store, prover);

    // Each pass re-observes the SAME unchanged card: recovery's own ladder write is not part of the
    // evidence signature, so the loop is counted rather than reset by its own bookkeeping.
    const claimed: boolean[] = [];
    const dispatchable: boolean[] = [];
    for (let pass = 0; pass <= MAX_EXECUTION_REARM_REFUSALS + 1; pass += 1) {
      const handled = await runFailure(deps, state.current) === true;
      claimed.push(handled);
      // A pass may only claim the card if the card is genuinely in flight (a runnable row) or provably
      // parked. Anything else is the silent-idle shape this task forbids.
      dispatchable.push(handled
        ? state.current.status === "failed"
          && String(state.current.error ?? "").startsWith(EXECUTION_REARM_EXHAUSTED_PREFIX)
        : true);
    }

    // Every pre-park pass declined (caller terminalizes as today); only the park and its aftermath
    // claim the card, and each of those passes finds the terminal park standing on the row.
    expect(claimed.slice(0, MAX_EXECUTION_REARM_REFUSALS)).toEqual(
      new Array(MAX_EXECUTION_REARM_REFUSALS).fill(false),
    );
    expect(claimed.slice(MAX_EXECUTION_REARM_REFUSALS).every(Boolean)).toBe(true);
    expect(dispatchable.every(Boolean)).toBe(true);
    // Terminalized exactly once, with the notice the operator can act on.
    const parks = state.patches.filter((patch) => String(patch.error ?? "").startsWith(EXECUTION_REARM_EXHAUSTED_PREFIX));
    expect(parks).toHaveLength(1);
    expect(state.current.status).toBe("failed");
    expect(store.logEntryOnce).toHaveBeenCalledTimes(1);
    expect(store.logEntryOnce).toHaveBeenCalledWith(
      state.current.id,
      expect.objectContaining({ outcome: "execution-rearm-exhausted" }),
    );
    // The loop is bounded where RUFU-291's was not: the card's History carries the refusal ONCE for
    // the unchanged card state, not once per ~45 s poll (RUFU-291 wrote this line ~140 times).
    expect(refusalLines(store)).toHaveLength(1);

    // A further pass against the standing park changes nothing at all: no second notice, no re-ladder.
    const auditsBefore = auditRows(store).length;
    const noticesBefore = store.logEntryOnce.mock.calls.length;
    await runFailure(deps, state.current);
    expect(store.logEntryOnce).toHaveBeenCalledTimes(noticesBefore);
    expect(auditRows(store).filter((row: any) => row.mutationType === "task:execution-rearm-exhausted")).toHaveLength(1);
    expect(auditRows(store)).toHaveLength(auditsBefore);
  });

  it("grants the stranded fallback the same re-entry: a claimable continuation, not a silent no-op", async () => {
    const { store, state } = makeStore(strandedTask());
    const prover = makeProver("occupied");

    // The stranded arm names the pending step's owner even with no node reference on the card.
    await expect(resolveStrandedStepExecuteNode(store, await store.getTask(state.current.id))).resolves.toBe(OWNER_NODE);

    const result = await attemptExecutionRearm(
      { store, emptinessProver: prover as any },
      { taskId: state.current.id, failedNode: OWNER_NODE, wipColumn: WIP, reason: "stranded-continuation" },
    );

    expect(result.outcome).toBe("rearmed");
    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledWith(expect.objectContaining({
      taskId: state.current.id,
      nodeId: OWNER_NODE,
      kind: "task",
      state: "runnable",
      onlyIfNoActiveTaskContinuation: true,
    }));
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(state.current.column).toBe(WIP);
  });
});
