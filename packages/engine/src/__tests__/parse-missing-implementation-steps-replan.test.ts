import "./executor-test-helpers.js";
import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TransitionRejectionError, type Task } from "@fusion/core";

import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

/*
FNXC:PlanArtifactIntegrity 2026-11-13-05:10 (RUFU-693):
A plan that yields zero executable steps was terminalized `failed` in its own implementation column, where
no automatic claimant re-plans it -- the card then sits there while the planner overseer re-spends retries
on a deterministic failure. Measured on RUFU-518: 55 `overseer:intervention` rows in 24h, plus a branch, a
worktree and a file-scope lease held the whole time. The remedy is a rewritten plan, so the graph-failure
boundary must hand the card back to planning as `needs-replan` through the sanctioned reason
`parse-missing-implementation-steps`.

Asserted through the real `handleGraphFailure`, not a mock of its conclusion, because the invariant spans
four seams: the F5 deny rule, the sanctioned-reason registry, the lifecycle-move allow-list, and the
replan primitive's own column resolution. A test of any one of them alone stays green while the composite
refuses the move.

Case (c) covers the in-place outcome through a destination capacity refusal, because that is the cause an
executor-level fixture can raise honestly. (A hand-written IR that declares no planning lane was tried first
and did NOT reach the primitive: the resolver rejected the minimal IR and fell back to the default workflow,
whose planning column exists -- so asserting it would have pinned the fallback, not the feature.)
*/

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-518",
    title: "Cold-engine project scope must not borrow the launch project onMerge",
    description: "Route the merge by the target project.",
    column: "in-progress",
    status: "failed",
    error: "Workflow graph terminated with failure at node 'parse' (missing-implementation-steps)",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    workflowStepResults: [{
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      status: "passed",
      verdict: "APPROVE",
      phase: "pre-merge",
      completedAt: new Date().toISOString(),
    }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

type WorkflowFixture = "default" | "no-planning-lane" | "review-capable";

async function executorWithPrompt(tasksDir: string, liveTask: Task, workflow: WorkflowFixture = "default") {
  const store = createMockStore();
  await mkdir(join(tasksDir, liveTask.id), { recursive: true });
  await writeFile(
    join(tasksDir, liveTask.id, "PROMPT.md"),
    "# Task: RUFU-518 - prose only\n## What to do\nFix the routing.\n",
    "utf-8",
  );
  store.getTasksDir = vi.fn(() => tasksDir);
  store.getTask.mockResolvedValue(liveTask);
  // The default Coding workflow resolves when the store reports no selection and no definition, and it
  // replans in its declared planner column -- the same IR production uses for these cards.
  if (workflow === "no-planning-lane") {
    // A workflow whose own IR declares only a WIP lane and a terminal lane: there is genuinely no
    // planning column to move to, which is the case the primitive answers with `undefined`.
    store.getTaskWorkflowSelection = vi.fn(() => ({ workflowId: "custom:wip-only", stepIds: [] }));
    store.getWorkflowDefinition = vi.fn(async () => ({
      ir: {
        version: "v2", id: "custom:wip-only", name: "wip-only", nodes: [], edges: [],
        columns: [
          { id: "building", name: "Wip", traits: [{ trait: "wip" }] },
          { id: "finished", name: "Done", traits: [{ trait: "complete" }] },
        ],
      },
    }));
  } else {
    store.getTaskWorkflowSelection = vi.fn(() => undefined);
    store.getWorkflowDefinition = vi.fn(async () => undefined);
  }
  return { store, executor: new TaskExecutor(store, "/tmp/test") };
}

function parseFailure(value: string) {
  return {
    disposition: "failed",
    outcome: "failure",
    reason: value,
    visitedNodeIds: ["parse"],
    context: { "node:parse:value": value },
  };
}

describe("parse found no executable step: rebound to planning, not terminalized (RUFU-693)", () => {
  it("sends a WIP card with an approved plan back to planning as needs-replan", async () => {
    resetExecutorMocks();
    const tasksDir = await mkdtemp(join(tmpdir(), "fusion-zero-step-parse-"));
    const liveTask = task();
    const { store, executor } = await executorWithPrompt(tasksDir, liveTask);

    try {
      await (executor as any).handleGraphFailure(liveTask, parseFailure("missing-implementation-steps"));

      const movedWithSanctionedReason = store.moveTask.mock.calls
        .map((call: unknown[]) => call[2] as Record<string, unknown> | undefined)
        .filter((options) => options?.lifecycleReason === "parse-missing-implementation-steps");
      expect(movedWithSanctionedReason.length)
        .toBe(1);
      /*
      The destination is the ownership property, not an implementation detail. A status-only version of this
      fix was deployed and measured: the card sat `needs-replan` in `in-progress` for 8+ minutes with no
      claimant, and triage started a planner under a minute after the same row reached its planning lane. So
      this asserts the card lands in the lane the planning claimant actually reads -- the default Coding
      workflow's planner column -- rather than only that "a move happened somewhere".
      */
      const destination = store.moveTask.mock.calls
        .map((call: unknown[]) => call[1] as string)
        .filter((column) => column !== liveTask.column);
      expect(destination).toEqual(["todo"]);

      expect(store.updateTask).toHaveBeenCalledWith(
        liveTask.id,
        expect.objectContaining({
          status: "needs-replan",
          error: null,
          recoveryRetryCount: null,
          nextRecoveryAt: null,
          graphResumeRetryCount: 0,
        }),
        undefined,
      );
      // A deterministic plan defect must not be reported as an execution failure the overseer may retry.
      expect(store.updateTask).not.toHaveBeenCalledWith(
        liveTask.id,
        expect.objectContaining({ status: "failed" }),
        undefined,
      );
      expect(store.logEntry).toHaveBeenCalledWith(
        liveTask.id,
        "AI spec revision requested",
        expect.stringContaining("missing-implementation-steps"),
        undefined,
      );
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  it("does not touch a user-paused card, because an operator hold outranks recovery", async () => {
    resetExecutorMocks();
    const tasksDir = await mkdtemp(join(tmpdir(), "fusion-zero-step-paused-"));
    const liveTask = task({ userPaused: true, paused: true });
    const { store, executor } = await executorWithPrompt(tasksDir, liveTask);

    try {
      await (executor as any).handleGraphFailure(liveTask, parseFailure("missing-implementation-steps"));
      const replanned = store.updateTask.mock.calls.some(
        (call: unknown[]) => (call[1] as Record<string, unknown>).status === "needs-replan",
      );
      expect(replanned).toBe(false);
      expect(store.moveTask).not.toHaveBeenCalled();
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  /*
  FNXC:PlanArtifactIntegrity 2026-11-13-05:10 (RUFU-693):
  A destination at capacity is a transient refusal, not a plan defect, yet the primitive reports it the same
  way as "no planning lane declared" (`undefined`). Terminalizing `failed` there would convert a full lane
  into a card the planner overseer burns retries on. The move primitive is reached for real here: the store
  raises the same `TransitionRejectionError` the store layer raises in production.
  */
  it("holds the card as needs-replan in place when the planning lane refuses at capacity", async () => {
    resetExecutorMocks();
    const tasksDir = await mkdtemp(join(tmpdir(), "fusion-zero-step-capacity-"));
    const liveTask = task();
    const { store, executor } = await executorWithPrompt(tasksDir, liveTask);
    store.moveTask.mockRejectedValue(new TransitionRejectionError(
      { code: "capacity-exhausted", detail: "planning lane at capacity" },
      "destination at capacity",
    ));

    try {
      await (executor as any).handleGraphFailure(liveTask, parseFailure("missing-implementation-steps"));
      expect(store.moveTask).toHaveBeenCalled();
      expect(store.updateTask).toHaveBeenCalledWith(
        liveTask.id,
        expect.objectContaining({ status: "needs-replan", error: null }),
        undefined,
      );
      expect(store.updateTask).not.toHaveBeenCalledWith(
        liveTask.id,
        expect.objectContaining({ status: "failed" }),
        undefined,
      );
      expect(store.logEntry).toHaveBeenCalledWith(
        liveTask.id,
        "AI spec revision requested",
        expect.stringContaining("in place"),
        undefined,
      );
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  it("contains a review-lane card in place instead of moving it back to planning", async () => {
    resetExecutorMocks();
    const tasksDir = await mkdtemp(join(tmpdir(), "fusion-zero-step-review-"));
    const liveTask = task({ column: "in-review" });
    const { store, executor } = await executorWithPrompt(tasksDir, liveTask);

    try {
      await (executor as any).handleGraphFailure(liveTask, parseFailure("missing-implementation-steps"));
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.updateTask).toHaveBeenCalledWith(
        liveTask.id,
        expect.objectContaining({ status: "needs-replan", error: null }),
        undefined,
      );
      expect(store.updateTask).not.toHaveBeenCalledWith(
        liveTask.id,
        expect.objectContaining({ status: "failed" }),
        undefined,
      );
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  it("keeps the existing duplicate-redirect sub-case on its own path", async () => {
    resetExecutorMocks();
    const tasksDir = await mkdtemp(join(tmpdir(), "fusion-duplicate-still-works-"));
    const liveTask = task({
      title: "DUPLICATE: RUFU-500",
      status: null,
      error: "parse error",
    });
    const { store, executor } = await executorWithPrompt(tasksDir, liveTask);

    try {
      await (executor as any).handleGraphFailure(liveTask, parseFailure("parse-error"));
      expect(store.updateTask).toHaveBeenCalledWith(
        liveTask.id,
        { status: null, error: null },
        undefined,
      );
      expect(store.updateTask).not.toHaveBeenCalledWith(
        liveTask.id,
        expect.objectContaining({ status: "needs-replan" }),
        undefined,
      );
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });
});
