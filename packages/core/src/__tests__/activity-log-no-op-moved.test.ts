import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rm } from "node:fs/promises";

import { TaskStore } from "../store.js";
import { createTaskStoreTestHarness, makeTmpDir } from "./store-test-helpers.js";

describe("activity log task:moved no-op guard", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("does not record same-column task:moved emits and still records distinct moves", async () => {
    const store = harness.store();
    const task = await harness.createTestTask();

    (store as any).emit("task:moved", { task, from: "archived", to: "archived", source: "engine" });
    expect(await store.getActivityLog({ type: "task:moved" })).toEqual([]);

    (store as any).emit("task:moved", { task, from: "triage", to: "todo", source: "engine" });

    const activity = await store.getActivityLog({ type: "task:moved" });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      type: "task:moved",
      taskId: task.id,
      metadata: { from: "triage", to: "todo" },
    });
  });

  it("does not record activity for same-column moveTask calls", async () => {
    const store = harness.store();
    const task = await harness.createTestTask();

    await store.moveTask(task.id, "triage");

    expect(await store.getActivityLog({ type: "task:moved" })).toEqual([]);
  });

  it("records legitimate moveTask transitions exactly once", async () => {
    const store = harness.store();
    const task = await harness.createTestTask();

    await store.moveTask(task.id, "todo");

    expect(await store.getActivityLog({ type: "task:moved" })).toEqual([
      expect.objectContaining({
        taskId: task.id,
        metadata: { from: "triage", to: "todo" },
      }),
    ]);
  });

  it("does not emit or record archived-to-archived polling replication no-ops", async () => {
    const rootDir = makeTmpDir();
    const globalDir = makeTmpDir();
    const writer = new TaskStore(rootDir, globalDir);
    const observer = new TaskStore(rootDir, globalDir);

    try {
      await writer.init();
      await observer.init();

      const task = await writer.createTask({ column: "done", description: "archive me" });
      const archived = await writer.archiveTask(task.id, false);
      const movedEvents: Array<{ from: string; to: string }> = [];
      observer.on("task:moved", ({ from, to }) => movedEvents.push({ from, to }));
      (observer as any).taskCache.set(archived.id, { ...archived });
      (observer as any).lastKnownModified = 0;

      await (observer as any).checkForChanges();

      expect(movedEvents).toEqual([]);
      expect(await observer.getActivityLog({ type: "task:moved" })).toEqual([
        expect.objectContaining({
          taskId: task.id,
          metadata: { from: "done", to: "archived" },
        }),
      ]);
    } finally {
      writer.close();
      observer.close();
      await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(globalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("does not emit or record same-column polling observations", async () => {
    const rootDir = makeTmpDir();
    const globalDir = makeTmpDir();
    const writer = new TaskStore(rootDir, globalDir);
    const observer = new TaskStore(rootDir, globalDir);

    try {
      await writer.init();
      await observer.init();

      const task = await writer.createTask({ column: "todo", description: "same-column poll" });
      const movedEvents: Array<{ from: string; to: string }> = [];
      observer.on("task:moved", ({ from, to }) => movedEvents.push({ from, to }));
      (observer as any).taskCache.set(task.id, { ...task });
      (observer as any).lastKnownModified = 0;

      await writer.updateTask(task.id, { title: "still todo" });
      await (observer as any).checkForChanges();

      expect(movedEvents).toEqual([]);
      expect(await observer.getActivityLog({ type: "task:moved" })).toEqual([]);
    } finally {
      writer.close();
      observer.close();
      await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(globalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
