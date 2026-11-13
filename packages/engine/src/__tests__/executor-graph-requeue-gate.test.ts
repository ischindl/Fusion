import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import { BUILTIN_STEPWISE_CODING_WORKFLOW_IR } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import { createNoopLegacySeams } from "../workflows/workflow-node-handlers.js";
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

  it("parks invalid persisted step dependencies for planner repair before generic graph failure handling", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: "FN-INVALID-PERSISTED-DAG",
      steps: [{ name: "First", status: "pending", dependsOn: [1] }],
    });
    store.getTask.mockResolvedValue(live);
    const executor = new TaskExecutor(store, "/tmp/test");

    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["steps"],
      context: {
        "node:steps:value": "invalid-plan-dependency:step 1 depends on invalid step 2 (self-or-forward)",
      },
    });

    expect(store.updateTask).toHaveBeenCalledWith(live.id, {
      status: "needs-replan",
      error: null,
      recoveryRetryCount: null,
      nextRecoveryAt: null,
    }, undefined);
    expect(store.logEntry).toHaveBeenCalledWith(
      live.id,
      "AI spec revision requested",
      "Step dependency validation rejected the plan: step 1 depends on invalid step 2 (self-or-forward)",
      undefined,
    );
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
  });

  /*
  FNXC:StepDependencyDiagnostics 2026-11-12-22:51 (RUFU-501):
  Recovery reproduction across the two production seams, with no hand-written failure value: the run comes
  from the real parse node of the shipped coding IR and the result goes to the real failure handler. The
  plan-repair sink was already value-driven, so the only way to show what this card fixes is to let the
  node author the value — on the base it says `parse-error`, the card takes the generic retry ladder, and
  the plan-repair branch that would have routed it to the planner is never reached. The paired case below
  holds the opposite direction: an unreadable artifact is infrastructure and must keep taking the ladder.
  */

  /** Runs the shipped coding IR through the real parse node and returns the result shape the executor acts on. */
  async function runRealParseNode(live: TaskDetail, readArtifact: () => Promise<string>) {
    const graph = new WorkflowGraphExecutor({
      seams: createNoopLegacySeams(),
      getTaskSteps: () => [],
      parseStepsDeps: { readArtifact, writeSteps: async () => {} },
      runCustomNode: async () => ({ outcome: "success" as const }),
    });
    const result = await graph.run(
      live,
      { experimentalFeatures: { workflowGraphExecutor: true } } as never,
      BUILTIN_STEPWISE_CODING_WORKFLOW_IR,
    );
    return {
      disposition: "failed" as const,
      outcome: result.outcome,
      visitedNodeIds: result.visitedNodeIds,
      context: result.context,
    };
  }

  it("routes an unresolvable plan dependency from the real parse node to planner repair, not the retry ladder", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: "FN-PARSE-PLAN-REFUSAL",
      worktree: "/tmp/fusion-parse-plan-refusal",
      steps: [{ name: "Preflight", status: "pending" }],
    });
    store.getTask.mockResolvedValue(live);
    const executor = new TaskExecutor(store, "/tmp/test");
    const activeWorktrees = (executor as any).activeWorktrees as Map<string, Set<string>>;
    activeWorktrees.set(live.id, new Set([live.worktree!]));

    const result = await runRealParseNode(live, async () => "### Step 0: Preflight\n### Step 1: Fence the reclaim write (depends: 1)");
    expect(result.context?.["node:parse:value"]).toMatch(/^invalid-plan-dependency:/);

    await (executor as any).handleGraphFailure(live, result);

    const diagnostic = String(result.context?.["node:parse:value"]).slice("invalid-plan-dependency:".length);
    expect(store.updateTask).toHaveBeenCalledWith(live.id, {
      status: "needs-replan",
      error: null,
      recoveryRetryCount: null,
      nextRecoveryAt: null,
    }, undefined);
    expect(store.logEntry).toHaveBeenCalledWith(
      live.id,
      "AI spec revision requested",
      `Step dependency validation rejected the plan: ${diagnostic}`,
      undefined,
    );
    // Never the generic ladder: no failed park, no recovery-budget burn, no atomic terminal write.
    expect(store.updateTask).not.toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalledWith(
      live.id,
      expect.stringContaining("terminated with failure at node 'parse'"),
      expect.anything(),
      expect.anything(),
    );
    // Lifecycle containment: the plan-repair sink re-seeds planning in place and moves nothing. A card
    // whose plan cannot be read must never land in a complete-trait column, so the terminal lane is
    // asserted here as byte-identical placement, not merely as "no handoff to review".
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(live.column).toBe("in-progress");
    // The run's checkout is released with the run, exactly as the other committing terminal parks do.
    expect(activeWorktrees.has(live.id)).toBe(false);
  });

  it("keeps an unreadable artifact from that same node on the generic ladder, diverted to no planner", async () => {
    // The A/B half of the routing fix: the two classes share a node and an IR edge, and only the value
    // separates them. An artifact the parser could not even read is infrastructure — it must keep its
    // failed park and must never be labelled a plan the planner should rewrite.
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: "FN-PARSE-INFRA-FAILURE",
      worktree: "/tmp/fusion-parse-infra-failure",
      steps: [{ name: "Preflight", status: "pending" }],
    });
    store.getTask.mockResolvedValue(live);
    const executor = new TaskExecutor(store, "/tmp/test");

    const result = await runRealParseNode(live, async () => {
      throw new Error("artifact store unreachable");
    });
    expect(result.context?.["node:parse:value"]).toBe("parse-error");

    await (executor as any).handleGraphFailure(live, result);

    expect(store.updateTask).not.toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "needs-replan" }),
      expect.anything(),
    );
    expect(store.logEntry).not.toHaveBeenCalledWith(
      live.id,
      "AI spec revision requested",
      expect.any(String),
      expect.anything(),
    );
    const parkedFailed = store.updateTask.mock.calls.some(
      ([, patch]) => (patch as { status?: string }).status === "failed",
    );
    expect(parkedFailed).toBe(false);
    expect(store.updateTask).not.toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "needs-replan" }),
      expect.anything(),
    );
    expect(store.logEntry).not.toHaveBeenCalledWith(
      live.id,
      "AI spec revision requested",
      expect.any(String),
      expect.anything(),
    );
    // The ladder's own honest terminal: the failed park is a fenced atomic write, and the card's History
    // names the node and the generic value. This is the pair of log lines the reported cards carried.
    expect(store.updateTaskAtomic).toHaveBeenCalledTimes(1);
    expect(store.logEntry).toHaveBeenCalledWith(
      live.id,
      expect.stringContaining("terminated with failure at node 'parse' (parse-error)"),
      undefined,
      undefined,
    );
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("keeps in-review graph failures in review without a REVISE handoff", async () => {
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
     * not an error bucket; return that shape to the declared WIP lane preserving
     * step progress so the engine can resume the correct unfinished step.
     */
    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["parse"],
      context: { "node:parse:value": "parse-error" },
    });

    expect(live.column).toBe("in-review");
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.handoffToReview).not.toHaveBeenCalled();
  });

  it("keeps premature merge failures in the implementation lane", async () => {
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
    expect(store.moveTask).not.toHaveBeenCalled();
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

  it("auto-recovers a no-live-session code-review-remediation failure with a durable failed gate result", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: "FN-7476-REMEDIATION",
      column: "in-review",
      status: "failed",
      error: "Workflow graph terminated with failure at node 'code-review-remediation'",
      steps: [{ name: "Implement", status: "done" }],
      postReviewFixCount: 2,
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        output: "Fix the reviewer finding before merge.",
        verdict: "REVISE",
        reviewKind: "code",
        startedAt: now,
        completedAt: now,
      }],
      log: Array.from({ length: 2 }, (_, index) => ({
        timestamp: now,
        action: `Auto-reviving in-review task with failed pre-merge workflow step (attempt ${index + 1}/3)`,
        outcome: "Step: Code Review\nWorkflow revision key: code-review",
      })),
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
     * FNXC:WorkflowRemediation 2026-09-03-05:40:
     * FN-7476-class parked rows have no live session left, but the durable failed Code Review
     * result is enough to enter the remediation recovery owner. This fixture retains one bounded
     * attempt; separate convergence coverage owns the exhausted-budget outcome.
     */
    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["code-review", "code-review-remediation"],
      context: { "node:code-review-remediation:value": "remediation-not-scheduled" },
    });

    expect(store.updateTask).toHaveBeenCalledWith(live.id, { postReviewFixCount: 3 }, undefined);
    expect(store.logEntry).toHaveBeenCalledWith(
      live.id,
      expect.stringContaining("Auto-recovered retryable remediation node 'code-review-remediation'"),
      expect.stringContaining("Workflow revision key: code-review"),
      undefined,
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
    expect(store.handoffToReview).not.toHaveBeenCalled();
  });

  it("does not route plan-replan graph failures through pre-merge remediation recovery", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: "FN-PLAN-REPLAN-PARKED",
      column: "in-review",
      status: "failed",
      error: "Workflow graph terminated with failure at node 'plan-replan'",
      steps: [{ name: "Plan", status: "done" }],
      workflowStepResults: [{
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
        phase: "pre-merge",
        status: "failed",
        output: "Revise the task plan before implementation.",
        startedAt: now,
        completedAt: now,
      }],
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
     * FNXC:WorkflowRemediation 2026-07-03-23:10:
     * A parked Plan Review `plan-replan` failure is not a pre-merge implementation remediation node. It must not call the Code Review remediation bridge, because that bridge injects fix instructions and sends the task back to executor work instead of the plan-replan/triage path.
     */
    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["plan-review", "plan-replan"],
      context: { "node:plan-replan:value": "remediation-not-scheduled" },
    });

    expect(store.addTaskComment).not.toHaveBeenCalledWith(
      live.id,
      expect.stringContaining("Auto-revived from in-review: pre-merge workflow step"),
      "agent",
    );
    expect(store.logEntry).not.toHaveBeenCalledWith(
      live.id,
      expect.stringContaining("Auto-recovered retryable remediation node 'plan-replan'"),
      expect.anything(),
      expect.anything(),
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(live.id, { status: null, error: null }, undefined);
    expect(store.updateTask).not.toHaveBeenCalledWith(live.id, { workflowStepResults: [] }, undefined);
  });

  it.each(["remediation-not-scheduled", "missing-remediation-context"])("FN-8910 keeps a completed review card in place when remediation reports %s", async (failureValue) => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: `FN-8910-${failureValue}`,
      column: "in-review",
      steps: [{ name: "Implement", status: "done" }],
    });
    store.getTask.mockResolvedValue(live);
    const executor = new TaskExecutor(store, "/tmp/test");

    await expect((executor as any).routeGraphFailureToExecutionResume(
      live,
      "code-review-remediation",
      failureValue,
    )).resolves.toBe(false);

    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["code-review", "code-review-remediation"],
      context: { "node:code-review-remediation:value": failureValue },
    });

    /*
    FNXC:WorkflowRemediation 2026-08-09-21:53:
    FN-8910 requires policy-refused remediation to remain visibly parked in the
    review lane after implementation is complete, never rebound to execution.
    */
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("does not resume an incomplete review card without named REVISE remediation", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: "FN-8910-INCOMPLETE",
      column: "in-review",
      steps: [{ name: "Implement", status: "pending" }],
    });
    store.getTask.mockResolvedValue(live);
    const executor = new TaskExecutor(store, "/tmp/test");

    await expect((executor as any).routeGraphFailureToExecutionResume(
      live,
      "code-review-remediation",
      "remediation-not-scheduled",
    )).resolves.toBe(false);

    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("still parks a remediation-node graph failure as failed when no durable failed gate result exists", async () => {
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

    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["code-review", "code-review-remediation"],
      context: {},
    });

    expect(store.updateTaskAtomic).toHaveBeenCalledWith(live.id, expect.any(Function), undefined);
    await expect(store.getTask(live.id)).resolves.toEqual(expect.objectContaining({
      status: "failed",
      error: expect.stringContaining("Workflow graph terminated with failure at node 'code-review-remediation'"),
    }));
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
      visitedNodeIds: ["earlier", "parse"],
      context: {
        "node:earlier:error": "stale failure must stay hidden",
        "node:parse:value": "exception",
        "node:parse:error": "repair arm did not start",
      },
    });

    expect(store.updateTaskAtomic).toHaveBeenCalledWith(live.id, expect.any(Function), undefined);
    await expect(store.getTask(live.id)).resolves.toEqual(expect.objectContaining({
      status: "failed",
      error: "Workflow graph terminated with failure at node 'parse' (exception): repair arm did not start",
    }));
    expect(store.logEntry).toHaveBeenCalledWith(
      live.id,
      "Workflow graph terminated with failure at node 'parse' (exception): repair arm did not start",
      undefined,
      undefined,
    );
    expect(store.handoffToReview).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalledWith(live.id, "in-review", expect.anything());
  });
});
