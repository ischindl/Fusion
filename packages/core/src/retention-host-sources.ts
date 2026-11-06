/*
FNXC:RetentionCensus 2026-11-06-09:08 (RUFU-871): a registration surface for retained structures that do not
live in the dashboard package.

Why this exists. `/metrics` carries a retention census (`fusion_retention_*`) that was added after seven OOM
crashes with no attribution, and it worked exactly as designed for the structures it could see — all of which
live in `packages/dashboard/src`. The dashboard then kept dying anyway with `fusion_retention_coverage_ratio`
measured at 7.5e-7: 2,756 tracked bytes against a 3.67 GiB residual, because the task-keyed collections that
actually accumulate live in `packages/engine/src/executor/` (about 30 task-keyed Maps/Sets on
`TaskExecutorState`), and the dependency direction is dashboard -> engine -> core, so engine code cannot
reach a registry that lives in the dashboard. A GC-forced heap snapshot named the content (133k strings
>= 4 KiB holding 34 % of the heap; the largest are agent lane transcripts at ~200 KiB each), but naming the
content is not naming the holder, and only a live entry count per collection can decide whether a finished
task ever released its session.

Why the registry is numbers-only and lives HERE. The obvious move — relocate the census itself into core — was
tried and backed out within the hour, because the census module imports `node:v8` for the heap reading, and the
browser bundle deliberately aliases `@fusion/core` to browser-safe leaves under a scanner
(`scripts/lib/dashboard-browser-safe-core-modules.json`) that keeps Node-only code out of the client. Moving a
`node:v8` importer into core means either aliasing a Node module into the client bundle or maintaining a new
subpath alias in `vite.config.ts`, `vitest.config.ts`, and the engine gate bundle. This file has no imports at
all, so it is browser-safe by construction and travels through the existing `@fusion/core` index import that
every package already resolves. The dashboard keeps the census, the heap math, the coverage ratio, and the
pressure signal; it pulls these entries in and folds them into the same snapshot, so one scrape explains one
process rather than two half-censuses.

Contract, restated because the scrape path depends on it: `read()` must be O(1), synchronous, and
non-throwing — `map.size` qualifies, walking held objects does not. Bytes are therefore the owner's own
estimate, and a source that reports the overhead floor while the heap grows is reporting the truth: the weight
is inside the values, which is precisely the answer this instrument was built to produce.
*/

/** Entry overhead this registry assumes when an owner supplies no per-entry weight. */
export const HOST_RETENTION_ENTRY_OVERHEAD_BYTES = 96;

/** What kind of structure reports itself. Mirrors the dashboard census vocabulary so one label set fits. */
export type HostRetentionSourceKind =
  | "cache"
  | "session"
  | "counter"
  | "rate-limit-window"
  | "token-store"
  | "output-buffer"
  | "registry";

/** One owner's registration. */
export interface HostRetentionSourceDescriptor {
  /** Stable snake_case id; becomes the `source` label value on `/metrics`. */
  id: string;
  kind: HostRetentionSourceKind;
  /** O(1), synchronous, non-throwing live entry count. */
  read: () => number;
  /** Owner's per-entry byte estimate; defaults to {@link HOST_RETENTION_ENTRY_OVERHEAD_BYTES}. */
  bytesPerEntry?: number;
}

/** A registered source as the census reads it. */
export interface HostRetentionSource {
  id: string;
  kind: HostRetentionSourceKind;
  /** Live entry count, or 0 when the owner's reader misbehaves. */
  entries(): number;
  /** `entries() * bytesPerEntry`, floored at 0, never NaN. */
  approxBytes(): number;
  /** True when the last `entries()` call threw or returned a non-finite number. */
  probeFailed(): boolean;
}

const registered = new Map<string, HostRetentionSource & { markFailed(v: boolean): void }>();
const failureFlags = new Map<string, boolean>();

/**
 * Register one host source. Returns false when the id is already taken — the id is a metric label, and two
 * owners publishing one id would make `fusion_retention_source_bytes{source=...}` meaningless, so the first
 * owner wins and the second is visible only by getting `false` back.
 */
export function registerHostRetentionSource(
  descriptor: HostRetentionSourceDescriptor,
): boolean {
  if (registered.has(descriptor.id)) return false;
  /*
  FNXC:RetentionCensus 2026-11-06-11:52 (RUFU-871):
  An explicit 0 is a claim, not a missing value, and it must survive. Cumulative throughput sources
  (`step_output_captured_chars_total` and friends) report their volume through `entries` and intend to contribute
  NO retained bytes, because the dashboard census sums `approxBytes()` into `fusion_retention_tracked_bytes`
  and derives `residualBytes = heap - tracked`. Under the previous `> 0` guard a declared 0 silently fell back to
  the 96 B overhead, so one sample of a 50 000-character counter added 4.8 MB of fictional retention to the same
  metric whose honesty is the reason this instrument exists — caught by `step-output-retention.test.ts`.
  Anything that is not a finite non-negative number (undefined, NaN, negative, infinite) is still treated as
  "owner gave me no weight" and gets the overhead floor.
  */
  const bytesPerEntry =
    Number.isFinite(descriptor.bytesPerEntry) && (descriptor.bytesPerEntry as number) >= 0
      ? (descriptor.bytesPerEntry as number)
      : HOST_RETENTION_ENTRY_OVERHEAD_BYTES;
  const source = {
    id: descriptor.id,
    kind: descriptor.kind,
    entries(): number {
      try {
        const n = descriptor.read();
        if (!Number.isFinite(n) || n < 0) {
          failureFlags.set(descriptor.id, true);
          return 0;
        }
        failureFlags.set(descriptor.id, false);
        return Math.floor(n);
      } catch {
        failureFlags.set(descriptor.id, true);
        return 0;
      }
    },
    approxBytes(): number {
      return this.entries() * bytesPerEntry;
    },
    probeFailed(): boolean {
      return failureFlags.get(descriptor.id) === true;
    },
    markFailed(v: boolean): void {
      failureFlags.set(descriptor.id, v);
    },
  };
  registered.set(descriptor.id, source);
  return true;
}

/** Every host source in registration order — the input the dashboard sampler folds into its census. */
export function listHostRetentionSources(): HostRetentionSource[] {
  return [...registered.values()];
}

/** How many hosts registered (a scrape-independent sanity number for tests). */
export function hostRetentionRegistrySize(): number {
  return registered.size;
}

/** Test seam: an isolated registry, so a unit test never reads another test's sources. */
export function resetHostRetentionRegistryForTests(): void {
  registered.clear();
  failureFlags.clear();
}
