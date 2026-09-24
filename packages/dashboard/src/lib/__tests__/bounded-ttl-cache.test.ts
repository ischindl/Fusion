import { describe, expect, it } from "vitest";
import {
  approxStringListBytes,
  createBoundedTtlCache,
} from "../bounded-ttl-cache.js";
import {
  listRetentionSourceIds,
  retentionCensus,
  retentionCensusSnapshot,
  type RetentionSourceSnapshot,
} from "../retention-census.js";

/*
FNXC:RetentionCensus 2026-09-21-10:49 (RUFU-257):
These tests pin the two properties the 2026-09-17 crash loop needed. A TTL that only bypasses on read
is the first one — the leak survived a TTL precisely because the entry stayed in the map — and a
cache with no ceiling is the second. Each case therefore asserts the ENTRY IS GONE, not merely that
the value was not served. Census ids are unique per case because the census registry is shared and
rejects duplicates by design.
*/

function makeCache(id: string, options: { ttlMs?: number; max?: number; valueBytes?: (v: string[]) => number } = {}) {
  let nowMs = 1_000_000;
  const cache = createBoundedTtlCache<string[]>({
    id,
    keys: "ttl",
    ttlMs: options.ttlMs ?? 10_000,
    max: options.max ?? 10,
    valueBytes: options.valueBytes,
    now: () => nowMs,
  });
  return { cache, advance: (ms: number) => { nowMs += ms; }, now: () => nowMs };
}

function censusRow(id: string): RetentionSourceSnapshot | undefined {
  return retentionCensusSnapshot().sources.find((source) => source.id === id);
}

describe("bounded TTL cache", () => {
  it("serves a value inside the TTL and deletes it once expired", () => {
    const { cache, advance } = makeCache("bounded_ttl_expiry");
    cache.set("FN-1", ["a.ts"]);

    expect(cache.get("FN-1")).toEqual(["a.ts"]);

    advance(10_001);
    expect(cache.get("FN-1")).toBeUndefined();
    // The leak class was a bypass that left the entry behind; retention must actually drop to zero.
    expect(cache.size()).toBe(0);
  });

  it("evicts the oldest insertion to hold the ceiling instead of growing with traffic", () => {
    const { cache } = makeCache("bounded_ttl_ceiling", { max: 2 });
    cache.set("task-1", ["a.ts"]);
    cache.set("task-2", ["b.ts"]);
    cache.set("task-3", ["c.ts"]);

    expect(cache.size()).toBe(2);
    expect(cache.get("task-1")).toBeUndefined();
    expect(cache.get("task-2")).toEqual(["b.ts"]);
    expect(cache.get("task-3")).toEqual(["c.ts"]);
  });

  it("does not evict when a write refreshes a key already held", () => {
    const { cache, advance } = makeCache("bounded_ttl_refresh", { max: 2 });
    cache.set("task-1", ["a.ts"]);
    cache.set("task-2", ["b.ts"]);
    advance(5_000);
    cache.set("task-1", ["a.ts", "b.ts"]);

    expect(cache.size()).toBe(2);
    // The refreshed key carries a NEW expiry, so it outlives the key written earlier in wall time.
    advance(6_000);
    expect(cache.get("task-1")).toEqual(["a.ts", "b.ts"]);
    expect(cache.get("task-2")).toBeUndefined();
  });

  it("reclaims expired entries on sweep without needing a read", () => {
    const { cache, advance } = makeCache("bounded_ttl_sweep", { max: 10 });
    cache.set("task-1", ["a.ts"]);
    cache.set("task-2", ["b.ts"]);
    cache.set("task-3", ["c.ts"]);
    advance(10_001);
    cache.set("task-4", ["d.ts"]);

    const row = censusRow("bounded_ttl_sweep");
    // The snapshot sweeps before probing, so the reported entry count is the POST-reclaim state.
    expect(row?.entries).toBe(1);
    expect(row?.expiredEntries).toBe(0);
    expect(cache.size()).toBe(1);
    expect(cache.get("task-4")).toEqual(["d.ts"]);
  });

  it("is a census source: entries, ceiling, and attributed bytes all render", () => {
    const { cache } = makeCache("bounded_ttl_census_row", { max: 4, valueBytes: approxStringListBytes });
    cache.set("FN-42", ["src/a.ts", "src/b.ts"]);
    cache.set("FN-43", ["src/c.ts"]);

    expect(listRetentionSourceIds()).toContain("bounded_ttl_census_row");
    const row = censusRow("bounded_ttl_census_row");
    expect(row?.ceiling).toBe(4);
    expect(row?.entries).toBe(2);
    expect(row?.approxBytes).toBeGreaterThan(0);
    expect(row?.probeFailed).toBe(false);
  });

  it("attributes more bytes to a bigger value under the same key", () => {
    const { cache } = makeCache("bounded_ttl_bytes_scale", { max: 4, valueBytes: approxStringListBytes });
    cache.set("small", ["a"]);
    const small = censusRow("bounded_ttl_bytes_scale")?.approxBytes ?? 0;

    cache.set("large", ["a".repeat(4000), "b".repeat(4000)]);
    const large = censusRow("bounded_ttl_bytes_scale")?.approxBytes ?? 0;

    expect(large).toBeGreaterThan(small);
    expect(approxStringListBytes([])).toBeGreaterThan(0);
  });

  it("flags the ceiling as reached so pressure evaluation can see a full cache", () => {
    const { cache } = makeCache("bounded_ttl_at_ceiling", { max: 1 });
    cache.set("task-1", ["a.ts"]);

    expect(censusRow("bounded_ttl_at_ceiling")?.atCeiling).toBe(true);

    cache.set("task-2", ["b.ts"]);
    expect(cache.size()).toBe(1);
    expect(censusRow("bounded_ttl_at_ceiling")?.atCeiling).toBe(true);
  });

  it("refuses a ceiling that would not bound anything", () => {
    expect(() =>
      createBoundedTtlCache<string[]>({ id: "bounded_ttl_bad_max", keys: "ttl", ttlMs: 1000, max: 0 }),
    ).toThrow(/positive max/);
    expect(() =>
      createBoundedTtlCache<string[]>({ id: "bounded_ttl_bad_ttl", keys: "ttl", ttlMs: -1, max: 5 }),
    ).toThrow(/non-negative ttlMs/);
  });

  it("supports the test seam: clear plus an injected clock", () => {
    const { cache, advance } = makeCache("bounded_ttl_reset", { max: 5 });
    cache.set("task-1", ["a.ts"]);
    expect(cache.size()).toBe(1);

    cache.resetForTests();
    expect(cache.size()).toBe(0);

    let fake = 500;
    cache.resetForTests(() => fake);
    cache.set("task-2", ["b.ts"]);
    expect(cache.get("task-2")).toEqual(["b.ts"]);

    fake = 500 + 10_001;
    expect(cache.get("task-2")).toBeUndefined();
    advance(0);
  });

  /*
   * RUFU-257 code review, finding `retention-op-family-no-producer`: `fusion_retention_op_total` and
   * `fusion_retention_op_latency_bucket` are rendered from the census op lane, and nothing in
   * production called `recordRetentionOp`, so both families published zeros forever. The gap survived
   * because every sampler test injected an `ops` fixture — a mocked feed cannot fail to be empty. These
   * cases therefore drive REAL cache traffic and read the REAL shared census.
   */
  it("counts every get and set into the census op lane under the cache's own id", () => {
    const { cache } = makeCache("bounded_ttl_ops");

    cache.set("FN-1", ["a.ts"]);
    cache.get("FN-1");
    cache.get("absent-key");

    const ops = retentionCensus().opsSnapshot();
    const row = ops.ops.find((entry) => entry.sourceId === "bounded_ttl_ops");
    // A miss is an operation too: the operator's question is how expensive this lane's traffic is,
    // and a cache that always misses is the failure the counters exist to reveal.
    expect(row?.count).toBe(3);
    // The bucket family is built from the latency ring, so a counter without ring samples would leave
    // it permanently zero even with traffic — assert the ring received one entry per op.
    expect(ops.recentLatencyMs.length).toBeGreaterThanOrEqual(3);
    expect(ops.recentLatencyMs.every((ms) => Number.isFinite(ms) && ms >= 0)).toBe(true);
  });

  it("lets a test cache opt out of the shared op lane without opting out of being a cache", () => {
    const cache = createBoundedTtlCache<string[]>({
      id: "bounded_ttl_ops_optout",
      keys: "ttl",
      ttlMs: 1_000,
      max: 4,
      registerCensus: false,
      recordOps: false,
    });

    cache.set("k", ["x.ts"]);
    cache.get("k");

    expect(retentionCensus().opsSnapshot().ops.find((e) => e.sourceId === "bounded_ttl_ops_optout")).toBeUndefined();
    expect(cache.get("k")).toEqual(["x.ts"]);
  });
});
