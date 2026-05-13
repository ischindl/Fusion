import { describe, expect, it } from "vitest";

import { Database } from "../db.js";
import { detectTaskIdIntegrityAnomalies } from "../task-id-integrity.js";

function createDb(): Database {
  const db = new Database("/tmp/fusion-task-id-integrity-test", { inMemory: true });
  db.init();
  return db;
}

function insertTask(db: Database, id: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, '', 'todo', ?, ?)",
  ).run(id, now, now);
}

describe("detectTaskIdIntegrityAnomalies", () => {
  it("returns ok for a clean database", () => {
    const db = createDb();

    const report = detectTaskIdIntegrityAnomalies(db);

    expect(report.status).toBe("ok");
    expect(report.checkedAt).toEqual(expect.any(String));
    expect(report.anomalies).toEqual([]);
  });

  it("returns ok when allocator tables are missing", () => {
    const db = createDb();
    db.exec("DROP TABLE distributed_task_id_reservations");
    db.exec("DROP TABLE distributed_task_id_state");

    const report = detectTaskIdIntegrityAnomalies(db);

    expect(report.status).toBe("ok");
    expect(report.anomalies).toEqual([]);
  });

  it("detects duplicate active task IDs", () => {
    const db = createDb();
    db.exec("ALTER TABLE tasks RENAME TO tasks_original");
    db.exec("CREATE TABLE tasks (id TEXT NOT NULL, description TEXT, \"column\" TEXT, createdAt TEXT, updatedAt TEXT)");
    db.exec(`
      INSERT INTO tasks (id, description, "column", createdAt, updatedAt) VALUES
      ('FN-101', '', 'todo', '2026-05-12T00:00:00.000Z', '2026-05-12T00:00:00.000Z'),
      ('FN-101', '', 'todo', '2026-05-12T00:00:01.000Z', '2026-05-12T00:00:01.000Z')
    `);

    const report = detectTaskIdIntegrityAnomalies(db);

    expect(report.status).toBe("anomaly");
    expect(report.anomalies).toContainEqual(
      expect.objectContaining({
        kind: "duplicate_active_id",
        prefix: "FN",
        affectedIds: ["FN-101"],
      }),
    );
  });

  it("detects IDs present in both active and archived storage", () => {
    const db = createDb();
    insertTask(db, "FN-102");
    db.prepare("INSERT INTO archivedTasks (id, data, archivedAt) VALUES (?, ?, ?)").run(
      "FN-102",
      JSON.stringify({ id: "FN-102" }),
      new Date().toISOString(),
    );

    const report = detectTaskIdIntegrityAnomalies(db);

    expect(report.anomalies).toContainEqual(
      expect.objectContaining({
        kind: "id_in_active_and_archived",
        prefix: "FN",
        affectedIds: ["FN-102"],
      }),
    );
  });

  it("detects stale nextSequence values at or below an existing used sequence", () => {
    const db = createDb();
    const now = new Date().toISOString();
    insertTask(db, "FN-100");
    db.prepare(
      "INSERT INTO distributed_task_id_state (prefix, nextSequence, committedClusterTaskCount, lastCommittedTaskId, updatedAt) VALUES (?, ?, ?, ?, ?)",
    ).run("FN", 100, 0, null, now);

    const report = detectTaskIdIntegrityAnomalies(db);

    expect(report.anomalies).toContainEqual(
      expect.objectContaining({
        kind: "next_sequence_at_or_below_used",
        prefix: "FN",
        affectedIds: ["FN-100"],
      }),
    );
  });

  it("does not flag committed reservations that point at existing task IDs (the happy-path steady state)", () => {
    const db = createDb();
    const now = new Date().toISOString();
    insertTask(db, "FN-103");
    db.prepare(
      "INSERT INTO distributed_task_id_state (prefix, nextSequence, committedClusterTaskCount, lastCommittedTaskId, updatedAt) VALUES (?, ?, ?, ?, ?)",
    ).run("FN", 104, 1, "FN-103", now);
    db.prepare(
      `INSERT INTO distributed_task_id_reservations (
        reservationId, prefix, nodeId, sequence, taskId, status, reason, expiresAt, committedAt, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, 'committed', NULL, ?, ?, ?, ?)`,
    ).run(
      "res-103",
      "FN",
      "node-a",
      103,
      "FN-103",
      new Date(Date.now() + 60_000).toISOString(),
      now,
      now,
      now,
    );

    const report = detectTaskIdIntegrityAnomalies(db);

    expect(report.status).toBe("ok");
    expect(report.anomalies).toEqual([]);
  });

  it("detects active task rows whose prefix is outside distributed state", () => {
    const db = createDb();
    const now = new Date().toISOString();
    insertTask(db, "KB-001");
    db.prepare(
      "INSERT INTO distributed_task_id_state (prefix, nextSequence, committedClusterTaskCount, lastCommittedTaskId, updatedAt) VALUES (?, ?, ?, ?, ?)",
    ).run("FN", 2, 0, null, now);

    const report = detectTaskIdIntegrityAnomalies(db);

    expect(report.anomalies).toContainEqual(
      expect.objectContaining({
        kind: "task_row_outside_known_prefix",
        prefix: "KB",
        affectedIds: ["KB-001"],
      }),
    );
  });
});
