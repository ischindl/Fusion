import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { BranchWriteProvenanceError, type Settings, type Task, type TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { AutoRecoveryDispatcher } from "../healing/auto-recovery.js";
import * as branchConflicts from "../execution/branch-conflicts.js";
import * as worktreePool from "../worktree/worktree-pool.js";
import * as gitEvidence from "../self-healing-git-evidence.js";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { withBranchWriteProvenance } from "./branch-write-provenance-store-stub.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-4763",
    title: "task",
    description: "task",
    column: "in-progress",
    branch: "fusion/fn-4763",
    worktree: "/tmp/test/.worktrees/fn-4763",
    paused: false,
    userPaused: false,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    prInfo: { url: "u", number: 1, status: "open", title: "t", headBranch: "h", baseBranch: "b", commentCount: 0, mergeable: "conflicting" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function makeStore(
  task: Task | null,
  paused = false,
  enginePaused = false,
  settingsOverrides: Partial<Settings> = {},
): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const settings = {
    globalPause: paused,
    enginePaused,
    autoRecovery: { mode: "deterministic-only", maxRetries: 3 },
    ...settingsOverrides,
  } as Settings;
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    getTask: vi.fn(async (id: string) => (task && id === task.id ? task : null)),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => {
      if (!task) return [];
      if (!column) return [task];
      if (column === "in-progress") return [task];
      return [];
    }),
    updateTask: vi.fn(withBranchWriteProvenance(async (_id: string, updates: Partial<Task>) => (task ? Object.assign(task, updates) : null))),
    /*
    FNXC:BranchConflictRecoveryFence 2026-10-01-08:15 (upstream FN-9423/FN-9437 port):
    The branch-conflict pause and the fully-subsumed clear now write through the atomic fence, so the
    harness must model the store's real contract: the updater re-sees the LIVE row and a returned
    `null` writes nothing. Handing the same object back is the honest baseline (nothing overtook the
    sweep); a case that needs a divergent live row overrides this mock.
    */
    updateTaskAtomic: vi.fn(async (_id: string, updater: (live: Task) => Partial<Task> | null) => {
      if (!task) return null;
      const patch = updater(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => {
      if (!task) return null;
      task.column = column;
      return task;
    }),
    handoffToReview: vi.fn(async (id: string) => {
      if (!task || id !== task.id) return null;
      task.column = "in-review";
      return task;
    }),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    recordRunAuditEvent: vi.fn(async () => undefined),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    getRootDir: vi.fn(() => "/tmp/test"),
  }) as unknown as TaskStore & EventEmitter;
}

describe("SelfHealingManager.reclaimPrConflictForTask", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    activeSessionRegistry.clear();
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
  });

  it("returns stale-resolved when inspection reports stale-resolved", async () => {
    const task = makeTask();
    const store = makeStore(task);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValue({ kind: "stale-resolved" } as any);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result.outcome).toBe("stale-resolved");
    expect(task.branch).toBeNull();
  });

  it("skips user-paused task", async () => {
    const task = makeTask({ userPaused: true });
    const store = makeStore(task);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result).toEqual({ outcome: "skipped", reason: "user-paused" });
  });

  it("delegates tip-already-merged through reclaim sweep", async () => {
    const task = makeTask();
    const store = makeStore(task);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValue({ kind: "tip-already-merged", livePath: null, tipSha: "abc123", integrationRef: "main" } as any);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const sweepSpy = vi.spyOn(manager, "reclaimSelfOwnedBranchConflicts").mockResolvedValue(1);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result.outcome).toBe("tip-already-merged");
    expect(sweepSpy).toHaveBeenCalled();
  });

  it("returns reclaimed for reclaimable conflicts with derived engine provenance", async () => {
    const task = makeTask({ column: "in-review", paused: true, pausedReason: "branch-conflict-unrecoverable" as any, updatedAt: new Date(Date.now() - 11 * 60_000).toISOString() });
    const store = makeStore(task);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValue({ kind: "reclaimable", livePath: task.worktree, tipSha: "abc123", taskAttributedCommitCount: 1, strandedCommits: [{ sha: "abc123" }] } as any);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result.outcome).toBe("reclaimed");
    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      branch: "fusion/fn-4763",
      branchWriteOrigin: "engine",
      worktree: "/tmp/test/.worktrees/fn-4763",
    }));
    /*
    FNXC:LifecycleContainment 2026-09-13 (RUFU-231 test reconciliation):
    FN-207/FN-217 removed backward-move authority from recovery reasons — the reclaimed
    review-lane card is retained in its current lane (only a REVISE transition moves a card
    backward). The pre-containment expectation of an `in-progress` moveTask asserted a move the
    lifecycle contract now refuses; assert the retained-in-place outcome instead.
    */
    expect((store.moveTask as any).mock.calls.some((c: any[]) => c[1] === "in-progress")).toBe(false);
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("Lifecycle recovery retained in 'in-review'"));
  });

  it("preserves operator branch ownership during reclaim", async () => {
    const override = { branch: "fusion/fn-4763", by: "operator" as const, at: "2026-08-28T06:41:00.000Z" };
    const task = makeTask({ branchContext: { branchOverride: override } as Task["branchContext"] });
    const store = makeStore(task);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValue({
      kind: "reclaimable",
      livePath: task.worktree,
      tipSha: "abc123",
      taskAttributedCommitCount: 1,
      strandedCommits: [{ sha: "abc123" }],
    } as any);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);

    const result = await manager.reclaimPrConflictForTask(task.id);

    expect(result.outcome).toBe("reclaimed");
    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      branch: "fusion/fn-4763",
      branchWriteOrigin: "operator",
    }));
    expect(task.branchContext?.branchOverride).toEqual(override);
  });

  it("returns reclaimed for fully-subsumed conflicts", async () => {
    const task = makeTask({ branch: "feature/non-fusion-branch" });
    const store = makeStore(task);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValue({ kind: "fully-subsumed", livePath: task.worktree, tipSha: "abc123", taskAttributedCommitCount: 0, strandedCommits: [] } as any);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result.outcome).toBe("reclaimed");
  });

  /*
  FNXC:BranchConflictRecoveryFence 2026-10-01-08:15 (upstream FN-9423 port):
  A reclaim removes the checkout first, so the durable clear can land on a row a scheduler update
  already moved. The fence must then write NOTHING and say so on the card, rather than restoring the
  generation the sweep inspected — the newer checkout pointer and pause state belong to that writer.
  */
  it("does not clear a newer scheduler checkout after fully-subsumed cleanup", async () => {
    const task = makeTask({ branch: "fusion/fn-4763", paused: true, pausedReason: "branch-conflict-unrecoverable" as any, status: "failed" as any });
    const store = makeStore(task);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValue({ kind: "fully-subsumed", livePath: task.worktree, tipSha: "abc123", taskAttributedCommitCount: 0, strandedCommits: [] } as any);
    (store as any).updateTaskAtomic.mockImplementationOnce(async (_id: string, updater: (live: Task) => Partial<Task> | null) => {
      const patch = await updater({ ...task, worktree: "/tmp/newer-checkout", paused: false, pausedReason: undefined, status: undefined });
      expect(patch).toBeNull();
      return task;
    });
    vi.spyOn(worktreePool, "removeWorktree").mockResolvedValue(undefined as never);
    // The reclaim runs `git worktree prune` + `git branch -D` between the removal and the fenced
    // durable clear; stub the shell so the case reaches the fence instead of the git-failure defer.
    vi.spyOn(gitEvidence, "execAsync").mockResolvedValue({ stdout: "", stderr: "" } as any);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);

    expect(await manager.reclaimPrConflictForTask(task.id)).toEqual({ outcome: "skipped", reason: "superseded" });
    expect(task.worktree).toBe("/tmp/test/.worktrees/fn-4763");
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("retained a newer task lifecycle update"));
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-23:20:
  `prConflictWipColumns` builds the worktree-owner index behind `ownedByOtherInProgressTask` — the
  guard that stops this sweep DELETING a worktree another live task is executing in. Keyed on the id
  that index is empty on a renamed board, so every worktree reads as unowned.

  ASSERTS ON `removeWorktree`, NOT ON `result.outcome`. My first attempt asserted the outcome and
  failed while the fix was in place: `reclaimed` is reachable through a second path this guard does
  not gate, so the outcome cannot isolate it. `removeWorktree` + `git branch -D` run ONLY on the
  guarded branch, which makes them the observable that discriminates — and they are also the
  irreversible part, which is what the guard exists to prevent.
  */
  it("does NOT delete a worktree owned by another task in a RENAMED wip lane", async () => {
    /* Default id/branch pair is kept: the reclaim path also requires the branch to name THIS task
       (branchOwnerTaskId === taskIdUpper), so overriding one of them alone makes the case vacuous. */
    const task = makeTask();
    const otherOwner = { ...makeTask({ id: "FN-OTHER" }), column: "building", worktree: task.worktree } as Task;
    const store = makeStore(task);
    const RENAMED_IR = {
      version: "v2", id: "custom:renamed", nodes: [], edges: [],
      columns: [{ id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] }],
    };
    (store as any).listWorkflowDefinitions = vi.fn(async () => [{ id: "custom:renamed", ir: RENAMED_IR }]);
    (store as any).listTasks = vi.fn(async ({ column }: { column?: string } = {}) => (
      column === "building" ? [otherOwner] : column ? [] : [task, otherOwner]
    ));
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValue({
      kind: "fully-subsumed", livePath: task.worktree, tipSha: "abc123", taskAttributedCommitCount: 0, strandedCommits: [],
    } as any);
    const removeSpy = vi.spyOn(worktreePool, "removeWorktree").mockResolvedValue(undefined as never);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);

    await manager.reclaimPrConflictForTask(task.id);

    /* The other task's checkout survives — deleting it is not recoverable. */
    expect(removeSpy).not.toHaveBeenCalled();
  });

  describe("non-conflict PR reclaim failures", () => {
    const failures = [
      new BranchWriteProvenanceError(),
      new Error('Command failed: git worktree remove --force "/tmp/live"'),
      new Error("ENOTEMPTY: directory not empty, rmdir '/tmp/live/node_modules'"),
      new Error("database unavailable"),
    ];

    for (const failure of failures) {
      it(`defers ${failure.message} without relocation or a destructive park`, async () => {
        const task = makeTask();
        const store = makeStore(task);
        vi.spyOn(branchConflicts, "inspectBranchConflict").mockRejectedValueOnce(failure);
        const dispatcher = vi.spyOn(AutoRecoveryDispatcher.prototype, "dispatch");
        const relocate = vi.spyOn(worktreePool, "relocateReclaimableWorktreeIntoRoot");
        const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);

        const result = await manager.reclaimPrConflictForTask(task.id);

        expect(result).toEqual({ outcome: "skipped", reason: failure.message });
        expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("reclaim deferred — non-conflict error"));
        expect(dispatcher).not.toHaveBeenCalled();
        expect(relocate).not.toHaveBeenCalled();
        expect((store.updateTask as any).mock.calls.some((call: any[]) => call[1]?.status === "failed")).toBe(false);
        expect((store.moveTask as any).mock.calls.some((call: any[]) => call[2]?.preserveWorktree === false)).toBe(false);
        expect(task).toMatchObject({ branch: "fusion/fn-4763", worktree: "/tmp/test/.worktrees/fn-4763" });
      });
    }
  });

  it("reseeds an unrecoverable branch conflict at and beyond its retry cap", async () => {
    const task = makeTask({ recoveryRetryCount: 3, status: "queued", error: "branch recovery" });
    const store = makeStore(task);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValue({
      kind: "live-foreign",
      error: new branchConflicts.BranchConflictError({
        branchName: task.branch!,
        conflictingWorktreePath: task.worktree!,
        existingTipSha: "abc123",
        strandedCommits: [{ sha: "abc123", subject: "foreign" }],
        startPoint: "main",
        recommendedAction: "manual",
      }),
    } as any);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);

    const result = await manager.reclaimPrConflictForTask(task.id);


    expect(result.outcome).toBe("escalated-reseed");
    expect(task).toMatchObject({ column: "in-progress", paused: false, status: null, error: null });
    expect(task.recoveryRetryCount).toBeNull();
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("fenced reclaim reseed"));
    /*
    FNXC:BranchConflictRecoveryFence 2026-10-01-08:15 (kept through the 2026-10-08 origin/main merge):
    The disposition change is upstream FN-9512's — a spent budget now reseeds instead of parking — but the
    durability point this line added still holds and still needs pinning: the state change is authored INSIDE
    `updateTaskAtomic`, never through a plain `updateTask` call site.
    */
    expect((store as any).updateTaskAtomic).toHaveBeenCalled();
  });

  it("skips worktrunk operation failed paused tasks", async () => {
    const task = makeTask({ pausedReason: "worktrunk_operation_failed" as any });
    const store = makeStore(task);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result).toEqual({ outcome: "skipped", reason: "worktrunk-paused" });
  });

  it("skips when engine pause is active", async () => {
    const task = makeTask();
    const store = makeStore(task, false, true);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result).toEqual({ outcome: "skipped", reason: "engine-paused" });
  });

  it("skips when global pause is active", async () => {
    const task = makeTask();
    const store = makeStore(task, true);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result).toEqual({ outcome: "skipped", reason: "engine-paused" });
  });

  it("returns task-not-found for missing task", async () => {
    const store = makeStore(null);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask("FN-404");
    expect(result).toEqual({ outcome: "skipped", reason: "task-not-found" });
  });

  it("skips when branch or worktree is missing", async () => {
    const task = makeTask({ branch: undefined });
    const store = makeStore(task);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result).toEqual({ outcome: "skipped", reason: "missing-branch-or-worktree" });
  });

  it("skips checked out tasks", async () => {
    const task = makeTask({ checkedOutBy: "agent-1" as any });
    const store = makeStore(task);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result).toEqual({ outcome: "skipped", reason: "checked-out" });
  });

  it("only sweeps tasks marked as conflicting", async () => {
    const task = makeTask({ prInfo: { ...makeTask().prInfo!, mergeable: "clean" } as any });
    const store = makeStore(task, false, false, { worktrunk: { enabled: true } as any });
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const reclaimSpy = vi.spyOn(manager, "reclaimPrConflictForTask");
    const reclaimed = await manager.reclaimPrConflicts();
    expect(reclaimed).toBe(0);
    expect(reclaimSpy).not.toHaveBeenCalled();
  });

  it("skips when worktree has an active session", async () => {
    const task = makeTask();
    const store = makeStore(task);
    activeSessionRegistry.registerPath(task.worktree!, { taskId: task.id, kind: "executor", ownerKey: task.id });
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result).toEqual({ outcome: "skipped", reason: "active-session" });
    activeSessionRegistry.clear();
  });

  it("skips unusable worktree", async () => {
    const task = makeTask();
    const store = makeStore(task);
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValueOnce(false);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result).toEqual({ outcome: "skipped", reason: "unusable-worktree" });
  });
});
