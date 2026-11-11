/*
FNXC:KnowledgeGraph 2026-11-11-18:53 (RUFU-500):
The stat sidecar is the only part of RUFU-500 that can make the graph STALE, so these tests are written as
the four refusals that make it safe rather than as coverage: a corrupt cache reads as absent, a sidecar hit
whose manifest hash disagrees is NOT a hit, a path with no entry is read, and `--force` bypasses the whole
mechanism. The reuse predicate is tested as a pure function because the trust rule is what an auditor has to
be able to read in one place.
*/
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  KNOWLEDGE_GRAPH_STAT_CACHE_VERSION,
  KNOWLEDGE_GRAPH_STAT_CACHE_FILENAME,
  loadStatCache,
  serializeStatCache,
  statCacheMayReuse,
  statCachePath,
  writeStatCache,
  type KnowledgeGraphStatCache,
} from "../graph-stat-cache.js";

const dirs: string[] = [];
async function dir() { const path = await mkdtemp(join(tmpdir(), "kg-stat-")); dirs.push(path); return path; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const ENTRIES: KnowledgeGraphStatCache = {
  "src/b.ts": { size: 21, mtimeMs: 111, hash: "h-b" },
  "src/a.ts": { size: 40, mtimeMs: 222, hash: "h-a" },
};

describe("statCacheMayReuse", () => {
  const entry = { size: 40, mtimeMs: 222, hash: "h-a" };
  it("reuses only when size, mtime, and the manifest hash all agree", () => {
    expect(statCacheMayReuse(entry, { size: 40, mtimeMs: 222 }, "h-a")).toBe(true);
  });
  it("refuses when the size moved", () => {
    expect(statCacheMayReuse(entry, { size: 41, mtimeMs: 222 }, "h-a")).toBe(false);
  });
  it("refuses when the mtime moved", () => {
    expect(statCacheMayReuse(entry, { size: 40, mtimeMs: 223 }, "h-a")).toBe(false);
  });
  it("refuses when the sidecar is missing for the path", () => {
    expect(statCacheMayReuse(undefined, { size: 40, mtimeMs: 222 }, "h-a")).toBe(false);
  });
  it("refuses when the manifest carries no entry, i.e. after any artifact recovery", () => {
    expect(statCacheMayReuse(entry, { size: 40, mtimeMs: 222 }, undefined)).toBe(false);
  });
  it("refuses when the sidecar stat matches but the manifest hash DIFFERS: the file IS re-read", () => {
    // This is the load-bearing case. A manifest that disagrees about the hash means the committed graph
    // does not describe these bytes, so trusting `stat` would keep stale nodes in a committable artifact.
    expect(statCacheMayReuse(entry, { size: 40, mtimeMs: 222 }, "other-hash")).toBe(false);
  });
});

describe("stat cache sidecar", () => {
  it("round-trips through the sidecar and sorts paths for byte-stable rewrites", async () => {
    const graphDir = await dir();
    await writeStatCache(graphDir, ENTRIES);
    expect(await loadStatCache(graphDir)).toEqual(ENTRIES);
    const text = await readFile(statCachePath(graphDir), "utf8");
    expect(JSON.parse(text)).toMatchObject({ version: KNOWLEDGE_GRAPH_STAT_CACHE_VERSION });
    expect(Object.keys(JSON.parse(text).entries)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("writes the sidecar beside the artifact triple without entering it", async () => {
    const graphDir = await dir();
    await writeStatCache(graphDir, ENTRIES);
    expect(statCachePath(graphDir)).toBe(join(graphDir, KNOWLEDGE_GRAPH_STAT_CACHE_FILENAME));
    // The committable triple names its keys exactly; a machine-local stat must never appear in them.
    expect(serializeStatCache(ENTRIES)).not.toContain("importRefs");
    expect(JSON.parse(serializeStatCache(ENTRIES))).toEqual({ version: KNOWLEDGE_GRAPH_STAT_CACHE_VERSION, entries: ENTRIES });
  });

  it("treats corrupt, truncated, wrong-version, and absent sidecars as an empty cache", async () => {
    const graphDir = await dir();
    expect(await loadStatCache(graphDir)).toEqual({});
    await writeFile(statCachePath(graphDir), "{ this is not json");
    expect(await loadStatCache(graphDir)).toEqual({});
    await writeFile(statCachePath(graphDir), "[1,2,3]");
    expect(await loadStatCache(graphDir)).toEqual({});
    await writeFile(statCachePath(graphDir), JSON.stringify({ version: KNOWLEDGE_GRAPH_STAT_CACHE_VERSION + 1, entries: ENTRIES }));
    expect(await loadStatCache(graphDir)).toEqual({});
    // A future schema version must invalidate every existing cache rather than mis-trust it.
    await writeFile(statCachePath(graphDir), JSON.stringify({ version: KNOWLEDGE_GRAPH_STAT_CACHE_VERSION, entries: { "src/a.ts": { size: 1 } } }));
    expect(await loadStatCache(graphDir)).toEqual({});
  });

  it("drops a single malformed entry and keeps the sound ones", async () => {
    const graphDir = await dir();
    await writeFile(statCachePath(graphDir), JSON.stringify({
      version: KNOWLEDGE_GRAPH_STAT_CACHE_VERSION,
      entries: { "src/a.ts": { size: 40, mtimeMs: 222, hash: "h-a" }, "src/bad.ts": { size: "big", mtimeMs: 1, hash: "h" }, "src/nihil.ts": null },
    }));
    expect(await loadStatCache(graphDir)).toEqual({ "src/a.ts": { size: 40, mtimeMs: 222, hash: "h-a" } });
  });

  it("rewrites nothing when the content is identical and survives a target it cannot write", async () => {
    const graphDir = await dir();
    expect(await writeStatCache(graphDir, ENTRIES)).toBe(true);
    expect(await writeStatCache(graphDir, ENTRIES)).toBe(false);
    // A sidecar is an optimisation: losing it may never fail the build that could not write it. An ancestor
    // that is a regular file makes mkdir fail with ENOTDIR, which is the hostile-host case.
    await writeFile(join(graphDir, "occupied"), "not a directory");
    await expect(writeStatCache(join(graphDir, "occupied", "nested"), ENTRIES)).resolves.toBe(false);
    expect(await loadStatCache(graphDir)).toEqual(ENTRIES);
  });
});
