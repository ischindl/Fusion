import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

/*
FNXC:EphemeralAgents 2026-07-01-00:00:
Regression coverage for the ephemeral-disabled dispatch gate. `ephemeralAgentsEnabled: false`
must stop the workflow engine from running unassigned work, not just the legacy spawn path.
The bug: EphemeralWorkerManager.onTaskStart is a fire-and-forget bookkeeping callback that runs
AFTER execution begins, and the three workflow dispatch paths in TaskExecutor.execute()
(maybeExecuteWorkflowGraph, workflowAuthoritativeDispatch, maybeDispatchWorkflowWorkEngine)
never consulted the toggle — so tasks reaching execute() without a permanent assignment ran
anyway. These tests assert the invariant across ALL THREE workflow dispatch entry points
(Surface Enumeration), not just one reproduction.
*/

const now = "2026-07-01T00:00:00.000Z";

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-EPHEMERAL-GATE",
    title: "Ephemeral-disabled dispatch gate",
    description: "Gate coverage for ephemeralAgentsEnabled=false workflow dispatch",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Implement", status: "pending" }],
    currentStep: 0,
    log: [],
    branch: "fusion/fn-ephemeral-gate",
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-ephemeral-gate",
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

function settings(overrides: Record<string, unknown> = {}) {
  return {
    autoMerge: true,
    maxAutoMergeRetries: 3,
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    ...overrides,
  };
}

describe("executor ephemeral-disabled dispatch gate", () => {
  it("blocks and re-queues an unassigned task when ephemeralAgentsEnabled=false", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({ column: "in-progress", assignedAgentId: undefined });
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue(settings({ ephemeralAgentsEnabled: false }));
    const executor = new TaskExecutor(store, "/tmp/test");

    const blocked = await (executor as any).blockOuterDispatchWhenEphemeralDisabled(live);

    expect(blocked).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith(
      live.id,
      "todo",
      expect.objectContaining({ preserveProgress: true, moveSource: "engine", recoveryRehome: true }),
    );
    expect(store.updateTask).toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "queued" }),
      undefined,
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      live.id,
      expect.stringContaining("ephemeral agents disabled"),
      expect.stringContaining("Executor pre-dispatch ephemeral gate"),
      undefined,
    );
  });

  it("allows dispatch when ephemeralAgentsEnabled is on (default)", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({ assignedAgentId: undefined });
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue(settings({ ephemeralAgentsEnabled: true }));
    const executor = new TaskExecutor(store, "/tmp/test");

    const blocked = await (executor as any).blockOuterDispatchWhenEphemeralDisabled(live);

    expect(blocked).toBe(false);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("allows dispatch when the toggle is absent (undefined defaults to enabled)", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({ assignedAgentId: undefined });
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue(settings());
    const executor = new TaskExecutor(store, "/tmp/test");

    expect(await (executor as any).blockOuterDispatchWhenEphemeralDisabled(live)).toBe(false);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("allows a task assigned to a permanent (non-ephemeral) agent through", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({ assignedAgentId: "agent-permanent" });
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue(settings({ ephemeralAgentsEnabled: false }));
    const agentStore = {
      getAgent: vi.fn().mockResolvedValue({ id: "agent-permanent", name: "reviewer", role: "executor" }),
    };
    const executor = new TaskExecutor(store, "/tmp/test", { agentStore } as any);

    const blocked = await (executor as any).blockOuterDispatchWhenEphemeralDisabled(live);

    expect(blocked).toBe(false);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("blocks a task whose assigned agent is itself ephemeral", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({ assignedAgentId: "executor-FN-EPHEMERAL-GATE" });
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue(settings({ ephemeralAgentsEnabled: false }));
    // isEphemeralAgent keys off the runtime-managed task-worker marker.
    const agentStore = {
      getAgent: vi.fn().mockResolvedValue({
        id: "executor-FN-EPHEMERAL-GATE",
        name: "executor-FN-EPHEMERAL-GATE",
        role: "executor",
        metadata: { agentKind: "task-worker", taskWorker: true },
      }),
    };
    const executor = new TaskExecutor(store, "/tmp/test", { agentStore } as any);

    const blocked = await (executor as any).blockOuterDispatchWhenEphemeralDisabled(live);

    expect(blocked).toBe(true);
    expect(store.updateTask).toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "queued" }),
      undefined,
    );
  });

  /*
  FNXC:EphemeralAgents 2026-07-01-00:00:
  Surface Enumeration — one gate must cover all three workflow dispatch entry points.
  Drive the real execute() and assert none of maybeExecuteWorkflowGraph,
  workflowAuthoritativeDispatch, or maybeDispatchWorkflowWorkEngine is reached when the
  gate blocks. This is the invariant that prevented the fix from being repro-only.
  */
  it("execute() reaches no workflow dispatch path when ephemeral is disabled and task is unassigned", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({ assignedAgentId: undefined });
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue(settings({ ephemeralAgentsEnabled: false }));

    const workflowAuthoritativeDispatch = vi.fn().mockResolvedValue(false);
    const executor = new TaskExecutor(store, "/tmp/test", { workflowAuthoritativeDispatch } as any);

    const graphSpy = vi.spyOn(executor as any, "maybeExecuteWorkflowGraph").mockResolvedValue(false);
    const workEngineSpy = vi
      .spyOn(executor as any, "maybeDispatchWorkflowWorkEngine")
      .mockResolvedValue(false);

    await executor.execute(live);

    // Every workflow dispatch entry point must be unreachable once the gate blocks.
    expect(graphSpy).not.toHaveBeenCalled();
    expect(workflowAuthoritativeDispatch).not.toHaveBeenCalled();
    expect(workEngineSpy).not.toHaveBeenCalled();

    // And the task is re-queued for the scheduler to assign a permanent agent.
    expect(store.updateTask).toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "queued" }),
      undefined,
    );
  });

  it("execute() still reaches the workflow graph path when ephemeral agents are enabled", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({ assignedAgentId: undefined });
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue(settings({ ephemeralAgentsEnabled: true }));

    const executor = new TaskExecutor(store, "/tmp/test");
    // Return true so execute() stops after the first workflow path — we only need
    // to prove the gate did NOT short-circuit dispatch when the toggle is on.
    const graphSpy = vi.spyOn(executor as any, "maybeExecuteWorkflowGraph").mockResolvedValue(true);

    await executor.execute(live);

    expect(graphSpy).toHaveBeenCalledTimes(1);
    expect(store.updateTask).not.toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "queued" }),
      undefined,
    );
  });
});
