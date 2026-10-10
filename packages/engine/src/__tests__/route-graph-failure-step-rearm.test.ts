/**
 * RUFU-308 regression: a stuck-session disposal must be followed by an attempt to re-arm the SAME node
 * and step, or by one terminalized park with an operator notice — never by an unbounded
 * "retained in 'in-progress', no backward-move authority" cycle.
 *
 * Measured on RUFU-291 (main tip 5b7cdd962b): Step 1 was in progress with four commits already in its
 * worktree when the session was disposed at 00:21; the graph failed with `step-failed` at
 * `steps#1:step-execute`, the resume router refused because the card was already in `in-progress`, and
 * from 00:23 to ~02:40 the card logged the same containment refusal every ~45 s until a human paused and
 * unpaused it. The work was never at risk; only the re-entry authority was missing.
 *
 * The invariant asserted here is therefore about AUTHORITY, not about lanes: a re-arm may install a
 * runnable continuation and clear the execution markers, and may do so with no `moveTask` call and no
 * column change at all — while the refusal path that terminalizes an evidence-less card keeps working.
 */
import { describe, expect, it, vi } from "vitest";
import { routeGraphFailureToExecutionResume } from "../executor/route-graph-failure-to-execution-resume.js";
/* RUFU-308 Step 3: the containment-refusal dedupe moved next to the refusal line it bounds. */
import { resetContainmentRefusalLogForTesting } from "../execution/lifecycle-move.js";
import {
  MAX_EXECUTION_REARM_ATTEMPTS,
  readExecutionRarmMarker,
  resolveStrandedStepExecuteNode,
} from "../executor/execution-rearm.js";

const WIP = "in-progress";
const REVIEW = "in-review";
const STUCK_ERROR = "Task terminated due to stuck agent session (reason=inactivity, no progress for ~27min)";
const FAILED_NODE = "steps#1:step-execute";

/** The RUFU-291 shape: 5 steps done, Step 1 in progress with committed work, graph failed at that step. */
function strandedTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "RUFU-291-shape",
    title: "stranded after stuck-session disposal",
    description: "",
    prompt: "# task",
    column: WIP,
    status: "failed" as string | null,
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
      { workflowStepId: "steps#1:step-execute", status: "failed", source: "node" },
    ],
    dependencies: [],
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
    ...overrides,
  } as any;
}

/** A foreach template IR whose per-step instance is the node that just failed. */
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

function makeStore(task: any) {
  let current = task;  const state = {
    get current() {
      return current;
    },
    set current(value: any) {
      current = value;
    },
    patches: [] as Array<Record<string, unknown>>,
  };
  const store = {
    getTask: vi.fn(async () => current),
    getRootDir: () => "/repo",
    getSettings: vi.fn(async () => ({ integrationBranch: "main" })),
    getTaskWorkflowSelection: () => ({ workflowId: "builtin:stepwise-coding", stepIds: [] }),
    getWorkflowDefinition: async () => ({ ir: STEPWISE_IR }),
    // The evidence seam under test: production resolves an integration branch, then proves per repo.
    replaceActiveTaskWorkflowContinuation: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    logEntryOnce: vi.fn(async () => true),
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
    checkoutEmptinessProver: prover,
    ...extra,
  } as any;
}

/**
 * Prover stand-in keyed by the singular checkout's lookup key (`""`). The verdict enum is the whole
 * contract of the evidence gate, so no test in this file needs a real worktree or a real git call.
 */
function makeProver(...verdicts: string[]): { proveTask: ReturnType<typeof vi.fn> } {
  let index = 0;
  return {
    proveTask: vi.fn(async () => new Map([["", verdicts[Math.min(index++, verdicts.length - 1)]]])),
  };
}

/**
 * Per-repository prover for workspace cards: each pass returns the verdict map at the given index
 * (the last one repeats), so a multi-repo card can be proven `empty` in one repository and `occupied`
 * in another without any git call.
 */
function makeProverEntries(...passes: Array<Record<string, string>>): { proveTask: ReturnType<typeof vi.fn> } {
  let index = 0;
  return {
    proveTask: vi.fn(async (_task: unknown, _ctx: unknown) => new Map(Object.entries(passes[Math.min(index++, passes.length - 1)]))),
  };
}

/** A workspace card: two retained member checkouts, no singular worktree. */
function workspaceTask(overrides: Record<string, unknown> = {}) {
  return strandedTask({
    worktree: null,
    workspaceWorktrees: {
      "packages/alpha": { worktreePath: ".fusion/worktrees/rufu-291/packages/alpha", branch: "fusion/rufu-291", baseCommitSha: "5b7cdd962b" },
      "packages/beta": { worktreePath: ".fusion/worktrees/rufu-291/packages/beta", branch: "fusion/rufu-291", baseCommitSha: "5b7cdd962b" },
    },
    ...overrides,
  });
}

/** Runs one disposal cycle: the card is stranded, the graph fails at its in-progress step. */
function runFailure(deps: any, task: any) {
  return routeGraphFailureToExecutionResume(deps, task, FAILED_NODE, "step-failed", undefined, undefined, STUCK_ERROR);
}

describe("RUFU-308 execution re-arm at the graph-failure router", () => {
  it("re-arms the failed step in place instead of refusing, with no move and no lane change", async () => {
    resetContainmentRefusalLogForTesting();
    const prover = makeProver("occupied");
    const { store, state } = makeStore(strandedTask());
    const deps = makeDeps(store, prover);
    const task = state.current;

    await expect(runFailure(deps, task)).resolves.toBe(true);

    // The re-entry itself: a runnable task continuation at the node that just failed.
    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(1);
    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task.id,
      nodeId: FAILED_NODE,
      kind: "task",
      state: "runnable",
      onlyIfNoActiveTaskContinuation: true,
      blockedReason: "execution-rearm:step-failed",
    }));

    // Nothing moved: containment governs lane changes, and a re-arm makes none.
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.moveTaskIf).not.toHaveBeenCalled();
    expect(state.current.column).toBe(WIP);
    expect(state.current.status).toBeNull();
    expect(state.current.error).toBeNull();

    // The refusal that fired every ~45 s on RUFU-291 is gone from this path.
    expect(store.logEntry).not.toHaveBeenCalledWith(
      task.id,
      expect.stringContaining("automatic recovery cannot move"),
      expect.anything(),
      expect.anything(),
    );
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("Execution re-arm"), undefined, undefined);

    // Durable visibility: the re-arm writes no lifecycle row, so the audit row is the record.
    const audit = store.recordRunAuditEvent.mock.calls.map((call: any[]) => call[0]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      taskId: task.id,
      target: task.id,
      domain: "database",
      mutationType: "task:execution-rearmed",
      metadata: expect.objectContaining({ nodeId: FAILED_NODE, reason: "step-failed", attempt: 1, evidence: "occupied" }),
    });

    // The step plan is untouched — re-entering a step is not replanning it.
    expect(state.current.steps.map((step: any) => step.status)).toEqual(["done", "in-progress", "pending"]);
    // Neither replan nor stranded-retry counter is written: those are other ladders' currencies, and
    // mixing them would make a re-arm look like a plan defect or buy extra stranded-recovery budget.
    expect(state.current.recoveryRetryCount).toBeUndefined();
    for (const patch of state.patches) {
      expect(patch).not.toHaveProperty("recoveryRetryCount");
      expect(patch).not.toHaveProperty("column");
      expect(patch.status).not.toBe("needs-replan");
    }
  });

  it("keeps the pre-existing refusal and terminal park when the worktree proves nothing", async () => {
    resetContainmentRefusalLogForTesting();
    const prover = makeProver("empty");
    const { store, state } = makeStore(strandedTask());
    const deps = makeDeps(store, prover);

    await expect(runFailure(deps, state.current)).resolves.toBe(false);

    // No evidence, no re-entry: the caller stays entitled to park the card `failed`.
    expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(state.current.column).toBe(WIP);
    expect(state.current.status).toBe("failed");
    expect(store.logEntry).toHaveBeenCalledWith(
      state.current.id,
      expect.stringContaining("automatic recovery cannot move 'in-progress' backward"),
      undefined,
      undefined,
    );
    // The refusal still counts against the ladder, which is what bounds the loop.
    expect(readExecutionRarmMarker(state.current)?.refusal).toBe(1);
  });

  it("treats an unprovable checkout as no evidence rather than as a license to re-arm", async () => {
    resetContainmentRefusalLogForTesting();
    const prover = makeProver("unknown");
    const { store, state } = makeStore(strandedTask());

    await expect(runFailure(makeDeps(store, prover), state.current)).resolves.toBe(false);
    expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
  });

  it("declines a card under a human hold without claiming, moving, or clearing anything", async () => {
    resetContainmentRefusalLogForTesting();
    const prover = makeProver("occupied");
    const { store, state } = makeStore(strandedTask({ userPaused: true }));

    await expect(runFailure(makeDeps(store, prover), state.current)).resolves.toBe(false);

    expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(state.current.status).toBe("failed");
    expect(state.current.error).toBe(STUCK_ERROR);
  });

  it("declines a failed node that is not step execution, leaving review-lane owners in charge", async () => {
    resetContainmentRefusalLogForTesting();
    const prover = makeProver("occupied");
    const { store, state } = makeStore(strandedTask());
    const deps = makeDeps(store, prover);

    await expect(routeGraphFailureToExecutionResume(
      deps, state.current, "steps#1:step-review", "step-failed", undefined, undefined, STUCK_ERROR,
    )).resolves.toBe(false);

    expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
  });

  it("bounds repeated identical cycles: after the attempt budget the card terminalizes once with a notice", async () => {
    resetContainmentRefusalLogForTesting();
    const prover = makeProver("occupied");
    const { store, state } = makeStore(strandedTask());
    const deps = makeDeps(store, prover);

    // Each pass is one disposal cycle: the re-armed run fails again at the same step with the same
    // markers, which is what makes the evidence signature — and therefore the budget — meaningful.
    const claimed: boolean[] = [];
    for (let cycle = 0; cycle < MAX_EXECUTION_REARM_ATTEMPTS + 1; cycle += 1) {
      // Each pass begins where the previous disposal left the card: the same failed step and markers.
      if (cycle > 0) state.current = { ...state.current, status: "failed", error: STUCK_ERROR };
      claimed.push(await runFailure(deps, state.current));
    }

    expect(claimed.slice(0, MAX_EXECUTION_REARM_ATTEMPTS)).toEqual(
      Array.from({ length: MAX_EXECUTION_REARM_ATTEMPTS }, () => true),
    );
    // The exhausted pass is still claimed: the re-arm seam wrote the park itself, so the caller must not
    // add a second, different terminal disposition on top of the announced one.
    expect(claimed.at(-1)).toBe(true);

    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(MAX_EXECUTION_REARM_ATTEMPTS);
    expect(state.current.status).toBe("failed");
    expect(state.current.error).toContain("EXECUTION_REARM_EXHAUSTED:");
    expect(state.current.column).toBe(WIP);
    expect(store.logEntryOnce).toHaveBeenCalledTimes(1);
    expect(readExecutionRarmMarker(state.current)?.heldAt).toBeTruthy();

    const audit = store.recordRunAuditEvent.mock.calls.map((call: any[]) => call[0]);
    expect(audit.at(-1)).toMatchObject({
      mutationType: "task:execution-rearm-exhausted",
      metadata: expect.objectContaining({ attemptLimit: MAX_EXECUTION_REARM_ATTEMPTS, outcome: "exhausted", reason: "no-progress" }),
    });
    // Bounded, not silent: exactly one exhaustion notice for the whole episode, never hundreds of lines.
    expect(audit.filter((row: any) => row.mutationType === "task:execution-rearm-exhausted")).toHaveLength(1);
  });

  it("re-arms a card the FN-9359 retryStep fallback cannot even see", async () => {
    resetContainmentRefusalLogForTesting();
    const prover = makeProver("occupied");
    // The stuck-session disposal clears the execution markers before the graph run reports failure, so
    // the card reaches recovery badge-clean: `retryStep` requires status === "failed" and would refuse
    // it. The re-arm must not depend on the marker the disposal just erased.
    const { store, state } = makeStore(strandedTask({ status: null, error: null }));
    const deps = makeDeps(store, prover);

    await expect(runFailure(deps, state.current)).resolves.toBe(true);

    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(1);
    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: FAILED_NODE, state: "runnable" }),
    );
    expect(state.current.column).toBe(WIP);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("keeps the failure markers when the seed itself is refused — authority first, cosmetics second", async () => {
    resetContainmentRefusalLogForTesting();
    const prover = makeProver("occupied");
    const { store, state } = makeStore(strandedTask());
    store.replaceActiveTaskWorkflowContinuation = vi.fn(async () => {
      throw new Error("continuation slot unavailable");
    });

    await expect(runFailure(makeDeps(store, prover), state.current)).resolves.toBe(false);

    // A refused seed means there is NO re-entry, so the card must keep the failure it arrived with —
    // clearing it would leave the badge clean with nothing scheduled, which is the RUFU-291 dead card.
    expect(state.current.status).toBe("failed");
    expect(state.current.error).toBe(STUCK_ERROR);
    expect(store.logEntry).toHaveBeenCalledWith(
      state.current.id,
      expect.stringContaining("automatic recovery cannot move 'in-progress' backward"),
      undefined,
      undefined,
    );
    // The pass still counted as a real attempt, because the evidence was there.
    expect(readExecutionRarmMarker(state.current)?.attempt).toBe(1);
  });

  it("claims the card when only the marker clear fails, because the seed already restored re-entry", async () => {
    resetContainmentRefusalLogForTesting();
    const prover = makeProver("occupied");
    const { store, state } = makeStore(strandedTask());
    const seedCall = store.replaceActiveTaskWorkflowContinuation;
    let updateCalls = 0;
    store.updateTask = vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      updateCalls += 1;
      // The ladder write (updateTaskAtomic) is separate; only the post-seed clear can fail here.
      if ("status" in patch && patch.status === null) throw new Error("write conflict");
      state.current = { ...state.current, ...patch };
      return state.current;
    });

    await expect(runFailure(makeDeps(store, prover), state.current)).resolves.toBe(true);

    expect(seedCall).toHaveBeenCalledTimes(1);
    expect(updateCalls).toBeGreaterThan(0);
    // The card stays runnable through the continuation even though its error text survives, and the
    // History line says so instead of pretending the marker is gone.
    expect(store.logEntry).toHaveBeenCalledWith(
      state.current.id,
      expect.stringContaining("the failure marker could not be cleared"),
      undefined,
      undefined,
    );
  });

  it("preserves every retained checkout, branch, and recorded diff across a re-arm", async () => {
    resetContainmentRefusalLogForTesting();
    const prover = makeProver("occupied");
    const { store, state } = makeStore(strandedTask({ modifiedFiles: ["packages/engine/src/self-healing.ts"] }));
    const before = structuredClone(state.current);

    await expect(runFailure(makeDeps(store, prover), state.current)).resolves.toBe(true);

    for (const patch of state.patches) {
      for (const key of ["worktree", "branch", "baseCommitSha", "modifiedFiles", "workspaceWorktrees", "sessionFile"]) {
        expect(patch).not.toHaveProperty(key);
      }
    }
    expect(state.current.worktree).toBe(before.worktree);
    expect(state.current.branch).toBe(before.branch);
    expect(state.current.baseCommitSha).toBe(before.baseCommitSha);
    expect(state.current.modifiedFiles).toEqual(before.modifiedFiles);
  });

  it("re-arms a workspace card on one occupied member repository and keeps every member binding", async () => {
    resetContainmentRefusalLogForTesting();
    // The prover's per-repository polarity is the point: `empty` in one member must not veto the
    // unmerged work in the other, and the re-arm must leave both bindings intact for the next run.
    const prover = makeProverEntries({ "packages/alpha": "empty", "packages/beta": "occupied" });
    const { store, state } = makeStore(workspaceTask());
    const bindings = structuredClone(state.current.workspaceWorktrees);

    await expect(runFailure(makeDeps(store, prover), state.current)).resolves.toBe(true);

    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(1);
    expect(state.current.workspaceWorktrees).toEqual(bindings);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("refuses a workspace card whose every member checkout is provably empty", async () => {
    resetContainmentRefusalLogForTesting();
    const prover = makeProverEntries({ "packages/alpha": "empty", "packages/beta": "empty" });
    const { store, state } = makeStore(workspaceTask());

    await expect(runFailure(makeDeps(store, prover), state.current)).resolves.toBe(false);

    expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
    expect(readExecutionRarmMarker(state.current)?.refusal).toBe(1);
  });

  it("records re-entry in audit with fixed enums only — no worktree path, diff, or error text", async () => {
    resetContainmentRefusalLogForTesting();
    const prover = makeProver("occupied");
    const { store, state } = makeStore(strandedTask({ modifiedFiles: ["packages/engine/src/self-healing.ts"] }));

    await expect(runFailure(makeDeps(store, prover), state.current)).resolves.toBe(true);

    const rows = store.recordRunAuditEvent.mock.calls.map((call: any[]) => call[0]);
    const serialized = JSON.stringify(rows.map((row: any) => ({ mutationType: row.mutationType, metadata: row.metadata })));
    expect(serialized).toContain("task:execution-rearmed");
    for (const leaked of [".fusion/worktrees", "fusion/rufu-291", "5b7cdd962b", "self-healing.ts", "stuck agent session"]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("resets the ladder on real step progress, so a re-arm never inherits another lane's budget", async () => {
    resetContainmentRefusalLogForTesting();
    const prover = makeProver("occupied");
    const { store, state } = makeStore(strandedTask());
    const deps = makeDeps(store, prover);

    await expect(runFailure(deps, state.current)).resolves.toBe(true);
    expect(readExecutionRarmMarker(state.current)).toMatchObject({ attempt: 1, refusal: 0 });

    // The re-armed run actually finished Step 1 and moved to Step 2, then stranded again. The step
    // signature — not the elapsed clock — is what makes an attempt meaningful, so the budget restarts.
    state.current = {
      ...state.current,
      status: "failed",
      error: STUCK_ERROR,
      steps: [
        { id: "0", title: "Preflight", status: "done" },
        { id: "1", title: "Implementation", status: "done" },
        { id: "2", title: "Tests", status: "in-progress" },
      ],
      workflowStepResults: [
        { workflowStepId: "steps#0:step-execute", status: "passed", source: "node" },
        { workflowStepId: "steps#1:step-execute", status: "passed", source: "node" },
        { workflowStepId: "steps#2:step-execute", status: "failed", source: "node" },
      ],
    };

    await expect(routeGraphFailureToExecutionResume(
      deps, state.current, "steps#2:step-execute", "step-failed", undefined, undefined, STUCK_ERROR,
    )).resolves.toBe(true);

    const marker = readExecutionRarmMarker(state.current);
    expect(marker).toMatchObject({ attempt: 1, refusal: 0, heldAt: null });
    expect(marker?.signature).toContain("steps#2:step-execute");
    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(2);
    // Still no replan currency: the card re-enters its own plan, it does not get a new one.
    for (const patch of state.patches) {
      expect(patch.status).not.toBe("needs-replan");
      expect(patch).not.toHaveProperty("recoveryRetryCount");
    }
  });

  it("counts a lost seed race as owned re-entry instead of escalating to a park", async () => {
    resetContainmentRefusalLogForTesting();
    const prover = makeProver("occupied");
    const { store, state } = makeStore(strandedTask());
    const contention = Object.assign(new Error("one active task continuation allowed"), {
      name: "ActiveTaskContinuationError",
    });
    store.replaceActiveTaskWorkflowContinuation = vi.fn(async () => {
      throw contention;
    });

    await expect(runFailure(makeDeps(store, prover), state.current)).resolves.toBe(true);

    // The active row owns the re-entry; escalating here would destroy a legitimate hold.
    expect(state.current.column).toBe(WIP);
    expect(store.logEntry).not.toHaveBeenCalledWith(
      state.current.id,
      expect.stringContaining("automatic recovery cannot move"),
      expect.anything(),
      expect.anything(),
    );
  });

  /*
  FNXC:ExecutionReArm 2026-10-07-16:20 (RUFU-308 Step 3):
  The spec's terminal invariant, stated as a count: N recovery passes must end in either a re-arm or
  ONE terminalized park with an operator-visible notice — never a `donekonečná` cycle. The exhaustion
  test above proves the park appears; this proves it STICKS, because a park that restarts its ladder
  after the hold re-parks and re-notifies on every ~45 s poll, which is the same defect relabelled.
  */
  it("holds one terminal park: further passes add no notice, no audit row, and no second seed", async () => {
    resetContainmentRefusalLogForTesting();
    const prover = makeProver("occupied");
    const { store, state } = makeStore(strandedTask());
    const deps = makeDeps(store, prover);

    // Burn the ladder the way the RUFU-291 loop did: same node, same step, same signature each pass.
    for (let cycle = 0; cycle <= MAX_EXECUTION_REARM_ATTEMPTS; cycle += 1) {
      if (cycle > 0) state.current = { ...state.current, status: "failed", error: STUCK_ERROR };
      await expect(runFailure(deps, state.current)).resolves.toBe(true);
    }

    const parked = state.current;
    expect(parked.status).toBe("failed");
    expect(parked.error).toContain("EXECUTION_REARM_EXHAUSTED:");
    const seeds = store.replaceActiveTaskWorkflowContinuation.mock.calls.length;
    const notices = store.logEntryOnce.mock.calls.length;
    const auditRows = store.recordRunAuditEvent.mock.calls.length;
    const exhaustedRows = () => store.recordRunAuditEvent.mock.calls
      .map((call: any[]) => call[0])
      .filter((row: any) => row.mutationType === "task:execution-rearm-exhausted");
    // Four earned attempts each recorded a re-arm, and exactly one pass terminalized.
    expect(notices).toBe(1);
    expect(exhaustedRows()).toHaveLength(1);

    // Ten more passes on the parked card (the overseer's ~45 s cadence for minutes): the answer is
    // still the existing park — no new write, no new notice, no new audit row, no new seed.
    for (let pass = 0; pass < 10; pass += 1) {
      await expect(runFailure(deps, state.current)).resolves.toBe(true);
    }

    expect(state.current).toBe(parked);
    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(seeds);
    expect(store.logEntryOnce).toHaveBeenCalledTimes(notices);
    expect(store.recordRunAuditEvent).toHaveBeenCalledTimes(auditRows);
    expect(exhaustedRows()).toHaveLength(1);
    expect(store.moveTask).not.toHaveBeenCalled();
    // The refusal line the loop used to repeat is still never written: the park replaced it.
    expect(store.logEntry).not.toHaveBeenCalledWith(
      parked.id,
      expect.stringContaining("automatic recovery cannot move"),
      expect.anything(),
      expect.anything(),
    );
  });

  /*
  FNXC:ExecutionReArm 2026-10-07-16:20 (RUFU-308 Step 3):
  A stranded card carries no `failedNode` argument — the run that owned it is over — so recovery must
  NAME the owner node from durable state, and may only ever name one. The order of trust is the graph's
  own words (the node id a terminalization wrote into `error`), then the instantiated owner of the first
  non-terminal step, then the bare template node of a non-foreach workflow; a review/merge node is never
  adopted, because re-running it would replace a real gate verdict with a step re-run.
  */
  describe("naming the owner node for an already-stranded card", () => {
    function storeWithIr(ir: unknown) {
      return {
        getTaskWorkflowSelection: () => ({ workflowId: "custom:stranded", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir }),
      } as any;
    }

    it("prefers the node the graph itself named in the error sentence", async () => {
      // Step 1 is the non-terminal step, but the graph's own words name Step 0's owner — the row's
      // step list is a fallback, never an override of what the failed run reported.
      const task = strandedTask({ error: "Workflow graph failed at node 'steps#0:step-execute' (step-failed)" });
      await expect(resolveStrandedStepExecuteNode(storeWithIr(STEPWISE_IR), task))
        .resolves.toBe("steps#0:step-execute");
    });

    it("falls back to the first non-terminal step's instantiated owner once the error is cleared", async () => {
      // The stuck-session disposal clears `status`/`error`, which is exactly why FN-9359's fence misses
      // this card — the step rows are what still say where execution stopped.
      const task = strandedTask({ status: null, error: null });
      await expect(resolveStrandedStepExecuteNode(storeWithIr(STEPWISE_IR), task))
        .resolves.toBe(FAILED_NODE);
    });

    it("uses the bare template node for a non-foreach workflow", async () => {
      const flatIr = {
        version: "v2",
        columns: [],
        nodes: [{ id: "step-execute", kind: "prompt", config: { seam: "step-execute" } }],
        edges: [],
      };
      const task = strandedTask({ status: null, error: null });
      await expect(resolveStrandedStepExecuteNode(storeWithIr(flatIr), task))
        .resolves.toBe("step-execute");
    });

    it("names nothing when only a review/merge node could answer", async () => {
      const gateIr = {
        version: "v2",
        columns: [],
        nodes: [
          { id: "code-review", kind: "prompt", config: { seam: "code-review" } },
          { id: "merge", kind: "prompt", config: { seam: "merge" } },
        ],
        edges: [],
      };
      const task = strandedTask({
        error: "Workflow graph failed at node 'code-review' (step-failed)",
        // Every step is terminal: there is no step owner left to resume, only gate verdicts.
        steps: [
          { id: "0", title: "Preflight", status: "done" },
          { id: "1", title: "Implementation", status: "done" },
        ],
      });
      await expect(resolveStrandedStepExecuteNode(storeWithIr(gateIr), task)).resolves.toBeNull();
    });

    it("names nothing when the workflow declares only a review owner for its steps", async () => {
      const reviewOnlyIr = {
        version: "v2",
        columns: [],
        nodes: [{ id: "steps", kind: "foreach", config: { source: "task-steps", template: {
          nodes: [{ id: "step-review", kind: "prompt", config: { seam: "step-review" } }],
        } } }],
        edges: [],
      };
      const task = strandedTask({ status: null, error: null });
      await expect(resolveStrandedStepExecuteNode(storeWithIr(reviewOnlyIr), task)).resolves.toBeNull();
    });

    it("never throws when the workflow definition itself is unreadable", async () => {
      // A transient store failure must not crash a recovery pass. Whether the resolver can still answer
      // from a default IR is the resolver's business; the helper's contract is that it swallows the
      // error rather than escaping with one.
      const brokenStore = {
        getTaskWorkflowSelection: () => ({ workflowId: "custom:gone", stepIds: [] }),
        getWorkflowDefinition: async () => {
          throw new Error("workflow definition unavailable");
        },
      } as any;
      const node = await resolveStrandedStepExecuteNode(brokenStore, strandedTask());
      expect(node === null || node.startsWith("steps#")).toBe(true);
    });
  });
});
