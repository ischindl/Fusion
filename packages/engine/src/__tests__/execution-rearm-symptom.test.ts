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
import { buildManualRetryResetPatch } from "@fusion/core";
import { cleanupMergeStateForReverification } from "../executor/cleanup-merge-state.js";
import { routeGraphFailureToExecutionResume } from "../executor/route-graph-failure-to-execution-resume.js";
import { resetContainmentRefusalLogForTesting } from "../execution/lifecycle-move.js";
import { applyTaskPatch } from "./fixtures/task-patch-store.js";
import {
  EXECUTION_REARM_EXHAUSTED_PREFIX,
  MAX_EXECUTION_REARM_ATTEMPTS,
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
function makeStore(task: any) {  let current = task;
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
      current = applyTaskPatch(current, patch);
      return current;
    }),
    updateTaskAtomic: vi.fn(async (_id: string, reducer: (value: any) => any) => {
      const patch = reducer(current);
      if (!patch) return null;
      state.patches.push(patch);
      current = applyTaskPatch(current, patch);
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

/*
FNXC:ExecutionReArmCeiling 2026-11-13-22:17 (RUFU-1027):
The ceiling existed only on paper. Measured on production RunFusion over 24 h: 327
`task:execution-rearmed` rows for RUFU-278, EVERY one with `attempt: 1`, and zero
`task:execution-rearm-exhausted` — the card re-entered the same failing node every ~5 minutes while
holding a WIP slot, and the second holder of the same latch (RUFU-593) had 17.

Two causes, both measured on the live row, and the task's own spec named only the second one. The
live marker read `attempt: 1` with `firstAt === at` while its `signature` carried the SAME
`status:failed`, the SAME error sentence and the SAME step statuses as the pass before it — so the
counter itself was not surviving to be compared. Cause 1 is storage: the register sits inside
`mergeDetails`, and `cleanupMergeStateForReverification` writes `mergeDetails: null` on the very path
this card walks every cycle (`Executor detected stale merge state …` precedes every re-arm in its
History), so a legitimate merge cleanup erased the counter. Cause 2 is keying: `rearmSignature` keyed
the episode on the live `status`/`error` columns that the same cleanup and the successful re-arm path
both clear, so even a surviving marker would compute `unchanged = false`.

Fixing only the key would therefore leave the loop running: a wiped register restarts at 1 no matter
how the key is computed. This test drives BOTH halves — the cleanup that nulls `mergeDetails` and the
new failure that re-stamps the badges — because asserting only the keying would pin a fiction.

The assertion the fix must satisfy is the growth, not the count: 1,2,3,4 then ONE exhaustion row and
ONE park, with the fifth re-arm refused. Asserting only "attempt is 1" is what let the defect ship.
*/
describe("RUFU-1027: the declared re-arm ceiling must be reachable", () => {
  it("counts 1..4 over repeated identical failures, then terminalizes exactly once", async () => {
    resetContainmentRefusalLogForTesting();
    const { store, state } = makeStore(strandedTask({ status: "failed", error: STUCK_ERROR }));
    const deps = makeDeps(store, makeProver("occupied"));

    for (let cycle = 0; cycle <= MAX_EXECUTION_REARM_ATTEMPTS; cycle++) {
      // The stale-merge-state cleanup this card really hits every cycle: the whole column is nulled,
      // and the badges go with it (measured: `mergeDetails: null, status: null, error: null`).
      state.current = { ...state.current, mergeDetails: null, status: null, error: null };
      // The next dispatch fails again at the SAME node, wearing the SAME error sentence.
      state.current = { ...state.current, status: "failed", error: STUCK_ERROR };
      await runFailure(deps, state.current);
    }

    const rows = auditRows(store);
    const rearmAttempts = rows
      .filter((row: any) => row.mutationType === "task:execution-rearmed")
      .map((row: any) => row.metadata.attempt);
    expect(rearmAttempts).toEqual([1, 2, 3, 4]);

    const exhausted = rows.filter((row: any) => row.mutationType === "task:execution-rearm-exhausted");
    expect(exhausted).toHaveLength(1);

    const parks = state.patches.filter((patch: any) =>
      String(patch.error ?? "").startsWith(EXECUTION_REARM_EXHAUSTED_PREFIX));
    expect(parks).toHaveLength(1);

    expect(state.current.column).toBe(WIP);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });
});


/*
FNXC:ExecutionReArmCeiling 2026-11-14-16:20 (RUFU-1028):
RUFU-1027 made the ceiling reachable; these pin that it HOLDS. The shipped RUFU-1027 test above re-wears the
same error sentence on every cycle, which is exactly the assumption the old guard rested on — and production
does not honour it. Measured on RUFU-583 (2026-11-14): `attempt 4/4` at 15:49:50, `5/4 EXHAUSTED` at 15:52:54,
`attempt 1/4` again at 15:55:57, 44 grants by 16:04, with the card's own episode row showing `firstAt` moving
forward twice. The re-dispatch that followed the park was an `overseer:intervention action:"retry"`.

Each test below takes the park's announcement away the way a real writer does, then asks the same question
again, and asserts the answer is still "exhausted" with the episode untouched.
*/
describe("RUFU-1028: the terminal park must survive writers that do not own it", () => {
  function rearmDeps(store: any, verdict = "occupied") {
    return { store, emptinessProver: makeProver(verdict) as any, getRunContextFor: () => undefined } as any;
  }

  function rearm(deps: any, state: any) {
    return attemptExecutionRearm(deps, {
      taskId: state.current.id, failedNode: OWNER_NODE, wipColumn: WIP, reason: "step-failed",
    });
  }

  function rearmRows(store: any) {
    return auditRows(store).filter((row: any) => row.mutationType === "task:execution-rearmed");
  }

  function exhaustedRows(store: any) {
    return auditRows(store).filter((row: any) => row.mutationType === "task:execution-rearm-exhausted");
  }

  function disturbedRows(store: any) {
    return auditRows(store).filter((row: any) => row.mutationType === "task:execution-rearm-park-marker-cleared");
  }

  /** Drive to exhaustion without re-wearing the exhausted sentence, which is what production does. */
  async function driveToPark(deps: any, state: any) {
    for (let cycle = 0; cycle <= MAX_EXECUTION_REARM_ATTEMPTS; cycle++) {
      state.current = { ...state.current, status: "failed", error: STUCK_ERROR };
      await rearm(deps, state);
    }
  }

  it("holds the park across three real merge resets that remove its row-level announcement", async () => {
    resetContainmentRefusalLogForTesting();
    const { store, state } = makeStore(strandedTask({ status: "failed", error: STUCK_ERROR }));
    const deps = rearmDeps(store);
    await driveToPark(deps, state);

    const parked = readExecutionRarmMarker(state.current)!;
    expect(parked.heldAt).not.toBeNull();
    const grantsBefore = rearmRows(store).length;
    expect(grantsBefore).toBe(MAX_EXECUTION_REARM_ATTEMPTS);
    expect(exhaustedRows(store)).toHaveLength(1);

    const cleanupDeps = { store, getRunContextFor: () => undefined } as any;
    for (let pass = 0; pass < 3; pass++) {
      // The real cleanup, not a hand-written patch: it nulls `mergeDetails` and both badges in one statement.
      state.current = await cleanupMergeStateForReverification(
        cleanupDeps, state.current,
        "Executor detected stale merge state while task was in-progress — reset verification steps and merge metadata before resuming",
        { resetSource: "execute-preflight" },
      );
      expect(state.current.status).toBeNull();
      expect(state.current.error).toBeNull();

      const again = await rearm(deps, state);
      expect(again.outcome).toBe("budget-exhausted");
    }

    // No further grants, no second park, and the episode is byte-identical — the RUFU-583 restart is gone.
    expect(rearmRows(store)).toHaveLength(grantsBefore);
    expect(exhaustedRows(store)).toHaveLength(1);
    const after = readExecutionRarmMarker(state.current)!;
    expect(after.firstAt).toBe(parked.firstAt);
    expect(after.heldAt).toBe(parked.heldAt);
    expect(after.attempt).toBe(parked.attempt);
    expect(after.questionStamp).toBe(parked.questionStamp);
    expect(store.moveTask).not.toHaveBeenCalled();

    // Step 3: three resets, ONE announcement. `logEntryOnce` is the dedupe authority, and the audit row
    // follows only when that write was appended.
    expect(disturbedRows(store)).toHaveLength(1);
    expect(disturbedRows(store)[0].metadata).toMatchObject({
      outcome: "marker-cleared",
      observedFrom: "merge-reset",
      resetSource: "execute-preflight",
      parkHeld: true,
      attemptLimit: MAX_EXECUTION_REARM_ATTEMPTS,
      refusalLimit: MAX_EXECUTION_REARM_REFUSALS,
    });
    // Six observations (three resets + three claims) and ONE audit row, which is the pair that proves the
    // bound: the append is what the row follows. The dedupe key must carry no growing counter, or every pass
    // would be a fresh "first" announcement (RUFU-442).
    const disturbanceKeys = store.logEntryOnce.mock.calls
      .filter((call: any[]) => call[1]?.outcome === "execution-rearm-park-marker-cleared")
      .map((call: any[]) => `${call[0]}|${call[1].dedupeKey}|${call[1].windowMs}`);
    expect(disturbanceKeys).toHaveLength(6);
    expect(new Set(disturbanceKeys)).toEqual(
      new Set([`${state.current.id}|execution-rearm-park-marker-cleared:${state.current.id}|${6 * 60 * 60 * 1000}`]),
    );
  });

  it("holds the park when another failure sentence replaces the exhausted one (graph-failure shape)", async () => {
    resetContainmentRefusalLogForTesting();
    const { store, state } = makeStore(strandedTask({ status: "failed", error: STUCK_ERROR }));
    const deps = rearmDeps(store);
    await driveToPark(deps, state);
    const parked = readExecutionRarmMarker(state.current)!;
    const grantsBefore = rearmRows(store).length;

    for (let pass = 0; pass < 3; pass++) {
      state.current = { ...state.current, status: "failed", error: "TypeError: boom raised by an unrelated node" };
      const again = await rearm(deps, state);
      expect(again.outcome).toBe("budget-exhausted");
    }

    expect(rearmRows(store)).toHaveLength(grantsBefore);
    expect(exhaustedRows(store)).toHaveLength(1);
    const after = readExecutionRarmMarker(state.current)!;
    expect(after.firstAt).toBe(parked.firstAt);
    expect(after.heldAt).toBe(parked.heldAt);
    // Replacing the exhausted sentence DOES remove the park's row-level announcement, so the disturbance is
    // real and must be recorded — once, from the claim seam, with no reset to blame.
    const disturbed = disturbedRows(store);
    expect(disturbed).toHaveLength(1);
    expect(disturbed[0].metadata).toMatchObject({ observedFrom: "rearm-claim", resetSource: "unknown", parkHeld: true });
  });

  it("releases for genuine step-ledger progress but NOT for an evidence-token flip", async () => {
    resetContainmentRefusalLogForTesting();
    const { store, state } = makeStore(strandedTask({ status: "failed", error: STUCK_ERROR }));
    await driveToPark(rearmDeps(store), state);
    const parked = readExecutionRarmMarker(state.current)!;

    // The worktree probe changing its mind is a transient, not a new question. `signature` carries the
    // verdict, so a guard keyed on the signature alone would hand this card a fresh four-attempt ladder.
    const flipped = await attemptExecutionRearm(rearmDeps(store, "unproven"), {
      taskId: state.current.id, failedNode: OWNER_NODE, wipColumn: WIP, reason: "step-failed",
    });
    expect(flipped.outcome).toBe("budget-exhausted");
    expect(readExecutionRarmMarker(state.current)!.heldAt).toBe(parked.heldAt);

    // Real forward movement in the durable ledger IS a different question, and the park answers the old one.
    state.current = {
      ...state.current,
      status: null,
      error: null,
      steps: state.current.steps.map((step: any, index: number) =>
        index === 1 ? { ...step, status: "done" } : index === 2 ? { ...step, status: "in-progress" } : step),
    };
    const fresh = await rearm(rearmDeps(store), state);
    expect(fresh.outcome).toBe("rearmed");
    const next = readExecutionRarmMarker(state.current)!;
    expect(next.attempt).toBe(1);
    expect(next.heldAt).toBeNull();
    // `firstAt` is deliberately not asserted: the fake clock has no seam, and comparing two `new Date()`
    // reads inside one event loop turn is a flake waiting to happen. The episode identity is the assertion.
    expect(next.questionStamp).not.toBe(parked.questionStamp);
  });

  it("restarts the ladder only through the real operator Retry patch", async () => {
    resetContainmentRefusalLogForTesting();
    const { store, state } = makeStore(strandedTask({ status: "failed", error: STUCK_ERROR }));
    const deps = rearmDeps(store);
    await driveToPark(deps, state);
    expect(readExecutionRarmMarker(state.current)!.heldAt).not.toBeNull();

    // The park's release authority: `buildManualRetryResetPatch` nulls the episode key at KEY level.
    state.current = applyTaskPatch(state.current, buildManualRetryResetPatch() as any);
    expect(readExecutionRarmMarker(state.current)).toBeUndefined();

    const restarted = await rearm(deps, state);
    expect(restarted.outcome).toBe("rearmed");
    expect(readExecutionRarmMarker(state.current)!.attempt).toBe(1);
  });

  it("keeps today's non-rearm answers for a pause and a lane exit", async () => {
    resetContainmentRefusalLogForTesting();
    const { store, state } = makeStore(strandedTask({ status: "failed", error: STUCK_ERROR }));
    const deps = rearmDeps(store);
    await driveToPark(deps, state);

    state.current = { ...state.current, paused: true };
    expect((await rearm(deps, state)).outcome).toBe("not-eligible");

    state.current = { ...state.current, paused: false, column: REVIEW };
    expect((await rearm(deps, state)).outcome).toBe("not-eligible");
    expect(store.updateTask).not.toHaveBeenCalledWith(
      state.current.id, expect.objectContaining({ status: "failed", error: expect.stringContaining("another") }));
  });

  /*
   * THE AMNESIA PATH IS GONE, BY CONSTRUCTION. The old code did not need a new failure to restart a spent
   * ladder: it only needed `heldAt != null` to make `unchanged` false, which rewrote `attempt` to 1, `firstAt`
   * to now, and `heldAt` to null. Every badge shape below is a row a production writer can leave behind — the
   * merge reset nulls both, a fresh graph run wears its own sentence, and containment re-labels the card. None
   * of them may buy a fresh attempt now.
   */
  it("cannot be talked back to attempt 1 by any badge shape", async () => {
    const badgeShapes: Array<{ label: string; row: (t: any) => any }> = [
      { label: "both badges cleared by the merge reset", row: (t) => ({ ...t, status: null, error: null }) },
      { label: "a different failure sentence", row: (t) => ({ ...t, status: "failed", error: "Execution failed: something else entirely" }) },
      { label: "no status, exhausted sentence kept", row: (t) => ({ ...t, status: null }) },
      { label: "failed with no sentence at all", row: (t) => ({ ...t, status: "failed", error: null }) },
    ];

    for (const shape of badgeShapes) {
      resetContainmentRefusalLogForTesting();
      const { store, state } = makeStore(strandedTask({ status: "failed", error: STUCK_ERROR }));
      const deps = rearmDeps(store);
      await driveToPark(deps, state);
      const grantsBefore = rearmRows(store).length;
      const parked = readExecutionRarmMarker(state.current)!;

      state.current = shape.row(state.current);
      const pass = await rearm(deps, state);
      expect(pass.outcome, shape.label).toBe("budget-exhausted");
      expect(rearmRows(store), shape.label).toHaveLength(grantsBefore);
      const after = readExecutionRarmMarker(state.current)!;
      expect(after.attempt, shape.label).toBe(parked.attempt);
      expect(after.firstAt, shape.label).toBe(parked.firstAt);
      expect(after.heldAt, shape.label).toBe(parked.heldAt);
    }
  });
});
