import { Database } from "@fusion/core";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureReportSchema } from "../../report-schema.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "report-schema-test-"));
}

describe("ensureReportSchema", () => {
  let tmp: string;
  let db: Database;

  beforeEach(() => {
    tmp = makeTmpDir();
    db = new Database(join(tmp, ".fusion"), { inMemory: true });
    db.init();
  });

  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("creates reports table and indexes idempotently", () => {
    ensureReportSchema(db);
    ensureReportSchema(db);

    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reports'").get() as { name: string } | undefined;
    expect(table?.name).toBe("reports");

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='reports' ORDER BY name").all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining([
      "idxReportsCadenceCreated",
      "idxReportsStatusUpdated",
      "idxReportsPeriod",
    ]));
  });

  it("enforces cadence and status CHECK constraints", () => {
    ensureReportSchema(db);

    const base = {
      id: "rep_1",
      cadence: "daily",
      periodStart: "2026-05-08T00:00:00.000Z",
      periodEnd: "2026-05-08T23:59:59.999Z",
      title: "Daily Report",
      status: "generating",
      generationStartedAt: "2026-05-09T00:00:00.000Z",
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:00.000Z",
    };

    const stmt = db.prepare(`
      INSERT INTO reports (id, cadence, periodStart, periodEnd, title, status, generationStartedAt, createdAt, updatedAt)
      VALUES (@id, @cadence, @periodStart, @periodEnd, @title, @status, @generationStartedAt, @createdAt, @updatedAt)
    `);

    expect(() => stmt.run({ ...base, id: "rep_bad_cadence", cadence: "hourly" })).toThrow();
    expect(() => stmt.run({ ...base, id: "rep_bad_status", status: "queued" })).toThrow();
  });
});
