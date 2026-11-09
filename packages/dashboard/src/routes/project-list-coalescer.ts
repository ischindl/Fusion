import { createHash } from "node:crypto";
import { TOKEN_QUERY_PARAM } from "../auth-middleware.js";
import { REMOTE_SESSION_COOKIE, readCookie } from "../remote-session.js";

/*
FNXC:ProjectListCoalescing 2026-11-09-10:18 (RUFU-905):
`GET /api/projects/across-nodes` is the project-list read the dashboard polls. Measured on the
operator's host on 2026-11-09: EIGHT dashboard tabs open for eight different projects, ONE dashboard
process on one event loop (`createServer`, single pid on :4040 — verified with `ss -ltnp` plus
`/proc/<pid>/cwd`). Each tab polls the route every 5 s independently, so the board's own event loop
took ~1.6 cross-project fan-outs per second, and the operator's report was "the first tab is
responsive, the rest lag". Sequential per-project reads over 25 projects measured 1.95, 2.43, 4.07,
4.79, 9.34, 24.7, 35.6, 57.3 and 59.5 s, with three more hitting a 60 s client cap — while a card
verification held ~170 % CPU and 2 GB on the same machine.

The fix is server-side single-flight plus a bounded staleness window, chosen over a client-side
leader-tab / BroadcastChannel election: one browser fix leaves every other browser, CLI and remote
node still multiplying, and adds tab-election lifecycle cases. Coalescing at the route fixes all
clients at once and collapses N tabs' identical poll to ONE fan-out per TTL window.

THE STALENESS BOUND IS THE POLL INTERVAL. `PROJECTS_POLL_INTERVAL_MS` mirrors the client's
`POLL_INTERVAL_MS` in `packages/dashboard/app/hooks/useProjects.ts:33` (the value `:108`/`:206` poll
on). A cached answer may never be older than one client poll, because a tab that polls on that period
must be able to observe a project registration within the period it already believes is fresh — that
is the whole reason the bound is a TTL rather than an invalidation policy. The clamp below is
therefore unconditional: no env value and no test seam can widen the window past one poll.
*/

/** One client poll of the project list; also the hard ceiling on cached staleness. */
export const PROJECTS_POLL_INTERVAL_MS = 5_000;

/** Environment knob name, so rollback needs no redeploy. `0` disables coalescing entirely. */
export const ACROSS_NODES_TTL_ENV_VAR = "FUSION_PROJECTS_ACROSS_NODES_TTL_MS";

/** Two polls of slack: short enough that a registration is visible on the next-or-next-next poll. */
const DEFAULT_ACROSS_NODES_TTL_MS = 2_000;

/** Entries retained per process. Keys are (principal, scoping params), so this is tabs-sized. */
const MAX_ACROSS_NODES_ENTRIES = 64;

/**
 * TTL resolution for the cross-project fan-out. Unset/blank/garbage/negative → the default; `0` is a
 * real answer and means "recompute on every request" (the no-redeploy rollback); anything above one
 * client poll is clamped to one poll rather than refused, so an operator typo cannot silently turn
 * the staleness bound into a permanently stale board.
 */
export function resolveAcrossNodesTtlMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_ACROSS_NODES_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_ACROSS_NODES_TTL_MS;
  return Math.min(Math.floor(parsed), PROJECTS_POLL_INTERVAL_MS);
}

let currentAcrossNodesTtlMs = resolveAcrossNodesTtlMs(
  typeof process !== "undefined" ? process.env[ACROSS_NODES_TTL_ENV_VAR] : undefined,
);

/** Test seam for the TTL; production never calls this. `0` restores per-request recompute. */
export function setAcrossNodesTtlMsForTests(ms: number): void {
  currentAcrossNodesTtlMs = Number.isFinite(ms) && ms >= 0 ? resolveAcrossNodesTtlMs(String(ms)) : 0;
}

/** The TTL currently in force for newly created coalescers (0 = disabled). */
export function acrossNodesTtlMs(): number {
  return currentAcrossNodesTtlMs;
}

/*
FNXC:ProjectListCoalescing 2026-11-09-10:18 (RUFU-905):
The freshness clock is a seam for the same reason the TTL is: expiry must be proven by moving time,
never by sleeping (this repo forbids real time waits in tests, and a 2 s sleep would only ever prove
that the machine was slow). Production keeps `Date.now`; a test installs its own counter and drives
it past the bound. It is a module-level seam rather than a constructor argument because the route
constructs its coalescer at registration time, before any test could hold a reference to it.
*/
let currentClock: () => number = Date.now;

/** Test seam for the freshness clock; production keeps the real `Date.now`. */
export function setAcrossNodesClockForTests(now: () => number): void {
  currentClock = now;
}

/** The clock every newly created coalescer reads. */
export function acrossNodesNow(): number {
  return currentClock();
}

interface CoalescerEntry {
  promise: Promise<unknown>;
  /** Freshness base: start time while in flight, completion time once settled. */
  at: number;
  settled: boolean;
}

export interface ProjectListCoalescer {
  /**
   * Return the value `work` produces for `key`: join a live computation, serve a still-fresh one, or
   * run `work`. With TTL `0` this is a plain pass-through — no join, no entry, every caller works.
   */
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
}

/**
 * Single-flight + TTL over an async read whose cost is a fan-out.
 *
 * FNXC:ProjectListCoalescing 2026-11-09-10:18 (RUFU-905):
 * Three rules carry the correctness, and the first is borrowed from `TaskLaneCache`
 * (`packages/core/src/task-lane-cache.ts`): **a miss is UNKNOWN, never EMPTY.** An expired entry is
 * deleted before the decision is made, so an expired key always re-runs the work — the cache can only
 * ever serve a value it actually computed, never an empty stand-in for one. Second: an entry is
 * retained only on SUCCESS; a rejected computation is removed, because caching one failure would keep
 * answering every later caller with an error the store has since recovered from. Third: the freshness
 * base is the COMPLETION time, not the start time — this fan-out measured up to 59 s, and bounding
 * staleness from the start would serve data that was already stale the moment it arrived.
 *
 * A rejection IS shared with the callers that joined the in-flight computation (they are waiting on
 * that exact computation); it is only never *cached*. And the TTL bounds how long a SETTLED answer may
 * be served, never how long a caller may join a computation that is still running: starting a second
 * copy of a read the loop is already choking on is the opposite of why this seam exists.
 */
export function createProjectListCoalescer(options: {
  ttlMs: number;
  maxSize?: number;
  /** Injectable clock, so expiry is tested by moving time, never by sleeping. Defaults to the module seam. */
  now?: () => number;
} = { ttlMs: DEFAULT_ACROSS_NODES_TTL_MS }): ProjectListCoalescer {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? Math.floor(options.ttlMs) : 0;
  const maxSize = options.maxSize ?? MAX_ACROSS_NODES_ENTRIES;
  const now = options.now ?? acrossNodesNow;
  const entries = new Map<string, CoalescerEntry>();

  return {
    async run<T>(key: string, work: () => Promise<T>): Promise<T> {
      // Disabled: byte-for-byte the pre-coalescing behavior — every request does its own work.
      if (ttlMs <= 0) return await work();

      const live = entries.get(key);
      if (live) {
        // Still running: join it, however long it has been running (see the note above).
        if (!live.settled) return (await live.promise) as T;
        if (now() - live.at < ttlMs) {
          // Refresh insertion order without touching the recorded time, as TaskLaneCache does.
          entries.delete(key);
          entries.set(key, live);
          return (await live.promise) as T;
        }
        // Expired: a genuine miss, so the work runs again. A miss is never answered with the stale
        // value, and never with an empty stand-in for one.
        entries.delete(key);
      }

      const entry: CoalescerEntry = { promise: work(), at: now(), settled: false };
      entries.set(key, entry);
      try {
        const value = (await entry.promise) as T;
        entry.settled = true;
        entry.at = now();
        if (entries.get(key) !== entry) return value;
        while (entries.size > maxSize) {
          const oldest = entries.keys().next();
          if (oldest.done) break;
          entries.delete(oldest.value);
        }
        return value;
      } catch (error) {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      }
    },
  };
}

/** Minimal request shape the key needs, so a bare harness request satisfies it. */
export type KeyableRequest = {
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
};

function queryValue(url: string | undefined, name: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, "http://_placeholder_").searchParams.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Truncated digest: identifies a credential in a cache key without ever holding the credential. */
function credentialDigest(secret: string, kind: "token" | "session"): string {
  return `${kind}:${createHash("sha256").update(secret).digest("hex").slice(0, 16)}`;
}

/**
 * Identity of the credential this request authenticated with.
 *
 * FNXC:ProjectListCoalescing 2026-11-09-10:18 (RUFU-905):
 * Project visibility is per-principal and RLS-enforced, so one computed project list may NEVER be
 * handed to a different principal — it would leak which projects exist to a principal that cannot see
 * them. The identity therefore keys on the credential the request actually carried, in the same
 * precedence the auth middleware uses (`auth-middleware.ts`): bearer header, then the `fn_token`
 * query fallback, then the remote-login session cookie, then anonymous. The header and query forms of
 * one token deliberately collide on one identity — they ARE one principal.
 *
 * Only a truncated SHA-256 enters the key. The dashboard's daemon token legitimately appears in
 * `NODE_OPTIONS`-adjacent process state and logs elsewhere, and a cache key is retained state: the
 * raw credential must not live there.
 */
export function requestPrincipalKey(req: KeyableRequest): string {
  const authorization = req.headers?.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return credentialDigest(authorization.slice(7), "token");
  }
  const queryToken = queryValue(req.url, TOKEN_QUERY_PARAM);
  if (queryToken) return credentialDigest(queryToken, "token");
  const cookie = req.headers?.cookie;
  const sessionId = typeof cookie === "string" ? readCookie(cookie, REMOTE_SESSION_COOKIE) : undefined;
  if (sessionId) return credentialDigest(sessionId, "session");
  return "anonymous";
}

/**
 * The request's own scoping parameters, canonicalized.
 *
 * FNXC:ProjectListCoalescing 2026-11-09-10:18 (RUFU-905):
 * `across-nodes` consults no query parameter today, so all of today's traffic — including the 8 tabs
 * this change exists for — shares one scoping string and one entry per principal. The parameters are
 * keyed anyway so the day this route does scope on one, a second caller cannot be served another
 * caller's payload. Order-insensitive, and `fn_token` is excluded: it is credential material already
 * carried by the principal half of the key, so leaving it here would split one principal's entries by
 * transport instead of collapsing them.
 */
export function requestScopingKey(req: KeyableRequest): string {
  if (!req.url) return "-";
  let params: URLSearchParams;
  try {
    params = new URL(req.url, "http://_placeholder_").searchParams;
  } catch {
    // An unparseable URL scopes nothing; the work still runs and the answer stays correct.
    return "-";
  }
  const pairs: string[] = [];
  for (const [name, value] of [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (name === TOKEN_QUERY_PARAM) continue;
    pairs.push(`${name}=${value}`);
  }
  return pairs.length > 0 ? pairs.join("&") : "-";
}

/** Cache key: one entry per (authenticated principal, scoping params). */
export function acrossNodesRequestKey(req: KeyableRequest): string {
  return `${requestPrincipalKey(req)}|${requestScopingKey(req)}`;
}
