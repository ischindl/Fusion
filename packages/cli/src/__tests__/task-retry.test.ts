import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@fusion/core";
import { runTaskRetry } from "../commands/task.js";

describe("runTaskRetry", () => {
  const originalCwd = process.cwd();
  let tmpDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "fusion-task-retry-"));
    process.chdir(tmpDir);
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    process.chdir(originalCwd);
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createStore() {
    const store = new TaskStore(tmpDir);
    await store.init();
    return store;
  }

  it("clears the deadlock auto-pause when retrying a failed task", async () => {
    const store = await createStore();
    const task = await store.createTask({
      title: "deadlock-paused task",
      description: "test",
      column: "todo",
    });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "failed",
      error: "merge deadlock",
      paused: true,
      pausedReason: "in-review-stall-deadlock",
      mergeRetries: 4,
    });

    await runTaskRetry(task.id);

    const updated = await store.getTask(task.id);
    expect(updated.column).toBe("todo");
    expect(updated.status).toBeUndefined();
    expect(updated.error).toBeUndefined();
    expect(updated.paused).toBeUndefined();
    expect(updated.pausedReason).toBeUndefined();
    expect(updated.mergeRetries).toBe(0);
  });

});
