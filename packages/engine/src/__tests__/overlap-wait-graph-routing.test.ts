import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TaskDetail } from "@fusion/core";
import { OVERLAP_DELIVERY_UNAVAILABLE_ERROR } from "@fusion/core";
import "./executor-test-helpers.js";
import {
  OVERLAP_WAIT_HOLD_VALUE,
  SESSION_CONTENTION_HOLD_VALUE,
  WORKSPACE_PREPARATION_FAILURE_HOLD_VALUE,
} from "../workflows/workflow-graph-executor.js";
import { graphFailureValue, isOverlapWaitGraphFailure } from "../executor/graph-failure-pure.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

/*
FNXC:OverlapAcquisitionPark 2026-11-14-15:50 (RUFU-1040):
The routing half of "a refusal is not a failure, a budget, or a rebuild".

Two properties are pinned here and both were violated before this change:
  1. the refusal is recognized as its own graph value — in the direct `step-execute` shape AND as a foreach
     template, because the default coding workflow IS a foreach and a failed template records under the
     container key (a classifier that only reads the qualified id misses every real occurrence);
  2. the router must not write `status`, must not write `error`, and must not reach
     `routeGraphFailureToExecutionResume`, which is the ONLY router that spends an `executionRearmEpisode`
     unit. Measured cost of that spend on the live board: RUFU-593 consumed 5 units in 4 m 10 s
     (2026-11-14 13:02:34 → 13:06:44) before the RUFU-1027 ceiling parked it.

The negative controls matter as much as the positive ones: session contention, workspace preparation,
base-refresh and an ordinary `failure` must all keep their own routes, and a stale error text left by an
EARLIER node must not drag a genuine failure into the hold arm.
*/

const DIRECT_NODE = "step-execute";
const FOREACH_TEMPLATE = "steps#0:step-execute";
/* The bare foreach node, not the instance: `steps#0:step-execute` splits at "#", so the container context key
   is `node:steps:value`. (The card text said `node:steps#<n>:value`; the shipped lookup splits earlier, which
   is what this test now pins.) */
const FOREACH_CONTAINER = "steps";

function result(overrides: { visitedNodeIds: string[]; context: Record<string, unknown> }) {
  return {
    disposition: "failed" as const,
    outcome: "failure" as const,
    visitedNodeIds: overrides.visitedNodeIds,
    context: overrides.context,
  };
}

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  const now = new Date().toISOString();
  return {
    id: "FN-1040-T",
    title: "overlap waiter",
    description: "d",
    column: "in-progress",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    deletedAt: null,
    dependencies: [],
    steps: [],
    log: [],
    worktree: "/repo/.fusion/worktrees/fn-1040-t",
    branch: "fusion/fn-1040-t",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as unknown as TaskDetail;
}

function harness(task: TaskDetail) {
  const store = createMockStore();
  store.getTask.mockResolvedValue(task);
  store.getSettings.mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 15_000, autoMerge: true });
  store.getTaskWorkflowSelection = vi.fn(() => undefined);
  store.getTaskWorkflowSelectionAsync = vi.fn(async () => undefined);
  store.getWorkflowDefinition = vi.fn(async () => null);
  store.updateTask.mockImplementation(async (_id: string, patch: Partial<TaskDetail>) => {
    Object.assign(task, patch);
  });
  store.recordRunAuditEvent = vi.fn(async () => undefined);
  store.logEntry = vi.fn(async () => undefined);
  const executor = new TaskExecutor(store, "/repo");
  return { executor, store, task };
}

function logText(store: ReturnType<typeof createMockStore>): string {
  return store.logEntry.mock.calls.map((call: any[]) => String(call[1])).join("\n");
}

describe("isOverlapWaitGraphFailure", () => {
  it("recognizes the typed value on a direct step-execute node", () => {
    expect(isOverlapWaitGraphFailure(result({
      visitedNodeIds: [DIRECT_NODE],
      context: { [`node:${DIRECT_NODE}:value`]: OVERLAP_WAIT_HOLD_VALUE },
    }))).toBe(true);
  });

  it("recognizes the typed value recorded under the foreach CONTAINER key", () => {
    // The default coding workflow is a foreach; a failed template records on the container.
    expect(isOverlapWaitGraphFailure(result({
      visitedNodeIds: [FOREACH_TEMPLATE],
      context: { [`node:${FOREACH_CONTAINER}:value`]: OVERLAP_WAIT_HOLD_VALUE },
    }))).toBe(true);
    expect(graphFailureValue(result({
      visitedNodeIds: [FOREACH_TEMPLATE],
      context: { [`node:${FOREACH_CONTAINER}:value`]: OVERLAP_WAIT_HOLD_VALUE },
    }))).toBe(OVERLAP_WAIT_HOLD_VALUE);
  });

  it("recognizes the message shape on the FAILING node's own error text", () => {
    expect(isOverlapWaitGraphFailure(result({
      visitedNodeIds: [FOREACH_TEMPLATE],
      context: { [`node:${FOREACH_TEMPLATE}:error`]: `${OVERLAP_DELIVERY_UNAVAILABLE_ERROR}: waiting on FN-A` },
    }))).toBe(true);
  });

  it("does not widen: other holds, plain failures, and a stale error from an earlier node stay out", () => {
    const negatives = [
      result({ visitedNodeIds: [DIRECT_NODE], context: { [`node:${DIRECT_NODE}:value`]: "failure" } }),
      result({ visitedNodeIds: [DIRECT_NODE], context: { [`node:${DIRECT_NODE}:value`]: SESSION_CONTENTION_HOLD_VALUE } }),
      result({ visitedNodeIds: [DIRECT_NODE], context: { [`node:${DIRECT_NODE}:value`]: WORKSPACE_PREPARATION_FAILURE_HOLD_VALUE } }),
      result({ visitedNodeIds: [DIRECT_NODE], context: { [`node:${DIRECT_NODE}:value`]: "dirty-worktree" } }),
      /* The narrowing that keeps a real failure visible: the sentence sits on a node that is NOT the failing
         one, so this run must keep its own disposition instead of being silently held. */
      result({
        visitedNodeIds: ["review", DIRECT_NODE],
        context: {
          "node:review:error": OVERLAP_DELIVERY_UNAVAILABLE_ERROR,
          [`node:${DIRECT_NODE}:value`]: "failure",
        },
      }),
    ];
    for (const negative of negatives) expect(isOverlapWaitGraphFailure(negative)).toBe(false);
  });
});

describe("handleGraphFailure routes an overlap wait to the bounded in-place resume", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the card: no status write, no error write, no execution re-arm unit", async () => {
    const task = makeTask({ graphResumeRetryCount: null as unknown as number });
    const { executor, store } = harness(task);

    await (executor as any).handleGraphFailure(task, result({
      visitedNodeIds: [FOREACH_TEMPLATE],
      context: { [`node:${FOREACH_CONTAINER}:value`]: OVERLAP_WAIT_HOLD_VALUE },
    }));

    expect(task.status).toBeNull();
    expect(task.error).toBeNull();
    expect(task.column).toBe("in-progress");
    // The budget that must stay untouched: only routeGraphFailureToExecutionResume writes it.
    expect(task.recoveryRetryCount ?? null).toBeNull();
    expect(logText(store)).toContain("Waiting on a file-scope predecessor");
    expect(logText(store)).not.toContain("no execution re-arm unit spent (2 of 2)");
    // Assert the PATCH, not a call signature: the arm's whole write must be exactly this one counter, with
    // no status, error, pause, or strike riding along.
    const retryPatches = store.updateTask.mock.calls
      .map((call: any[]) => call[1] as Record<string, unknown>)
      .filter((patch) => patch && patch.graphResumeRetryCount !== undefined);
    expect(retryPatches).toEqual([{ graphResumeRetryCount: 1 }]);
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ status: "failed" }));
  });

  it("re-reads when the backoff fires instead of resuming over a pause or a moved card", async () => {
    const task = makeTask();
    const { executor, store } = harness(task);
    const before = store.getTask.mock.calls.length;

    await (executor as any).handleGraphFailure(task, result({
      visitedNodeIds: [FOREACH_TEMPLATE],
      context: { [`node:${FOREACH_CONTAINER}:value`]: OVERLAP_WAIT_HOLD_VALUE },
    }));

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    // The timer's guard re-reads the row; without that re-read a pause during the backoff would be resumed over.
    expect(store.getTask.mock.calls.length).toBeGreaterThan(before);
    expect(task.status).toBeNull();
  });

  it("writes nothing at all when the in-place budget is exhausted — the card stays held, not failed", async () => {
    const task = makeTask({ graphResumeRetryCount: 2 });
    const { executor, store } = harness(task);

    await (executor as any).handleGraphFailure(task, result({
      visitedNodeIds: [FOREACH_TEMPLATE],
      context: { [`node:${FOREACH_CONTAINER}:value`]: OVERLAP_WAIT_HOLD_VALUE },
    }));

    expect(task.status).toBeNull();
    expect(task.error).toBeNull();
    expect(logText(store)).toContain("in-place retry budget exhausted");
    // Exhausting a backoff is not a strike and not a charge against any counter.
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ graphResumeRetryCount: 3 }));
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ status: "failed" }));
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ recoveryRetryCount: expect.anything() }));
  });

  it("keeps an ordinary failure on its own route (negative control against swallowing)", async () => {
    const task = makeTask();
    const { executor, store } = harness(task);

    await (executor as any).handleGraphFailure(task, result({
      visitedNodeIds: [FOREACH_TEMPLATE],
      context: { [`node:${FOREACH_TEMPLATE}:value`]: "failure", [`node:${FOREACH_TEMPLATE}:error`]: "TypeError: boom" },
    }));

    expect(logText(store)).not.toContain("Waiting on a file-scope predecessor");
    expect(logText(store)).not.toContain("in-place retry budget exhausted");
  });
});
