/*
FNXC:WorkflowExecutionOwnership 2026-09-15-23:05 (RUFU-237):
Regression coverage for the RUFU-217 sighting: `fn_task_done` succeeded, the row moved to review,
and ~90 s later the SAME graph dispatch's session tail resolved a `failed` disposition and the
generic graph-failure sink overwrote the delivered row with
"Workflow graph terminated with failure at node 'steps#0:step-execute'".

The sink's review-lane block (FN-9243 reroute / RUFU-217 verdict-less / remediation producers + the
benign `already advanced` return) is gated on `wipColumn !== undefined`, so a VALID workflow that
declares no `wip` column (or declares no traits at all) skips the whole block and falls through to
the terminal write. These tests pin both halves of the hole (A1/A2/B/C and A3), prove the lane is
RESOLVED rather than the `"in-review"` literal (A2), keep every non-handoff shape terminalizing
unchanged (D1–D5, F), keep the FN-9243 reroute's precedence (E — this file fails if the new guard
is placed ahead of the producers), and fence the terminal WRITE against a handoff landing mid-flight
where the `columnMovedAt` stamp is not comparable (G).

Pre-fix RED was observed first on exactly A1/A2/A3/G (the terminalizing write / terminal reducer
patch); see the RUFU-237 commit bodies for the recorded output.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBuiltinWorkflow, type Task, type TaskDetail, type WorkflowIr } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import { isHandedOffAndWorkComplete } from "../executor/task-predicates.js";

const now = "2026-09-15T00:00:00.000Z";
const WF = "custom:honor";

/** A VALID workflow declaring NO wip trait — the sink's review-lane block is skipped entirely (A1). */
function noWipIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "inbox", label: "Inbox", traits: [{ trait: "intake" }] },
      { id: "drafting", label: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

/** No wip; the review lane is RENAMED (`waiting`) — proves the lane is resolved, never hardcoded (A2). */
function renamedReviewNoWipIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "inbox", label: "Inbox", traits: [{ trait: "intake" }] },
      { id: "drafting", label: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      // The lifecycle `review` role maps to the mergeOrchestration capability (`merge` trait) —
      // the same spelling executor-graph-failure-lanes-resolved.test.ts uses for a renamed lane.
      { id: "waiting", label: "Waiting", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }, { trait: "merge" }] },
      { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

/** Untraited legacy-style board: `resolveLifecycleColumns` finds NO role at all → no wip (A3). */
function untraitedIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "inbox", label: "Inbox", traits: [] },
      { id: "drafting", label: "Drafting", traits: [] },
      { id: "in-review", label: "In Review", traits: [] },
      { id: "shipped", label: "Shipped", traits: [] },
    ],
  } as unknown as WorkflowIr;
}

/** WIP-declaring renamed board (the must-stay-green D1 shape). */
function renamedWipIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "inbox", label: "Inbox", traits: [{ trait: "intake" }] },
      { id: "drafting", label: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "building", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-RUFU237",
    title: "Honor the handoff",
    description: "graph-failure-after-handoff coverage",
    column: "in-review",
    dependencies: [],
    steps: [{ name: "Implement", status: "in-progress" }],
    currentStep: 0,
    log: [],
    branch: "fusion/fn-rufu237",
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-rufu237",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    toolFailureDetectorLogCursor: 0,
    autoMerge: true,
    mergeRetries: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

/** Harness copied from executor-execution-policy-renamed-columns.test.ts (same mock-store shape). */
function harness(options: {
  ir: WorkflowIr | undefined;
  task?: Partial<TaskDetail>;
  settings?: Record<string, unknown>;
  entries?: Array<{ type: string }>;
}) {
  const store = createMockStore();
  const task = makeTask(options.task);
  const selection = { workflowId: WF, stepIds: [] };
  store.getTask.mockResolvedValue(task);
  store.getSettings.mockResolvedValue({
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15_000,
    autoMerge: true,
    executorToolFailureRetryCount: 2,
    executorToolFailureRetryBackoffMs: 0,
    executorToolFailureThreshold: 3,
    ...options.settings,
  });
  const entries = options.entries ?? [];
  store.getAgentLogCount = vi.fn().mockResolvedValue(entries.length);
  store.getAgentLogs = vi.fn().mockResolvedValue(entries);
  store.claimNextToolFailureRetry = vi.fn().mockResolvedValue({ outcome: "exhausted" });
  store.markToolFailureRetryExhaustedAudit = vi.fn().mockResolvedValue(true);
  store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  store.getTaskWorkflowSelection = vi.fn(() => selection);
  store.getTaskWorkflowSelectionAsync = vi.fn(async () => selection);
  store.getWorkflowDefinition = vi.fn(async () => (options.ir ? { id: WF, ir: options.ir } : null));
  store.updateTask.mockImplementation(async (_id: string, patch: Partial<TaskDetail>) => Object.assign(task, patch));
  store.updateTaskAtomic = vi.fn(async (_id: string, updater: (current: TaskDetail) => Partial<TaskDetail> | null) => {
    const updates = updater(task);
    if (updates) Object.assign(task, updates);
    return task;
  });
  const executor = new TaskExecutor(store, "/tmp/test");
  (executor as any).graphToolFailureRunCursors.set(task.id, 0);
  return { executor, store, task };
}

function stepExecuteFailure() {
  return {
    disposition: "failed" as const,
    outcome: "failure" as const,
    visitedNodeIds: ["steps#0:step-execute"],
    context: { "node:steps#0:step-execute:value": "failure" },
  };
}

function executeNodeFailure() {
  return {
    disposition: "failed" as const,
    outcome: "failure" as const,
    visitedNodeIds: ["execute"],
    context: { "node:execute:value": "recoverable" },
  };
}

const HONORED = "task:graph-failure-after-handoff-honored";
const GENERIC_TERMINAL = "Workflow graph terminated with failure";

describe("RUFU-237: the generic graph-failure sink honors a completed handoff already in the review lane", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("A1 honors the RUFU-217 sighting shape (no-wip board, row in 'in-review', all steps done)", async () => {
    // Pre-fix RED (recorded): status:"failed" + generic terminal error, column kept, no audit rows.
    const { executor, store, task } = harness({
      ir: noWipIr(),
      task: { column: "in-review", steps: [{ name: "Implement", status: "done" }] },
    });

    await (executor as any).handleGraphFailure(task, stepExecuteFailure());

    expect(task.status).toBeNull();
    expect(task.error).toBeNull();
    expect(task.column).toBe("in-review");
    expect(task.steps).toEqual([{ name: "Implement", status: "done" }]);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalledWith(
      task.id,
      expect.stringContaining(GENERIC_TERMINAL),
      undefined,
      undefined,
    );
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("honoring the handoff"), undefined, undefined);
    expect(store.recordRunAuditEvent).toHaveBeenCalledTimes(1);
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task.id,
      agentId: "executor",
      domain: "database",
      mutationType: HONORED,
      target: task.id,
      // N3 (plan review): metadata stays ids + fixed enum only — pinned EXACTLY so extra prose
      // (message text, error content, token totals) can never ride along.
      metadata: { taskId: task.id, nodeId: "steps#0:step-execute", column: "in-review", reason: "work-complete-handoff" },
    }));
  });

  it("A2 honors a RENAMED review lane ('waiting'), proving the lane is resolved not hardcoded", async () => {
    // Pre-fix RED (recorded): status:"failed" + generic terminal error at node 'steps#0:step-execute'.
    const { executor, store, task } = harness({
      ir: renamedReviewNoWipIr(),
      task: { column: "waiting", steps: [{ name: "Implement", status: "done" }] },
    });

    await (executor as any).handleGraphFailure(task, stepExecuteFailure());

    expect(task.status).toBeNull();
    expect(task.error).toBeNull();
    expect(task.column).toBe("waiting");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: HONORED,
      metadata: { taskId: task.id, nodeId: "steps#0:step-execute", column: "waiting", reason: "work-complete-handoff" },
    }));
  });

  it("A2-negative the same board still terminalizes a card that is NOT in the review lane", async () => {
    const { executor, store, task } = harness({
      ir: renamedReviewNoWipIr(),
      task: { column: "drafting", steps: [{ name: "Implement", status: "done" }] },
    });

    await (executor as any).handleGraphFailure(task, stepExecuteFailure());

    expect(task).toMatchObject({
      status: "failed",
      error: "Workflow graph terminated with failure at node 'steps#0:step-execute' (failure)",
    });
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ mutationType: HONORED }));
  });

  it("A3 honors an untraited legacy board (no roles declared at all → no wip either)", async () => {
    // Pre-fix RED (recorded): same terminalizing write through the same skipped block.
    const { executor, store, task } = harness({
      ir: untraitedIr(),
      task: { column: "in-review", steps: [{ name: "Implement", status: "done" }] },
    });

    await (executor as any).handleGraphFailure(task, stepExecuteFailure());

    expect(task.status).toBeNull();
    expect(task.error).toBeNull();
    expect(task.column).toBe("in-review");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: HONORED }));
  });

  it("B honors a plain 'execute' node failure the same way (execute-family)", async () => {
    const { executor, store, task } = harness({
      ir: noWipIr(),
      task: { column: "in-review", steps: [{ name: "Implement", status: "done" }] },
    });

    await (executor as any).handleGraphFailure(task, executeNodeFailure());

    expect(task.status).toBeNull();
    expect(task.error).toBeNull();
    expect(store.logEntry).not.toHaveBeenCalledWith(task.id, expect.stringContaining(GENERIC_TERMINAL), undefined, undefined);
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: HONORED,
      metadata: { taskId: task.id, nodeId: "execute", column: "in-review", reason: "work-complete-handoff" },
    }));
  });

  it("C honors with autoMerge:false too — in-review is terminal-until-human, never rewritten", async () => {
    const { executor, store, task } = harness({
      ir: noWipIr(),
      settings: { autoMerge: false },
      task: { column: "in-review", steps: [{ name: "Implement", status: "done" }], autoMerge: false },
    });

    await (executor as any).handleGraphFailure(task, stepExecuteFailure());

    expect(task).toMatchObject({ column: "in-review", status: null, error: null });
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: HONORED }));
  });

  it("D1 a card sitting in its WIP column still terminalizes (lane mismatch, no honor)", async () => {
    const { executor, store, task } = harness({
      ir: renamedWipIr(),
      task: { column: "building", steps: [{ name: "Implement", status: "done" }] },
    });

    await (executor as any).handleGraphFailure(task, stepExecuteFailure());

    expect(task).toMatchObject({
      status: "failed",
      error: "Workflow graph terminated with failure at node 'steps#0:step-execute' (failure)",
    });
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ mutationType: HONORED }));
  });

  it("D2 review lane with an unfinished step still terminalizes (work not complete)", async () => {
    const { executor, store, task } = harness({
      ir: noWipIr(),
      task: { column: "in-review", steps: [{ name: "Implement", status: "done" }, { name: "Verify", status: "pending" }] },
    });

    await (executor as any).handleGraphFailure(task, stepExecuteFailure());

    expect(task.status).toBe("failed");
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ mutationType: HONORED }));
  });

  it("D3 review lane with userPaused:true is not honored (operator hold keeps its own semantics)", async () => {
    const { executor, store, task } = harness({
      ir: noWipIr(),
      task: { column: "in-review", steps: [{ name: "Implement", status: "done" }], userPaused: true },
    });

    await (executor as any).handleGraphFailure(task, stepExecuteFailure());

    // The terminal branch does not honor it; the write itself is then refused by the terminal
    // reducer's own userPaused fence — either way the honor path is NOT taken.
    expect(store.logEntry).not.toHaveBeenCalledWith(task.id, expect.stringContaining("honoring the handoff"), undefined, undefined);
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ mutationType: HONORED }));
  });

  it("D4 an FN-8141 BLOCKED park keeps precedence — the park classifier runs first, no honor", async () => {
    const { executor, store, task } = harness({
      ir: noWipIr(),
      task: {
        column: "in-review",
        steps: [{ name: "Implement", status: "done" }],
        status: "failed",
        error: "BLOCKED: waiting on FN-1",
      },
    });

    await (executor as any).handleGraphFailure(task, stepExecuteFailure());

    expect(task).toMatchObject({ status: "failed", error: "BLOCKED: waiting on FN-1" });
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ mutationType: HONORED }));
  });

  it("D5 predicate unit states (incl. the paused:true/userPaused:false positive)", () => {
    const clean = (overrides: Partial<TaskDetail> = {}) =>
      makeTask({ column: "in-review", steps: [{ name: "Implement", status: "done" }], ...overrides }) as Task;

    expect(isHandedOffAndWorkComplete(clean(), "in-review")).toBe(true);
    // The FN-6648 residue: the graceful completion handoff can leave paused:true.
    expect(isHandedOffAndWorkComplete(clean({ paused: true, userPaused: false }), "in-review")).toBe(true);
    expect(isHandedOffAndWorkComplete(clean({ userPaused: true }), "in-review")).toBe(false);
    expect(isHandedOffAndWorkComplete(clean({ status: "failed" }), "in-review")).toBe(false);
    expect(isHandedOffAndWorkComplete(clean({ error: "boom" }), "in-review")).toBe(false);
    expect(isHandedOffAndWorkComplete(clean({ deletedAt: now }), "in-review")).toBe(false);
    expect(isHandedOffAndWorkComplete(clean({ column: "drafting" }), "in-review")).toBe(false);
    expect(isHandedOffAndWorkComplete(clean({ steps: [{ name: "Implement", status: "pending" }] }), "in-review")).toBe(false);
    expect(isHandedOffAndWorkComplete(clean({ steps: [] }), "in-review")).toBe(false);
    expect(isHandedOffAndWorkComplete(clean(), undefined)).toBe(false);
    expect(isHandedOffAndWorkComplete(clean(), "")).toBe(false);
  });

  it("E the FN-9243 unrun-gate reroute keeps precedence over the honor guard (placement pin)", async () => {
    const codingIr = getBuiltinWorkflow("builtin:coding")!.ir;
    const live = {
      id: "FN-9243-resultless",
      title: "Resultless review gate",
      description: "",
      column: "in-review",
      status: null,
      autoMerge: true,
      worktree: "/tmp/fn-9243-resultless",
      dependencies: [],
      steps: [{ name: "Implement", status: "done" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["code-review"],
      workflowStepResults: [{ workflowStepId: "plan-review", status: "passed", reviewKind: "plan" }],
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
    } as unknown as Task;
    const seedWorkspaceCodeReviewContinuationIfIdle = vi.fn(async () => ({ seeded: true }));
    const store = Object.assign(createMockStore(), {
      getTask: vi.fn(async () => live),
      getSettings: vi.fn(async () => ({ autoMerge: true })),
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["code-review"] })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["code-review"] })),
      getWorkflowDefinition: vi.fn(async () => ({ ir: codingIr })),
      listWorkflowDefinitions: vi.fn(async () => [{ ir: codingIr }]),
      listWorkflowWorkItemsForTask: vi.fn(async () => []),
      seedWorkspaceCodeReviewContinuationIfIdle,
      logEntry: vi.fn(async () => undefined),
      recordRunAuditEvent: vi.fn(async () => undefined),
      getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
      getAgentLogs: vi.fn(async () => []),
    } as any);
    store.getTask.mockResolvedValue(live);
    const executor = new TaskExecutor(store, "/tmp/fn-9243-resultless");
    vi.spyOn(executor as any, "routeRetryableRemediationGraphFailureToPreMergeFix").mockResolvedValue(false);
    vi.spyOn(executor as any, "routeGraphFailureToExecutionResume").mockResolvedValue(false);

    // The row is COMPLETE and in review — exactly what the honor guard matches on. It must NOT
    // preempt the reroute: this fails if the guard is placed ahead of the review-lane producers.
    await (executor as any).handleGraphFailure(live, stepExecuteFailure());

    expect(seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      taskId: live.id,
      nodeId: "code-review",
    }));
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ mutationType: HONORED }));
  });

  it("F a merge-family node failure for a review-lane row is NOT honored (guard is execute-family only)", async () => {
    const { executor, store, task } = harness({
      ir: noWipIr(),
      task: { column: "in-review", steps: [{ name: "Implement", status: "done" }] },
    });

    await (executor as any).handleGraphFailure(task, {
      disposition: "failed" as const,
      outcome: "failure" as const,
      visitedNodeIds: ["merge"],
      context: { "node:merge:value": "merge-conflict" },
    });

    expect(store.logEntry).not.toHaveBeenCalledWith(task.id, expect.stringContaining("honoring the handoff"), undefined, undefined);
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ mutationType: HONORED }));
  });

  it("G the terminal reducer declines a handoff that landed mid-flight (non-comparable columnMovedAt)", async () => {
    // Entry row is NOT handed off (its own fixture shape is the existing no-wip sink-reaching case);
    // the atomic write is forced to evaluate its reducer against the LATE handed-off row.
    // Pre-fix RED (recorded): the captured patch is the terminal `{ error, status: "failed" }`.
    const { executor, store, task } = harness({
      ir: noWipIr(),
      task: { column: "drafting", steps: [{ name: "Implement", status: "in-progress" }] },
    });
    const lateRow = makeTask({ column: "in-review", steps: [{ name: "Implement", status: "done" }] });
    const captured: Array<Partial<TaskDetail> | null> = [];
    store.updateTaskAtomic = vi.fn(async (_id: string, updater: (current: TaskDetail) => Partial<TaskDetail> | null) => {
      captured.push(updater(lateRow as TaskDetail));
      return undefined as any;
    });

    await (executor as any).handleGraphFailure(task, stepExecuteFailure());

    expect(captured.length).toBeGreaterThan(0);
    // Post-fix: every terminal patch evaluated against the handed-off row is declined.
    expect(captured[0]).toBeNull();
  });
});
