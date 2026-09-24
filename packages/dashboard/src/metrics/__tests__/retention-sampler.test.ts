/**
 * RUFU-257 Step 1 unit tests for the retention sampler.
 *
 * The sampler is the only place the census becomes operator-visible, so these lock the wire shape:
 *   - the census byte/entry series and the `le`-labelled op-latency BUCKET family all render, using
 *     the gauge-with-`le`-label idiom (this repo's Prometheus exposition has no histogram type);
 *   - every registered source keeps a line even at zero entries, so a cache is never invisible;
 *   - `buildSnapshot` performs zero awaited I/O and the tick timer is `unref()`'d, so an
 *     instrument can neither block a scrape nor hold the process open;
 *   - the pressure signal fires on both documented triggers and is cooldown-limited.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createRetentionSampler,
  DEFAULT_HEAP_PRESSURE_RATIO,
  type RetentionPressureSignal,
} from "../retention-sampler.js";
import type { RetentionCensusSnapshot } from "../../lib/retention-census.js";
import { createBoundedTtlCache } from "../../lib/bounded-ttl-cache.js";

function snapshotFixture(overrides: Partial<RetentionCensusSnapshot> = {}): RetentionCensusSnapshot {
  return {
    generatedAtMs: 5_000,
    sources: [
      {
        id: "task_diff_stats",
        kind: "cache",
        keys: "ttl",
        ceiling: 500,
        ceilingConstant: "TASK_DIFF_STATS_CACHE_MAX",
        entries: 3,
        approxBytes: 1_200,
        expiredEntries: 1,
        atCeiling: false,
        probeFailed: false,
      },
      {
        id: "knowledge_graph_artifacts",
        kind: "cache",
        keys: "ttl",
        ceiling: 4,
        ceilingConstant: "CACHE_SIZE",
        entries: 0,
        approxBytes: 0,
        expiredEntries: 0,
        atCeiling: false,
        probeFailed: false,
      },
    ],
    trackedBytes: 1_200,
    heapUsedBytes: 4_000,
    heapLimitBytes: 10_000,
    coverageRatio: 0.3,
    residualBytes: 2_800,
    probeFailureCount: 0,
    sweptSources: 0,
    sweptEntries: 0,
    ...overrides,
  };
}

/** Timer seam that records whether the sampler unref()'d what it scheduled. */
function fakeTimers() {
  const scheduled: Array<{ fn: () => void; ms: number; unrefed: boolean; id: number }> = [];
  let nextId = 1;
  return {
    scheduled,
    timers: {
      setInterval: (fn: () => void, ms: number) => {
        const entry = { fn, ms, unrefed: false, id: nextId++ };
        scheduled.push(entry);
        return {
          unref: () => {
            entry.unrefed = true;
          },
        };
      },
      clearInterval: () => {
        /* nothing to release in the fake */
      },
    },
  };
}

/** Render a family out of the snapshot by name. */
function family(sampler: ReturnType<typeof createRetentionSampler>, name: string) {
  return sampler.buildSnapshot().find((f) => f.name === name);
}

describe("retention sampler (RUFU-257)", () => {
  it("renders the census byte/entry series with a line per registered source, zero included", () => {
    const sampler = createRetentionSampler({
      census: () => snapshotFixture(),
      ops: () => ({ ops: [{ sourceId: "task_diff_stats", count: 7, totalMs: 14 }], recentLatencyMs: [1, 2, 40] }),
    });

    const bytes = family(sampler, "fusion_retention_source_bytes");
    const entries = family(sampler, "fusion_retention_source_entries");
    const expired = family(sampler, "fusion_retention_source_expired_entries");

    expect(bytes?.type).toBe("gauge");
    expect(bytes?.labels).toEqual(["source"]);
    // The zero-entry source is present with an explicit 0 rather than omitted.
    expect(bytes?.samples.map((s) => s.labelValues?.[0])).toEqual([
      "task_diff_stats",
      "knowledge_graph_artifacts",
    ]);
    expect(bytes?.samples[1]?.value).toBe(0);
    expect(entries?.samples[0]?.value).toBe(3);
    expect(expired?.samples?.[0]?.value).toBe(1);
  });

  it("renders the coverage-ratio / heap series so coverage is computable at 0%", () => {
    const sampler = createRetentionSampler({ census: () => snapshotFixture() });

    const tracked = family(sampler, "fusion_retention_tracked_bytes");
    const heap = family(sampler, "fusion_retention_heap_used_bytes");
    const ratio = family(sampler, "fusion_retention_coverage_ratio");
    const residual = family(sampler, "fusion_retention_residual_bytes");

    expect(tracked?.samples[0]?.value).toBe(1_200);
    expect(heap?.samples[0]?.value).toBe(4_000);
    expect(ratio?.samples[0]?.value).toBeCloseTo(0.3);
    expect(residual?.samples[0]?.value).toBe(2_800);
    // Ratio must be present even when it is 0, or "0% coverage" is indistinguishable from
    // "the retention sampler is not running".
    const emptyRatio = createRetentionSampler({
      census: () => snapshotFixture({ coverageRatio: 0, trackedBytes: 0, heapUsedBytes: 9_000 }),
    });
    expect(family(emptyRatio, "fusion_retention_coverage_ratio")?.samples[0]?.value).toBe(0);
  });

  it("renders op latency as a bucket family carrying an le label (gauge, not histogram)", () => {
    const sampler = createRetentionSampler({
      census: () => snapshotFixture(),
      ops: () => ({ ops: [{ sourceId: "task_diff_stats", count: 3, totalMs: 45 }], recentLatencyMs: [2, 8, 60] }),
      latencyBuckets: [1, 5, 10, 100],
    });

    const buckets = family(sampler, "fusion_retention_op_latency_bucket");
    const totals = family(sampler, "fusion_retention_op_total");

    // This repo's exposition format supports gauge|counter only, so the bucket family is a set of
    // gauges labelled by `le` — the same idiom as fusion_system_request_latency_bucket.
    expect(buckets?.labels).toEqual(["le"]);
    expect(buckets?.type).toBe("gauge");
    expect(buckets?.samples.map((s) => s.labelValues?.[0])).toEqual(["1", "5", "10", "100"]);
    expect(buckets?.samples.map((s) => s.value)).toEqual([0, 1, 2, 3]);
    expect(totals?.type).toBe("counter");
    expect(totals?.samples[0]?.value).toBe(3);
  });

  it("never throws and still renders the full family set when the census itself is hostile", () => {
    const sampler = createRetentionSampler({
      census: () => {
        throw new Error("census exploded");
      },
      ops: () => {
        throw new Error("ops exploded");
      },
    });

    let families!: ReturnType<typeof sampler.buildSnapshot>;
    expect(() => {
      families = sampler.buildSnapshot();
    }).not.toThrow();
    const names = families.map((f) => f.name);
    expect(names).toContain("fusion_retention_source_bytes");
    expect(names).toContain("fusion_retention_coverage_ratio");
    expect(names).toContain("fusion_retention_op_latency_bucket");
    expect(family(sampler, "fusion_retention_coverage_ratio")?.samples[0]?.value).toBe(0);
  });

  it("renders synchronously with a real pre-read sample before the first tick", () => {
    const census = vi.fn(() => snapshotFixture());
    const sampler = createRetentionSampler({ census });

    // A scrape that arrives before any tick must report the census, not a field of zeros that
    // would read as "every cache is empty".
    const families = sampler.buildSnapshot();
    expect(families.length).toBeGreaterThan(0);
    expect(census).toHaveBeenCalledTimes(1);
    expect(sampler.state.snapshot?.sources.length).toBe(2);
  });

  it("starts an unref()'d tick timer and stops it on stopTimers", () => {
    const { scheduled, timers } = fakeTimers();
    const sampler = createRetentionSampler({ census: () => snapshotFixture(), timers });

    sampler.start();
    sampler.start(); // idempotent — a second start must not add a second interval

    expect(scheduled.length).toBe(1);
    expect(scheduled[0]?.unrefed).toBe(true);
    expect(sampler.started).toBe(true);

    sampler.stopTimers();
    expect(sampler.started).toBe(false);
  });

  it("ticks the census and evaluates pressure on each tick", () => {
    const { scheduled, timers } = fakeTimers();
    const onPressure = vi.fn();
    const sampler = createRetentionSampler({
      census: () => snapshotFixture({ heapUsedBytes: 9_000, heapLimitBytes: 10_000 }),
      timers,
      onPressure,
    });

    sampler.start();
    scheduled[0]!.fn();

    expect(onPressure).toHaveBeenCalledTimes(1);
    const signal = onPressure.mock.calls[0]![0] as RetentionPressureSignal;
    expect(signal.reason).toBe("heap-ratio");
    // The signal names the dominant source so the runbook's decision table has a subject.
    expect(signal.topSourceId).toBe("task_diff_stats");
    expect(signal.topSourceBytes).toBe(1_200);
  });

  describe("pressure signal", () => {
    it("does not fire below the heap ratio threshold", () => {
      const onPressure = vi.fn();
      const sampler = createRetentionSampler({
        census: () =>
          snapshotFixture({
            heapLimitBytes: 10_000,
            heapUsedBytes: Math.floor(10_000 * DEFAULT_HEAP_PRESSURE_RATIO) - 1,
          }),
        onPressure,
      });

      expect(sampler.evaluatePressure()).toBeNull();
      expect(onPressure).not.toHaveBeenCalled();
    });

    it("fires after the named consecutive at-ceiling streak, not on the first at-ceiling sample", () => {
      const onPressure = vi.fn();
      const atCeiling = snapshotFixture({
        heapUsedBytes: 1_000,
        heapLimitBytes: 10_000,
        sources: [
          {
            id: "task_diff_stats",
            kind: "cache",
            keys: "ttl",
            ceiling: 500,
            ceilingConstant: "TASK_DIFF_STATS_CACHE_MAX",
            entries: 500,
            approxBytes: 5_000,
            expiredEntries: 0,
            atCeiling: true,
            probeFailed: false,
          },
        ],
      });
      const sampler = createRetentionSampler({ census: () => atCeiling, onPressure, ceilingStreakThreshold: 3 });

      expect(sampler.evaluatePressure()).toBeNull();
      expect(sampler.evaluatePressure()).toBeNull();
      const third = sampler.evaluatePressure();
      expect(third?.reason).toBe("source-at-ceiling");
      expect(third?.atCeilingStreak).toBe(3);
      expect(onPressure).toHaveBeenCalledTimes(1);
    });

    it("cooldowns repeated signals so a stall cannot spam the operator", () => {
      const onPressure = vi.fn();
      const sampler = createRetentionSampler({
        census: () => snapshotFixture({ heapUsedBytes: 9_500, heapLimitBytes: 10_000 }),
        onPressure,
        pressureCooldownMs: 60_000,
      });

      expect(sampler.evaluatePressure()).not.toBeNull();
      expect(sampler.evaluatePressure()).toBeNull();
      expect(sampler.evaluatePressure()).toBeNull();
      expect(onPressure).toHaveBeenCalledTimes(1);
    });

    it("absorbs a throwing pressure sink without breaking the sampler", () => {
      const sampler = createRetentionSampler({
        census: () => snapshotFixture({ heapUsedBytes: 9_500, heapLimitBytes: 10_000 }),
        onPressure: () => {
          throw new Error("mailbox unreachable");
        },
      });

      expect(() => sampler.evaluatePressure()).not.toThrow();
    });
  });

  /*
   * RUFU-257 code review, finding `retention-op-family-no-producer`:
   * Every case above injects an `ops` fixture, which is precisely why a census op lane with no
   * production producer stayed green while `fusion_retention_op_total` and its latency buckets
   * published zeros on a real dashboard. This case is the end-to-end proof of the wiring: real cache
   * traffic, the default (un-injected) census readers, and a non-zero family value. A regression that
   * unhooked the producer would leave both families at zero and fail here.
   */
  it("renders non-zero op families from the real census once a bounded cache sees traffic", () => {
    const cache = createBoundedTtlCache<string[]>({ id: "sampler_op_producer", keys: "ttl", ttlMs: 60_000, max: 4 });

    cache.set("task-1", ["a.ts"]);
    cache.get("task-1");
    cache.get("task-2");

    // No `census`/`ops` injected: this reads the process-wide census the /metrics route actually scrapes.
    const sampler = createRetentionSampler();

    const totals = family(sampler, "fusion_retention_op_total");
    expect(totals?.samples.find((s) => s.labelValues?.[0] === "sampler_op_producer")?.value).toBe(3);

    const buckets = family(sampler, "fusion_retention_op_latency_bucket");
    const atOrBelowOneMs = buckets?.samples.find((s) => s.labelValues?.[0] === "1");
    expect(atOrBelowOneMs?.value ?? 0).toBeGreaterThanOrEqual(3);
  });
});
