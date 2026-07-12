import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import "../executor-test-helpers.js";
import {
  EXECUTE_REQUEUE_LOOP_VISIBLE_THRESHOLD,
  MAX_EXECUTE_REQUEUE_LOOP_CYCLES,
  TaskExecutor,
} from "../../executor.js";
import { createMockStore, resetExecutorMocks } from "../executor-test-helpers.js";

const now = "2026-07-12T00:00:00.000Z";

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-7863-T",
    title: "Execute requeue loop",
    description: "Bound execute self-requeue loops",
    column: "todo",
    dependencies: [],
    steps: [{ name: "Implement", status: "pending" }],
    currentStep: 0,
    log: [],
    branch: "fusion/fn-7863",
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-7863",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    mergeRetries: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

function harness(initial: TaskDetail) {
  resetExecutorMocks();
  const store = createMockStore();
  let live = { ...initial } as TaskDetail;
  store.getTask.mockImplementation(async () => live);
  store.updateTask.mockImplementation(async (_id: string, updates: Partial<TaskDetail>) => {
    live = { ...live, ...updates } as TaskDetail;
    return live;
  });
  store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  const executor = new TaskExecutor(store, "/tmp/test");
  return {
    store,
    executor,
    get live() {
      return live;
    },
    setLive(patch: Partial<TaskDetail>) {
      live = { ...live, ...patch } as TaskDetail;
    },
  };
}

async function failAtExecute(executor: TaskExecutor, taskSnapshot: TaskDetail) {
  await (executor as any).handleGraphFailure(taskSnapshot, {
    disposition: "failed",
    outcome: "failure",
    visitedNodeIds: ["execute"],
    context: { "node:execute:value": "implementation-incomplete" },
  });
}

describe("execute requeue loop guard", () => {
  it("terminalizes unchanged todo execute self-requeues and preserves progress", async () => {
    const h = harness(task({
      id: "FN-7863-TODO",
      column: "todo",
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "in-progress" },
      ],
      currentStep: 1,
    }));

    for (let i = 0; i < MAX_EXECUTE_REQUEUE_LOOP_CYCLES; i += 1) {
      await failAtExecute(h.executor, h.live);
    }

    expect(h.store.updateTask).toHaveBeenCalledWith(
      "FN-7863-TODO",
      expect.objectContaining({
        status: "failed",
        error: expect.stringMatching(/^EXECUTION_DISPATCH_LOOP_EXHAUSTED:/),
        executeRequeueLoopCount: MAX_EXECUTE_REQUEUE_LOOP_CYCLES,
      }),
      undefined,
    );
    expect(h.store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:execution-dispatch-loop-terminalized",
      metadata: expect.objectContaining({
        taskId: "FN-7863-TODO",
        cycleCount: MAX_EXECUTE_REQUEUE_LOOP_CYCLES,
        maxCycles: MAX_EXECUTE_REQUEUE_LOOP_CYCLES,
        failureValue: "implementation-incomplete",
      }),
    }));
    expect(h.store.moveTask).not.toHaveBeenCalled();
    const terminalUpdate = h.store.updateTask.mock.calls.find((call: any[]) => call[1]?.status === "failed")?.[1];
    expect(terminalUpdate).not.toHaveProperty("worktree");
    expect(terminalUpdate).not.toHaveProperty("branch");
    expect(terminalUpdate).not.toHaveProperty("steps");
    const lastLog = h.store.logEntry.mock.calls.at(-1)?.[1] as string;
    expect(lastLog).toMatch(/^EXECUTION_DISPATCH_LOOP_EXHAUSTED:/);
    expect(lastLog).not.toContain("executor recovery preserved");
  });

  it("terminalizes the stale in-progress self-requeue marker path", async () => {
    const h = harness(task({ id: "FN-7863-STALE", column: "in-progress" }));
    (h.executor as any).graphRouting.add("FN-7863-STALE");
    (h.executor as any).markGraphExecuteSelfRequeued("FN-7863-STALE");

    for (let i = 0; i < MAX_EXECUTE_REQUEUE_LOOP_CYCLES; i += 1) {
      await failAtExecute(h.executor, h.live);
    }

    expect(h.store.updateTask).toHaveBeenCalledWith(
      "FN-7863-STALE",
      expect.objectContaining({ status: "failed", error: expect.stringMatching(/^EXECUTION_DISPATCH_LOOP_EXHAUSTED:/) }),
      undefined,
    );
  });

  it("resets the streak on real step progress and never terminalizes", async () => {
    const h = harness(task({ id: "FN-7863-PROGRESS", column: "todo" }));

    for (let i = 0; i < MAX_EXECUTE_REQUEUE_LOOP_CYCLES + 3; i += 1) {
      h.setLive({ currentStep: i, steps: [{ name: `Step ${i}`, status: i % 2 === 0 ? "pending" : "in-progress" }] as any });
      await failAtExecute(h.executor, h.live);
    }

    expect(h.store.updateTask).not.toHaveBeenCalledWith(
      "FN-7863-PROGRESS",
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
    expect(h.live.executeRequeueLoopCount).toBe(1);
  });

  it("emits a visible warning at the threshold without terminalizing", async () => {
    const h = harness(task({ id: "FN-7863-WARN", column: "todo" }));

    for (let i = 0; i < EXECUTE_REQUEUE_LOOP_VISIBLE_THRESHOLD; i += 1) {
      await failAtExecute(h.executor, h.live);
    }

    expect(h.store.logEntry).toHaveBeenCalledWith(
      "FN-7863-WARN",
      expect.stringContaining(`Execution dispatch loop building: ${EXECUTE_REQUEUE_LOOP_VISIBLE_THRESHOLD}/${MAX_EXECUTE_REQUEUE_LOOP_CYCLES}`),
      undefined,
      undefined,
    );
    expect(h.store.updateTask).not.toHaveBeenCalledWith(
      "FN-7863-WARN",
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
  });

  it.each([
    ["userPaused", { userPaused: true }],
    ["paused", { paused: true }],
  ])("does not terminalize %s tasks from the benign branch", async (_label, patch) => {
    const h = harness(task({ id: `FN-7863-${_label}`, column: "todo", ...patch }));

    for (let i = 0; i < MAX_EXECUTE_REQUEUE_LOOP_CYCLES; i += 1) {
      await failAtExecute(h.executor, h.live);
    }

    expect(h.store.updateTask).not.toHaveBeenCalledWith(
      h.live.id,
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
    expect(h.store.logEntry).toHaveBeenCalledWith(
      h.live.id,
      expect.stringContaining("paused awaiting explicit unpause"),
      undefined,
      undefined,
    );
  });
});
