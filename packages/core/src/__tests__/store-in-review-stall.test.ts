import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "../store.js";

describe("TaskStore inReviewStall hydration", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "store-in-review-stall-"));
    globalDir = join(rootDir, ".fusion-global-settings");
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  async function seedTask(id: string, overrides: { paused?: boolean; mergeDetails?: Record<string, unknown>; status?: string; mergeRetries?: number }) {
    const now = Date.now();
    const updatedAt = new Date(now - 6 * 60_000).toISOString();
    await store.createTaskWithReservedId(
      { description: id, column: "in-review" },
      { taskId: id, createdAt: updatedAt, updatedAt, applyDefaultWorkflowSteps: false },
    );
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...params: unknown[]) => unknown } } }).db;
    db.prepare(`UPDATE tasks
      SET status = ?, paused = ?, mergeRetries = ?, mergeDetails = ?, worktree = ?, updatedAt = ?
      WHERE id = ?`).run(
      overrides.status ?? "merging",
      overrides.paused ? 1 : 0,
      overrides.mergeRetries ?? 0,
      JSON.stringify(overrides.mergeDetails ?? {}),
      `/tmp/${id}`,
      updatedAt,
      id,
    );
  }

  it("hydrates transient stall for FN-4110 shape in slim list", async () => {
    await seedTask("FN-4110", {});

    const tasks = await store.listTasks({ slim: true });
    const task = tasks.find((entry) => entry.id === "FN-4110");

    expect(task?.inReviewStall?.code).toBe("transient-merge-status-no-owner");
    expect(task?.inReviewStall?.reason).toContain("no active merger");
  });

  it("omits inReviewStall for paused in-review task", async () => {
    await seedTask("FN-4217-PAUSED", { paused: true });

    const tasks = await store.listTasks({ slim: true });
    const task = tasks.find((entry) => entry.id === "FN-4217-PAUSED");

    expect(task?.inReviewStall).toBeUndefined();
  });

  it("omits inReviewStall when merge is confirmed", async () => {
    await seedTask("FN-4217-CONFIRMED", { mergeDetails: { mergeConfirmed: true } });

    const tasks = await store.listTasks({ slim: true });
    const task = tasks.find((entry) => entry.id === "FN-4217-CONFIRMED");

    expect(task?.inReviewStall).toBeUndefined();
  });
});
