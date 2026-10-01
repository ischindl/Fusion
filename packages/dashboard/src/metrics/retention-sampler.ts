/**
 * RUFU-257 retention sampler: publishes the in-process retention census on `/metrics`.
 *
 * This is the read side of the instrument created in `lib/retention-census.ts`. Before this
 * sampler existed, `/metrics` carried system + board gauges and NO in-process cache accounting,
 * which is why a 1.5-2 GB/h heap climb produced seven OOM crashes without ever naming the
 * structure responsible. Every registered cache now reports itself here.
 *
 * Series emitted (all `gauge` unless noted):
 *   - `fusion_retention_source_entries{source}` / `..._bytes{source}` /
 *     `..._expired_entries{source}` / `..._ceiling{source}` (`-1` = no declared ceiling)
 *   - `fusion_retention_tracked_bytes`, `fusion_retention_heap_used_bytes`,
 *     `fusion_retention_heap_limit_bytes`, `fusion_retention_residual_bytes`,
 *     `fusion_retention_coverage_ratio`, `fusion_retention_probe_failures`,
 *     `fusion_retention_swept_entries`
 *   - `fusion_retention_op_total{source}` (`counter`) and
 *     `fusion_retention_op_latency_bucket{le}` — the bucket family is a GAUGE set with an `le`
 *     label because `prometheus-text.ts` supports only `gauge | counter`; this is the exact
 *     idiom `runtime-sampler.ts` uses for `fusion_system_request_latency_bucket`.
 *
 * Contract mirrors `domain-sampler.ts`: the census is read on a pre-read tick, `buildSnapshot`
 * performs zero awaited I/O, and the tick timer is `unref()`'d so the instrument never holds
 * the process open. Because a census probe is O(1) by contract, a scrape that arrives before
 * the first tick renders a real on-demand sample rather than a field of zeros — a census that
 * reads as "all caches are empty" during a scrape would be actively misleading.
 *
 * Census numbers never enter the run-audit (FN-7158/FN-9175 reserve audit metadata for
 * ids/counts/outcomes); byte attribution lives here and in the operator pressure signal.
 */

import type { MetricFamily } from "./prometheus-text.js";
import {
  buildCumulativeBuckets,
  type RetentionCensusSnapshot,
  type RetentionOpsSnapshot,
  retentionCensusSnapshot,
  retentionCensus,
} from "../lib/retention-census.js";

/** Why a pressure warning fired. Fixed enum — it labels a log line, never carries prose. */
export type RetentionPressureReason = "heap-ratio" | "source-at-ceiling";

/** The pressure signal payload handed to the injected `onPressure` sink. */
export interface RetentionPressureSignal {
  reason: RetentionPressureReason;
  /** Registered source holding the most bytes at the moment the signal fired. */
  topSourceId: string | null;
  topSourceBytes: number;
  /** How many consecutive samples that source has sat at its ceiling (0 for `heap-ratio`). */
  atCeilingStreak: number;
  trackedBytes: number;
  heapUsedBytes: number;
  heapLimitBytes: number;
  coverageRatio: number;
  observedAtMs: number;
}

/** Constructor options; every host seam is injectable so tests never boot a server. */
export interface RetentionSamplerInit {
  /** Census snapshot source (defaults to the shared census). */
  census?: () => RetentionCensusSnapshot;
  /** Op counter/ring source (defaults to the shared census). */
  ops?: () => RetentionOpsSnapshot;
  /** Tick cadence in ms (default {@link RETENTION_TICK_MS}). */
  tickMs?: number;
  /** A fake-timer-friendly `setInterval`/`clearInterval` surface. */
  timers?: {
    setInterval: (fn: () => void, ms: number) => { unref?: () => void };
    clearInterval: (t: { unref?: () => void }) => void;
  };
  /** Bucket edges (ms) for the op-latency bucket family. */
  latencyBuckets?: readonly number[];
  /** Heap-used share of the limit that counts as pressure (default 0.75). */
  heapPressureRatio?: number;
  /** Consecutive at-ceiling samples before the ceiling reason fires (default 3). */
  ceilingStreakThreshold?: number;
  /** Minimum spacing between warnings so a stall cannot spam the mailbox (default 10 min). */
  pressureCooldownMs?: number;
  /** Sink for the pressure signal (omitted = signal tracking only, nothing emitted). */
  onPressure?: (signal: RetentionPressureSignal) => void;
}

/** The pre-read snapshot the render path reflects. */
export interface RetentionSamplerState {
  /** Last census snapshot, or `null` before the first sample. */
  snapshot: RetentionCensusSnapshot | null;
  /** Last op snapshot, or `null` before the first sample. */
  ops: RetentionOpsSnapshot | null;
  /** Consecutive samples in which each source sat at its ceiling, keyed by source id. */
  atCeilingStreaks: Record<string, number>;
}

/** The retention sampler's public handle. */
export interface RetentionSampler {
  readonly state: RetentionSamplerState;
  readonly started: boolean;
  /** Read the census + ops into the pre-read snapshot now (synchronous). */
  sample(): RetentionCensusSnapshot;
  /** Start the unref'd tick timer (idempotent). */
  start(): void;
  /** Clear the tick timer. */
  stopTimers(): void;
  /** Assemble the retention metric families for a scrape (synchronous). */
  buildSnapshot(nowMs?: number): MetricFamily[];
  /** Force the pressure signal path for the current sample (used by tests and the tick). */
  evaluatePressure(snapshot?: RetentionCensusSnapshot): RetentionPressureSignal | null;
}

/** Census tick cadence. Matches the runtime/domain 5s cadence rather than adding a new one. */
export const RETENTION_TICK_MS = 5_000;
/** Default heap-used / heap-limit share that counts as memory pressure. */
export const DEFAULT_HEAP_PRESSURE_RATIO = 0.75;
/** Default consecutive at-ceiling samples required before the ceiling reason fires. */
export const DEFAULT_CEILING_STREAK_THRESHOLD = 3;
/** Default minimum spacing between pressure warnings (10 minutes). */
export const DEFAULT_PRESSURE_COOLDOWN_MS = 600_000;
/** Op-latency bucket edges in ms; same order of magnitude as the request-latency buckets. */
export const DEFAULT_RETENTION_OP_BUCKETS_MS: readonly number[] = [1, 5, 10, 25, 50, 100, 250, 500, 1000];

/** Default timers from the global scope (fake-timer injectable). */
function defaultTimers(): NonNullable<RetentionSamplerInit["timers"]> {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms) as unknown as { unref?: () => void },
    clearInterval: (t) => clearInterval(t as unknown as ReturnType<typeof setInterval>),
  };
}

/** Create a retention sampler. No side effects until {@link RetentionSampler.start}. */
export function createRetentionSampler(init: RetentionSamplerInit = {}): RetentionSampler {
  const readCensus = init.census ?? retentionCensusSnapshot;
  const readOps = init.ops ?? (() => retentionCensus().opsSnapshot());
  const timers = init.timers ?? defaultTimers();
  const tickMs = init.tickMs ?? RETENTION_TICK_MS;
  const buckets = init.latencyBuckets ?? DEFAULT_RETENTION_OP_BUCKETS_MS;
  const heapPressureRatio = init.heapPressureRatio ?? DEFAULT_HEAP_PRESSURE_RATIO;
  const ceilingStreakThreshold = init.ceilingStreakThreshold ?? DEFAULT_CEILING_STREAK_THRESHOLD;
  const pressureCooldownMs = init.pressureCooldownMs ?? DEFAULT_PRESSURE_COOLDOWN_MS;

  const state: RetentionSamplerState = {
    snapshot: null,
    ops: null,
    atCeilingStreaks: {},
  };
  const timersMap = new Map<string, { unref?: () => void }>();
  let started = false;
  let lastPressureAtMs = -Infinity;

  function clearTimer(key: string): void {
    const timer = timersMap.get(key);
    if (timer) {
      try {
        timers.clearInterval(timer);
      } catch {
        /* ignore */
      }
      timersMap.delete(key);
    }
  }

  function sample(): RetentionCensusSnapshot {
    // A hostile census degrades to an empty-but-well-formed snapshot rather than losing the
    // whole `/metrics` body: the scrape must always render the families it always rendered.
    let snapshot: RetentionCensusSnapshot;
    try {
      snapshot = readCensus();
    } catch {
      snapshot = emptySnapshot(Date.now());
    }
    state.snapshot = snapshot;
    try {
      state.ops = readOps();
    } catch {
      state.ops = { ops: [], recentLatencyMs: [] };
    }
    for (const source of snapshot.sources) {
      state.atCeilingStreaks[source.id] = source.atCeiling ? (state.atCeilingStreaks[source.id] ?? 0) + 1 : 0;
    }
    return snapshot;
  }

  function emptySnapshot(nowMs: number): RetentionCensusSnapshot {
    return {
      generatedAtMs: nowMs,
      sources: [],
      trackedBytes: 0,
      heapUsedBytes: 0,
      heapLimitBytes: 0,
      coverageRatio: 0,
      residualBytes: 0,
      probeFailureCount: 0,
      sweptSources: 0,
      sweptEntries: 0,
    };
  }

  /** Pick the source holding the most bytes; ties break on registration order (stable series). */
  function topSource(snapshot: RetentionCensusSnapshot): { id: string | null; bytes: number } {
    let id: string | null = null;
    let bytes = -1;
    for (const source of snapshot.sources) {
      if (source.approxBytes > bytes) {
        bytes = source.approxBytes;
        id = source.id;
      }
    }
    return { id, bytes: Math.max(0, bytes) };
  }

  function evaluatePressure(explicit?: RetentionCensusSnapshot): RetentionPressureSignal | null {
    // Without an explicit snapshot this means "evaluate the CURRENT state", so it must re-read the
    // census: reusing the pre-read state would freeze the at-ceiling streaks, and a streak is only
    // meaningful if each evaluation advances it. The tick path passes its own snapshot, so a scrape
    // never triggers an extra census read.
    const snapshot = explicit ?? sample();
    if (!snapshot.sources.length && snapshot.heapUsedBytes <= 0) return null;

    let reason: RetentionPressureReason | null = null;
    let streak = 0;
    const heapRatio =
      snapshot.heapLimitBytes > 0 ? snapshot.heapUsedBytes / snapshot.heapLimitBytes : 0;
    if (snapshot.heapLimitBytes > 0 && heapRatio >= heapPressureRatio) {
      reason = "heap-ratio";
    }
    for (const source of snapshot.sources) {
      const sourceStreak = state.atCeilingStreaks[source.id] ?? 0;
      if (source.atCeiling && sourceStreak >= ceilingStreakThreshold && sourceStreak > streak) {
        reason = "source-at-ceiling";
        streak = sourceStreak;
      }
    }
    if (!reason) return null;

    // One warning per cooldown per reason-class: a stalled pile-up must not become a firehose.
    const nowMs = snapshot.generatedAtMs || Date.now();
    if (nowMs - lastPressureAtMs < pressureCooldownMs) return null;
    lastPressureAtMs = nowMs;

    const top = topSource(snapshot);
    const signal: RetentionPressureSignal = {
      reason,
      topSourceId: top.id,
      topSourceBytes: top.bytes,
      atCeilingStreak: reason === "source-at-ceiling" ? streak : 0,
      trackedBytes: snapshot.trackedBytes,
      heapUsedBytes: snapshot.heapUsedBytes,
      heapLimitBytes: snapshot.heapLimitBytes,
      coverageRatio: snapshot.coverageRatio,
      observedAtMs: nowMs,
    };
    try {
      init.onPressure?.(signal);
    } catch {
      /* a failing notification sink must not break the census tick */
    }
    return signal;
  }

  function start(): void {
    if (started) return;
    started = true;
    // Prime the pre-read state so the first scrape has real numbers before the first tick.
    sample();
    const timer = timers.setInterval(() => {
      const snapshot = sample();
      evaluatePressure(snapshot);
    }, tickMs);
    try {
      timer?.unref?.();
    } catch {
      /* hosts without unref still get the tick */
    }
    timersMap.set("retention", timer);
  }

  function stopTimers(): void {
    started = false;
    clearTimer("retention");
  }

  function buildSnapshot(nowMs?: number): MetricFamily[] {
    const now = nowMs ?? Date.now();
    // Pre-read state is authoritative once a tick has run; before that, sample synchronously so
    // an early scrape never reports a field of zeros as if the caches were empty.
    const snapshot = state.snapshot ?? sample();
    const ops = state.ops ?? { ops: [], recentLatencyMs: [] };
    const families: MetricFamily[] = [];

    const entriesSamples = snapshot.sources.map((source) => ({
      labelValues: [source.id],
      value: source.entries,
    }));
    const bytesSamples = snapshot.sources.map((source) => ({
      labelValues: [source.id],
      value: source.approxBytes,
    }));
    const expiredSamples = snapshot.sources.map((source) => ({
      labelValues: [source.id],
      value: source.expiredEntries,
    }));
    const ceilingSamples = snapshot.sources.map((source) => ({
      labelValues: [source.id],
      value: source.ceiling ?? -1,
    }));

    families.push({
      name: "fusion_retention_source_entries",
      help: "Live entries held by each registered in-process cache/buffer (0 is reported, never omitted)",
      type: "gauge",
      labels: ["source"],
      samples: entriesSamples,
    });
    families.push({
      name: "fusion_retention_source_bytes",
      help: "Approximate bytes attributed to each registered in-process cache/buffer",
      type: "gauge",
      labels: ["source"],
      samples: bytesSamples,
    });
    families.push({
      name: "fusion_retention_source_expired_entries",
      help: "Entries still held past their expiry by each registered source (0 after a reclaim sweep)",
      type: "gauge",
      labels: ["source"],
      samples: expiredSamples,
    });
    families.push({
      name: "fusion_retention_source_ceiling",
      help: "Named count ceiling enforced by each registered source (-1 = no declared ceiling)",
      type: "gauge",
      labels: ["source"],
      samples: ceilingSamples,
    });

    families.push({
      name: "fusion_retention_tracked_bytes",
      help: "Total bytes the retention census can attribute to registered sources",
      type: "gauge",
      samples: [{ value: snapshot.trackedBytes }],
    });
    families.push({
      name: "fusion_retention_heap_used_bytes",
      help: "process.memoryUsage().heapUsed for this census sample",
      type: "gauge",
      samples: [{ value: snapshot.heapUsedBytes }],
    });
    families.push({
      name: "fusion_retention_heap_limit_bytes",
      help: "V8 old-space heap limit for this process (0 when the host does not report it)",
      type: "gauge",
      samples: [{ value: snapshot.heapLimitBytes }],
    });
    families.push({
      name: "fusion_retention_residual_bytes",
      help: "heapUsed minus tracked bytes — the portion of the heap the census does not explain",
      type: "gauge",
      samples: [{ value: snapshot.residualBytes }],
    });
    families.push({
      name: "fusion_retention_coverage_ratio",
      help: "tracked bytes / heap used, clamped to [0,1]; near-zero means the census cannot explain the heap",
      type: "gauge",
      samples: [{ value: snapshot.coverageRatio }],
    });
    families.push({
      name: "fusion_retention_probe_failures",
      help: "Sources whose probe failed this sample (a silent-zero guard; healthy value is 0)",
      type: "gauge",
      samples: [{ value: snapshot.probeFailureCount }],
    });
    families.push({
      name: "fusion_retention_swept_entries",
      help: "Entries deleted by the most recent census reclaim sweep",
      type: "gauge",
      samples: [{ value: snapshot.sweptEntries }],
    });

    families.push({
      name: "fusion_retention_op_total",
      help: "Cache/buffer operations counted per registered source (cumulative)",
      type: "counter",
      labels: ["source"],
      samples: ops.ops.map((row) => ({ labelValues: [row.sourceId], value: row.count })),
    });
    const bucketCounts = buildCumulativeBuckets(ops.recentLatencyMs, buckets);
    families.push({
      name: "fusion_retention_op_latency_bucket",
      help: "Cumulative count of retention-lane operations at or below the bucket edge (ms)",
      type: "gauge",
      labels: ["le"],
      samples: Object.entries(bucketCounts).map(([edge, count]) => ({
        labelValues: [edge],
        value: count,
      })),
    });
    // `now` is accepted for orchestrator parity (all samplers render from pre-read state); the
    // retention values are point-in-time gauges and carry no sample-time-derived field.
    void now;
    return families;
  }

  return {
    state,
    get started() {
      return started;
    },
    sample,
    start,
    stopTimers,
    buildSnapshot,
    evaluatePressure,
  };
}
