import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

const now = "2026-06-23T00:00:00.000Z";

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-GRAPH-REQUEUE",
    title: "Graph execute recovery",
    description: "Gate coverage for execute-node self-requeue preservation",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Implement", status: "pending" }],
    currentStep: 0,
    log: [],
    branch: "fusion/fn-graph-requeue",
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-graph-requeue",
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

describe("executor graph execute self-requeue gate", () => {
  it("preserves executor todo recovery when the live refetch is stale in-progress", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({ column: "in-progress" });
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue({
      autoMerge: true,
      maxAutoMergeRetries: 3,
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
    });
    const executor = new TaskExecutor(store, "/tmp/test");

    /*
    FNXC:WorkflowLifecycle 2026-06-23-23:03:
    The workflow cutover gate must directly cover the graph execute self-requeue guard. A stale live `in-progress` refetch after an inner executor moved the task to `todo` must not be parked in review or marked failed.
    */
    (executor as any).graphRouting.add(live.id);
    (executor as any).markGraphExecuteSelfRequeued(live.id);
    try {
      await (executor as any).handleGraphFailure(live, {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["execute"],
        context: { "node:execute:value": "recoverable" },
      });
    } finally {
      (executor as any).graphRouting.delete(live.id);
    }

    expect(store.logEntry).toHaveBeenCalledWith(
      live.id,
      expect.stringContaining("executor recovery preserved"),
      undefined,
      undefined,
    );
    expect(store.moveTask).not.toHaveBeenCalledWith(live.id, "in-review", expect.anything());
    expect(store.updateTask).not.toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
  });

  it("moves in-review graph failures with incomplete steps back to todo for resume", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: "FN-7228",
      column: "in-review",
      status: "failed",
      error: "Workflow graph terminated with failure at node 'parse'",
      steps: [
        { name: "Preflight", status: "in-progress" },
        { name: "Implement", status: "in-progress" },
        { name: "Testing & Verification", status: "pending" },
      ],
    });
    store.getTask.mockResolvedValue(live);
    const executor = new TaskExecutor(store, "/tmp/test");

    /*
     * FNXC:WorkflowLifecycle 2026-06-29-11:12:
     * FN-7228/FN-7229 proved that restart-time graph failures can surface after a
     * stale handoff put the card in `in-review` with unfinished steps. Review is
     * not an error bucket; bounce that shape back to `todo` preserving step
     * progress so the engine can resume the correct unfinished step.
     */
    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["parse"],
      context: { "node:parse:value": "parse-error" },
    });

    expect(store.updateTask).toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: null, error: null }),
      undefined,
    );
    expect(store.moveTask).toHaveBeenCalledWith(
      live.id,
      "todo",
      expect.objectContaining({ preserveProgress: true, moveSource: "engine", recoveryRehome: true }),
    );
    expect(store.handoffToReview).not.toHaveBeenCalled();
  });

  it("moves premature merge failures with incomplete in-progress steps back to todo", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: "FN-7261",
      column: "in-progress",
      status: null,
      error: null,
      steps: [
        { name: "Preflight", status: "in-progress" },
        { name: "Implement", status: "pending" },
      ],
    });
    store.getTask.mockResolvedValue(live);
    const executor = new TaskExecutor(store, "/tmp/test");

    /*
     * FNXC:WorkflowMerge 2026-06-29-23:18:
     * Fast-mode graph traversal must not turn an unfinished legacy checklist into a no-op merge. If the merge node is reached before implementation proof exists, recover by requeueing executable work instead of parking the task failed in-progress.
     */
    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["merge"],
      context: { "node:merge:value": "implementation-incomplete" },
    });

    expect(store.updateTask).toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: null, error: null }),
      undefined,
    );
    expect(store.moveTask).toHaveBeenCalledWith(
      live.id,
      "todo",
      expect.objectContaining({ preserveProgress: true, moveSource: "engine", recoveryRehome: true }),
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
  });

  it("does not flag a remediation-node graph failure as failed while a live agent session is executing", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: "FN-REMEDIATION-LIVE",
      column: "in-progress",
      steps: [{ name: "Implement", status: "in-progress" }],
    });
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue({
      autoMerge: true,
      maxAutoMergeRetries: 3,
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
    });
    const executor = new TaskExecutor(store, "/tmp/test");

    /*
     * FNXC:WorkflowRemediation 2026-07-01-23:40:
     * `code-review-remediation` is a fire-and-forget async scheduler with no
     * `failure` out-edge; a failed re-arm bubbles out as the terminal graph
     * outcome. When a SEPARATE live agent session surface is still registered
     * (the previously-scheduled fix/reviewer is mid-flight), the terminal sink
     * must NOT stamp `status:"failed"` over live work.
     */
    (executor as any).activeSessions.set(live.id, { session: {} });
    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["code-review", "code-review-remediation"],
      context: {},
    });

    expect(store.updateTask).not.toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      live.id,
      expect.stringContaining("not flagging as failed"),
      undefined,
      undefined,
    );
    expect(store.moveTask).not.toHaveBeenCalledWith(live.id, "in-review", expect.anything());
  });

  it("still parks a remediation-node graph failure as failed when NO live session exists", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: "FN-REMEDIATION-DEAD",
      column: "in-progress",
      steps: [{ name: "Implement", status: "in-progress" }],
    });
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue({
      autoMerge: true,
      maxAutoMergeRetries: 3,
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
    });
    const executor = new TaskExecutor(store, "/tmp/test");

    // Surface enumeration: the guard is scoped to a LIVE session surface. With
    // no session (e.g. a genuinely exhausted rework budget), the remediation
    // failure remains terminal and parks failed exactly as before.
    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["code-review", "code-review-remediation"],
      context: {},
    });

    expect(store.updateTask).toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("Workflow graph terminated with failure at node 'code-review-remediation'"),
      }),
      undefined,
    );
  });

  it("does not hand generic graph failures to review", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: "FN-7229",
      column: "in-progress",
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "in-progress" },
      ],
    });
    store.getTask.mockResolvedValue(live);
    const executor = new TaskExecutor(store, "/tmp/test");

    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["parse"],
      context: { "node:parse:value": "parse-error" },
    });

    expect(store.updateTask).toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("Workflow graph terminated with failure at node 'parse'"),
      }),
      undefined,
    );
    expect(store.handoffToReview).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalledWith(live.id, "in-review", expect.anything());
  });
});
