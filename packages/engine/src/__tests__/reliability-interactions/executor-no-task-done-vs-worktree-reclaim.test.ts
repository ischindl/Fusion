import { describe, it, expect, vi, beforeEach } from "vitest";
import "../executor-test-helpers.js";
import { TaskExecutor } from "../../executor.js";
import { mockedCreateFnAgent, createMockStore, resetExecutorMocks } from "../executor-test-helpers.js";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4601",
    title: "Test",
    description: "Test task",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Preflight", status: "in-progress" }],
    currentStep: 0,
    taskDoneRetryCount: 0,
    worktree: "/tmp/test/.worktrees/fn-4601",
    branch: "fusion/fn-4601",
    log: [],
    prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as any;
}

function makeSession() {
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(),
    on: vi.fn(),
    sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
    state: {},
  };
}

describe("reliability interactions: executor no-fn_task_done vs worktree reclaim", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("pre-retry liveness recheck aborts retry and requeues", async () => {
    const store = createMockStore();
    const state = makeTask();
    let getTaskCalls = 0;
    store.getTask.mockImplementation(async () => {
      getTaskCalls++;
      if (getTaskCalls >= 2) {
        state.worktree = null;
        state.branch = null;
      }
      return { ...state };
    });

    mockedCreateFnAgent.mockResolvedValue({ session: makeSession() } as any);

    const executor = new TaskExecutor(store as any, "/tmp/test");
    await executor.execute(state);

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    expect(store.moveTask).toHaveBeenCalledWith("FN-4601", "todo", { preserveProgress: true });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4601",
      expect.stringContaining("worktree/branch reclaimed during no-fn_task_done retry"),
      undefined,
      expect.any(Object),
    );
    expect(store.updateTask).toHaveBeenCalledWith("FN-4601", expect.objectContaining({ taskDoneRetryCount: 1 }));
  });

  it("missing-worktree session-start error during retry clears metadata and requeues", async () => {
    const store = createMockStore();
    const state = makeTask();
    store.getTask.mockImplementation(async () => ({ ...state }));

    mockedCreateFnAgent
      .mockResolvedValueOnce({ session: makeSession() } as any)
      .mockRejectedValueOnce(new Error("Refusing to start coding agent in missing worktree: /tmp/test/.worktrees/fn-4601"));

    const executor = new TaskExecutor(store as any, "/tmp/test");
    await executor.execute(state);

    expect(store.updateTask).toHaveBeenCalledWith("FN-4601", {
      sessionFile: null,
      worktree: null,
      branch: null,
      baseCommitSha: null,
    });
    expect(store.moveTask).toHaveBeenCalledWith("FN-4601", "todo", { preserveProgress: true });
    expect(store.updateTask).toHaveBeenCalledWith("FN-4601", expect.objectContaining({ taskDoneRetryCount: 1 }));
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4601", "in-review");
  });

  it("non-recoverable retry error still follows failure path", async () => {
    const store = createMockStore();
    const state = makeTask();
    store.getTask.mockImplementation(async () => ({ ...state }));

    mockedCreateFnAgent
      .mockResolvedValueOnce({ session: makeSession() } as any)
      .mockRejectedValueOnce(new Error("boom"));

    const executor = new TaskExecutor(store as any, "/tmp/test");
    await executor.execute(state);

    expect(store.moveTask).toHaveBeenCalledWith("FN-4601", "in-review");
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-4601", expect.objectContaining({ baseCommitSha: null, worktree: null, branch: null }));
  });

  it("exhausted requeue budget keeps reclaim path in in-review", async () => {
    const store = createMockStore();
    const state = makeTask({ taskDoneRetryCount: 3 });
    let getTaskCalls = 0;
    store.getTask.mockImplementation(async () => {
      getTaskCalls++;
      if (getTaskCalls >= 2) {
        state.worktree = null;
        state.branch = null;
      }
      return { ...state };
    });

    mockedCreateFnAgent.mockResolvedValue({ session: makeSession() } as any);

    const executor = new TaskExecutor(store as any, "/tmp/test");
    await executor.execute(state);

    expect(store.moveTask).toHaveBeenCalledWith("FN-4601", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4601", "todo", { preserveProgress: true });
  });
});
