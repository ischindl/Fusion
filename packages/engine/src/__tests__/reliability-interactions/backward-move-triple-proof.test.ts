import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";
import { activeSessionRegistry, executingTaskLock } from "../../active-session-registry.js";

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, { cwd, encoding: "utf8" }).trim();
}

describe("FN-5335 reliability interactions: backward move triple proof", () => {
  let rootDir = "";
  let store: TaskStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T12:00:00.000Z"));
    activeSessionRegistry.clear();
    executingTaskLock._clearForTest();
    rootDir = mkdtempSync(join(tmpdir(), "fn-5335-reliability-"));
    git(rootDir, "init -b main");
    git(rootDir, "config user.name 'Fusion'");
    git(rootDir, "config user.email 'hi@runfusion.ai'");
    writeFileSync(join(rootDir, "README.md"), "root\n");
    git(rootDir, "add README.md");
    git(rootDir, "commit -m 'init'");
    mkdirSync(join(rootDir, ".worktrees"), { recursive: true });
    store = new TaskStore(rootDir, undefined, { inMemoryDb: false });
    await store.init();
  });

  afterEach(() => {
    activeSessionRegistry.clear();
    executingTaskLock._clearForTest();
    try { store?.close(); } catch {}
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function createNoProgressTask(worktree: string, ageMs: number) {
    const task = await store.createTask({ title: "no-progress", description: "no-progress" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.updateTask(task.id, {
      worktree,
      status: "failed",
      paused: false,
      error: "Agent finished without calling fn_task_done",
      executionStartedAt: new Date(Date.now() - ageMs).toISOString(),
      updatedAt: new Date(Date.now() - ageMs).toISOString(),
      steps: [{ name: "step", status: "pending" }],
    } as any);
    return task.id;
  }

  it("Scenario A: live session blocks backward move and emits no-action", async () => {
    const worktree = join(rootDir, ".worktrees", "np-live-missing");
    const id = await createNoProgressTask(worktree, 400_000);
    activeSessionRegistry.registerPath(worktree, { taskId: id, kind: "executor", ownerKey: "run-a" });

    const manager = new SelfHealingManager(store, { rootDir, isTaskActive: () => false });
    const recovered = await manager.recoverNoProgressNoTaskDoneFailures();
    const task = await store.getTask(id);
    const events = await store.getRunAuditEvents({ taskId: id, mutationType: "task:no-progress-no-task-done-no-action" });

    expect(recovered).toBe(0);
    expect(task?.column).toBe("in-progress");
    expect(events).toHaveLength(1);
    manager.stop();
  });

  it("Scenario B: usable worktree blocks backward move (recoverable git work short-circuit)", async () => {
    const worktree = join(rootDir, ".worktrees", "np-usable");
    mkdirSync(worktree, { recursive: true });
    const id = await createNoProgressTask(worktree, 400_000);
    const manager = new SelfHealingManager(store, { rootDir, isTaskActive: () => false });

    const recovered = await manager.recoverNoProgressNoTaskDoneFailures();
    const task = await store.getTask(id);
    const events = await store.getRunAuditEvents({ taskId: id, mutationType: "task:no-progress-no-task-done-no-action" });

    expect(recovered).toBe(0);
    expect(task?.column).toBe("in-progress");
    expect(events).toHaveLength(0);
    manager.stop();
  });

  it("Scenario C: recent activity blocks backward move", async () => {
    const id = await createNoProgressTask(join(rootDir, ".worktrees", "np-missing-recent"), 200);
    const manager = new SelfHealingManager(store, { rootDir, isTaskActive: () => false });

    const recovered = await manager.recoverNoProgressNoTaskDoneFailures();
    const task = await store.getTask(id);
    const events = await store.getRunAuditEvents({ taskId: id, mutationType: "task:no-progress-no-task-done-no-action" });

    expect(recovered).toBe(0);
    expect(task?.column).toBe("in-progress");
    expect(events).toHaveLength(1);
    manager.stop();
  });

  it("Scenario D: all triple-proof signals true allows recovery", async () => {
    const id = await createNoProgressTask(join(rootDir, ".worktrees", "np-missing-stale"), 400_000);
    const manager = new SelfHealingManager(store, { rootDir, isTaskActive: () => false });

    const recovered = await manager.recoverNoProgressNoTaskDoneFailures();
    const task = await store.getTask(id);

    expect(recovered).toBe(1);
    expect(task?.column).toBe("todo");
    manager.stop();
  });

  it("Scenario E: autoMerge false keeps in-review stage no-op", async () => {
    const task = await store.createTask({ title: "review", description: "review" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "failed",
      error: "Agent finished without calling fn_task_done",
      taskDoneRetryCount: 1,
      worktree: join(rootDir, ".worktrees", "review-missing"),
      updatedAt: new Date(Date.now() - 400_000).toISOString(),
      steps: [{ name: "done", status: "done" }, { name: "pending", status: "pending" }],
    } as any);
    await store.updateSettings({ ...(await store.getSettings()), autoMerge: false } as any);

    const manager = new SelfHealingManager(store, { rootDir, isTaskActive: () => false });
    const recovered = await manager.recoverPartialProgressNoTaskDoneFailures();
    const current = await store.getTask(task.id);

    expect(recovered).toBe(0);
    expect(current?.column).toBe("in-review");
    manager.stop();
  });

  it("Scenario F: churn-terminalized review task is not reopened", async () => {
    const task = await store.createTask({ title: "churn", description: "churn" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      paused: true,
      pausedReason: "in-review-stall-deadlock",
      status: "failed",
      error: "STUCK_NO_PROGRESS_CHURN",
      worktree: join(rootDir, ".worktrees", "churn-missing"),
      updatedAt: new Date(Date.now() - 400_000).toISOString(),
      steps: [{ name: "done", status: "done" }, { name: "pending", status: "pending" }],
    } as any);

    const manager = new SelfHealingManager(store, { rootDir, isTaskActive: () => false });
    const recovered = await manager.recoverPartialProgressNoTaskDoneFailures();
    const current = await store.getTask(task.id);

    expect(recovered).toBe(0);
    expect(current?.column).toBe("in-review");
    manager.stop();
  });

  it("Scenario G: order-independence across limbo and no-progress sweeps", async () => {
    const makeCandidate = async (title: string) => {
      const task = await store.createTask({ title, description: title });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.updateTask(task.id, {
        branch: null,
        worktree: join(rootDir, ".worktrees", `${task.id.toLowerCase()}-missing`),
        status: "failed",
        error: "Agent finished without calling fn_task_done",
        executionStartedAt: new Date(Date.now() - 400_000).toISOString(),
        updatedAt: new Date(Date.now() - 400_000).toISOString(),
        steps: [{ name: "step", status: "pending" }],
      } as any);
      return task.id;
    };

    const firstId = await makeCandidate("order-a");
    await (store as any).recordRunAuditEvent({ runId: "run-g-a", phase: "executor", taskId: firstId, taskLineageId: null, agentId: "executor", domain: "database", mutationType: "worktree:incomplete-detected", payload: {}, target: firstId, details: null, metadata: {} });
    const manager = new SelfHealingManager(store, { rootDir, isTaskActive: () => false, getExecutingTaskIds: () => new Set<string>() });
    await manager.recoverNoProgressNoTaskDoneFailures();
    await manager.recoverInProgressLimbo();
    const firstTask = await store.getTask(firstId);

    const secondId = await makeCandidate("order-b");
    await (store as any).recordRunAuditEvent({ runId: "run-g-b", phase: "executor", taskId: secondId, taskLineageId: null, agentId: "executor", domain: "database", mutationType: "worktree:incomplete-detected", payload: {}, target: secondId, details: null, metadata: {} });
    await manager.recoverInProgressLimbo();
    await manager.recoverNoProgressNoTaskDoneFailures();
    const secondTask = await store.getTask(secondId);

    expect(firstTask?.column).toBe("in-progress");
    expect(secondTask?.column).toBe("in-progress");
    manager.stop();
  });

  it("Scenario H: orphan and tightened sweeps can co-emit no-action events", async () => {
    const id = await createNoProgressTask(join(rootDir, ".worktrees", "np-missing-orphan-h"), 400_000);
    const manager = new SelfHealingManager(store, { rootDir, getExecutingTaskIds: () => new Set<string>(), isTaskActive: () => false });
    vi.setSystemTime(new Date("2026-05-21T12:10:00.000Z"));
    await manager.recoverOrphanedExecutions();
    await (store as any).recordRunAuditEvent({ runId: "run-h", phase: "executor", taskId: id, taskLineageId: null, agentId: "executor", domain: "database", mutationType: "worktree:incomplete-detected", payload: {}, target: id, details: null, metadata: {} });
    await manager.recoverNoProgressNoTaskDoneFailures();

    const orphanEvents = await store.getRunAuditEvents({ taskId: id, mutationType: "task:orphan-detected-no-action" });
    const noActionEvents = await store.getRunAuditEvents({ taskId: id, mutationType: "task:no-progress-no-task-done-no-action" });
    const current = await store.getTask(id);

    expect(current?.column).toBe("in-progress");
    expect(orphanEvents).toHaveLength(1);
    expect(noActionEvents).toHaveLength(1);
    manager.stop();
  });

  it("Scenario J: tightened sweep no-action is idempotent across re-sweeps", async () => {
    const worktree = join(rootDir, ".worktrees", "np-missing-orphan");
    const id = await createNoProgressTask(worktree, 400_000);

    const manager = new SelfHealingManager(store, { rootDir, getExecutingTaskIds: () => new Set<string>(), isTaskActive: () => false });
    vi.setSystemTime(new Date("2026-05-21T12:10:00.000Z"));
    await manager.recoverOrphanedExecutions();
    await (store as any).recordRunAuditEvent({
      runId: "run-fn5335-h",
      phase: "executor",
      taskId: id,
      taskLineageId: null,
      agentId: "executor",
      domain: "database",
      mutationType: "worktree:incomplete-detected",
      payload: { source: "executor-liveness-gate" },
      target: id,
      details: null,
      metadata: { source: "executor-liveness-gate" },
    });
    const first = await manager.recoverNoProgressNoTaskDoneFailures();
    const second = await manager.recoverNoProgressNoTaskDoneFailures();
    const noActionEvents = await store.getRunAuditEvents({ taskId: id, mutationType: "task:no-progress-no-task-done-no-action" });
    const current = await store.getTask(id);

    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(current?.column).toBe("in-progress");
    expect(noActionEvents).toHaveLength(2);
    manager.stop();
  });

  it("Scenario I: recent worktree:incomplete-detected audit counts as recent activity", async () => {
    const id = await createNoProgressTask(join(rootDir, ".worktrees", "np-missing-liveness"), 400_000);
    await (store as any).recordRunAuditEvent({
      runId: "run-fn5335-liveness",
      phase: "executor",
      taskId: id,
      taskLineageId: null,
      agentId: "executor",
      domain: "database",
      mutationType: "worktree:incomplete-detected",
      payload: { source: "executor-liveness-gate" },
      target: id,
      details: null,
      metadata: { source: "executor-liveness-gate" },
    });

    const manager = new SelfHealingManager(store, { rootDir, isTaskActive: () => false });
    const recovered = await manager.recoverNoProgressNoTaskDoneFailures();
    const noActionEvents = await store.getRunAuditEvents({ taskId: id, mutationType: "task:no-progress-no-task-done-no-action" });

    expect(recovered).toBe(0);
    expect(noActionEvents).toHaveLength(1);
    manager.stop();
  });
});
