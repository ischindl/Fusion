/**
 * RUFU-1012: the project-memory file lane must score on whole Unicode words and must tile a file
 * with non-overlapping windows. Written against the real files under `.fusion/memory/` in a temp
 * root, so no `qmd` binary and no network are involved (under vitest `searchWithQmd` declines and
 * the qmd backend answers through this same file lane, which is exactly the path pinned here).
 *
 * FNXC:MemoryQueryTerms 2026-11-19-04:35 (RUFU-1012).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileMemoryBackend,
  QmdMemoryBackend,
  hasProjectMemoryContent,
  searchMemoryFiles,
} from "../memory-backend.js";
import type { MemorySearchResult } from "../memory-backend.js";

let rootDir = "";

function useTempRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), "rufu-1012-core-"));
  return rootDir;
}

function writeLongTerm(content: string, filename = "MEMORY.md"): void {
  mkdirSync(join(rootDir, ".fusion", "memory"), { recursive: true });
  writeFileSync(join(rootDir, ".fusion", "memory", filename), content, "utf-8");
}

function overlappingPairs(hits: MemorySearchResult[]): string[] {
  const offenders: string[] = [];
  for (let a = 0; a < hits.length; a += 1) {
    for (let b = a + 1; b < hits.length; b += 1) {
      if (hits[a].path !== hits[b].path) continue;
      if (hits[a].lineStart <= hits[b].lineEnd && hits[b].lineStart <= hits[a].lineEnd) {
        offenders.push(`${hits[a].path}:${hits[a].lineStart}-${hits[a].lineEnd} <> ${hits[b].path}:${hits[b].lineStart}-${hits[b].lineEnd}`);
      }
    }
  }
  return offenders;
}

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
});

describe("FileMemoryBackend.search — word-level relevance", () => {
  const backend = new FileMemoryBackend();

  it("a diacritic query cannot cash in on an ASCII fragment of an English word", async () => {
    useTempRoot();
    // pre-fix terms for "systémové pravidlo" were [syst, mov, pravidlo]; `syst` is a substring of
    // "system", so this block scored 1 and was returned.
    writeLongTerm(["# Project Memory", "", "## Poznamky", "- the system route keeps files stable", ""].join("\n"));

    const hits = await backend.search(rootDir, { query: "systémové pravidlo", limit: 5 });
    expect(hits).toEqual([]);
  });

  it("a Slovak whole word in the file still matches", async () => {
    useTempRoot();
    writeLongTerm(["# Project Memory", "", "## Pravidlá", "- operatívna časť file scope je dohodnutá", ""].join("\n"));

    const hits = await backend.search(rootDir, { query: "operatívna", limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe(".fusion/memory/MEMORY.md");
    expect(hits[0].score).toBe(1);
    expect(hits[0].snippet).toContain("operatívna");
  });

  it("an English hyphenated compound is unaffected", async () => {
    useTempRoot();
    writeLongTerm(["# Project Memory", "", "- Post-merge verification gate covers project-wide refactors", ""].join("\n"));

    const hits = await backend.search(rootDir, { query: "post-merge project-wide", limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBe(2);
  });

  it("a punctuation-only query still returns the zero-term empty list", async () => {
    useTempRoot();
    writeLongTerm("# Project Memory\n\n- anything at all\n");
    expect(await backend.search(rootDir, { query: "...", limit: 5 })).toEqual([]);
  });
});

describe("memory file lane — windows do not overlap", () => {
  const fileBackend = new FileMemoryBackend();
  const qmdBackend = new QmdMemoryBackend();

  async function tiledFile(term: string, rows: number): Promise<number> {
    const lines = ["# Project Memory", ""];
    for (let i = 1; i <= rows; i += 1) lines.push(`- ${term} ${i}`);
    writeLongTerm(lines.join("\n"));
    return lines.length;
  }

  it("no two hits over one path share a line at the file backend", async () => {
    useTempRoot();
    const total = await tiledFile("udaj", 40);

    const hits = await fileBackend.search(rootDir, { query: "udaj", limit: 20 });
    expect(hits.length).toBeGreaterThan(1);
    expect(overlappingPairs(hits)).toEqual([]);
    for (const hit of hits) {
      expect(hit.lineEnd - hit.lineStart + 1).toBeLessThanOrEqual(12);
      expect(hit.lineEnd).toBeLessThanOrEqual(total);
    }
  });

  it("the qmd backend's fallback lane inherits the same geometry", async () => {
    useTempRoot();
    await tiledFile("udaj", 40);

    const hits = await qmdBackend.search(rootDir, { query: "udaj", limit: 20 });
    expect(hits.length).toBeGreaterThan(1);
    expect(overlappingPairs(hits)).toEqual([]);
    for (const hit of hits) expect(hit.backend).toBe("qmd");
  });

  it("the walk tiles the file exactly once (shared seam, documented geometry)", async () => {
    useTempRoot();
    await tiledFile("bod", 60);

    const hits = await searchMemoryFiles(rootDir, { query: "bod", limit: 20 }, "file");
    expect(hits.map((h) => `${h.lineStart}-${h.lineEnd}`).sort()).toEqual(
      ["1-12", "13-24", "25-36", "37-48", "49-60", "61-62"].sort(),
    );
  });

  it("the score sort and the limit clamp are unchanged", async () => {
    useTempRoot();
    const lines = ["# Project Memory", ""];
    for (let i = 1; i <= 24; i += 1) lines.push(i <= 12 ? `- udaj ${i}` : `- nic ${i}`);
    writeLongTerm(lines.join("\n"));

    const hits = await searchMemoryFiles(rootDir, { query: "udaj", limit: 1 }, "file");
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain("udaj");
  });
});

describe("hasProjectMemoryContent — the honest empty-store discriminator", () => {
  it("is false when no memory file exists", async () => {
    useTempRoot();
    expect(await hasProjectMemoryContent(rootDir)).toBe(false);
  });

  it("is false when the only memory file holds whitespace", async () => {
    useTempRoot();
    writeLongTerm("\n\n   \n");
    expect(await hasProjectMemoryContent(rootDir)).toBe(false);
  });

  it("is true once there is real content", async () => {
    useTempRoot();
    writeLongTerm("# Project Memory\n\n- durable rule\n");
    expect(await hasProjectMemoryContent(rootDir)).toBe(true);
  });

  it("is true (content may exist) when the inventory cannot be read", async () => {
    useTempRoot();
    // A file entry that cannot be read must not be reported as an empty store.
    mkdirSync(join(rootDir, ".fusion", "memory"), { recursive: true });
    writeFileSync(join(rootDir, ".fusion", "memory", "MEMORY.md"), "x", "utf-8");
    expect(await hasProjectMemoryContent(join(rootDir, "does-not-exist"))).toBe(false);
    expect(await hasProjectMemoryContent(rootDir)).toBe(true);
  });
});
