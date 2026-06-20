import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArchiveDatabase } from "../archive-db.js";
import type { ArchivedTaskEntry } from "../types.js";

type ArchiveEntryOverrides = Partial<ArchivedTaskEntry> & { title?: string | null };

function makeTmpDir(prefix = "kb-archive-fts-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeEntry(id: string, overrides: ArchiveEntryOverrides = {}): ArchivedTaskEntry {
  const timestamp = overrides.archivedAt ?? "2026-06-03T00:00:00.000Z";
  return {
    id,
    lineageId: overrides.lineageId ?? id,
    column: "archived",
    title: overrides.title === null ? undefined : overrides.title ?? `title ${id}`,
    description: overrides.description ?? `description ${id}`,
    comments: overrides.comments ?? [],
    dependencies: overrides.dependencies ?? [],
    steps: overrides.steps ?? [],
    currentStep: overrides.currentStep ?? 0,
    log: overrides.log ?? [],
    createdAt: overrides.createdAt ?? timestamp,
    updatedAt: overrides.updatedAt ?? timestamp,
    archivedAt: timestamp,
    columnMovedAt: overrides.columnMovedAt ?? timestamp,
    prompt: overrides.prompt,
  };
}

describe("ArchiveDatabase FTS maintenance", () => {
  let prevDisableFts5: string | undefined;

  beforeEach(() => {
    prevDisableFts5 = process.env.FUSION_DISABLE_FTS5;
  });

  afterEach(() => {
    if (prevDisableFts5 === undefined) {
      delete process.env.FUSION_DISABLE_FTS5;
    } else {
      process.env.FUSION_DISABLE_FTS5 = prevDisableFts5;
    }
  });

  it("rebuilds a churned disk-backed archive index down to a bounded size", async () => {
    const dir = makeTmpDir();
    const archive = new ArchiveDatabase(dir);

    try {
      archive.init();
      if (!archive.fts5Available) {
        expect(archive.rebuildFts5Index()).toBe(false);
        return;
      }

      const payload = "alpha ".repeat(400);
      for (let i = 0; i < 72; i++) {
        archive.upsert(makeEntry("FN-ARCHIVE-1", {
          archivedAt: new Date(1717372800000 + i * 1000).toISOString(),
          updatedAt: new Date(1717372800000 + i * 1000).toISOString(),
          title: `release-note-${i}`,
          description: `${payload}${i}`,
          comments: [{ id: `c-${i}`, text: `${payload}comment-${i}`, author: "tester", createdAt: new Date(1717372800000 + i * 1000).toISOString() }],
        }));
      }

      const grownBytes = archive.getFtsIndexBytes();
      expect(grownBytes).not.toBeNull();
      expect(grownBytes!).toBeGreaterThan(0);
      expect(archive.getArchivedRowCount()).toBe(1);

      expect(archive.rebuildFts5Index()).toBe(true);
      const rebuiltBytes = archive.getFtsIndexBytes();
      expect(rebuiltBytes).not.toBeNull();
      expect(rebuiltBytes!).toBeLessThan(grownBytes!);
      expect(rebuiltBytes!).toBeLessThan(1 * 1024 * 1024);
      expect(archive.search("release-note-71", 10).map((entry) => entry.id)).toContain("FN-ARCHIVE-1");
    } finally {
      archive.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("supports optimize and merge compaction on disk-backed archives", async () => {
    const dir = makeTmpDir();
    const archive = new ArchiveDatabase(dir);

    try {
      archive.init();
      if (!archive.fts5Available) {
        expect(archive.optimizeFts5("merge")).toBe(false);
        expect(archive.optimizeFts5("optimize")).toBe(false);
        return;
      }

      archive.upsert(makeEntry("FN-ARCHIVE-2", {
        description: "optimize target alpha beta gamma",
        comments: [{ id: "c-1", text: "merge optimize searchable", author: "tester", createdAt: "2026-06-03T00:00:00.000Z" }],
      }));

      expect(archive.optimizeFts5("merge")).toBe(true);
      expect(archive.optimizeFts5("optimize")).toBe(true);
      expect(archive.search("searchable", 10).map((entry) => entry.id)).toContain("FN-ARCHIVE-2");
    } finally {
      archive.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps archive search results identical before and after compaction across null fields, hyphenated tokens, churn, and deletes", async () => {
    const dir = makeTmpDir();
    const archive = new ArchiveDatabase(dir);

    try {
      archive.init();
      const rawDb = (archive as any).db;

      archive.upsert(makeEntry("FN-ARCHIVE-3", {
        title: "release-note-guard",
        description: "archive special-char target",
        comments: [{ id: "c-2", text: "comment-needle", author: "tester", createdAt: "2026-06-03T00:00:00.000Z" }],
      }));
      archive.upsert(makeEntry("FN-ARCHIVE-4", {
        title: null,
        description: "null title searchable phrase",
        comments: [],
      }));
      rawDb.prepare("UPDATE archived_tasks SET comments = NULL WHERE id = ?").run("FN-ARCHIVE-4");
      archive.upsert(makeEntry("FN-ARCHIVE-5", {
        title: "delete-me",
        description: "deleted archive needle",
      }));
      archive.delete("FN-ARCHIVE-5");

      for (let i = 0; i < 60; i++) {
        archive.upsert(makeEntry("FN-ARCHIVE-3", {
          archivedAt: new Date(1717372800000 + i * 1000).toISOString(),
          updatedAt: new Date(1717372800000 + i * 1000).toISOString(),
          title: `release-note-guard ${i}`,
          description: `archive special-char target marker-${i}`,
          comments: [{ id: `c-${i}`, text: `comment-needle marker-${i}`, author: "tester", createdAt: new Date(1717372800000 + i * 1000).toISOString() }],
        }));
      }

      const queryResultsBefore = {
        hyphen: archive.search("release-note-guard", 10).map((entry) => entry.id).sort(),
        nullTitle: archive.search("searchable phrase", 10).map((entry) => entry.id).sort(),
        comment: archive.search("comment-needle", 10).map((entry) => entry.id).sort(),
        special: archive.search("test + special (chars)", 10).map((entry) => entry.id).sort(),
        deleted: archive.search("deleted archive needle", 10).map((entry) => entry.id).sort(),
      };

      expect(queryResultsBefore.hyphen).toContain("FN-ARCHIVE-3");
      expect(queryResultsBefore.nullTitle).toContain("FN-ARCHIVE-4");
      expect(queryResultsBefore.comment).toContain("FN-ARCHIVE-3");
      expect(queryResultsBefore.deleted).not.toContain("FN-ARCHIVE-5");

      expect(archive.optimizeFts5("optimize")).toBe(archive.fts5Available);
      expect(archive.rebuildFts5Index()).toBe(archive.fts5Available);

      const queryResultsAfter = {
        hyphen: archive.search("release-note-guard", 10).map((entry) => entry.id).sort(),
        nullTitle: archive.search("searchable phrase", 10).map((entry) => entry.id).sort(),
        comment: archive.search("comment-needle", 10).map((entry) => entry.id).sort(),
        special: archive.search("test + special (chars)", 10).map((entry) => entry.id).sort(),
        deleted: archive.search("deleted archive needle", 10).map((entry) => entry.id).sort(),
      };

      expect(queryResultsAfter).toEqual(queryResultsBefore);
    } finally {
      archive.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats maintenance seams as safe no-ops when FTS5 is disabled or in-memory", async () => {
    process.env.FUSION_DISABLE_FTS5 = "1";
    const disabledDir = makeTmpDir("kb-archive-fts-disabled-");
    const disabledArchive = new ArchiveDatabase(disabledDir);

    try {
      disabledArchive.init();
      disabledArchive.upsert(makeEntry("FN-ARCHIVE-6", { title: null, description: "fallback-like alpha-beta" }));
      expect(disabledArchive.fts5Available).toBe(false);
      expect(disabledArchive.getFtsIndexBytes()).toBeNull();
      expect(disabledArchive.optimizeFts5("merge")).toBe(false);
      expect(disabledArchive.optimizeFts5("optimize")).toBe(false);
      expect(disabledArchive.rebuildFts5Index()).toBe(false);
      expect(disabledArchive.search("alpha-beta", 10).map((entry) => entry.id)).toEqual(["FN-ARCHIVE-6"]);
    } finally {
      disabledArchive.close();
      await rm(disabledDir, { recursive: true, force: true });
    }

    delete process.env.FUSION_DISABLE_FTS5;
    const memoryArchive = new ArchiveDatabase("/tmp/fusion-archive-memory-test", { inMemory: true });
    try {
      memoryArchive.init();
      memoryArchive.upsert(makeEntry("FN-ARCHIVE-7", { description: "memory archive search" }));
      expect(() => memoryArchive.getArchivedRowCount()).not.toThrow();
      expect(memoryArchive.search("memory archive", 10).map((entry) => entry.id)).toContain("FN-ARCHIVE-7");
      if (memoryArchive.fts5Available) {
        expect(memoryArchive.optimizeFts5("merge")).toBe(true);
        expect(memoryArchive.rebuildFts5Index()).toBe(true);
      } else {
        expect(memoryArchive.optimizeFts5("merge")).toBe(false);
        expect(memoryArchive.rebuildFts5Index()).toBe(false);
      }
    } finally {
      memoryArchive.close();
      rmSync("/tmp/fusion-archive-memory-test", { recursive: true, force: true });
    }
  });
});

describe("ArchiveDatabase WAL durability PRAGMAs", () => {
  let dir: string;
  let archive: ArchiveDatabase;

  beforeEach(() => {
    dir = makeTmpDir("kb-archive-pragma-");
    archive = new ArchiveDatabase(dir);
  });

  afterEach(async () => {
    archive.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("bounds WAL growth and durability like the per-project DB", () => {
    const rawDb = (archive as unknown as { db: { prepare(sql: string): { get(): unknown } } }).db;
    const synchronous = rawDb.prepare("PRAGMA synchronous").get() as { synchronous: number };
    const autoCheckpoint = rawDb
      .prepare("PRAGMA wal_autocheckpoint")
      .get() as { wal_autocheckpoint: number };
    const journalSizeLimit = rawDb
      .prepare("PRAGMA journal_size_limit")
      .get() as { journal_size_limit: number };

    expect(synchronous.synchronous).toBe(2); // FULL
    expect(autoCheckpoint.wal_autocheckpoint).toBe(1000);
    // Previously unset (-1 / unbounded), which let the archive WAL bloat and
    // slow every reader. Now capped at 4 MB to match db.ts/central-db.ts.
    expect(journalSizeLimit.journal_size_limit).toBe(4_194_304);
  });
});
