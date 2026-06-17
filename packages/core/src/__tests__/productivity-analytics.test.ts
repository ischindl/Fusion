import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "../db.js";
import { aggregateProductivityAnalytics } from "../productivity-analytics.js";

function insertTaskWithFiles(db: Database, id: string, files: string[], updatedAt: string): void {
  db.prepare(
    `INSERT INTO tasks (id, description, "column", createdAt, updatedAt, modifiedFiles)
     VALUES (?, 'desc', 'todo', ?, ?, ?)`,
  ).run(id, updatedAt, updatedAt, JSON.stringify(files));
}

function insertCommit(db: Database, id: string, sha: string, authoredAt: string): void {
  db.prepare(
    `INSERT INTO task_commit_associations
       (id, taskLineageId, taskIdSnapshot, commitSha, commitSubject, authoredAt,
        matchedBy, confidence, createdAt, updatedAt)
     VALUES (?, 'lin-1', 't-1', ?, 'subj', ?, 'canonical-lineage-trailer', 'canonical', ?, ?)`,
  ).run(id, sha, authoredAt, authoredAt, authoredAt);
}

function insertPr(db: Database, id: string, createdAtMs: number): void {
  db.prepare(
    `INSERT INTO pull_requests
       (id, sourceType, sourceId, repo, headBranch, state, createdAt, updatedAt)
     VALUES (?, 'task', ?, 'org/repo', ?, 'open', ?, ?)`,
  ).run(id, `src-${id}`, `branch-${id}`, createdAtMs, createdAtMs);
}

describe("productivity-analytics", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-productivity-analytics-"));
    db = new Database(join(tmpDir, ".fusion"));
    db.init();
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("counts modified files and language distribution", () => {
    insertTaskWithFiles(db, "t1", ["src/a.ts", "src/b.ts", "README.md"], "2026-03-01T00:00:00.000Z");
    insertTaskWithFiles(db, "t2", ["src/c.ts", "style.css"], "2026-03-02T00:00:00.000Z");

    const result = aggregateProductivityAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(result.modifiedFiles).toBe(5);
    const byLang = new Map(result.byLanguage.map((l) => [l.language, l.count]));
    expect(byLang.get("ts")).toBe(3);
    expect(byLang.get("md")).toBe(1);
    expect(byLang.get("css")).toBe(1);
    // sorted descending by count
    expect(result.byLanguage[0]).toEqual({ language: "ts", count: 3 });
  });

  it("counts commit associations and pull requests in range", () => {
    insertCommit(db, "c1", "sha1", "2026-03-01T00:00:00.000Z");
    insertCommit(db, "c2", "sha2", "2026-03-02T00:00:00.000Z");
    insertCommit(db, "c-old", "sha-old", "2025-01-01T00:00:00.000Z");

    insertPr(db, "pr1", Date.parse("2026-03-01T00:00:00.000Z"));
    insertPr(db, "pr2", Date.parse("2026-03-10T00:00:00.000Z"));
    insertPr(db, "pr-old", Date.parse("2025-01-01T00:00:00.000Z"));

    const result = aggregateProductivityAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(result.commits).toBe(2);
    expect(result.pullRequests).toBe(2);
  });

  it("reports LOC as unavailable (null + unavailable:true), never 0", () => {
    insertTaskWithFiles(db, "t1", ["src/a.ts"], "2026-03-01T00:00:00.000Z");
    const result = aggregateProductivityAnalytics(db, {});
    expect(result.loc).toEqual({ value: null, unavailable: true });
    expect(result.loc.value).not.toBe(0);
  });

  it("empty range returns zeroed structures, not nulls", () => {
    insertTaskWithFiles(db, "t1", ["src/a.ts"], "2026-03-01T00:00:00.000Z");
    insertCommit(db, "c1", "sha1", "2026-03-01T00:00:00.000Z");
    insertPr(db, "pr1", Date.parse("2026-03-01T00:00:00.000Z"));

    const result = aggregateProductivityAnalytics(db, { from: "2027-01-01T00:00:00.000Z", to: "2027-12-31T00:00:00.000Z" });
    expect(result.modifiedFiles).toBe(0);
    expect(result.byLanguage).toEqual([]);
    expect(result.commits).toBe(0);
    expect(result.pullRequests).toBe(0);
    // LOC unavailable regardless of range
    expect(result.loc).toEqual({ value: null, unavailable: true });
  });

  it("includes a boundary task exactly at `from`", () => {
    insertTaskWithFiles(db, "boundary", ["x.ts"], "2026-03-01T00:00:00.000Z");
    const result = aggregateProductivityAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(result.modifiedFiles).toBe(1);
  });
});
