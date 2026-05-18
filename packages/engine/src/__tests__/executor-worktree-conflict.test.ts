import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { activeSessionRegistry } from "../active-session-registry.js";
import { ActiveSessionWorktreeRemovalError } from "../worktree-backend.js";
import * as worktreePoolModule from "../worktree-pool.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

const CONFLICT_PATH = "/tmp/test/.worktrees/stale-self-owned";

describe("FN-4973: executor worktree conflict cleanup", () => {
  beforeEach(() => {
    resetExecutorMocks();
    activeSessionRegistry.clear();
  });

  it("reconciles stale self-owned registry entry before removal", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    store.listTasks.mockResolvedValue([]);
    activeSessionRegistry.registerPath(CONFLICT_PATH, { taskId: "FN-4973", kind: "executor", ownerKey: "FN-4973" });

    const removeSpy = vi.spyOn(worktreePoolModule, "removeWorktree").mockResolvedValue(undefined);
    const result = await (executor as any).cleanupConflictingWorktree(CONFLICT_PATH, "fusion/fn-4973", "FN-4973");

    expect(result).toBe(true);
    expect(removeSpy).toHaveBeenCalled();
    expect(activeSessionRegistry.lookupByPath(CONFLICT_PATH)).toBeNull();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4973",
      "Reconciled stale self-owned active-session registration",
      CONFLICT_PATH,
    );
  });

  it("does not reconcile when same-task in-memory binding is live and refuses removal", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    store.listTasks.mockResolvedValue([]);
    (executor as any).activeWorktrees.set("FN-4973", CONFLICT_PATH);
    activeSessionRegistry.registerPath(CONFLICT_PATH, { taskId: "FN-4973", kind: "executor", ownerKey: "FN-4973" });

    vi.spyOn(worktreePoolModule, "removeWorktree").mockRejectedValue(
      new ActiveSessionWorktreeRemovalError({
        worktreePath: CONFLICT_PATH,
        taskId: "FN-4973",
        kind: "executor",
        ownerKey: "FN-4973",
        reason: worktreePoolModule.RemovalReason.ExecutorDispose,
      }),
    );

    const result = await (executor as any).cleanupConflictingWorktree(CONFLICT_PATH, "fusion/fn-4973", "FN-4973");
    expect(result).toBe(false);
    expect(activeSessionRegistry.lookupByPath(CONFLICT_PATH)?.taskId).toBe("FN-4973");
  });

  it("does not reconcile foreign-task registry entries and keeps refusal behavior", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    store.listTasks.mockResolvedValue([]);
    activeSessionRegistry.registerPath(CONFLICT_PATH, { taskId: "FN-OTHER", kind: "executor", ownerKey: "FN-OTHER" });

    vi.spyOn(worktreePoolModule, "removeWorktree").mockRejectedValue(
      new ActiveSessionWorktreeRemovalError({
        worktreePath: CONFLICT_PATH,
        taskId: "FN-OTHER",
        kind: "executor",
        ownerKey: "FN-OTHER",
        reason: worktreePoolModule.RemovalReason.ExecutorDispose,
      }),
    );

    const result = await (executor as any).cleanupConflictingWorktree(CONFLICT_PATH, "fusion/fn-4973", "FN-4973");
    expect(result).toBe(false);
    expect(activeSessionRegistry.lookupByPath(CONFLICT_PATH)?.taskId).toBe("FN-OTHER");
  });

  it("reconciles once on race-window ActiveSessionWorktreeRemovalError then retries removal", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    store.listTasks.mockResolvedValue([]);

    const removeSpy = vi.spyOn(worktreePoolModule, "removeWorktree");
    removeSpy
      .mockImplementationOnce(async () => {
        activeSessionRegistry.registerPath(CONFLICT_PATH, { taskId: "FN-4973", kind: "executor", ownerKey: "FN-4973" });
        throw new ActiveSessionWorktreeRemovalError({
          worktreePath: CONFLICT_PATH,
          taskId: "FN-4973",
          kind: "executor",
          ownerKey: "FN-4973",
          reason: worktreePoolModule.RemovalReason.ExecutorDispose,
        });
      })
      .mockResolvedValueOnce(undefined);

    const result = await (executor as any).cleanupConflictingWorktree(CONFLICT_PATH, "fusion/fn-4973", "FN-4973");

    expect(result).toBe(true);
    expect(removeSpy).toHaveBeenCalledTimes(2);
    expect(activeSessionRegistry.lookupByPath(CONFLICT_PATH)).toBeNull();
  });
});
