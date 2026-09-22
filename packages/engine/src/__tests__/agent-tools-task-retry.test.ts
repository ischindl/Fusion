import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { createTaskRetryTool } from "../agent-tools.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-9317",
    description: "Recover an admitted merge retry",
    dependencies: [],
    column: "in-review",
    steps: [{ id: "step-1", title: "Implement", status: "done" }],
    currentStep: 0,
    log: [],
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    status: null,
    mergeRetries: 0,
    ...overrides,
  } as Task;
}

function atomicStore(task: Task) {
  return vi.fn(async (_id: string, mutate: (current: Task) => Partial<Task> | null | Promise<Partial<Task> | null>) => {
    const patch = await mutate(task);
    return patch ? { ...task, ...patch } : task;
  });
}

describe("createTaskRetryTool", () => {
  it("keeps a completed status-none review task in review and resets its merge recovery state", async () => {
    const completedReviewTask = task();
    const updateTask = vi.fn().mockResolvedValue(completedReviewTask);
    const logEntry = vi.fn().mockResolvedValue(undefined);
    const moveTask = vi.fn();
    const updateTaskAtomic = atomicStore(completedReviewTask);
    const resetInReviewMergeRetry = vi.fn().mockResolvedValue("reset");
    const store = {
      getTask: vi.fn().mockResolvedValue(completedReviewTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      updateTask,
      updateTaskAtomic,
      logEntry,
      moveTask,
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store, { resetInReviewMergeRetry }).execute(
      "run", { id: completedReviewTask.id }, undefined as never, undefined as never, undefined as never,
    );

    expect((result as { isError?: boolean }).isError).not.toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Retried FN-9317 in review");
    expect(resetInReviewMergeRetry).toHaveBeenCalledWith(completedReviewTask);
    expect(updateTaskAtomic).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalledWith("FN-9317", expect.stringContaining("in-review merge retry"));
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("refuses a status-none retry while ProjectEngine still owns the queued merge", async () => {
    const queuedMergeTask = task();
    const updateTask = vi.fn();
    const logEntry = vi.fn();
    const updateTaskAtomic = vi.fn();
    const isMergePending = vi.fn().mockResolvedValue(true);
    const resetInReviewMergeRetry = vi.fn().mockResolvedValue("pending");
    const store = {
      getTask: vi.fn().mockResolvedValue(queuedMergeTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      updateTask,
      updateTaskAtomic,
      logEntry,
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store, { isMergePending, resetInReviewMergeRetry }).execute(
      "run", { id: queuedMergeTask.id }, undefined as never, undefined as never, undefined as never,
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("merge is queued or active");
    expect(resetInReviewMergeRetry).toHaveBeenCalledWith(queuedMergeTask);
    expect(isMergePending).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(updateTaskAtomic).not.toHaveBeenCalled();
    expect(logEntry).not.toHaveBeenCalled();
  });

  it("refuses a completed status-none review card held for manual merge", async () => {
    const manualReviewTask = task({ autoMerge: false });
    const updateTask = vi.fn();
    const logEntry = vi.fn();
    const moveTask = vi.fn();
    const store = {
      getTask: vi.fn().mockResolvedValue(manualReviewTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      updateTask,
      logEntry,
      moveTask,
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store).execute(
      "run", { id: manualReviewTask.id }, undefined as never, undefined as never, undefined as never,
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not in a retryable state");
    expect(updateTask).not.toHaveBeenCalled();
    expect(logEntry).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("fails closed when chat lacks ProjectEngine merge ownership", async () => {
    const completedReviewTask = task();
    const updateTaskAtomic = vi.fn();
    const store = {
      getTask: vi.fn().mockResolvedValue(completedReviewTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      updateTaskAtomic,
      logEntry: vi.fn(),
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store).execute("run", { id: completedReviewTask.id }, undefined as never, undefined as never, undefined as never);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("authoritative merge ownership is unavailable");
    expect(updateTaskAtomic).not.toHaveBeenCalled();
  });

  /*
  FNXC:TaskRetrySurfaceSeparation 2026-09-22-10:14 (RUFU-261):
  Chat Retry is the third operator Retry surface, and it releases a failed card rather than parking
  it — by a different mechanism than the CLI surfaces, which state the release explicitly
  (`parkOnHold: false`) because they keep `moveSource: "user"` for attribution. This surface passes
  NO move options at all, so `moveTask` derives `moveSource: "engine"` and the hold-lane park
  predicate (`moveSource === "user"`) can never fire. Pinning the absence of a park-producing source
  is the contract: adding operator attribution here later would silently make chat Retry the same
  self-defeating park RUFU-261 removed, and no other case in this file exercises the re-queue branch.
  */
  it("re-queues a failed task without a park-producing move source", async () => {
    const failedTask = task({ column: "in-progress", status: "failed", error: "boom", userPaused: true, paused: true });
    const updateTask = vi.fn().mockResolvedValue(failedTask);
    const moveTask = vi.fn().mockResolvedValue(failedTask);
    const logEntry = vi.fn().mockResolvedValue(undefined);
    const store = {
      getTask: vi.fn().mockResolvedValue(failedTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({}),
      updateTask,
      moveTask,
      logEntry,
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store).execute(
      "run", { id: failedTask.id }, undefined as never, undefined as never, undefined as never,
    );

    expect((result as { isError?: boolean }).isError).not.toBe(true);
    expect(updateTask).toHaveBeenCalledWith(failedTask.id, { status: null, error: null });
    expect(moveTask).toHaveBeenCalledTimes(1);
    const [, targetColumn, moveOptions] = moveTask.mock.calls[0] as [
      string,
      string,
      { moveSource?: string; parkOnHold?: boolean } | undefined,
    ];
    // The rebound destination (the board's hold lane, legacy `todo` when the workflow is unreadable)
    // is the parking lane, so the move's source is the only thing keeping this card dispatchable.
    expect(typeof targetColumn).toBe("string");
    expect(targetColumn.length).toBeGreaterThan(0);
    expect(moveOptions?.moveSource).not.toBe("user");
    expect(moveOptions?.parkOnHold).not.toBe(true);
    // Three-argument call: the third is the "Task reset to <lane> for retry" detail, so the row is
    // auditable with the destination it actually landed in.
    expect(logEntry.mock.calls[0][0]).toBe(failedTask.id);
    expect(logEntry.mock.calls[0][1]).toBe("Retry requested via chat tool");
    expect(String(logEntry.mock.calls[0][2])).toContain(targetColumn);
  });

  it("refuses when the ProjectEngine-owned reset fence observes a merge admission", async () => {
    const completedReviewTask = task();
    const resetInReviewMergeRetry = vi.fn().mockResolvedValue("pending");
    const logEntry = vi.fn();
    const store = {
      getTask: vi.fn().mockResolvedValue(completedReviewTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      logEntry,
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store, { resetInReviewMergeRetry }).execute("run", { id: completedReviewTask.id }, undefined as never, undefined as never, undefined as never);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("merge is queued or active");
    expect(resetInReviewMergeRetry).toHaveBeenCalledWith(completedReviewTask);
    expect(logEntry).not.toHaveBeenCalled();
  });
});
