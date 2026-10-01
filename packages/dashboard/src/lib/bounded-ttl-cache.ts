import {
  MAP_ENTRY_OVERHEAD_BYTES,
  approxStringBytes,
  recordRetentionOp,
  registerRetentionSource,
  type RetentionKeyClass,
  type RetentionSourceKind,
} from "./retention-census.js";

/*
FNXC:RetentionCensus 2026-09-21-10:49 (RUFU-257):
This is the shape every in-process TTL cache in the dashboard must take, and the reason it exists is
the 2026-09-17 crash loop: caches keyed by task, session, or client IP grew one entry per unit of
traffic and expired entries were never deleted — a TTL that only bypasses a value on read still
retains it forever if nothing ever reads it again. The two defects are separate and this type closes
both at once: a count ceiling with oldest-entry eviction, AND delete-on-expire on the read path.

The design constraint that makes it a ratchet rather than a helper: the census row is registered
HERE, so constructing one of these caches also creates its `/metrics` retention series. A cache built
through this seam cannot exist unattributed, which is the failure mode the crash loop needed. Callers
that only need a ceiling (and already have their own census row) are fine; new caches should not
hand-roll the idiom again.

Insertion order — not access recency — is what eviction discards, matching the `taskDiffStatsCache`
precedent this mirrors. That is deliberate: a least-recently-used variant would need a second
structure per entry to be correct, and the point here is a bound on retention, not a hit-rate
optimisation.
*/

/** One retained entry. The wrapper exists so callers deal in values, not TTL plumbing. */
interface BoundedTtlEntry<V> {
  value: V;
  expiresAt: number;
}

export interface BoundedTtlCacheOptions<V> {
  /** Census source id rendered in `fusion_retention_source_*{source="..."}`; must be unique process-wide. */
  id: string;
  /** Census classification. A TTL cache with a count ceiling is still a `cache`, not a `buffer`. */
  kind?: RetentionSourceKind;
  /** How the key space is produced. `ttl`/`load` caches grow with traffic and are the leak class. */
  keys: RetentionKeyClass;
  /** Entry lifetime. Reads at or past it delete the entry instead of serving or ignoring it. */
  ttlMs: number;
  /** Hard ceiling on retained entries; the oldest insertion is evicted to hold it. */
  max: number;
  /** Constant name rendered in the census inventory so the CI checker can resolve the ceiling. */
  ceilingConstant?: string;
  /** Estimated heap bytes of one value beyond its key + map overhead. Defaults to key + entry overhead only. */
  valueBytes?: (value: V) => number;
  /** Injectable clock (tests). Production leaves this unset. */
  now?: () => number;
  /** Skip census registration (tests only — a production cache must never be unattributed). */
  registerCensus?: false;
  /**
   * Opt out of the census op lane (tests only). Left unset in production, where a cache that is
   * counted in `fusion_retention_source_*` must also be counted in `fusion_retention_op_total`.
   */
  recordOps?: false;
  /** Injectable monotonic duration clock (tests). Defaults to sub-millisecond `performance.now()`. */
  opClock?: () => number;
}

export interface BoundedTtlCache<V> {
  /** Returns the live value, or `undefined` for a miss. An expired entry is DELETED, not skipped. */
  get(key: string): V | undefined;
  /** Retains `value` for `ttlMs`, evicting the oldest insertion when the ceiling is reached. */
  set(key: string, value: V): void;
  /** Current retained entry count (including entries that are past TTL but unread). */
  size(): number;
  /** Live entry count, reclaiming expired entries as it scans. Used by the census probe. */
  liveSize(): number;
  /** Retained entries for a bounded shallow byte sum; iteration order is insertion order. */
  entries(): IterableIterator<[string, BoundedTtlEntry<V>]>;
  readonly ttlMs: number;
  readonly max: number;
  /** Drop everything (and optionally install a fake clock). Test seam. */
  resetForTests(now?: () => number): void;
}

/*
FNXC:RetentionCensus 2026-09-23-22:43 (RUFU-257 code review, finding `retention-op-family-no-producer`):
`fusion_retention_op_total` and `fusion_retention_op_latency_bucket` are rendered from the census op
lane, which is fed only by `recordRetentionOp`. Nothing called it, so both families published zeros
forever and an operator reading the runbook could not tell "this cache is cheap" from "nobody is
measuring this cache" — the one distinction the instrument exists to make. The producer belongs on the
seam rather than at individual call sites for the same reason the census row belongs here: a cache
built through `createBoundedTtlCache` then cannot exist with byte accounting but no traffic signal.

The op id is the cache's census id, so the op lane and the source gauges join on the same label, and
`MAX_RETENTION_OP_SOURCES` already bounds the row count by the registry's own ceiling. Latency uses
`performance.now()` because a Map read is sub-millisecond and `Date.now()` would floor every sample to
`0`; durations stay O(1) and never allocate, so measuring stays cheaper than the git work it is there
to explain away.
*/
/** Sub-millisecond monotonic duration source; falls back to wall clock if the host lacks it. */
function defaultOpClock(): () => number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return () => performance.now();
  }
  return Date.now;
}

const moduleOpClock = defaultOpClock();

/**
 * Start a retention op duration for a census-registered cache that is NOT built through this seam, so
 * it still feeds `fusion_retention_op_total`. Pair with {@link finishRetentionOp}. The seam measures
 * its own ops; these exist because a hand-rolled map registered with `registerRetentionSource` has no
 * seam to instrument, and an op row that never appears is indistinguishable from an op row of zero.
 */
export function startRetentionOp(): number {
  return moduleOpClock();
}

/** Close a duration started by {@link startRetentionOp} into the census op lane under `sourceId`. */
export function finishRetentionOp(sourceId: string, startedAt: number): void {
  recordRetentionOp(sourceId, moduleOpClock() - startedAt);
}

/** Rough cost of an array/object wrapper around string payloads. */
export const ARRAY_SLOT_OVERHEAD_BYTES = 16;

/** Shallow byte estimate for a list of paths/strings — the common diff-lane value shape. */
export function approxStringListBytes(values: readonly string[]): number {
  let bytes = MAP_ENTRY_OVERHEAD_BYTES;
  for (const value of values) bytes += ARRAY_SLOT_OVERHEAD_BYTES + approxStringBytes(value);
  return bytes;
}

/**
 * Creates a count-bounded TTL cache that is also a retention-census source.
 *
 * The census probe walks at most `max` entries and sums declared estimates only, so the scrape path
 * stays O(ceiling) with no deep object walk.
 */
export function createBoundedTtlCache<V>(options: BoundedTtlCacheOptions<V>): BoundedTtlCache<V> {
  const { id, kind = "cache", keys, ttlMs, max, ceilingConstant, valueBytes } = options;
  if (!Number.isFinite(max) || max < 1) {
    throw new Error(`bounded ttl cache "${id}" needs a positive max (got ${String(max)})`);
  }
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error(`bounded ttl cache "${id}" needs a non-negative ttlMs (got ${String(ttlMs)})`);
  }

  const store = new Map<string, BoundedTtlEntry<V>>();
  let now = options.now ?? (() => Date.now());

  if (options.registerCensus !== false) {
    registerRetentionSource({
      id,
      kind,
      keys,
      ceiling: max,
      ceilingConstant,
      // The cache owns its own sweep: unlike a cache swept by an external maintainer, nothing else
      // knows about this map. Without this hook an entry that is never read again is never reclaimed.
      sweep: () => {
        const nowMs = now();
        let reclaimed = 0;
        for (const [key, entry] of store) {
          if (entry.expiresAt <= nowMs) {
            store.delete(key);
            reclaimed++;
          }
        }
        // Eviction is not a sweep, but reporting how far over the ceiling a caller would be keeps
        // the operator-visible number honest when `max` shrinks at a restart boundary.
        while (store.size > max) {
          const oldest = store.keys().next();
          if (oldest.done === true) break;
          store.delete(oldest.value);
          reclaimed++;
        }
        return reclaimed;
      },
      probe: () => {
        const nowMs = now();
        let approxBytes = 0;
        let expiredEntries = 0;
        for (const [key, entry] of store) {
          approxBytes += MAP_ENTRY_OVERHEAD_BYTES + approxStringBytes(key);
          if (valueBytes) approxBytes += valueBytes(entry.value);
          if (entry.expiresAt <= nowMs) expiredEntries++;
        }
        return { entries: store.size, approxBytes, expiredEntries };
      },
    });
  }

  const recordOps = options.recordOps !== false;
  const opClock = options.opClock ?? moduleOpClock;

  return {
    get(key: string): V | undefined {
      const startedAt = recordOps ? opClock() : 0;
      const hit = store.get(key);
      // A miss, an expired entry, and a hit are all one measured operation: the operator's question
      // is how expensive this lane's traffic is, which includes the reads that return nothing.
      let value: V | undefined;
      if (hit) {
        if (hit.expiresAt <= now()) {
          // Delete-on-expire: a TTL that only bypasses on read retains the value forever when the key
          // stops being read, which is exactly how the per-task diff caches reached gigabytes.
          store.delete(key);
        } else {
          value = hit.value;
        }
      }
      if (recordOps) recordRetentionOp(id, opClock() - startedAt);
      return value;
    },

    set(key: string, value: V): void {
      const startedAt = recordOps ? opClock() : 0;
      if (store.size >= max && !store.has(key)) {
        const oldestKey = store.keys().next();
        if (oldestKey.done === false) store.delete(oldestKey.value);
      }
      store.set(key, { value, expiresAt: now() + ttlMs });
      if (recordOps) recordRetentionOp(id, opClock() - startedAt);
    },

    size: () => store.size,
    entries: () => store.entries(),
    ttlMs,
    max,

    liveSize(): number {
      const nowMs = now();
      let live = 0;
      for (const [key, entry] of store) {
        if (entry.expiresAt <= nowMs) store.delete(key);
        else live++;
      }
      return live;
    },

    resetForTests(nowMs?: () => number): void {
      store.clear();
      if (nowMs) now = nowMs;
    },
  };
}
