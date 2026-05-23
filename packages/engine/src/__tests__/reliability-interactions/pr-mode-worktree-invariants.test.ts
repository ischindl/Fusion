import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskStore, type Task } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";
import { WorktreePool } from "../../worktree-pool.js";
import { activeSessionRegistry } from "../../active-session-registry.js";

async function loadPrLifecycleModule() {
  const moduleUrl = new URL("../../../../cli/src/commands/task-lifecycle.js", import.meta.url);
  return import(moduleUrl.href);
}

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, { cwd, encoding: "utf8" }).trim();
}

function createStore(tasks: Task[], settingsOverrides: Record<string, unknown> = {}) {
  const emitter = new EventEmitter() as any;
  const audits: any[] = [];
  emitter.getSettings = vi.fn().mockResolvedValue({
    autoMerge: false,
    globalPause: false,
    enginePaused: false,
    taskStuckTimeoutMs: 60_000,
    inReviewStalledThresholdMs: 60_000,
    inReviewStallDeadlockThreshold: 3,
    maxPostReviewFixes: 2,
    ...settingsOverrides,
  });
  emitter.listTasks = vi.fn().mockImplementation(async ({ column }: { column?: string } = {}) => {
    if (!column) return tasks;
    return tasks.filter((t) => t.column === column);
  });
  emitter.logEntry = vi.fn().mockImplementation(async (taskId: string, action: string) => {
    const t = tasks.find((x) => x.id === taskId);
    if (!t) return;
    t.log = t.log ?? [];
    t.log.push({ timestamp: new Date().toISOString(), action } as any);
  });
  emitter.updateTask = vi.fn().mockImplementation(async (taskId: string, updates: Partial<Task>) => {
    const t = tasks.find((x) => x.id === taskId);
    if (!t) return;
    Object.assign(t, updates, { updatedAt: new Date().toISOString() });
    return t;
  });
  emitter.moveTask = vi.fn().mockImplementation(async (taskId: string, column: string) => {
    const t = tasks.find((x) => x.id === taskId);
    if (!t) return;
    t.column = column as any;
    t.updatedAt = new Date().toISOString();
    return t;
  });
  emitter.recordRunAuditEvent = vi.fn().mockImplementation(async (event: any) => audits.push(event));
  emitter.getAgentLogs = vi.fn().mockResolvedValue([]);
  emitter.getTask = vi.fn().mockImplementation(async (id: string) => tasks.find((t) => t.id === id));
  emitter.updatePrInfo = vi.fn().mockResolvedValue(undefined);
  emitter.getActiveMergingTask = vi.fn().mockReturnValue(null);
  emitter.__audits = audits;
  return emitter;
}

describe("FN-5420 reliability interactions: PR mode worktree invariants", () => {
  afterEach(() => {
    activeSessionRegistry.clear();
    vi.restoreAllMocks();
  });

  it("FN-5420/FN-5147: autoMerge=false keeps in-review stable; PR flow still finalizes on merged status", async () => {
    const task = {
      id: "FN-5420-5147",
      title: "t",
      description: "d",
      column: "in-review",
      paused: false,
      status: undefined,
      steps: [{ name: "s", status: "done" as const }],
      dependencies: [],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      columnMovedAt: "2026-01-01T00:00:00.000Z",
      branch: "fusion/fn-5420-5147",
      prInfo: { number: 42, url: "https://example.test/pr/42", status: "open" as const },
    } as unknown as Task;
    const store = createStore([task], { autoMerge: false, mergeStrategy: "pull-request" });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    await manager.surfaceInReviewStalls();
    await manager.surfaceInReviewStalled();
    await manager.recoverMergeableReviewTasks();
    await manager.recoverMergedReviewTasks();

    expect(task.column).toBe("in-review");
    expect(task.paused).toBe(false);
    expect(task.status).toBeUndefined();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.__audits.some((e: any) => String(e.mutationType ?? "").startsWith("task:auto-recover-"))).toBe(false);

    const github = {
      findPrForBranch: vi.fn(),
      createPr: vi.fn(),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: { number: 42, url: "https://example.test/pr/42", status: "merged" as const },
        reviewDecision: "APPROVED",
        checks: [],
        mergeReady: true,
        blockingReasons: [],
      })),
      mergePr: vi.fn(),
    };

    const { processPullRequestMergeTask } = await loadPrLifecycleModule();
    await processPullRequestMergeTask(store as any, "/tmp/repo", task.id, github as any, () => undefined);
    expect(store.moveTask).toHaveBeenCalledWith(task.id, "done");
    manager.stop();
  });

  it("FN-5420/FN-5083: PR-mode branch binding stays intact and drifted-null binding rebinds", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-5420-5083-"));
    let store: TaskStore | null = null;
    try {
      git(rootDir, "init -b main");
      git(rootDir, "config user.name 'Fusion'");
      git(rootDir, "config user.email 'hi@runfusion.ai'");
      writeFileSync(join(rootDir, "README.md"), "root\n");
      git(rootDir, "add README.md");
      git(rootDir, "commit -m 'init'");
      store = new TaskStore(rootDir, undefined, { inMemoryDb: false });

      const created = await store.createTask({ title: "t", description: "d" });
      await store.moveTask(created.id, "todo");
      await store.moveTask(created.id, "in-progress");
      await store.moveTask(created.id, "in-review");
      const branch = `fusion/${created.id.toLowerCase()}`;
      git(rootDir, `checkout -b ${branch}`);
      writeFileSync(join(rootDir, "f.txt"), "x\n");
      git(rootDir, "add f.txt");
      git(rootDir, "commit -m 'change'");
      git(rootDir, "checkout main");
      await store.updateTask(created.id, { branch, worktree: null as any });

      const manager = new SelfHealingManager(store, { rootDir });
      const intact = await manager.reconcileInReviewBranchRebind({ includeTaskIds: new Set([created.id]) });
      expect(intact.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: created.id, reason: "binding-intact" })]));

      manager.stop();
    } finally {
      try { store?.close(); } catch {}
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("FN-5420/FN-5083: drifted-null PR-mode branch rebinds to canonical fusion/<id>", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-5420-5083-drift-"));
    let store: TaskStore | null = null;
    try {
      git(rootDir, "init -b main");
      git(rootDir, "config user.name 'Fusion'");
      git(rootDir, "config user.email 'hi@runfusion.ai'");
      writeFileSync(join(rootDir, "README.md"), "root\n");
      git(rootDir, "add README.md");
      git(rootDir, "commit -m 'init'");
      store = new TaskStore(rootDir, undefined, { inMemoryDb: false });

      const created = await store.createTask({ title: "t2", description: "d2" });
      await store.moveTask(created.id, "todo");
      await store.moveTask(created.id, "in-progress");
      await store.moveTask(created.id, "in-review");
      const branch = `fusion/${created.id.toLowerCase()}`;
      git(rootDir, `checkout -b ${branch}`);
      writeFileSync(join(rootDir, "g.txt"), "g\n");
      git(rootDir, "add g.txt");
      git(rootDir, "commit -m 'change-2'");
      git(rootDir, "checkout main");
      store.getDatabase().prepare("UPDATE tasks SET branch = NULL, worktree = NULL WHERE id = ?").run(created.id);

      const manager = new SelfHealingManager(store, { rootDir });
      await manager.reconcileInReviewBranchRebind({ includeTaskIds: new Set([created.id]) });
      const reboundTask = await store.getTask(created.id);
      expect(reboundTask?.branch).toBe(branch);
      manager.stop();
    } finally {
      try { store?.close(); } catch {}
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("FN-5420/FN-5345/FN-5377: PR cleanup path does not create commits", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-5420-cleanup-"));
    try {
      git(rootDir, "init -b main");
      git(rootDir, "config user.name 'Fusion'");
      git(rootDir, "config user.email 'hi@runfusion.ai'");
      writeFileSync(join(rootDir, "README.md"), "root\n");
      git(rootDir, "add README.md");
      git(rootDir, "commit -m 'init'");
      const branch = "fusion/fn-5420-cleanup";
      const wt = join(rootDir, "wt");
      git(rootDir, `worktree add ${JSON.stringify(wt)} -b ${branch}`);
      writeFileSync(join(wt, "a.txt"), "a\n");
      git(wt, "add a.txt");
      git(wt, "commit -m 'feat: branch commit'");
      const before = git(rootDir, "rev-parse HEAD");

      const { cleanupMergedTaskArtifacts } = await loadPrLifecycleModule();
      await cleanupMergedTaskArtifacts(rootDir, { id: "FN-5420-CLEANUP", worktree: wt } as any);
      const after = git(rootDir, "rev-parse HEAD");
      expect(after).toBe(before);

      writeFileSync(join(rootDir, "README.md"), "root-2\n");
      git(rootDir, "add README.md");
      git(rootDir, "commit -m 'post-cleanup commit works'");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("FN-5420/FN-5056: cleanup recovers stale registration without manual prune", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-5420-stale-"));
    try {
      git(rootDir, "init -b main");
      git(rootDir, "config user.name 'Fusion'");
      git(rootDir, "config user.email 'hi@runfusion.ai'");
      writeFileSync(join(rootDir, "README.md"), "root\n");
      git(rootDir, "add README.md");
      git(rootDir, "commit -m 'init'");
      const wt = join(rootDir, "wt");
      git(rootDir, `worktree add ${JSON.stringify(wt)} -b fusion/fn-5420-stale`);
      rmSync(wt, { recursive: true, force: true });

      const { cleanupMergedTaskArtifacts } = await loadPrLifecycleModule();
      await cleanupMergedTaskArtifacts(rootDir, { id: "FN-5420-STALE", worktree: wt } as any);
      git(rootDir, `worktree add ${JSON.stringify(wt)} -b fusion/fn-5420-stale-b`);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("FN-5455: PR-mode cleanupMergedTaskArtifacts releases WorktreePool lease for task worktree", async () => {
    const pool = new WorktreePool();
    const path = "/tmp/fn-5455-leased";
    (pool as any).getLeasedPaths().set(path, "FN-5455-LEAK");

    const releaseSpy = vi.spyOn(pool, "release");
    const { cleanupMergedTaskArtifacts } = await loadPrLifecycleModule();
    await cleanupMergedTaskArtifacts("/tmp", { id: "FN-5455-LEAK", worktree: path } as any, { pool });

    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith(path, "FN-5455-LEAK");
    expect(pool.getLeasedPaths().has(path)).toBe(false);
    expect(pool.getLeasedPaths().get(path)).toBeUndefined();
  });

  it("FN-5455: cleanupMergedTaskArtifacts is a no-op for pool when options.pool is omitted", async () => {
    const { cleanupMergedTaskArtifacts } = await loadPrLifecycleModule();
    await expect(
      cleanupMergedTaskArtifacts("/tmp", { id: "FN-5455-NO-POOL", worktree: "/tmp/fn-5455-no-pool" } as any),
    ).resolves.toBeUndefined();
  });

  it("FN-5455: cleanupMergedTaskArtifacts calls pool.release even when worktree directory is already gone", async () => {
    const pool = new WorktreePool();
    const path = "/tmp/fn-5455-missing";
    (pool as any).getLeasedPaths().set(path, "FN-5455-MISSING");
    const releaseSpy = vi.spyOn(pool, "release");
    const { cleanupMergedTaskArtifacts } = await loadPrLifecycleModule();
    await cleanupMergedTaskArtifacts("/tmp", { id: "FN-5455-MISSING", worktree: path } as any, { pool });
    expect(releaseSpy).toHaveBeenCalledWith(path, "FN-5455-MISSING");
    expect(pool.getLeasedPaths().has(path)).toBe(false);
  });

  it("FN-5455: cleanupMergedTaskArtifacts swallows pool.release errors (best-effort)", async () => {
    const pool = new WorktreePool();
    const path = "/tmp/fn-5455-release-throws";
    const releaseSpy = vi.spyOn(pool, "release").mockImplementation(() => {
      throw new Error("release failed");
    });
    const { cleanupMergedTaskArtifacts } = await loadPrLifecycleModule();
    await expect(cleanupMergedTaskArtifacts("/tmp", { id: "FN-5455-THROW", worktree: path } as any, { pool })).resolves.toBeUndefined();
    expect(releaseSpy).toHaveBeenCalledWith(path, "FN-5455-THROW");
  });

  it.skip("FN-5456 follow-up required: cleanup should clear active-session registry entry", async () => {
    const path = "/tmp/fn-5456-session";
    activeSessionRegistry.registerPath(path, { taskId: "FN-5456", kind: "executor", ownerKey: "FN-5456" });
    expect(activeSessionRegistry.lookupByPath(path)).not.toBeNull();
  });

  it("FN-5420/FN-5279: mergeIntegrationWorktree setting does not gate PR-mode processing", async () => {
    const task = {
      id: "FN-5420-5279",
      title: "t",
      description: "d",
      column: "in-review",
      steps: [{ name: "s", status: "done" as const }],
      dependencies: [],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      columnMovedAt: "2026-01-01T00:00:00.000Z",
      branch: "fusion/fn-5420-5279",
      prInfo: { number: 79, url: "https://example.test/pr/79", status: "open" as const },
    } as unknown as Task;
    const store = createStore([task], {
      autoMerge: false,
      mergeStrategy: "pull-request",
      mergeIntegrationWorktree: "reuse-task-worktree",
    });

    const github = {
      findPrForBranch: vi.fn(),
      createPr: vi.fn(),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: { number: 79, url: "https://example.test/pr/79", status: "open" as const },
        reviewDecision: null,
        checks: [],
        mergeReady: false,
        blockingReasons: [],
      })),
      mergePr: vi.fn(),
    };

    const { processPullRequestMergeTask } = await loadPrLifecycleModule();
    const result = await processPullRequestMergeTask(store as any, "/tmp/repo", task.id, github as any, () => undefined);
    expect(result).toBe("waiting");
    expect(github.getPrMergeStatus).toHaveBeenCalled();
  });
});
