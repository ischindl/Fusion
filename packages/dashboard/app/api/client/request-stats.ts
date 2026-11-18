/*
FNXC:RouteCostAccounting 2026-11-18-07:22 (RUFU-479) — the client's own count of what one boot asked for.

The server half of this pair (`src/metrics/route-cost.ts`) answers what a route COST. It cannot answer how
often a browser ASKED, which is the other half of the measured failure: 42 of 63 requests started inside
the same second, and `/api/settings/global` was fetched four times by one board load. Those are client
facts, and until now they only existed in a browser trace.

Both axes are bounded before anything is stored, because this lives in the tab that a memory leak would
hurt:
  * the key is a normalised URL PATTERN (`/api/tasks/42/diff` becomes `/api/tasks/:id/diff`), so the key
    space is the endpoint vocabulary and not every id ever opened;
  * the table caps at `REQUEST_STATS_MAX_PATTERNS` patterns, oldest-inserted evicted.

It is deliberately in-memory and per-boot, never persisted: a board tab's request history is a diagnostic
for the load that just happened, and the payload some of these endpoints carry (settings carries daemon
and git tokens) must not be retained anywhere beyond the response the caller already holds. Only counts
and byte totals are recorded, never URLs with query strings, bodies, or headers.
*/

/** Cardinality bound on distinct URL patterns held for one boot. */
export const REQUEST_STATS_MAX_PATTERNS = 128;

export interface RequestStatEntry {
  count: number;
  totalBytes: number;
  /** Whether the request failed at the HTTP level, counted separately so a 404 is not read as a success. */
  failures: number;
}

const stats = new Map<string, RequestStatEntry>();

/**
 * Normalise a request path into its pattern: drop the query string, then replace variable-shaped path
 * segments (numeric ids, task ids like `RUFU-479`, uuid-ish and long opaque segments) with `:id`.
 */
export function requestPattern(path: string): string {
  const withoutQuery = path.split("?")[0] ?? path;
  return withoutQuery
    .split("/")
    .map((segment) => {
      if (segment === "") return segment;
      if (/^\d+$/.test(segment)) return ":id";
      if (/^[A-Za-z]+-\d+$/.test(segment)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ":id";
      // Fusion's own opaque ids are prefixed rather than bare hex (`proj_9326d74a133b421a`,
      // `agent-8f3c21`), so they need their own shape rule - without it a board that opens a hundred
      // projects or agents mints a hundred keys and the bound this table exists for is gone.
      if (/^[a-z][a-z0-9]{1,7}_[0-9a-f]{8,}$/i.test(segment)) return ":id";
      if (/^agent-[0-9a-z]+$/i.test(segment)) return ":id";
      if (segment.length >= 24 && /^[0-9a-z_-]+$/i.test(segment)) return ":id";
      return segment;
    })
    .join("/");
}

/** Record one completed request. Called from the client's single fetch seam. */
export function observeRequestStat(path: string, options?: { bytes?: number; failed?: boolean }): void {
  const pattern = requestPattern(path);
  let entry = stats.get(pattern);
  if (!entry) {
    if (stats.size >= REQUEST_STATS_MAX_PATTERNS) {
      const oldest = stats.keys().next();
      if (!oldest.done) stats.delete(oldest.value);
    }
    entry = { count: 0, totalBytes: 0, failures: 0 };
    stats.set(pattern, entry);
  }
  entry.count += 1;
  entry.totalBytes += Number.isFinite(options?.bytes) ? (options?.bytes ?? 0) : 0;
  if (options?.failed) entry.failures += 1;
}

/** The whole table, keyed by pattern. An unrequested pattern is absent, not zero-filled. */
export function requestStatSnapshot(): Record<string, RequestStatEntry> {
  return Object.fromEntries(stats);
}

/**
 * How many times one pattern was requested this boot.
 *
 * Returns a number, never `undefined`, so a caller never has to decide whether an absent key means zero
 * requests or an unbuilt counter.
 */
export function requestStatCount(path: string): number {
  return stats.get(requestPattern(path))?.count ?? 0;
}

/** Test seam: clear the table so a suite can count its own requests. */
export function resetRequestStats(): void {
  stats.clear();
}
