import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { retentionCensusSnapshot } from "../lib/retention-census";
import * as sessionDiffRoutes from "../routes/register-session-diff-routes";
import { codeWithoutComments } from "../../../../scripts/check-retention-coverage.mjs";

/*
FNXC:RetentionCensus 2026-09-23-18:22 (RUFU-257 Step 4):
The diff lane is where the OOM class was born: two of its three caches keyed one entry per task/session and
retained whole patch strings, and their `expiresAt` only made a stale entry IGNORED on read, so the entry
itself never left. Steps 2 and 3 fixed that (`session_files`/`file_diffs` onto the bounded TTL seam,
`task_diff_stats` already ceiling-guarded), and every existing test here proves the *latency* contract of
the lane. None of them fails if the retention half is removed again — a cache whose eviction guard is
deleted still answers every request correctly, and only the heap notices hours later.

So this file locks the retention half specifically, in the two ways that are actually observable at a test
boundary: the CEILINGS are advertised through the real census registrations (behavioral, through the
production module), and the eviction/reclamation WIRES exist in the write and read paths (a code-construct
guard, which AGENTS permits where the invariant is structural rather than user-observable). The third
cache's raw-`Map` declaration is asserted absent, because "it went back to a plain Map" is exactly how the
regression would arrive.

Each structural guard runs against comment-stripped source and carries a mutated-fixture control in
`describe.each` below, so a pattern that stopped matching anything cannot pass.
*/

const ROUTE_FILE = resolve(__dirname, "../routes/register-session-diff-routes.ts");
const routeCode = codeWithoutComments(readFileSync(ROUTE_FILE, "utf8"));

/**
 * The write path must test the count ceiling and drop an entry inside that branch. Plain substring
 * windows rather than a regex: the invariant is "a delete happens right after the size test", and a
 * quoting/escaping bug in a generated regex would silently widen the match to nothing.
 */
function guardedCeilingWrite(code: string, symbol: string, ceiling: string): boolean {
  const guard = code.indexOf(`${symbol}.size >= ${ceiling}`);
  return guard !== -1 && code.slice(guard, guard + 220).includes(".delete(");
}

/** The read path must DELETE an expired entry rather than only bypassing it (the original bug). */
function deleteOnExpireRead(code: string, symbol: string): boolean {
  const scope = readFunctionBody(code) ?? code;
  const expiryTest = scope.indexOf("expiresAt <= ");
  const reclaim = scope.indexOf(`${symbol}.delete(`);
  return expiryTest !== -1 && reclaim > expiryTest && reclaim - expiryTest < 160;
}

/** Body of `readTaskDiffStatsCache`, so a `expiresAt` comparison elsewhere cannot satisfy the guard. */
function readFunctionBody(code: string): string | undefined {
  const start = code.indexOf("function readTaskDiffStatsCache");
  return start === -1 ? undefined : code.slice(start, start + 600);
}

const STRUCTURAL_WIRES = [
  {
    label: "count-ceiling eviction on write",
    predicate: (code: string) => guardedCeilingWrite(code, "taskDiffStatsCache", "TASK_DIFF_STATS_CACHE_MAX"),
    unboundedVariant: `
const taskDiffStatsCache = new Map();
const TASK_DIFF_STATS_CACHE_MAX = 500;
function writeTaskDiffStatsCache(key: string, stats: unknown): void {
  taskDiffStatsCache.set(key, { stats, expiresAt: 1 });
}
`,
  },
  {
    label: "delete-on-expire on read",
    predicate: (code: string) => deleteOnExpireRead(code, "taskDiffStatsCache"),
    unboundedVariant: `
const taskDiffStatsCache = new Map();
function readTaskDiffStatsCache(key: string) {
  const hit = taskDiffStatsCache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= now()) return undefined;
  return hit.stats;
}
`,
  },
];

describe("diff-lane retention wires (RUFU-257 recurrence lock)", () => {
  it("advertises all three diff-lane caches through the real census with their named ceilings", () => {
    const census = retentionCensusSnapshot();
    const rows = Object.fromEntries(census.sources.map((source) => [source.id, source]));
    // 500 file-listings and 100 patch sets are the maximum this lane may hold; a silent widening of
    // either is the leak returning with a bigger number attached.
    expect(rows.session_files).toMatchObject({ keys: "ttl", ceiling: 500, ceilingConstant: "SESSION_FILES_CACHE_MAX" });
    expect(rows.file_diffs).toMatchObject({ keys: "ttl", ceiling: 100, ceilingConstant: "FILE_DIFFS_CACHE_MAX" });
    expect(rows.task_diff_stats).toMatchObject({ keys: "ttl", ceiling: 500, ceilingConstant: "TASK_DIFF_STATS_CACHE_MAX" });
    // The route module must be the one that registered them — a census row that lives only in a test
    // fixture would satisfy the id check while the shipping process still reported nothing.
    expect(Object.keys(sessionDiffRoutes)).toContain("__resetDiffLaneCachesForTests");
  });

  it("builds the two leaky caches through the bounded TTL seam instead of a raw module-scope Map", () => {
    expect(routeCode).toMatch(/const sessionFilesCache = createBoundedTtlCache[\s\S]{0,400}?max: SESSION_FILES_CACHE_MAX/);
    expect(routeCode).toMatch(/const fileDiffsCache = createBoundedTtlCache[\s\S]{0,400}?max: FILE_DIFFS_CACHE_MAX/);
    expect(routeCode).not.toMatch(/const sessionFilesCache = new Map/);
    expect(routeCode).not.toMatch(/const fileDiffsCache = new Map/);
  });

  // Mutated-fixture control: each predicate must hold against the shipping file AND refuse the shape the
  // regression would take. Without the second half, a pattern that stopped matching anything would read
  // as a passing guard forever — the same non-vacuity rule the CI ratchet applies to itself.
  describe.each(STRUCTURAL_WIRES)("$label", ({ predicate, unboundedVariant }) => {
    it("holds in the shipping file", () => expect(predicate(routeCode)).toBe(true));
    it("refuses the unbounded variant", () => expect(predicate(codeWithoutComments(unboundedVariant))).toBe(false));
  });
});
