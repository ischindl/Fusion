import {
  MAP_ENTRY_OVERHEAD_BYTES,
  approxStringBytes,
  registerRetentionSource,
  type RetentionKeyClass,
  type RetentionSourceKind,
} from "../retention-census.js";

/*
FNXC:RetentionCensus 2026-09-21-21:40 (RUFU-257):
The dashboard's other unbounded module-scope collections — the IP-keyed rate-limit windows, the
per-project-root metrics cache, and the issued-token table — are the same defect in different
clothing: the entry is retained until some *other* code path happens to notice it has expired, and
nothing caps how many entries exist while nobody notices. A rate-limit map that deletes expired
IPs only inside its own `cleanupExpired*` sweep still grows one entry per distinct address between
sweeps, and a map with no sweep at all never deletes anything.

This module is the shared seam for bounding those collections WITHOUT rewriting their admission
logic. A module keeps its own window/limit semantics — same limit, same window, same reset time
reported to clients — and this helper adds exactly two things: a named count ceiling, and expiry
reclamation that deletes. Both are reported to the retention census, so bounding a map and making
it visible on `/metrics` are one action, not two that can drift.

Three rules keep this from becoming a second owner of somebody else's data structure:
1. A map that already has a reclaimer (`cleanupExpiredSessions` and friends) registers with
   `sweptElsewhere: true`, so the census gets accounting only and the existing sweep stays the
   single owner of deletion.
2. Count eviction discards the OLDEST INSERTION, never a chosen victim, and is only reached past
   a ceiling orders of magnitude above real usage. Where dropping a live entry would be a user- or
   security-visible event (an issued token), the caller must pass `evictLiveEntries: false` so the
   ceiling becomes a reportable pressure threshold instead of a deletion.
3. The expiry comparison is the OWNER's, not the helper's — see {@link BoundedWindowMapSpec.isExpired}.
   A bound that reclaims an entry its owner still serves is a behavioral change dressed as a fix.
*/

/** Clock seam so a probe's expiry decision is deterministic under fake timers. */
type Clock = () => number;

/** Byte attribution for one retained value beyond its key + hash-map overhead. */
type ValueBytes<V> = (value: V) => number;

export interface BoundedWindowMapSpec<K, V> {
  /** Census source id; becomes the `source` label on `fusion_retention_source_*`. */
  id: string;
  /** The live module-scope map. The census holds it by reference; it never copies it. */
  map: Map<K, V>;
  /** Named count ceiling. Report it via `ceilingConstant` too so the ratchet can resolve it. */
  ceiling: number;
  /** Name of the constant holding `ceiling`, rendered on the census row. */
  ceilingConstant: string;
  /** Absolute expiry (epoch ms) for one value. A non-finite value means "never expires". */
  expiryOf: (value: V) => number;
  /**
   * Ownership rule for what "expired" means, applied to both the sweep and the probe.
   *
   * Defaults to {@link expiryStrictlyBefore} because that is the comparison every owner in this
   * package already uses (`now - firstRequestAt > WINDOW`, `now - updatedAt > TTL`,
   * `nowMs > effectiveExpiryMs`): the entry is still live AT its expiry instant. The sweep must
   * never be more eager than the code that serves the data — deleting a row its owner would still
   * honour would turn a rate-limit window or an issued token into a silent reset/sign-out.
   * An owner whose read path is `expiresAt > now` (expired at the instant) passes
   * {@link expiryAtOrBefore} to reclaim exactly as eagerly as it bypasses.
   */
  isExpired?: (expiresAt: number, nowMs: number) => boolean;
  kind?: RetentionSourceKind;
  keys?: RetentionKeyClass;
  /** Pass `true` when the owning module already reclaims this map on its own schedule. */
  sweptElsewhere?: boolean;
  /** Pass `false` when every entry is live user/security state — the ceiling then only reports. */
  evictLiveEntries?: boolean;
  /** Injectable clock for the expiry decision (defaults to `Date.now`). */
  now?: Clock;
  /** Extra byte attribution beyond key + map overhead. */
  valueBytes?: ValueBytes<V>;
  /** Census registration guard for tests that must not touch the shared registry. */
  registerCensus?: false;
}

export interface BoundedRegistryMapSpec<K, V> {
  id: string;
  map: Map<K, V>;
  ceiling: number;
  ceilingConstant: string;
  kind?: RetentionSourceKind;
  keys?: RetentionKeyClass;
  evictLiveEntries?: boolean;
  valueBytes?: ValueBytes<V>;
  registerCensus?: false;
}

/** Expiry rule for an owner that bypasses at `expiresAt > now`: dead at the expiry instant. */
export function expiryAtOrBefore(expiresAt: number, nowMs: number): boolean {
  return expiresAt <= nowMs;
}

/**
 * Default expiry rule, for an owner that treats the expiry instant as still live
 * (`now - firstRequestAt > WINDOW`). Strict, so a sweep can never retire a row its owner honors.
 */
export function expiryStrictlyBefore(expiresAt: number, nowMs: number): boolean {
  return expiresAt < nowMs;
}

export function reclaimExpiredEntries<K, V>(
  map: Map<K, V>,
  expiryOf: (value: V) => number,
  nowMs: number,
  isExpired: (expiresAt: number, nowMs: number) => boolean = expiryStrictlyBefore,
): number {
  let reclaimed = 0;
  for (const [key, value] of map) {
    const expiresAt = expiryOf(value);
    if (Number.isFinite(expiresAt) && isExpired(expiresAt, nowMs)) {
      map.delete(key);
      reclaimed++;
    }
  }
  return reclaimed;
}

/**
 * Drop oldest insertions until `map.size` fits `ceiling`. Returns how many were evicted.
 *
 * Insertion order is the eviction order, matching the `taskDiffStatsCache` precedent. Callers that
 * must never lose a live entry pass the result through `evicted` reporting instead of calling this.
 */
export function enforceEntryCeiling<K, V>(map: Map<K, V>, ceiling: number): number {
  return clampEntryCeiling(map, ceiling, undefined);
}

/**
 * Ceiling clamp for maps whose rows own dependent state (stream buffers, abort handles, native
 * handles). Every victim goes through `onRemove` — the owning module's own deletion path — so a
 * count bound can never trade a map leak for a worse one.
 */
export function clampEntryCeilingWithCleanup<K, V>(
  map: Map<K, V>,
  ceiling: number,
  onRemove: (key: K, value: V) => void,
): number {
  return clampEntryCeiling(map, ceiling, onRemove);
}

function clampEntryCeiling<K, V>(
  map: Map<K, V>,
  ceiling: number,
  onRemove: ((key: K, value: V) => void) | undefined,
): number {
  if (!Number.isFinite(ceiling) || ceiling < 1) return 0;
  let evicted = 0;
  while (map.size > ceiling) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    const value = map.get(oldest.value);
    // Notify the owner while the row is still present — owner cleanup functions commonly early-return
    // for a missing row, and deleting first would skip the dependent teardown this exists to trigger.
    // The delete afterwards is idempotent for an owner that removes the row itself.
    if (onRemove && value !== undefined) onRemove(oldest.value, value);
    map.delete(oldest.value);
    evicted++;
  }
  return evicted;
}

/** Shallow byte estimate for one map entry: documented slot overhead + key + attributed value. */
function entryBytes<K, V>(key: K, value: V, valueBytes?: ValueBytes<V>): number {
  const keyBytes = typeof key === "string" ? approxStringBytes(key) : MAP_ENTRY_OVERHEAD_BYTES / 2;
  return MAP_ENTRY_OVERHEAD_BYTES + keyBytes + (valueBytes ? Math.max(0, valueBytes(value)) : 0);
}

function countExpired<K, V>(
  map: Map<K, V>,
  expiryOf: (value: V) => number,
  nowMs: number,
  isExpired: (expiresAt: number, nowMs: number) => boolean,
): number {
  let expired = 0;
  for (const value of map.values()) {
    const expiresAt = expiryOf(value);
    if (Number.isFinite(expiresAt) && isExpired(expiresAt, nowMs)) expired++;
  }
  return expired;
}

/**
 * Register a module-scope map that holds expiry-bearing entries (rate-limit windows, TTL caches,
 * issued tokens, TTL sessions) with the retention census, with count + expiry bounds.
 *
 * When this helper owns reclamation (`sweptElsewhere` not set), the census's own tick performs the
 * delete-on-expire and the ceiling clamp, so the map needs no timer of its own — that is the point:
 * these maps previously needed somebody to remember to sweep them, and nobody had.
 */
export function registerBoundedWindowMap<K, V>(spec: BoundedWindowMapSpec<K, V>): void {
  const now = spec.now ?? ((): number => Date.now());
  const evictLive = spec.evictLiveEntries !== false;
  const isExpired = spec.isExpired ?? expiryStrictlyBefore;
  const { map, ceiling, expiryOf } = spec;

  if (spec.registerCensus === false) return;

  registerRetentionSource({
    id: spec.id,
    kind: spec.kind ?? "rate-limit-window",
    keys: spec.keys ?? "ttl",
    ceiling,
    ceilingConstant: spec.ceilingConstant,
    sweep: spec.sweptElsewhere
      ? undefined
      : () => {
          const nowMs = now();
          const reclaimed = reclaimExpiredEntries(map, expiryOf, nowMs, isExpired);
          return evictLive ? reclaimed + enforceEntryCeiling(map, ceiling) : reclaimed;
        },
    probe: () => {
      const nowMs = now();
      let approxBytes = 0;
      for (const [key, value] of map) approxBytes += entryBytes(key, value, spec.valueBytes);
      return {
        entries: map.size,
        approxBytes,
        expiredEntries: countExpired(map, expiryOf, nowMs, isExpired),
      };
    },
  });
}

/**
 * Register an expiry-free in-flight/counter map (concurrency slots, reservations, per-session
 * queues). Entries are removed by their own completion path, so this registers accounting plus an
 * optional ceiling clamp and nothing else.
 */
export function registerBoundedRegistryMap<K, V>(spec: BoundedRegistryMapSpec<K, V>): void {
  if (spec.registerCensus === false) return;
  const evictLive = spec.evictLiveEntries !== false;
  const { map, ceiling } = spec;

  registerRetentionSource({
    id: spec.id,
    kind: spec.kind ?? "registry",
    keys: spec.keys ?? "load",
    ceiling,
    ceilingConstant: spec.ceilingConstant,
    sweep: evictLive ? () => enforceEntryCeiling(map, ceiling) : undefined,
    probe: () => {
      let approxBytes = 0;
      for (const [key, value] of map) approxBytes += entryBytes(key, value, spec.valueBytes);
      return { entries: map.size, approxBytes, expiredEntries: 0 };
    },
  });
}
