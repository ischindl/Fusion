import { describe, it, expect, vi, beforeEach } from "vitest";
import { acquireTaskWorktree } from "../worktree-acquisition.js";
import { WorktrunkOperationError } from "../worktree-backend.js";

vi.mock("../worktree-pool.js", async () => {
  const actual = await vi.importActual<any>("../worktree-pool.js");
  return { ...actual, isUsableTaskWorktree: vi.fn().mockResolvedValue(true) };
});

vi.mock("../worktree-db-hydrate.js", () => ({
  hydrateWorktreeDb: vi.fn().mockResolvedValue({ degraded: false, tasksCopied: 1, documentsCopied: 1 }),
}));

const { execMock } = vi.hoisted(() => {
  const mock = vi.fn();
  (mock as any)[Symbol.for("nodejs.util.promisify.custom")] = mock;
  return { execMock: mock };
});

vi.mock("node:child_process", () => ({ exec: execMock }));

describe("acquireTaskWorktree worktrunk wiring", () => {
  const task = {
    id: "FN-1",
    title: "Task",
    description: "Desc",
    branch: null,
    worktree: null,
  } as any;

  const store = {
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as any;

  beforeEach(() => {
    execMock.mockReset();
    store.updateTask.mockClear();
    store.logEntry.mockClear();
  });

  it("uses native backend by default", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    await acquireTaskWorktree({
      task,
      rootDir: "/repo",
      store,
      settings: { worktreeNaming: "task-id" } as any,
    });

    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining("git worktree add -b"),
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("uses worktrunk backend and emits create audit on success", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const git = vi.fn().mockResolvedValue(undefined);
    await acquireTaskWorktree({
      task,
      rootDir: "/repo",
      store,
      settings: { worktreeNaming: "task-id", worktrunk: { enabled: true, binaryPath: "worktrunk", onFailure: "fail" } } as any,
      audit: { git },
    });

    expect(execMock).toHaveBeenCalledWith('"worktrunk" --help', expect.objectContaining({ cwd: "/repo" }));
    expect(git).toHaveBeenCalledWith(expect.objectContaining({ type: "worktree:worktrunk-create" }));
    expect(git).not.toHaveBeenCalledWith(expect.objectContaining({ type: "worktree:worktrunk-fallback" }));
  });

  it("fails without native fallback when onFailure is fail", async () => {
    execMock.mockRejectedValue({ stderr: "boom", code: 1 });

    await expect(
      acquireTaskWorktree({
        task,
        rootDir: "/repo",
        store,
        settings: { worktreeNaming: "task-id", worktrunk: { enabled: true, binaryPath: "worktrunk", onFailure: "fail" } } as any,
        audit: { git: vi.fn() },
      }),
    ).rejects.toBeInstanceOf(WorktrunkOperationError);

    expect(execMock).not.toHaveBeenCalledWith(expect.stringContaining("git worktree add -b"), expect.anything());
  });

  it("falls back to native when configured", async () => {
    execMock
      .mockRejectedValueOnce({ stderr: "boom", code: 1 })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const git = vi.fn().mockResolvedValue(undefined);
    await acquireTaskWorktree({
      task,
      rootDir: "/repo",
      store,
      settings: {
        worktreeNaming: "task-id",
        worktrunk: { enabled: true, binaryPath: "worktrunk", onFailure: "fallback-native" },
      } as any,
      audit: { git },
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(execMock.mock.calls[1]?.[0]).toContain("git worktree add -b");
    expect(git).toHaveBeenCalledWith(expect.objectContaining({ type: "worktree:worktrunk-fallback" }));
  });

  it("throws missing-binary error when binaryPath is absent", async () => {
    await expect(
      acquireTaskWorktree({
        task,
        rootDir: "/repo",
        store,
        settings: { worktreeNaming: "task-id", worktrunk: { enabled: true, onFailure: "fail" } } as any,
      }),
    ).rejects.toMatchObject({
      name: "WorktrunkOperationError",
      code: "worktrunk_binary_missing",
    });
  });
});
