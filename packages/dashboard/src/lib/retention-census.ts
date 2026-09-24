/**
 * RUFU-257 retention census: the dashboard's in-process memory attribution registry.
 *
 * On 2026-09-17 the dashboard OOM-crashed seven times under load while its heap climbed
 * 1.5-2 GB/h, and nothing in the process could name WHICH structure was growing: `/metrics`
 * reported system and board gauges but zero in-process cache accounting. This module is the
 * instrument that closes that gap. A cache registers itself once (at module scope, beside its
 * declaration) with a cheap probe, and the census can then answer, per source: how many
 * entries, roughly how many bytes, and how many entries are past their expiry.
 *
 * Contract, and the reasons it is written this way:
 *   - {@link retentionCensusSnapshot} is pure and SYNCHRONOUS, and reports EVERY registered
 *     id even at `0` entries. A missing series must never be readable as "empty", because an
 *     operator deciding "this cache is not the problem" from an absent line would be wrong
 *     about a cache that was simply never registered.
 *   - A probe must be O(1)-ish: a counted length, or a shallow sum over at most `ceiling`
 *     entries. The snapshot runs on the scrape path, so deep-walking a live structure is a
 *     bug in the probe, not a slow path.
 *   - A hostile (throwing / returning garbage) probe is isolated per source: it contributes
 *     `0` and is flagged `probeFailed`, and the census never throws. Telemetry must not be
 *     able to take down the surface that serves it (mirrors the FN-9175 bounded-audit rule).
 *   - Census numbers never go into the run-audit. Run-audit metadata is ids/counts/outcomes
 *     only (FN-7158/FN-9175); byte-level heap attribution belongs on `/metrics` and in the
 *     operator pressure signal.
 *
 * `coverageRatio` = tracked bytes / heap used. It is deliberately honest rather than flattering:
 * it is clamped to `[0, 1]` (byte attribution is an estimate, and an estimate above 100% of the
 * heap means the estimate is wrong, not that the heap is negative), and `residualBytes`
 * (`heapUsed - tracked`) is reported next to it so the runbook can state how much the census
 * does NOT explain.
 */

import v8 from "node:v8";

/*
FNXC:RetentionCensus 2026-09-21-21:55 (RUFU-257):
`session` and `counter` joined the enum while bounding the interactive-session surfaces. An
interview/planning/onboarding session is not a `cache`: nothing is recomputable-from-a-source-of-truth
about it, its value carries multi-KB conversation text, and eviction loses user work — so the operator
ranking it on `/metrics` must be able to tell "a big cache" from "a live user session". `counter` is
the numeric-aggregate registry (per-project in-flight tallies): its values are numbers, so its byte
floor is the entry overhead and its bound is a concurrency alarm rather than a memory ceiling.
*/
/** What kind of retained structure a source is. Fixed enum: it labels a metric, never prose. */
export type RetentionSourceKind =
  | "cache"
  | "session"
  | "counter"
  | "rate-limit-window"
  | "token-store"
  | "output-buffer"
  | "registry";

/**
 * Why the source can grow. `ttl` = grows with distinct keys that expire; `load` = grows with
 * the workload's key space (task ids, sessions); `fixed` = the key set is static by
 * construction (enum/feature tables). This is the same taxonomy the recurrence ratchet
 * (`scripts/check-retention-coverage.mjs`) classifies the checked-in inventory with.
 */
export type RetentionKeyClass = "ttl" | "load" | "fixed";

/** One probe reading: the numbers a source reports about itself. */
export interface RetentionProbeReading {
  /** Live entry count (entries the cache would still serve, not counting expired ones). */
  entries: number;
  /** Estimated retained bytes; see {@link approxStringBytes} for the documented weight. */
  approxBytes: number;
  /** Entries present in the backing collection but already past their expiry. */
  expiredEntries: number;
}

/** A source's registration. `probe` must be cheap, synchronous, and non-throwing by convention. */
export interface RetentionSourceDescriptor {
  /** Stable snake_case id; becomes the `source` label value on `/metrics`. */
  id: string;
  kind: RetentionSourceKind;
  keys: RetentionKeyClass;
  /**
   * The named count ceiling the owner enforces, when it has one. `undefined` means "no
   * ceiling", which the ratchet only permits for a `fixed` key class.
   */
  ceiling?: number;
  /** Name of the constant that holds {@link ceiling}, so docs can point at one source of truth. */
  ceilingConstant?: string;
  /** Cheap self-report. Called on the scrape path. */
  probe: () => RetentionProbeReading;
  /**
   * Optional reclaim hook: delete expired entries, return how many were deleted. The census
   * tick calls it, so a bounded cache needs no timer of its own. A structure that is already
   * swept by an existing owner (e.g. `planning.ts`'s `cleanupExpiredSessions`) deliberately
   * omits this hook so there stays exactly ONE owner per swept structure.
   */
  sweep?: () => number;
}

/** A source's contribution to one snapshot. */
export interface RetentionSourceSnapshot {
  id: string;
  kind: RetentionSourceKind;
  keys: RetentionKeyClass;
  ceiling: number | null;
  ceilingConstant: string | null;
  entries: number;
  approxBytes: number;
  expiredEntries: number;
  /** True when `entries` has reached a declared ceiling (the pressure-signal input). */
  atCeiling: boolean;
  /** True when the probe threw or returned a non-finite reading for this sample. */
  probeFailed: boolean;
}

/** A full census snapshot: per-source rows plus the totals the coverage ratio is derived from. */
export interface RetentionCensusSnapshot {
  generatedAtMs: number;
  /** Every registered id, in registration order, including zero-entry sources. */
  sources: RetentionSourceSnapshot[];
  /** Sum of every source's `approxBytes`. */
  trackedBytes: number;
  /** `process.memoryUsage().heapUsed` for this sample. */
  heapUsedBytes: number;
  /** The V8 old-space limit; `0` when the host hides it. */
  heapLimitBytes: number;
  /** `trackedBytes / heapUsedBytes`, clamped to `[0, 1]`; `0` when the heap reading is unusable. */
  coverageRatio: number;
  /** `heapUsedBytes - trackedBytes`, floored at `0` — the honest unexplained residual. */
  residualBytes: number;
  /** How many sources failed their probe this sample (a silent-zero guard for the operator). */
  probeFailureCount: number;
  /** How many sources the tick reclaimed expired entries from this sample. */
  sweptSources: number;
  /** Total entries deleted by this sample's sweeps. */
  sweptEntries: number;
}

/** Per-source operation counters fed by {@link recordRetentionOp}. */
export interface RetentionOpSnapshot {
  sourceId: string;
  count: number;
  totalMs: number;
}

/** The op-lane view: monotonic counters plus the recent latency ring for bucketing. */
export interface RetentionOpsSnapshot {
  ops: RetentionOpSnapshot[];
  /** Recent operation durations (ms), newest last, capped at {@link RETENTION_OP_LATENCY_RING_CAP}. */
  recentLatencyMs: number[];
}

/** Constructor seams. Everything host-dependent is injectable so tests never need real time. */
export interface RetentionCensusInit {
  /** Heap reader (defaults to `process.memoryUsage`). */
  memory?: () => { heapUsed?: number; rss?: number };
  /** V8 heap limit reader (defaults to `v8.getHeapStatistics().heap_size_limit`). */
  heapLimit?: () => number;
  /** Clock (defaults to `Date.now`), used only to stamp `generatedAtMs`. */
  now?: () => number;
}

/*
FNXC:RetentionCensus 2026-09-21-10:49:
The census is a registry of statically-declared sources, so its own collections need named
ceilings too — the recurrence ratchet classifies a declaration as `bounded` only when a constant
names its ceiling, and the census must satisfy its own rule. `MAX_REGISTERED_SOURCES` bounds the
registry (the inventory this task ships registers ~20, so the ceiling is headroom, not a tuning
knob); `RETENTION_OP_LATENCY_RING_CAP` bounds the latency ring the bucket family is built from.
*/
/** Ceiling on distinct registered sources; a duplicate or 65th registration is refused. */
export const MAX_REGISTERED_SOURCES = 64;
/** Ceiling on distinct operation ids counted by {@link recordRetentionOp}. */
export const MAX_RETENTION_OP_SOURCES = 64;
/** Ring length for recent op latencies (mirrors `REQUEST_LATENCY_RING_CAP`'s role). */
export const RETENTION_OP_LATENCY_RING_CAP = 256;

/**
 * Documented per-entry weight for a hash-collection slot.
 *
 * V8 stores a `Map` entry as a key slot + value slot + insertion-order link, plus the key
 * string object itself. 96 bytes is a deliberately round, deliberately conservative estimate:
 * the census's job is to rank which source dominates the heap, not to report an exact size, and
 * a per-entry constant is O(1) to apply where a shallow sum is impossible.
 */
export const MAP_ENTRY_OVERHEAD_BYTES = 96;

/** Bytes attributed per string character (UTF-16 units; conservative for V8's Latin1 strings). */
export const STRING_BYTES_PER_CHAR = 2;

/** Attribute bytes to a string key/value using the documented weight. O(1) in `text.length`. */
export function approxStringBytes(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.max(0, text.length) * STRING_BYTES_PER_CHAR;
}

/*
FNXC:RetentionCensus 2026-09-21-21:55 (RUFU-257):
Named per-value weights for the record shapes the bounded caches hold. A probe that counted only
`map.size` could not rank a 40 KB cached diff against a 200 B rate-limit row, which is the comparison
the OOM diagnosis needs; a probe that walked each value deep would make every census sample more
expensive than the load it is measuring. So each shape gets one documented flat weight, added to
`MAP_ENTRY_OVERHEAD_BYTES` plus any string length the probe can read in O(1). Estimates, ranked by
shape — not allocations, and deliberately not derived from a measured object header.
*/

/** Rate-limit row: `{ count, firstRequestAt }` plus its Date object. */
export const RATE_LIMIT_ENTRY_BYTES = 64;

/** Session-shaped record before its variable text (interview, planning, onboarding, terminal). */
export const SESSION_RECORD_BYTES = 512;

/** One Q&A turn retained by an interview or planning session's history array. */
export const HISTORY_ENTRY_BYTES = 256;

/** Native speech-recognizer handle attributed to an open voice session row. */
export const RECOGNIZER_HANDLE_BYTES = 1_024;

/** Small aggregate record held by a project-keyed metrics cache (method counts, coverage summary). */
export const AGGREGATE_RECORD_BYTES = 128;

/** Coerce a probe number to a finite non-negative integer; garbage becomes `0`. */
function sanitizeCount(value: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric);
}

/**
 * Build cumulative "at or below `edge`" bucket counts from observed latencies.
 *
 * The Prometheus exposition in this repo supports `gauge | counter` only
 * (`metrics/prometheus-text.ts` has no histogram type), so op latency is exposed the way
 * `runtime-sampler.ts` already exposes request latency: a `*_latency_bucket` family of GAUGES
 * carrying an `le` label. Kept here as a pure helper so the sampler stays a rendering layer.
 */
export function buildCumulativeBuckets(
  values: readonly number[],
  edges: readonly number[],
): Record<string, number> {
  const out: Record<string, number> = {};
  const sorted = [...edges].sort((a, b) => a - b);
  for (const edge of sorted) {
    let count = 0;
    for (const v of values) if (v <= edge) count++;
    out[String(edge)] = count;
  }
  return out;
}

/** One census registry. The module-level singleton below is what production registers into. */
export interface RetentionCensus {
  /** Register a source. Returns `false` (and records why) for a duplicate/overflow/invalid id. */
  register(descriptor: RetentionSourceDescriptor): boolean;
  /** Registered ids in registration order. */
  sourceIds(): string[];
  /** A registered source's descriptor, for owner-side assertions. */
  descriptor(id: string): RetentionSourceDescriptor | undefined;
  /** Synchronous snapshot including every registered id, even at zero entries. */
  snapshot(): RetentionCensusSnapshot;
  /** Run every opted-in sweep hook once; returns total entries deleted. */
  sweepAll(): number;
  /** Count one operation against a source and record its latency into the bounded ring. */
  recordOp(sourceId: string, durationMs: number): void;
  /** The op counters + latency ring for the sampler to render. */
  opsSnapshot(): RetentionOpsSnapshot;
  /** Registration refusals (duplicate id / registry overflow), for tests and diagnostics. */
  registrationRejections(): string[];
  /** Test-only: drop all registrations, counters, and rings. */
  resetForTests(): void;
}

/** Create an isolated census (the default export is the shared singleton this produces). */
export function createRetentionCensus(init: RetentionCensusInit = {}): RetentionCensus {
  const sources = new Map<string, RetentionSourceDescriptor>();
  const rejections: string[] = [];
  const ops = new Map<string, RetentionOpSnapshot>();
  const latencyRing: number[] = [];

  const memory = init.memory ?? ((): { heapUsed?: number } => process.memoryUsage());
  const heapLimit = init.heapLimit ?? ((): number => 0);
  const now = init.now ?? ((): number => Date.now());

  function register(descriptor: RetentionSourceDescriptor): boolean {
    const id = typeof descriptor?.id === "string" ? descriptor.id.trim() : "";
    if (!id) {
      rejections.push("<missing id>");
      return false;
    }
    if (sources.has(id)) {
      rejections.push(id);
      return false;
    }
    if (sources.size >= MAX_REGISTERED_SOURCES) {
      rejections.push(`${id} (registry full at ${MAX_REGISTERED_SOURCES})`);
      return false;
    }
    if (typeof descriptor.probe !== "function") {
      rejections.push(`${id} (no probe)`);
      return false;
    }
    sources.set(id, { ...descriptor, id, ceiling: descriptor.ceiling });
    return true;
  }

  function snapshot(): RetentionCensusSnapshot {
    const rows: RetentionSourceSnapshot[] = [];
    let trackedBytes = 0;
    let probeFailureCount = 0;
    let sweptSources = 0;
    let sweptEntries = 0;

    // Sweep first, so the entry/byte numbers the operator reads describe the post-reclaim state.
    for (const source of sources.values()) {
      if (typeof source.sweep === "function") {
        try {
          const removed = sanitizeCount(source.sweep());
          if (removed > 0) {
            sweptSources++;
            sweptEntries += removed;
          }
        } catch {
          // A throwing sweep must not cost the source its metric lines; the probe still reports.
        }
      }
    }

    for (const source of sources.values()) {
      let reading: RetentionProbeReading = { entries: 0, approxBytes: 0, expiredEntries: 0 };
      let probeFailed = false;
      try {
        const raw = source.probe();
        if (!raw || typeof raw !== "object") throw new Error("probe returned no reading");
        reading = {
          entries: sanitizeCount(raw.entries),
          approxBytes: sanitizeCount(raw.approxBytes),
          expiredEntries: sanitizeCount(raw.expiredEntries),
        };
      } catch {
        probeFailed = true;
        probeFailureCount++;
      }
      const ceiling = Number.isFinite(source.ceiling as number) ? (source.ceiling as number) : null;
      rows.push({
        id: source.id,
        kind: source.kind,
        keys: source.keys,
        ceiling,
        ceilingConstant: source.ceilingConstant ?? null,
        entries: reading.entries,
        approxBytes: reading.approxBytes,
        expiredEntries: reading.expiredEntries,
        atCeiling: ceiling !== null && reading.entries >= ceiling,
        probeFailed,
      });
      trackedBytes += reading.approxBytes;
    }

    let heapUsedBytes = 0;
    try {
      heapUsedBytes = sanitizeCount(Number(memory()?.heapUsed) || 0);
    } catch {
      heapUsedBytes = 0;
    }
    let heapLimitBytes = 0;
    try {
      heapLimitBytes = sanitizeCount(Number(heapLimit()) || 0);
    } catch {
      heapLimitBytes = 0;
    }

    // An estimate can exceed the heap it is measured against; clamping to 1 says "the census
    // accounts for the whole heap" rather than fabricating a ratio the operator cannot read.
    const rawRatio = heapUsedBytes > 0 ? trackedBytes / heapUsedBytes : 0;
    const coverageRatio = Math.min(1, Math.max(0, rawRatio));

    return {
      generatedAtMs: now(),
      sources: rows,
      trackedBytes,
      heapUsedBytes,
      heapLimitBytes,
      coverageRatio,
      residualBytes: Math.max(0, heapUsedBytes - trackedBytes),
      probeFailureCount,
      sweptSources,
      sweptEntries,
    };
  }

  function sweepAll(): number {
    let removed = 0;
    for (const source of sources.values()) {
      if (typeof source.sweep !== "function") continue;
      try {
        removed += sanitizeCount(source.sweep());
      } catch {
        /* absorbed — see snapshot() */
      }
    }
    return removed;
  }

  function recordOp(sourceId: string, durationMs: number): void {
    const id = typeof sourceId === "string" ? sourceId.trim() : "";
    if (!id) return;
    let row = ops.get(id);
    if (!row) {
      // The op map is keyed by source ids, which the registry already bounds; an unknown id
      // collapses into one shared bucket instead of growing a map keyed by caller strings. The
      // reserve-one rule keeps the collapse bucket itself inside the ceiling: the map can never
      // exceed MAX_RETENTION_OP_SOURCES rows, collapse row included.
      if (ops.size >= MAX_RETENTION_OP_SOURCES - 1) {
        row = ops.get("unknown");
        if (!row) {
          row = { sourceId: "unknown", count: 0, totalMs: 0 };
          ops.set("unknown", row);
        }
      } else {
        row = { sourceId: id, count: 0, totalMs: 0 };
        ops.set(id, row);
      }
    }
    row.count++;
    row.totalMs += Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
    latencyRing.push(Math.max(0, Number.isFinite(durationMs) ? durationMs : 0));
    if (latencyRing.length > RETENTION_OP_LATENCY_RING_CAP) {
      latencyRing.splice(0, latencyRing.length - RETENTION_OP_LATENCY_RING_CAP);
    }
  }

  function opsSnapshot(): RetentionOpsSnapshot {
    return {
      ops: [...ops.values()].map((row) => ({ ...row })),
      recentLatencyMs: [...latencyRing],
    };
  }

  function resetForTests(): void {
    sources.clear();
    ops.clear();
    latencyRing.length = 0;
    rejections.length = 0;
  }

  return {
    register,
    sourceIds: () => [...sources.keys()],
    descriptor: (id: string) => sources.get(id),
    snapshot,
    sweepAll,
    recordOp,
    opsSnapshot,
    registrationRejections: () => [...rejections],
    resetForTests,
  };
}

/**
 * The process-wide census every dashboard module registers into.
 *
 * Registration is a module-scope side effect by design: a cache and its census row must not be
 * separable, otherwise the inventory and the metrics can drift apart silently. `heapLimit` is
 * read lazily from `node:v8` at first snapshot rather than at import so a test that constructs
 * its own census never touches V8.
 */
/** V8 old-space limit reader; degrades to `0` when the host cannot answer, never throws. */
function readV8HeapLimit(): number {
  try {
    return sanitizeCount(v8.getHeapStatistics().heap_size_limit);
  } catch {
    return 0;
  }
}

const sharedCensus = createRetentionCensus({ heapLimit: readV8HeapLimit });

/** Register a retention source with the process-wide census (idempotent per id, bounded). */
export function registerRetentionSource(descriptor: RetentionSourceDescriptor): boolean {
  return sharedCensus.register(descriptor);
}

/** The process-wide census handle. */
export function retentionCensus(): RetentionCensus {
  return sharedCensus;
}

/** Ids currently registered, in registration order. */
export function listRetentionSourceIds(): string[] {
  return sharedCensus.sourceIds();
}

/** Synchronous census snapshot for `/metrics` and the pressure signal. */
export function retentionCensusSnapshot(): RetentionCensusSnapshot {
  return sharedCensus.snapshot();
}

/** Count a cache operation (and its latency) for the op counters / latency bucket family. */
export function recordRetentionOp(sourceId: string, durationMs: number): void {
  sharedCensus.recordOp(sourceId, durationMs);
}

/** Test-only: clear the shared registry so a test can assert registration wiring. */
export function resetRetentionCensusForTests(): void {
  sharedCensus.resetForTests();
}
