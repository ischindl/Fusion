/*
FNXC:DashboardCliProbeMemo 2026-11-08-00:55:
`GET /api/auth/status` measured 9,39 s and 10,92 s on production :4040 for a 9 219 B body, and a CPU
profile taken during a real 155-second event-loop stall (33 289 samples over 25 s) put ~24 % of samples
inside `node:child_process` spawn machinery (`spawn` 7 922, `execFile` 6 070, `exec` 5 278) plus ~10 %
in `onStreamRead`/`Readable.push` reading those children's stdout. The problem is shape, not per-probe
speed: every CLI presence probe forks a binary per request, one `/auth/status` call awaits eight of
them, and the UI fires ~25 endpoints on first load.

This is the `packages/core/src/cli/gh-cli.ts` TTL cache (GH_CHECK_TTL_MS = 60_000 + reset helper)
ported to the async probes, with the two additions the async shape needs: single-flight, so N concurrent
callers share ONE spawn instead of N, and a separate shorter TTL for failures, because "not installed
yet" must become "installed" without a process restart — gh-cli's reasoning ("callers still notice if
the user runs `gh auth login` mid-session") applied to installation instead of auth.

Invalidation stays explicit (`invalidate()`): a settings save or an operator pressing Test/Refresh must
observe the new state immediately, mirroring `resetGhAvailabilityCache`'s role. Callers arriving after
the flight-staleness bound start their own probe rather than inheriting a hang, so one wedged child
process cannot pin the endpoint forever.
*/

/** Freshness window for a probe that reported the CLI present. Mirrors GH_CHECK_TTL_MS. */
export const CLI_PROBE_SUCCESS_TTL_MS = 60_000;

/**
 * Freshness window for a probe that reported the CLI missing / timed out / errored.
 *
 * Deliberately far shorter than the success TTL: a successful probe is the expensive one
 * (a real binary run) and its answer barely changes, while a missing CLI is exactly the
 * state an operator fixes mid-session by installing the binary. Keeping failures cached at
 * all is what stops a "not installed" machine from forking per request.
 */
export const CLI_PROBE_FAILURE_TTL_MS = 5_000;

export interface CliProbeCacheOptions {
  /** Identifies the answer a cached value applies to (e.g. a configured binary path). */
  isFailure: (result: unknown) => boolean;
  successTtlMs?: number;
  failureTtlMs?: number;
  /**
   * How long an unsettled in-flight probe may be shared with later callers. Past this bound a
   * new caller spawns its own probe instead of awaiting a promise that may never settle.
   */
  flightStaleMs?: number;
  /** Injectable clock; tests advance it to exercise TTL expiry without waiting. */
  now?: () => number;
}

interface CacheEntry {
  value: unknown;
  /**
   * Set when the probe REJECTED. A cached rejection must reject the callers it is handed to —
   * returning `undefined` here would turn a probe error into a phantom "no error" answer.
   */
  error?: unknown;
  /** When the value was produced. */
  at: number;
  failed: boolean;
}

interface FlightEntry {
  id: number;
  startedAt: number;
  promise: Promise<unknown>;
}

/** A memoized probe: call it like the original, plus `invalidate`. */
export interface MemoizedCliProbe<T> {
  /** `key` scopes the cache; omit it when the probe has no per-call variable input. */
  (key?: string): Promise<T>;
  /** Drop one key (or every key) so the next call probes again. */
  invalidate(key?: string): void;
}

/**
 * Wrap a spawn-per-call probe so N requests share ONE child process per key per TTL.
 *
 * The wrapper never decides what the probe reports — `produce` owns that entirely. It only
 * decides whether to ask again.
 */
export function createCliProbeCache<T>(
  produce: (key: string) => Promise<T>,
  options: CliProbeCacheOptions,
): MemoizedCliProbe<T> {
  const successTtlMs = options.successTtlMs ?? CLI_PROBE_SUCCESS_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? CLI_PROBE_FAILURE_TTL_MS;
  const flightStaleMs = options.flightStaleMs ?? failureTtlMs;
  // Read `Date.now` lazily so a test's fake-timer patch is observed (a captured
  // reference would keep the pre-patch implementation).
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, CacheEntry>();
  const flights = new Map<string, FlightEntry>();
  let flightSeq = 0;

  const fresh = (entry: CacheEntry): boolean =>
    now() - entry.at < (entry.failed ? failureTtlMs : successTtlMs);

  const settledResult = (entry: CacheEntry): Promise<T> =>
    entry.error === undefined
      ? Promise.resolve(entry.value as T)
      : Promise.reject(entry.error as never);

  const run = (key: string): Promise<T> => {
    const cached = entries.get(key);
    if (cached && fresh(cached)) return settledResult(cached);

    const existing = flights.get(key);
    if (existing && now() - existing.startedAt < flightStaleMs) {
      return existing.promise as Promise<T>;
    }

    const flight: FlightEntry = { id: ++flightSeq, startedAt: now(), promise: undefined as unknown as Promise<unknown> };
    flights.set(key, flight);
    flight.promise = (async () => {
      let result: T;
      try {
        result = await produce(key);
      } catch (err) {
        // A throwing probe is still an answer: record it as a short-TTL failure so a burst of
        // callers shares one attempt, and let the original rejection reach this caller.
        entries.set(key, { value: undefined, error: err, at: now(), failed: true });
        if (flights.get(key)?.id === flight.id) flights.delete(key);
        throw err;
      }
      entries.set(key, { value: result, at: now(), failed: options.isFailure(result) });
      // Only the current flight clears the slot; an abandoned (stale) one must not evict the
      // flight that replaced it.
      if (flights.get(key)?.id === flight.id) flights.delete(key);
      return result;
    })();
    return flight.promise as Promise<T>;
  };

  const memoized = ((key?: string) => run(key ?? "")) as MemoizedCliProbe<T>;
  memoized.invalidate = (key?: string) => {
    if (key === undefined) {
      entries.clear();
      flights.clear();
      return;
    }
    entries.delete(key);
    flights.delete(key);
  };
  return memoized;
}

/** Cache key for the probe façades: the configured binary path, or the on-PATH default. */
export const ON_PATH_PROBE_KEY = "on-path";

export function cliProbeKey(binaryPath?: string): string {
  return binaryPath && binaryPath.length > 0 ? binaryPath : ON_PATH_PROBE_KEY;
}

/** Inverse of `cliProbeKey`, for a producer that has to rebuild its probe arguments. */
export function binaryPathFromProbeKey(key: string): string | undefined {
  return key === ON_PATH_PROBE_KEY ? undefined : key;
}
