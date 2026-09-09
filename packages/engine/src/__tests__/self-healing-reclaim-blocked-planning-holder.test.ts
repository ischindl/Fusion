// Real-git wallclock under parallel CI load; do not lower per-test timeouts
// without re-measuring under pnpm test:full. (RUFU-200, following FN-4839 guidance)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { resetCheckoutEmptinessProversForTesting } from "../worktree/checkout-emptiness.js";

/*
FNXC:OverlapScheduling 2026-09-09-00:36 (RUFU-200):
Symptom verification for the RUFU-198 deadlock. A DEPENDENCY-BLOCKED planning-lane card is never
dispatched, so it never takes the dispatch-time ghost-conflict cleanup — while the self-owned-branch
reclaim sweep unconditionally skipped blocked cards. That combination left a blocked card holding a
dormant file-scope lease on every overlapping peer forever. These tests run the REAL classifier
(checkout-emptiness prover) and the REAL reclaim sweep over an ephemeral git repository:

  1. blocked planning-lane holder whose checkout is clean and zero commits ahead → reclaimed, worktree
     metadata cleared, `reason=stale-cached-metadata-ghost-conflict` recorded;
  2. the same shape with a dirty tree → skip preserved, metadata untouched, worktree kept;
  3. an unresolvable base commit (proof unknown) → fail-closed skip preserved.

Before the RUFU-200 widening this fixture hit `skipping blocked todo task` and nothing was reclaimed —
that skip is the red-state proof for case 1.
*/

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

type TaskMap = Map<string, Task>;

function makeTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  const { id, ...rest } = overrides;
  return {
    id,
    title: overrides.title ?? id,
    description: overrides.description ?? id,
    column: overrides.column ?? "todo",
    dependencies: overrides.dependencies ?? [],
    steps: overrides.steps ?? [],
    currentStep: overrides.currentStep ?? 0,
    log: overrides.log ?? [],
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    ...rest,
  } as Task;
}

function createStore(tasks: TaskMap, settings: Partial<Settings> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const mergedSettings: Settings = {
    globalPause: false,
    enginePaused: false,
    maintenanceIntervalMs: 0,
    taskStuckTimeoutMs: 60_000,
    autoMerge: true,
    ...settings,
  } as Settings;

  const store = Object.assign(emitter, {
    getSettings: vi.fn(async () => mergedSettings),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => {
      const values = [...tasks.values()];
      return values.filter((task) => {
        if (column && task.column !== column) return false;
        return true;
      });
    }),
    updateTask: vi.fn(async (id: string, updates: Partial<Task>) => {
      const current = tasks.get(id)!;
      tasks.set(id, { ...current, ...updates, updatedAt: new Date().toISOString() } as Task);
      return tasks.get(id);
    }),
    moveTask: vi.fn(async (id: string, column: Task["column"]) => {
      const current = tasks.get(id)!;
      tasks.set(id, { ...current, column, columnMovedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as Task);
    }),
    logEntry: vi.fn(async (id: string, message: string) => {
      const current = tasks.get(id)!;
      const log = current.log ?? [];
      tasks.set(id, { ...current, log: [...log, { timestamp: new Date().toISOString(), action: message } as any] });
    }),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    updateSettings: vi.fn(async () => mergedSettings),
    mergeTask: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => ""),
    recordRunAuditEvent: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;

  return store;
}

describeIfGit("SelfHealingManager reclaimSelfOwnedBranchConflicts — blocked planning-lane holder (real git)", () => {
  const repos: string[] = [];

  beforeEach(() => {
    // Per-rootDir prover TTL caches must never leak a verdict between fixtures.
    resetCheckoutEmptinessProversForTesting();
  });

  afterEach(() => {
    for (const repo of repos.splice(0)) {
      rmSync(repo, { recursive: true, force: true });
    }
    resetCheckoutEmptinessProversForTesting();
  });

  /**
   * Builds the RUFU-198 shape: an ephemeral repo on `main` with one base commit, and a live worktree
   * `fusion/fn-test-1` checked out AT that base (clean, zero commits ahead). Returns the base sha,
   * the worktree path, and a dependency-blocked `todo` task retaining the worktree metadata.
   */
  function setupBlockedHolderFixture(options: { dirtyTree?: boolean; unresolvableBase?: boolean } = {}) {
    const repo = mkdtempSync(path.join(os.tmpdir(), "rufu-200-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test"');
    git(repo, "git commit --allow-empty -m 'init'");
    const baseSha = git(repo, "git rev-parse HEAD");

    const worktreePath = path.join(repo, ".fusion", "worktrees", "fn-test-1");
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repo, `git worktree add ${JSON.stringify(worktreePath)} -b fusion/fn-test-1`);

    if (options.dirtyTree) {
      writeFileSync(path.join(worktreePath, "untracked-note.txt"), "operator scratch\n", "utf-8");
    }

    const task = makeTask({
      id: "FN-TEST-1",
      column: "todo",
      branch: "fusion/fn-test-1",
      worktree: worktreePath,
      baseCommitSha: options.unresolvableBase ? "0000000000000000000000000000000000000000" : baseSha,
      blockedBy: "FN-DEP",
      dependencies: ["FN-DEP"],
    });
    const tasks: TaskMap = new Map([["FN-TEST-1", task]]);
    // settings.integrationBranch keeps resolution deterministic without an origin remote.
    const store = createStore(tasks, { integrationBranch: "main" } as Partial<Settings>);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set<string>() });
    return { repo, baseSha, worktreePath, tasks, store, manager };
  }

  it("reclaims a blocked planning-lane holder whose retained checkout is proven empty", async () => {
    const { repo, worktreePath, tasks, manager } = setupBlockedHolderFixture();

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(1);
    const task = tasks.get("FN-TEST-1")!;
    expect(task.worktree).toBeNull();
    expect(task.branch).toBeNull();
    expect(task.baseCommitSha).toBeNull();
    // The reused tip-already-merged arm must be the one that released the card.
    expect(task.log.some((entry: any) => String(entry.action).includes("reason=stale-cached-metadata-ghost-conflict"))).toBe(true);
    // No worktree left behind: gone from disk and from the git worktree registry, branch deleted.
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repo, "git worktree list")).not.toContain(worktreePath);
    expect(git(repo, "git branch --list fusion/fn-test-1")).toBe("");
    // The card stays in its hold lane — this is a metadata clear, not a lifecycle move.
    expect(task.column).toBe("todo");
    // The reused arm clears worktree metadata only: the dependency edges survive, so a
    // dependency-blocked card is NEVER silently unblocked by the reclaim.
    expect(task.blockedBy).toBe("FN-DEP");
    expect(task.dependencies).toEqual(["FN-DEP"]);
  }, 30_000);

  it("keeps the skip verbatim for a blocked holder with a dirty (occupied) checkout", async () => {
    const { worktreePath, tasks, manager } = setupBlockedHolderFixture({ dirtyTree: true });

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(0);
    const task = tasks.get("FN-TEST-1")!;
    // Fail-closed: an occupied proof keeps ALL retained metadata and the checkout on disk.
    expect(task.worktree).toBe(worktreePath);
    expect(task.branch).toBe("fusion/fn-test-1");
    expect(task.baseCommitSha).not.toBeNull();
    expect(existsSync(worktreePath)).toBe(true);
    expect(task.log.some((entry: any) => String(entry.action).includes("[recovery]"))).toBe(false);
  }, 30_000);

  it("keeps the skip verbatim when the emptiness proof cannot be computed (unknown base)", async () => {
    const { worktreePath, tasks, manager } = setupBlockedHolderFixture({ unresolvableBase: true });

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(0);
    const task = tasks.get("FN-TEST-1")!;
    expect(task.worktree).toBe(worktreePath);
    expect(task.branch).toBe("fusion/fn-test-1");
    expect(existsSync(worktreePath)).toBe(true);
    expect(task.log.some((entry: any) => String(entry.action).includes("[recovery]"))).toBe(false);
  }, 30_000);
});
