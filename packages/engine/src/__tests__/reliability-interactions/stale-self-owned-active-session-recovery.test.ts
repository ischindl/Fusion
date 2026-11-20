import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../executor-test-helpers.js";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { TaskExecutor } from "../../executor.js";
import { SelfHealingManager } from "../../self-healing.js";
import { activeSessionRegistry } from "../../agents/active-session-registry.js";
import { ActiveSessionWorktreeRemovalError, RemovalReason } from "../../worktree/worktree-backend.js";
import * as worktreePoolModule from "../../worktree/worktree-pool.js";
import { createMockStore, resetExecutorMocks } from "../executor-test-helpers.js";

const TASK_ID = "FN-4973";
const CONFLICT_PATH = "/tmp/test/.worktrees/solar-flame";

/*
FNXC:SelfHealingRepoRoot 2026-11-20-06:37 (RUFU-804):
`reclaimStaleActiveBranches` now proves its project root before it spawns git, so a root that never
existed makes the sweep refuse the pass before its per-card body runs. This file's manager fixture
used exactly such a path: its assertion (the reclaimed branch must not re-register an active session)
would then have passed because the sweep never looked at anything — vacuous, not verified. A real
temp repository keeps the sweep body reachable, which is the only way this test can still fail when
it is supposed to. The `TaskExecutor` fixtures keep `"/tmp/test"`: nothing on that path probes a root.
*/
const HEALING_REPO_ROOT = (() => {
  const root = mkdtempSync(join(tmpdir(), "fn-4973-healing-"));
  execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
  return root;
})();
afterAll(() => {
  rmSync(HEALING_REPO_ROOT, { recursive: true, force: true });
});

function makeStore(task: Task): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const settings = {
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    baseBranch: "main",
    mergeStrategy: "direct",
    autoRecovery: { mode: "deterministic-only", maxRetries: 3 },
  } as unknown as Settings;
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    getTask: vi.fn(async () => task),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => (column === "in-progress" ? [task] : [task])),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => Object.assign(task, updates)),
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => {
      task.column = column;
      return task;
    }),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => settings),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    recordRunAuditEvent: vi.fn(async () => undefined),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    mergeTask: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => "/tmp/test"),
  }) as unknown as TaskStore & EventEmitter;
}

function makeTask(): Task {
  return {
    id: TASK_ID,
    title: "test",
    description: "test",
    column: "in-progress",
    branch: "fusion/fn-4973",
    worktree: CONFLICT_PATH,
    paused: false,
    userPaused: false,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as Task;
}

describe("FN-4973 reliability interactions: stale self-owned active-session recovery", () => {
  beforeEach(() => {
    resetExecutorMocks();
    activeSessionRegistry.clear();
    vi.restoreAllMocks();
  });

  it("FN-4973 reconciles stale self-owned entry and remains clear across self-healing sweeps", async () => {
    const store = createMockStore();
    store.listTasks.mockResolvedValue([]);
    const executor = new TaskExecutor(store, "/tmp/test");
    activeSessionRegistry.registerPath(CONFLICT_PATH, { taskId: TASK_ID, kind: "executor", ownerKey: TASK_ID });
    // FN-5256: backdate so the new min-idle window doesn't refuse the reconcile.
    (activeSessionRegistry.lookupByPath(CONFLICT_PATH) as any).registeredAt = 0;

    vi.spyOn(worktreePoolModule, "removeWorktree").mockResolvedValue(undefined);

    const cleaned = await (executor as any).cleanupConflictingWorktree(CONFLICT_PATH, "fusion/fn-4973", TASK_ID);
    expect(cleaned).toBe(true);
    expect(activeSessionRegistry.lookupByPath(CONFLICT_PATH)).toBeNull();

    const task = makeTask();
    const healingStore = makeStore(task);
    const manager = new SelfHealingManager(healingStore as any, { rootDir: HEALING_REPO_ROOT } as any);
    await manager.reconcileTaskWorktreeMetadata();
    await manager.reclaimStaleActiveBranches();

    expect(activeSessionRegistry.lookupByPath(CONFLICT_PATH)).toBeNull();
    manager.stop();
  });

  it("FN-4973 preserves FN-4811 foreign-task ownership refusal", async () => {
    const store = createMockStore();
    store.listTasks.mockResolvedValue([]);
    const executor = new TaskExecutor(store, "/tmp/test");
    activeSessionRegistry.registerPath(CONFLICT_PATH, { taskId: "FN-FOREIGN", kind: "executor", ownerKey: "FN-FOREIGN" });

    vi.spyOn(worktreePoolModule, "removeWorktree").mockRejectedValue(
      new ActiveSessionWorktreeRemovalError({
        worktreePath: CONFLICT_PATH,
        taskId: "FN-FOREIGN",
        kind: "executor",
        ownerKey: "FN-FOREIGN",
        reason: RemovalReason.ExecutorDispose,
      }),
    );

    const cleaned = await (executor as any).cleanupConflictingWorktree(CONFLICT_PATH, "fusion/fn-4973", TASK_ID);
    expect(cleaned).toBe(false);
    expect(activeSessionRegistry.lookupByPath(CONFLICT_PATH)?.taskId).toBe("FN-FOREIGN");
  });

  it("FN-4973 refuses same-task live in-memory binding", async () => {
    const store = createMockStore();
    store.listTasks.mockResolvedValue([]);
    const executor = new TaskExecutor(store, "/tmp/test");
    (executor as any).addActiveWorktree(TASK_ID, CONFLICT_PATH);
    activeSessionRegistry.registerPath(CONFLICT_PATH, { taskId: TASK_ID, kind: "executor", ownerKey: TASK_ID });

    vi.spyOn(worktreePoolModule, "removeWorktree").mockRejectedValue(
      new ActiveSessionWorktreeRemovalError({
        worktreePath: CONFLICT_PATH,
        taskId: TASK_ID,
        kind: "executor",
        ownerKey: TASK_ID,
        reason: RemovalReason.ExecutorDispose,
      }),
    );

    const cleaned = await (executor as any).cleanupConflictingWorktree(CONFLICT_PATH, "fusion/fn-4973", TASK_ID);
    expect(cleaned).toBe(false);
    expect(activeSessionRegistry.lookupByPath(CONFLICT_PATH)?.taskId).toBe(TASK_ID);
  });
});
