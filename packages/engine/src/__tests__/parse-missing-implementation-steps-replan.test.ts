import "./executor-test-helpers.js";
import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@fusion/core";

import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

/*
FNXC:PlanArtifactIntegrity 2026-11-13-07:30 (RUFU-693):
A plan that published successfully but yields zero executable steps was terminalized `failed` in its own
lane. That single word was the bug: `needs-replan` always has a planning claimant while a `failed` card has
none (`triage.ts`), so the card sat holding a branch, a worktree and a file-scope lease while the planner
overseer re-spent retries on a deterministic answer. Measured on RUFU-518: 55 `overseer:intervention` rows
in 24h.

Asserted through the real `handleGraphFailure` rather than a mock of its conclusion, because the fix is a
DISPOSITION: what gets written, what must never be written, and what must not be touched.

The card must also never be MOVED. Graph routing has no backward lifecycle authority, and a move would have
required a new sanctioned `wip -> hold` reason plus a widened F5 -- a second backward-move authority for a
benefit the status alone already delivers. A first cut did that; these assertions are why it does not.
*/

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-518",
    title: "Cold-engine project scope must not borrow the launch project onMerge",
    description: "Route the merge by the target project.",
    column: "in-progress",
    status: "failed",
    error: "Workflow graph terminated with failure at node 'parse' (missing-implementation-steps)",
    recoveryRetryCount: 3,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    workflowStepResults: [{
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      status: "passed",
      verdict: "APPROVE_WITH_NOTES",
      phase: "pre-merge",
      completedAt: new Date().toISOString(),
    }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

async function executorWithProsePlan(tasksDir: string, liveTask: Task) {
  const store = createMockStore();
  await mkdir(join(tasksDir, liveTask.id), { recursive: true });
  await writeFile(
    join(tasksDir, liveTask.id, "PROMPT.md"),
    "# Task: RUFU-518\n## What to do\nFix the routing.\n",
    "utf-8",
  );
  store.getTasksDir = vi.fn(() => tasksDir);
  store.getTask.mockResolvedValue(liveTask);
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

function writesWithStatus(store, status: string) {
  return store.updateTask.mock.calls.filter(
    (call: unknown[]) => (call[1] as Record<string, unknown>).status === status,
  );
}

describe("parse found no executable step: parked for planner repair, never terminalized (RUFU-693)", () => {
  it("parks a WIP card as needs-replan with recovery counters cleared, and never writes failed", async () => {
    resetExecutorMocks();
    const tasksDir = await mkdtemp(join(tmpdir(), "fusion-zero-step-parse-"));
    const liveTask = task();
    const { store, executor } = await executorWithProsePlan(tasksDir, liveTask);

    try {
      await (executor as any).handleGraphFailure(liveTask, parseFailure("missing-implementation-steps"));

      expect(store.updateTask).toHaveBeenCalledWith(
        liveTask.id,
        expect.objectContaining({
          status: "needs-replan",
          error: null,
          recoveryRetryCount: null,
          nextRecoveryAt: null,
        }),
        undefined,
      );
      // The whole defect was the terminal status: it has no planning claimant.
      expect(writesWithStatus(store, "failed")).toHaveLength(0);
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  it("names the exact heading shape in the plan-revision History entry", async () => {
    resetExecutorMocks();
    const tasksDir = await mkdtemp(join(tmpdir(), "fusion-zero-step-history-"));
    const liveTask = task();
    const { store, executor } = await executorWithProsePlan(tasksDir, liveTask);

    try {
      await (executor as any).handleGraphFailure(liveTask, parseFailure("missing-implementation-steps"));
      const revision = store.logEntry.mock.calls.find(
        (call: unknown[]) => call[1] === "AI spec revision requested",
      );
      expect(revision).toBeDefined();
      const detail = String(revision[2]);
      expect(detail).toContain("missing-implementation-steps");
      expect(detail).toContain("## Steps");
      expect(detail).toContain("### Step N:");
      // A revision notice that only says "refused" invites the same stepless bytes.
      expect(detail).not.toContain("retry the same");
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  it("author no backward move: the card stays in the lane it was dispatched from", async () => {
    resetExecutorMocks();
    const tasksDir = await mkdtemp(join(tmpdir(), "fusion-zero-step-nomove-"));
    const liveTask = task();
    const { store, executor } = await executorWithProsePlan(tasksDir, liveTask);

    try {
      await (executor as any).handleGraphFailure(liveTask, parseFailure("missing-implementation-steps"));
      // Graph routing has no backward lifecycle authority; a move here would need a new sanctioned
      // `wip -> hold` reason and a widened F5, which is the second authority this card refused to add.
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.moveTaskIf).not.toHaveBeenCalled();
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  it("parks a review-lane card in place as well, because containment is not lane-specific here", async () => {
    resetExecutorMocks();
    const tasksDir = await mkdtemp(join(tmpdir(), "fusion-zero-step-review-"));
    const liveTask = task({ column: "in-review" });
    const { store, executor } = await executorWithProsePlan(tasksDir, liveTask);

    try {
      await (executor as any).handleGraphFailure(liveTask, parseFailure("missing-implementation-steps"));
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.updateTask).toHaveBeenCalledWith(
        liveTask.id,
        expect.objectContaining({ status: "needs-replan", error: null }),
        undefined,
      );
      expect(writesWithStatus(store, "failed")).toHaveLength(0);
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  it("does not touch a user-paused card, because an operator hold outranks recovery", async () => {
    resetExecutorMocks();
    const tasksDir = await mkdtemp(join(tmpdir(), "fusion-zero-step-paused-"));
    const liveTask = task({ userPaused: true, paused: true });
    const { store, executor } = await executorWithProsePlan(tasksDir, liveTask);

    try {
      await (executor as any).handleGraphFailure(liveTask, parseFailure("missing-implementation-steps"));
      expect(writesWithStatus(store, "needs-replan")).toHaveLength(0);
      expect(store.moveTask).not.toHaveBeenCalled();
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  it("keeps the existing duplicate-redirect sub-case on its own path", async () => {
    resetExecutorMocks();
    const tasksDir = await mkdtemp(join(tmpdir(), "fusion-duplicate-still-works-"));
    const liveTask = task({ title: "DUPLICATE: RUFU-500", status: null, error: "parse error" });
    const { store, executor } = await executorWithProsePlan(tasksDir, liveTask);

    try {
      await (executor as any).handleGraphFailure(liveTask, parseFailure("parse-error"));
      expect(store.updateTask).toHaveBeenCalledWith(liveTask.id, { status: null, error: null }, undefined);
      expect(writesWithStatus(store, "needs-replan")).toHaveLength(0);
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });
});
