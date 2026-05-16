import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, TaskStore, Task } from "@fusion/core";
import { cleanupOrphanedWorktrees } from "../../worktree-pool.js";
import { SelfHealingManager } from "../../self-healing.js";
import { readFileSync } from "node:fs";

const { execSpy, existsSpy, readdirSpy } = vi.hoisted(() => ({
  execSpy: vi.fn(),
  existsSpy: vi.fn(() => true),
  readdirSpy: vi.fn(() => []),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, exec: execSpy };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: existsSpy, readdirSync: readdirSpy };
});

function storeForSelfHealing(settings: Partial<Settings>, task: Partial<Task>): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, ...settings } as Settings)),
    listTasks: vi.fn(async ({ column }: any = {}) => (column === "in-review" ? [task] : [])),
    updateTask: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    getTask: vi.fn(async () => task),
  }) as unknown as TaskStore & EventEmitter;
}

describe("reliability interactions: worktrunk worktree removal routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execSpy.mockImplementation((_cmd: string, _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => cb(null, "", ""));
    existsSpy.mockReturnValue(true);
  });

  it("worktree-pool cleanup keeps native remove behavior in native mode", async () => {
    readdirSpy.mockReturnValue([{ isDirectory: () => true, name: "fn-1" }]);
    execSpy.mockImplementation((cmd: string, _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
      if (cmd.includes("git worktree list --porcelain")) {
        cb(null, "worktree /repo/.worktrees/fn-1\n", "");
        return;
      }
      cb(null, "", "");
    });

    const store = { listTasks: vi.fn(async () => []) } as unknown as TaskStore;
    await cleanupOrphanedWorktrees("/repo", store, { worktreesDir: "/repo/.worktrees" });

    expect(execSpy.mock.calls.some((call) => String(call[0]).includes("git worktree remove --force \"/repo/.worktrees/fn-1\""))).toBe(true);
  });

  it("self-healing recover path avoids native git remove under worktrunk mode", async () => {
    const task = {
      id: "FN-999",
      column: "in-review",
      status: "failed",
      branch: "fusion/fn-999",
      worktree: "/repo/.worktrees/fn-999",
      mergeDetails: { mergeConfirmed: false },
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as Task;
    const store = storeForSelfHealing({ worktrunk: { enabled: true, onFailure: "fail" } as any }, task);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo", getExecutingTaskIds: () => new Set() });

    vi.spyOn(mgr as any, "isBranchTipMisboundToTask").mockResolvedValue({ misbound: true, branchTip: "abc", landed: { sha: "abc", strategy: "tip-reachable" } });
    vi.spyOn(mgr as any, "clearCompletionBranchIfSubsumed").mockResolvedValue(true);

    await mgr.recoverBranchMisboundInReviewTasks();

    expect(execSpy.mock.calls.some((call) => String(call[0]).includes("git worktree remove"))).toBe(false);
  });

  it("merger callsite is migrated to removeWorktree helper", () => {
    const source = readFileSync(new URL("../../merger.ts", import.meta.url), "utf-8");
    expect(source).toContain("await removeWorktree({");
    expect(source).toContain("removePostMergeWorktree(rootDir, postMergeWorktree, taskId, settings)");
  });
});
