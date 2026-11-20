/**
 * FNXC:SelfHealingRepoRoot 2026-11-20-06:37 (RUFU-804):
 * Symptom and invariant coverage for the two self-healing sweeps that used to build git commands
 * against `rootDir` without proving it.
 *
 * The reproduced condition is the measured production shape: a registered project root that is a
 * NON-git workspace folder holding a real member repository. Before the gate both sweeps threw
 * `Command failed: git …`, the broad catch turned that into one log line, and the pass returned 0
 * (or nothing) leaving no refusal evidence — so "nothing to reclaim" and "cannot look" were the
 * same observable state.
 *
 * `node:child_process` is mocked by DELEGATING to the real implementation while recording every
 * command. That is deliberate: the not-a-repository verdict stays a real git measurement instead of
 * a fabricated rejection, and the recording gives the census that proves the sweep itself spawned
 * nothing. The delegation also re-attaches the custom promisify hook, because the sweeps destructure
 * `{ stdout }` from `promisify(exec)` and a plain spy would silently change that shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunAuditEventInput, Settings, Task, TaskStore } from "@fusion/core";
import { activeSessionRegistry } from "../../agents/active-session-registry.js";

const { execCalls, execSyncCalls } = vi.hoisted(() => ({
  execCalls: [] as string[],
  execSyncCalls: [] as string[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const util = await import("node:util");
  const nodePromisify = util.promisify as unknown as { custom: symbol };

  const execForward = ((...args: unknown[]) => {
    execCalls.push(String(args[0]));
    return (actual.exec as (...a: unknown[]) => unknown)(...args);
  }) as typeof actual.exec;
  execForward[nodePromisify.custom] = (command: string, options?: unknown) => {
    execCalls.push(String(command));
    return new Promise((resolve, reject) => {
      (actual.exec as (...a: unknown[]) => void)(command, options, (error: unknown, stdout: string, stderr: string) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    });
  };

  const execSyncForward = ((...args: unknown[]) => {
    execSyncCalls.push(String(args[0]));
    return (actual.execSync as (...a: unknown[]) => unknown)(...args);
  }) as unknown as typeof actual.execSync;

  return { ...actual, exec: execForward, execSync: execSyncForward };
});

import { SelfHealingManager } from "../../self-healing.js";

/** Every git command the manager spawned through either seam, newest last. */
function allGitCommands(): string[] {
  return [...execSyncCalls, ...execCalls];
}

function sh(command: string[], cwd: string): string {
  // Fixture git, deliberately through `execFileSync`, which the mock above leaves real: harness
  // commands therefore never enter the census, and every recorded command is one the MANAGER spawned.
  return String(execFileSync(command[0], command.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" }) ?? "");
}

/** A workspace root that is NOT a repository but contains one real member repository. */
function makeNonRepoWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "rufu-804-ws-"));
  const member = join(root, "lager-manager");
  mkdirSync(member, { recursive: true });
  sh(["git", "init"], member);
  return root;
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "rufu-804-repo-"));
  sh(["git", "init"], root);
  sh(["git", "config", "user.email", "test@example.com"], root);
  sh(["git", "config", "user.name", "Test User"], root);
  writeFileSync(join(root, "README.md"), "base\n", "utf-8");
  sh(["git", "add", "README.md"], root);
  sh(["git", "commit", "-m", "init"], root);
  sh(["git", "branch", "-M", "main"], root);
  return root;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-8040",
    title: "stale pointer card",
    description: "card whose worktree pointer outlived its worktree",
    column: "done",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    pausedReason: undefined,
    stallReason: undefined,
    branch: "fusion/fn-8040",
    worktree: join(tmpdir(), "fn-8040-already-gone"),
    checkedOutBy: undefined,
    executionStartedAt: new Date(Date.now() - 86_400_000).toISOString(),
    dependencies: [],
    steps: [],
    log: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    ...overrides,
  } as unknown as Task;
}

/**
 * The once-seam is implemented at STORE level on purpose: the bound has to survive a new manager
 * over the same store, which is the supervised-restart shape RUFU-643 exists for.
 */
function makeStore(task: Task | null) {
  const emitter = new EventEmitter();
  const settings = {
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    maintenanceIntervalMs: 900_000,
    baseBranch: "main",
    mergeStrategy: "direct",
  } as unknown as Settings;
  const auditEvents: RunAuditEventInput[] = [];
  const logEntries: Array<{ taskId: string; action: string; at: number }> = [];
  const onceSightings = new Map<string, number>();
  const tasks = task ? [task] : [];

  return Object.assign(emitter, {
    auditEvents,
    logEntries,
    getSettings: vi.fn(async () => settings),
    getTask: vi.fn(async () => task),
    listTasks: vi.fn(async () => tasks),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => Object.assign(task ?? {}, updates)),
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => {
      if (task) task.column = column;
      return task;
    }),
    logEntry: vi.fn(async (id: string, action: string) => {
      logEntries.push({ taskId: id, action, at: Date.now() });
    }),
    logEntryOnce: vi.fn(async (id: string, input: { action: string; dedupeKey: string; windowMs: number }) => {
      const key = `${id}|${input.dedupeKey}`;
      const last = onceSightings.get(key);
      if (last !== undefined && Date.now() - last < input.windowMs) return false;
      onceSightings.set(key, Date.now());
      logEntries.push({ taskId: id, action: input.action, at: Date.now() });
      return true;
    }),
    recordRunAuditEvent: vi.fn(async (event: RunAuditEventInput) => {
      auditEvents.push(event);
    }),
    isBackendMode: vi.fn(() => false),
    getAsyncLayer: vi.fn(() => null),
  }) as unknown as TaskStore & EventEmitter & {
    auditEvents: RunAuditEventInput[];
    logEntries: Array<{ taskId: string; action: string; at: number }>;
  };
}

const REFUSAL_ROW = "worktree:repo-root-refused";

describe("RUFU-804: a self-healing pass may not spawn git against an unproven project root", () => {
  const tempRoots: string[] = [];

  function track<T extends string>(root: T): T {
    tempRoots.push(root);
    return root;
  }

  beforeEach(() => {
    activeSessionRegistry.clear();
    execCalls.length = 0;
    execSyncCalls.length = 0;
  });

  afterEach(() => {
    activeSessionRegistry.clear();
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses both sweeps on a non-repo workspace root: no sweep git, one row each, one History line", async () => {
    const workspace = track(makeNonRepoWorkspace());
    const task = makeTask();
    const store = makeStore(task);
    const manager = new SelfHealingManager(store, { rootDir: workspace } as any);

    const reclaimed = await manager.reclaimStaleActiveBranches();
    await (manager as unknown as { pruneWorktrees(): Promise<void> }).pruneWorktrees();

    // (a) The failure condition cannot recur: the sweep's own git commands never spawned. Only the
    // sanctioned single probe ran, once per pass, and it is not the sweep's command.
    const commands = allGitCommands();
    expect(commands.filter((command) => command.includes("branch --list"))).toEqual([]);
    expect(commands.filter((command) => command.includes("worktree prune"))).toEqual([]);
    expect(commands.filter((command) => command.includes("status --porcelain"))).toEqual([]);
    expect(commands.filter((command) => command.includes("rev-parse --git-dir"))).toHaveLength(2);
    expect(reclaimed).toBe(0);

    // (b) One refusal row per sweep, with the closed metadata set and no path or error prose. The
    // reclaim row names the card it could not look at; prune owns no card set, so it honestly names
    // zero candidates rather than borrowing the other sweep's count.
    const refusals = store.auditEvents.filter((event) => event.mutationType === REFUSAL_ROW);
    expect(refusals).toHaveLength(2);
    expect(refusals.map((event) => (event.metadata as Record<string, unknown>).sweep).sort()).toEqual([
      "maintenance-worktree-prune",
      "stale-active-branch-reclaim",
    ]);
    const expectedCandidates: Record<string, number> = {
      "stale-active-branch-reclaim": 1,
      "maintenance-worktree-prune": 0,
    };
    for (const row of refusals) {
      const sweep = String((row.metadata as Record<string, unknown>).sweep);
      expect(row.metadata).toEqual({
        sweep,
        reason: "not-repo",
        rootState: "present",
        candidateTaskCount: expectedCandidates[sweep],
        outcome: "refused",
      });
      expect(row.target).toBe("project-repo-root");
      const serialized = JSON.stringify({ target: row.target, metadata: row.metadata });
      expect(serialized).not.toContain(workspace);
      expect(serialized).not.toContain("not a git repository");
      expect(serialized).not.toContain("fatal:");
    }

    // (c) One durable History line on the affected card, naming that the branch was NOT reclaimed.
    const history = store.logEntries.filter((entry) => entry.taskId === task.id && entry.action.includes("repo-root") === false && entry.action.includes("was NOT reclaimed"));
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].action).toContain("skipped");

    // (d) "cannot reclaim" is distinguishable from "nothing to reclaim": no success artifact, yes refusal.
    expect(store.auditEvents.some((event) => event.mutationType === "branch:stale-active-reclaim")).toBe(false);
    expect(refusals.length).toBe(2);

    manager.stop();
  });

  it("keeps the six-hour bound across a new manager over the same store (RUFU-643 shape)", async () => {
    const workspace = track(makeNonRepoWorkspace());
    const task = makeTask();
    const store = makeStore(task);

    const first = new SelfHealingManager(store, { rootDir: workspace } as any);
    await first.reclaimStaleActiveBranches();
    first.stop();
    const afterFirst = store.logEntries.filter((entry) => entry.action.includes("was NOT reclaimed")).length;

    // The supervised dashboard restarts every ~14-27 min; an in-process latch would reset here.
    const second = new SelfHealingManager(store, { rootDir: workspace } as any);
    await second.reclaimStaleActiveBranches();
    second.stop();

    expect(afterFirst).toBe(1);
    expect(store.logEntries.filter((entry) => entry.action.includes("was NOT reclaimed"))).toHaveLength(1);
  });

  it("still reclaims and still prunes on a healthy single-project repository, with no refusal row", async () => {
    const repo = track(makeRepo());
    sh(["git", "checkout", "-b", "fusion/fn-8040"], repo);
    sh(["git", "checkout", "main"], repo);
    const task = makeTask({ worktree: join(repo, ".worktrees", "gone-now") });
    const store = makeStore(task);
    const manager = new SelfHealingManager(store, { rootDir: repo } as any);

    const reclaimed = await manager.reclaimStaleActiveBranches();

    expect(reclaimed).toBe(1);
    expect(store.auditEvents.some((event) => event.mutationType === "branch:stale-active-reclaim")).toBe(true);
    expect(store.auditEvents.some((event) => event.mutationType === REFUSAL_ROW)).toBe(false);
    expect(() => sh(["git", "rev-parse", "--verify", "fusion/fn-8040"], repo)).toThrow();
    expect(allGitCommands().some((command) => command.includes("worktree prune"))).toBe(true);

    await (manager as unknown as { pruneWorktrees(): Promise<void> }).pruneWorktrees();
    expect(store.auditEvents.some((event) => event.mutationType === REFUSAL_ROW)).toBe(false);

    manager.stop();
  });

  it("records a zero-candidate refusal without touching any card", async () => {
    const workspace = track(makeNonRepoWorkspace());
    const store = makeStore(null);
    const manager = new SelfHealingManager(store, { rootDir: workspace } as any);

    await (manager as unknown as { pruneWorktrees(): Promise<void> }).pruneWorktrees();

    const refusals = store.auditEvents.filter((event) => event.mutationType === REFUSAL_ROW);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].metadata).toMatchObject({ sweep: "maintenance-worktree-prune", reason: "not-repo", candidateTaskCount: 0 });
    expect(store.logEntries).toEqual([]);
    expect(allGitCommands().some((command) => command.includes("worktree prune"))).toBe(false);
    manager.stop();
  });

  it("writes no lifecycle state on a refused pass (criterion 5)", async () => {
    const workspace = track(makeNonRepoWorkspace());
    const task = makeTask();
    const before = {
      column: task.column,
      status: task.status,
      error: task.error,
      paused: task.paused,
      pausedReason: task.pausedReason,
      stallReason: task.stallReason,
      branch: task.branch,
      worktree: task.worktree,
    };
    const store = makeStore(task);
    const manager = new SelfHealingManager(store, { rootDir: workspace } as any);

    await manager.reclaimStaleActiveBranches();
    await (manager as unknown as { pruneWorktrees(): Promise<void> }).pruneWorktrees();

    expect({
      column: task.column,
      status: task.status,
      error: task.error,
      paused: task.paused,
      pausedReason: task.pausedReason,
      stallReason: task.stallReason,
      branch: task.branch,
      worktree: task.worktree,
    }).toEqual(before);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    manager.stop();
  });
});
