import { beforeEach, describe, expect, it } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import type { TaskDetail } from "@fusion/core";

const now = "2026-06-20T00:00:00.000Z";

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-6782-T",
    title: "pause-abort benign todo repro",
    description: "Reproduces FN-6782 benign requeue-to-todo classification",
    column: "todo",
    dependencies: [],
    steps: [{ name: "Implement", status: "pending" }],
    currentStep: 0,
    log: [],
    branch: null,
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-6782-t",
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

function makeHarness(taskOverrides: Partial<TaskDetail> = {}) {
  const store = createMockStore();
  const task = makeTask(taskOverrides);
  store.getTask.mockResolvedValue(task);
  store.getSettings.mockResolvedValue({
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    autoMerge: true,
    maxAutoMergeRetries: 3,
  });
  const executor = new TaskExecutor(store, "/tmp/test", {});
  (executor as any).markPausedAborted(task.id, "hard-cancel");
  return { store, task, executor };
}

async function invokeGraphFailure(executor: TaskExecutor, task: TaskDetail) {
  await (executor as any).handleGraphFailure(task, {
    disposition: "failed",
    outcome: "failure",
    visitedNodeIds: ["plan", "execute"],
    context: {},
  });
}

function logText(store: ReturnType<typeof createMockStore>): string {
  return store.logEntry.mock.calls.map((call: unknown[]) => call[1]).join("\n");
}

describe("pause-abort benign requeue-to-todo (FN-6782)", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("does NOT park a todo-column pause-abort as failed (no retry storm)", async () => {
    const { store, task, executor } = makeHarness({ column: "todo" });
    (executor as any).activeWorktrees.set(task.id, task.worktree);

    await invokeGraphFailure(executor, task);

    // FNXC:WorkflowLifecycle a todo pause-abort must NOT write status:"failed" — that was the storm trigger.
    const parkedFailed = store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { status?: string } | undefined)?.status === "failed",
    );
    expect(parkedFailed).toBe(false);
    // FNXC:WorkflowLifecycle the benign-clear log must surface for observability.
    expect(logText(store)).toContain("benign, cleared for normal scheduling");
    // FNXC:WorkflowLifecycle the pausedAborted marker must be cleared so the next dispatch starts clean.
    expect((executor as any).pausedAborted.has(task.id)).toBe(false);
    // FNXC:WorkflowLifecycle the leaked worktree slot must be released to avoid board-wide concurrency blockage.
    expect((executor as any).activeWorktrees.has(task.id)).toBe(false);
    // FNXC:WorkflowLifecycle 2026-06-20-19:58 a clean todo row (no stale status/error)
    // must NOT trigger the reconciliation write — the `live.status != null ||
    // live.error != null` guard skips it so the common benign re-queue stays a no-op.
    const clearedClean = store.updateTask.mock.calls.some(
      (call: unknown[]) => {
        const patch = call[1] as { status?: unknown; error?: unknown } | undefined;
        return patch?.status === null && patch?.error === null;
      },
    );
    expect(clearedClean).toBe(false);
  });

  it("clears a stale failed status when reclassifying a todo pause-abort as benign (no lingering failure notification)", async () => {
    // FNXC:WorkflowLifecycle 2026-06-20-19:58 a pause-abort parked status:"failed"
    // on an earlier non-todo observation stays dispatchable (scheduler filters
    // column+paused, not status) and re-enters this branch in todo. The benign
    // reclassification must reconcile the row to status:null/error:null —
    // otherwise the persisted failure survives, the board shows it failed, and
    // the deferred failure notification fires despite the benign log.
    const { store, task, executor } = makeHarness({
      column: "todo",
      status: "failed",
      error: "Workflow graph failure surfaced after paused engine abort during pause/resume",
    });
    (executor as any).activeWorktrees.set(task.id, task.worktree);

    await invokeGraphFailure(executor, task);

    const clearedFailure = store.updateTask.mock.calls.some(
      (call: unknown[]) => {
        const patch = call[1] as { status?: unknown; error?: unknown } | undefined;
        return patch?.status === null && patch?.error === null;
      },
    );
    expect(clearedFailure).toBe(true);
    const reParkedFailed = store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { status?: string } | undefined)?.status === "failed",
    );
    expect(reParkedFailed).toBe(false);
    expect(logText(store)).toContain("benign, cleared for normal scheduling");
    // FNXC:WorkflowLifecycle 2026-06-20-19:58 the clear path must emit an
    // `Auto-recovered:`-prefixed log so NotificationService proactively cancels
    // the pending failure timer (recoveredStatus path), not just suppress it at
    // fire time. Prefix is the documented self-healing recovery contract.
    expect(logText(store)).toContain("Auto-recovered: cleared stale pause-abort failure on todo re-queue");
  });

  it("STILL parks a non-todo (in-review) pause-abort as operator-action failed", async () => {
    const { store, task, executor } = makeHarness({ column: "in-review" });

    await invokeGraphFailure(executor, task);

    const parkedFailed = store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { status?: string } | undefined)?.status === "failed",
    );
    expect(parkedFailed).toBe(true);
    expect(logText(store)).toContain("operator action required");
  });
});
