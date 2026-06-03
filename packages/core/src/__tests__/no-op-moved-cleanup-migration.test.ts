import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("no-op task:moved activity cleanup migration", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    await harness.beforeEach();
    await harness.reopenDiskBackedStore();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("deletes only no-op task:moved rows once and leaves later rows untouched", async () => {
    const store = harness.store();
    const db = store.getDatabase();
    const task = await harness.createTestTask();
    const insert = db.prepare(
      `INSERT INTO activityLog (id, timestamp, type, taskId, taskTitle, details, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    insert.run(
      "noop-1",
      "2026-06-03T00:00:01.000Z",
      "task:moved",
      task.id,
      task.title ?? null,
      "noop archived",
      JSON.stringify({ from: "archived", to: "archived" }),
    );
    insert.run(
      "noop-2",
      "2026-06-03T00:00:02.000Z",
      "task:moved",
      task.id,
      task.title ?? null,
      "noop todo",
      JSON.stringify({ from: "todo", to: "todo" }),
    );
    insert.run(
      "move-1",
      "2026-06-03T00:00:03.000Z",
      "task:moved",
      task.id,
      task.title ?? null,
      "real move",
      JSON.stringify({ from: "triage", to: "todo" }),
    );
    insert.run(
      "created-1",
      "2026-06-03T00:00:04.000Z",
      "task:created",
      task.id,
      task.title ?? null,
      "created",
      null,
    );
    db.prepare("DELETE FROM __meta WHERE key = ?").run("noOpTaskMovedActivityCleanupVersion");

    await harness.reopenDiskBackedStore();

    const migratedDb = harness.store().getDatabase();
    const movedRows = migratedDb.prepare(
      "SELECT id, metadata FROM activityLog WHERE type = 'task:moved' ORDER BY id",
    ).all() as Array<{ id: string; metadata: string | null }>;
    const migrationRow = migratedDb
      .prepare("SELECT value FROM __meta WHERE key = ?")
      .get("noOpTaskMovedActivityCleanupVersion") as { value: string } | undefined;

    expect(movedRows).toEqual([
      {
        id: "move-1",
        metadata: JSON.stringify({ from: "triage", to: "todo" }),
      },
    ]);
    const createdRows = migratedDb.prepare(
      "SELECT id FROM activityLog WHERE type = 'task:created' ORDER BY id",
    ).all() as Array<{ id: string }>;
    expect(createdRows.map((row) => row.id)).toContain("created-1");
    expect(migrationRow?.value).toBe("1");

    migratedDb.prepare("DELETE FROM activityLog WHERE id = ?").run("move-1");
    migratedDb.prepare(
      `INSERT INTO activityLog (id, timestamp, type, taskId, taskTitle, details, metadata)
       VALUES (?, ?, 'task:moved', ?, ?, ?, ?)`,
    ).run(
      "noop-after",
      "2026-06-03T00:00:05.000Z",
      task.id,
      task.title ?? null,
      "post-migration noop",
      JSON.stringify({ from: "archived", to: "archived" }),
    );

    await harness.reopenDiskBackedStore();

    const reopenedDb = harness.store().getDatabase();
    const postReopenRows = reopenedDb.prepare(
      "SELECT id FROM activityLog WHERE type = 'task:moved' ORDER BY id",
    ).all() as Array<{ id: string }>;

    expect(postReopenRows).toEqual([{ id: "noop-after" }]);
  });
});
