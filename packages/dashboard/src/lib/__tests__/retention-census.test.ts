/**
 * RUFU-257 Step 1 unit tests for the retention census.
 *
 * These lock the three properties the operator-facing instrument depends on and that a future
 * "optimization" could silently break:
 *   1. the snapshot is pure + synchronous and reports EVERY registered id, even at 0 entries —
 *      because a missing series is indistinguishable from an unregistered cache;
 *   2. a hostile probe cannot take the census down — it contributes 0 and is flagged, so one
 *      broken cache cannot blind the whole memory investigation;
 *   3. the coverage ratio is clamped to [0, 1] and never negative, because byte attribution is
 *      an estimate that can exceed the heap reading it is divided by.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createRetentionCensus,
  buildCumulativeBuckets,
  approxStringBytes,
  MAP_ENTRY_OVERHEAD_BYTES,
  MAX_REGISTERED_SOURCES,
  RETENTION_OP_LATENCY_RING_CAP,
  type RetentionProbeReading,
} from "../retention-census.js";

/** Build a census with host seams that need no real process/V8 reads. */
function makeCensus(opts: { heapUsed?: number; heapLimit?: number } = {}) {
  const heapUsed = opts.heapUsed ?? 1000;
  const heapLimit = opts.heapLimit ?? 4000;
  return createRetentionCensus({
    memory: () => ({ heapUsed, rss: heapUsed * 2 }),
    heapLimit: () => heapLimit,
    now: () => 1234,
  });
}

function source(
  id: string,
  reading: RetentionProbeReading | (() => RetentionProbeReading),
  extra: Partial<Parameters<ReturnType<typeof createRetentionCensus>["register"]>[0]> = {},
) {
  return {
    id,
    kind: "cache" as const,
    keys: "ttl" as const,
    probe: typeof reading === "function" ? reading : () => reading,
    ...extra,
  };
}

describe("retention census (RUFU-257)", () => {
  let census: ReturnType<typeof createRetentionCensus>;

  beforeEach(() => {
    census = makeCensus();
  });

  describe("purity + full-id reporting", () => {
    it("reports every registered source id even when it holds zero entries", () => {
      census.register(source("empty_cache", { entries: 0, approxBytes: 0, expiredEntries: 0 }));
      census.register(source("warm_cache", { entries: 3, approxBytes: 300, expiredEntries: 1 }));

      const snapshot = census.snapshot();

      // The acceptance requirement: both ids present, the empty one as an explicit zero row.
      expect(snapshot.sources.map((s) => s.id)).toEqual(["empty_cache", "warm_cache"]);
      const empty = snapshot.sources.find((s) => s.id === "empty_cache");
      expect(empty?.entries).toBe(0);
      expect(empty?.approxBytes).toBe(0);
      expect(snapshot.trackedBytes).toBe(300);
    });

    it("is synchronous and repeatable without mutating what it measured", () => {
      const map = new Map<string, string>([
        ["a", "x"],
        ["b", "yy"],
      ]);
      census.register(
        source("from_map", () => ({
          entries: map.size,
          approxBytes: map.size * MAP_ENTRY_OVERHEAD_BYTES,
          expiredEntries: 0,
        })),
      );

      const first = census.snapshot();
      const second = census.snapshot();

      expect(typeof first.generatedAtMs).toBe("number");
      expect(second.sources).toEqual(first.sources);
      // Reading the census must not consume or clear the measured structure.
      expect(map.size).toBe(2);
    });

    it("sums tracked bytes and derives coverage ratio, residual, and ceiling flags", () => {
      census.register(source("a", { entries: 1, approxBytes: 400, expiredEntries: 0 }, { ceiling: 1 }));
      census.register(source("b", { entries: 0, approxBytes: 100, expiredEntries: 0 }));

      const snapshot = census.snapshot();

      expect(snapshot.trackedBytes).toBe(500);
      expect(snapshot.heapUsedBytes).toBe(1000);
      expect(snapshot.coverageRatio).toBeCloseTo(0.5);
      expect(snapshot.residualBytes).toBe(500);
      expect(snapshot.sources.find((s) => s.id === "a")?.atCeiling).toBe(true);
      expect(snapshot.sources.find((s) => s.id === "b")?.atCeiling).toBe(false);
      expect(snapshot.sources.find((s) => s.id === "b")?.ceiling).toBeNull();
    });
  });

  describe("coverage ratio honesty", () => {
    it("clamps an over-estimating census to 1 instead of reporting >100% coverage", () => {
      const tinyHeap = makeCensus({ heapUsed: 100, heapLimit: 4000 });
      tinyHeap.register(source("over_estimator", { entries: 10, approxBytes: 9_000, expiredEntries: 0 }));

      expect(tinyHeap.snapshot().coverageRatio).toBe(1);
    });

    it("reports 0 coverage and a floored residual when the heap reading is unusable", () => {
      const broken = createRetentionCensus({
        memory: () => {
          throw new Error("host hides memory usage");
        },
        heapLimit: () => {
          throw new Error("host hides heap limit");
        },
      });
      broken.register(source("real", { entries: 2, approxBytes: 200, expiredEntries: 0 }));

      const snapshot = broken.snapshot();
      expect(snapshot.heapUsedBytes).toBe(0);
      expect(snapshot.heapLimitBytes).toBe(0);
      expect(snapshot.coverageRatio).toBe(0);
      expect(snapshot.residualBytes).toBe(0);
      expect(Number.isFinite(snapshot.coverageRatio)).toBe(true);
    });

    it("never reports a negative ratio or negative byte counts from garbage readings", () => {
      census.register(
        source("negative_reader", {
          entries: -5,
          approxBytes: -9000,
          expiredEntries: -1,
        }),
      );

      const snapshot = census.snapshot();
      const row = snapshot.sources[0]!;
      expect(row.entries).toBe(0);
      expect(row.approxBytes).toBe(0);
      expect(row.expiredEntries).toBe(0);
      expect(snapshot.coverageRatio).toBeGreaterThanOrEqual(0);
      expect(snapshot.trackedBytes).toBe(0);
    });
  });

  describe("hostile probe isolation", () => {
    it("absorbs a throwing probe: the source reports 0, is flagged, and the census does not throw", () => {
      census.register(source("healthy", { entries: 2, approxBytes: 200, expiredEntries: 0 }));
      census.register(
        source("hostile", () => {
          throw new Error("probe exploded");
        }),
      );

      let snapshot!: ReturnType<typeof census.snapshot>;
      expect(() => {
        snapshot = census.snapshot();
      }).not.toThrow();

      expect(snapshot.sources.map((s) => s.id)).toEqual(["healthy", "hostile"]);
      const hostile = snapshot.sources.find((s) => s.id === "hostile");
      expect(hostile?.probeFailed).toBe(true);
      expect(hostile?.entries).toBe(0);
      expect(hostile?.approxBytes).toBe(0);
      expect(snapshot.probeFailureCount).toBe(1);
      // A hostile neighbour must not steal the healthy source's numbers.
      expect(snapshot.sources.find((s) => s.id === "healthy")?.approxBytes).toBe(200);
    });

    it("treats a non-finite / missing probe reading as a failed probe contributing 0", () => {
      census.register(source("nan_reader", () => ({ entries: NaN, approxBytes: Infinity, expiredEntries: 0 })));
      census.register(source("nothing_reader", (() => undefined) as unknown as () => RetentionProbeReading));

      const snapshot = census.snapshot();
      expect(snapshot.trackedBytes).toBe(0);
      // NaN/Infinity sanitize to 0 rather than poisoning the sum; a missing reading fails loudly.
      expect(snapshot.sources.find((s) => s.id === "nothing_reader")?.probeFailed).toBe(true);
      expect(Number.isFinite(snapshot.coverageRatio)).toBe(true);
    });

    it("absorbs a throwing sweep without losing the source's metric row", () => {
      census.register(
        source("bad_sweeper", { entries: 4, approxBytes: 40, expiredEntries: 0 }, {
          sweep: () => {
            throw new Error("sweep exploded");
          },
        }),
      );

      const snapshot = census.snapshot();
      expect(snapshot.sources.find((s) => s.id === "bad_sweeper")?.entries).toBe(4);
      expect(snapshot.sweptEntries).toBe(0);
    });
  });

  describe("reclaim sweep ownership", () => {
    it("runs only opted-in sweep hooks and counts what they removed", () => {
      const expired = new Map<string, number>([
        ["stale", 1],
        ["fresh", Number.MAX_SAFE_INTEGER],
      ]);
      census.register(
        source("swept", () => ({ entries: expired.size, approxBytes: expired.size * 10, expiredEntries: 0 }), {
          sweep: () => {
            let removed = 0;
            for (const [k, expiresAt] of expired) {
              if (expiresAt <= 5) {
                expired.delete(k);
                removed++;
              }
            }
            return removed;
          },
        }),
      );
      let otherSweeps = 0;
      census.register(
        source("self_sweeping_elsewhere", { entries: 1, approxBytes: 10, expiredEntries: 0 }),
      );
      census.register({
        ...source("declared_sweeper", { entries: 1, approxBytes: 10, expiredEntries: 0 }),
        sweep: () => {
          otherSweeps++;
          return 1;
        },
      });

      const snapshot = census.snapshot();

      expect(expired.size).toBe(1);
      expect(snapshot.sweptEntries).toBe(2);
      expect(snapshot.sweptSources).toBe(2);
      // A source without a hook is never swept by the census — one owner per structure.
      expect(otherSweeps).toBe(1);
    });
  });

  describe("registry bounds", () => {
    it("refuses duplicate ids and overflow past the named ceiling, recording why", () => {
      expect(census.register(source("dup", { entries: 1, approxBytes: 1, expiredEntries: 0 }))).toBe(true);
      expect(census.register(source("dup", { entries: 1, approxBytes: 1, expiredEntries: 0 }))).toBe(false);
      expect(census.registrationRejections()).toContain("dup");

      const filled = makeCensus();
      for (let i = 0; i < MAX_REGISTERED_SOURCES; i++) {
        filled.register(source(`s_${i}`, { entries: 1, approxBytes: 1, expiredEntries: 0 }));
      }
      expect(filled.sourceIds().length).toBe(MAX_REGISTERED_SOURCES);
      expect(filled.register(source("overflow", { entries: 1, approxBytes: 1, expiredEntries: 0 }))).toBe(false);
    });

    it("keeps its own op ring bounded at the named cap", () => {
      for (let i = 0; i < RETENTION_OP_LATENCY_RING_CAP + 40; i++) {
        census.recordOp("task_diff_stats", i);
      }
      const ops = census.opsSnapshot();
      expect(ops.recentLatencyMs.length).toBe(RETENTION_OP_LATENCY_RING_CAP);
      // The ring keeps the NEWEST samples, not the first ones written.
      expect(ops.recentLatencyMs[ops.recentLatencyMs.length - 1]).toBe(
        RETENTION_OP_LATENCY_RING_CAP + 39,
      );
      const row = ops.ops.find((o) => o.sourceId === "task_diff_stats");
      expect(row?.count).toBe(RETENTION_OP_LATENCY_RING_CAP + 40);
    });

    it("collapses unknown op ids into one bounded bucket instead of growing per caller string", () => {
      for (let i = 0; i < 200; i++) census.recordOp(`caller_${i}`, 1);
      const ids = census.opsSnapshot().ops.map((o) => o.sourceId);
      expect(ids.length).toBeLessThanOrEqual(64);
      expect(ids).toContain("unknown");
    });
  });

  describe("documented byte weights", () => {
    it("attributes string bytes as length x the documented per-char weight", () => {
      expect(approxStringBytes("abcd")).toBe(4 * 2);
      expect(approxStringBytes("")).toBe(0);
      expect(approxStringBytes(undefined)).toBe(0);
      expect(MAP_ENTRY_OVERHEAD_BYTES).toBeGreaterThan(0);
    });

    it("builds cumulative latency buckets that never decrease across edges", () => {
      const buckets = buildCumulativeBuckets([2, 7, 60, 900], [1, 5, 10, 100]);
      expect(buckets).toEqual({ "1": 0, "5": 1, "10": 2, "100": 3 });
      const values = Object.values(buckets);
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]!);
      }
    });
  });
});
