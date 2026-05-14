import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";

const execMock = vi.fn();
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFn: any = (cmd: string, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    execMock(cmd, opts)
      .then((stdout: string) => callback?.(null, stdout, ""))
      .catch((err: Error) => callback?.(err, "", err.message));
  };
  execFn[promisify.custom] = (cmd: string, opts?: any) => execMock(cmd, opts).then((stdout: string) => ({ stdout, stderr: "" }));
  return { exec: execFn, execSync: vi.fn() };
});

import { SelfHealingManager } from "../../self-healing.js";
import * as branchConflicts from "../../branch-conflicts.js";
import * as worktreePool from "../../worktree-pool.js";

function createStore(): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  (emitter as any).getSettings = vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false });
  (emitter as any).listTasks = vi.fn();
  (emitter as any).updateTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).moveTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).logEntry = vi.fn().mockResolvedValue(undefined);
  (emitter as any).recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  return emitter;
}

describe("reliability interactions: live-zero reclaim", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  beforeEach(() => {
    store = createStore();
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test" });
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
    execMock.mockReset();
    execMock.mockResolvedValue("");
  });

  it("skips userPaused tasks", async () => {
    (store.listTasks as any)
      .mockResolvedValueOnce([{ id: "FN-9101", column: "todo", checkedOutBy: null, branch: "fusion/fn-9101", worktree: "/tmp/live", userPaused: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const inspectSpy = vi.spyOn(branchConflicts, "inspectBranchConflict");
    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(0);
    expect(inspectSpy).not.toHaveBeenCalled();
  });

  it("is idempotent across two sweeps", async () => {
    (store.listTasks as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "FN-9102", column: "in-review", checkedOutBy: null, branch: "fusion/fn-9102", worktree: "/tmp/live", paused: true, pausedReason: "branch-conflict-unrecoverable", lineageId: "lin-9102" },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({ kind: "fully-subsumed", livePath: "/tmp/live", tipSha: "abc123abc123" } as any);

    const first = await manager.reclaimSelfOwnedBranchConflicts();
    const second = await manager.reclaimSelfOwnedBranchConflicts();

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledTimes(1);
  });
});
