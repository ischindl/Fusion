import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore execution timing semantics", () => {
  const harness = createTaskStoreTestHarness();
  let store = harness.store();

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("hydrates legacy tasks without firstExecutionAt and initializes on next in-progress transition", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T10:00:00.000Z"));

    const task = await store.createTask({ description: "legacy timing row" });
    await store.moveTask(task.id, "todo");
    await store.updateTask(task.id, {
      firstExecutionAt: null,
      cumulativeActiveMs: null,
      executionStartedAt: null,
    });

    const moved = await store.moveTask(task.id, "in-progress");
    expect(moved.firstExecutionAt).toBe("2026-05-15T10:00:00.000Z");
    expect(moved.cumulativeActiveMs).toBe(0);
  });

  it("tracks firstExecutionAt and cumulativeActiveMs across reopen/resume cycles", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-05-15T08:42:00.000Z");
    vi.setSystemTime(t0);

    const task = await store.createTask({ description: "timing lifecycle" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");

    vi.setSystemTime(new Date("2026-05-15T08:46:00.000Z"));
    await store.moveTask(task.id, "todo", { moveSource: "user" });

    vi.setSystemTime(new Date("2026-05-15T13:15:00.000Z"));
    const resumed = await store.moveTask(task.id, "in-progress");

    vi.setSystemTime(new Date("2026-05-15T13:17:00.000Z"));
    const reviewed = await store.moveTask(task.id, "in-review");

    expect(resumed.executionStartedAt).toBe("2026-05-15T13:15:00.000Z");
    expect(reviewed.firstExecutionAt).toBe("2026-05-15T08:42:00.000Z");
    expect(reviewed.cumulativeActiveMs).toBe(6 * 60_000);
  });

  it("accumulates active segment when preserveResumeState bounce exits in-progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T09:00:00.000Z"));

    const task = await store.createTask({ description: "preserve resume timing" });
    await store.moveTask(task.id, "todo");
    const running = await store.moveTask(task.id, "in-progress");

    vi.setSystemTime(new Date("2026-05-15T09:03:00.000Z"));
    const bounced = await store.moveTask(task.id, "todo", { preserveResumeState: true });

    expect(bounced.executionStartedAt).toBe(running.executionStartedAt);
    expect(bounced.cumulativeActiveMs).toBe(3 * 60_000);
  });

  it("counts only in-progress time for in-progress → in-review → done", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T11:00:00.000Z"));

    const task = await store.createTask({ description: "in review wait excluded" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");

    vi.setSystemTime(new Date("2026-05-15T11:05:00.000Z"));
    await store.moveTask(task.id, "in-review");

    vi.setSystemTime(new Date("2026-05-15T11:25:00.000Z"));
    const done = await store.moveTask(task.id, "done");

    expect(done.cumulativeActiveMs).toBe(5 * 60_000);
  });
});
