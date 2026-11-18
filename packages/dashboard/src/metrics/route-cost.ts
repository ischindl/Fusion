/*
FNXC:RouteCostAccounting 2026-11-18-07:05 (RUFU-479) — "which route is costing this" must be a query.

THE MEASURED PROBLEM. A board load on the deployed node took 22-31 s end to end. The only number the
operator could get was a browser trace: one page (`GET /api/tasks/page?limit=100`) turned out to cost
8.79 / 9.34 / 10.79 s solo and 15.5 s during the burst, while a settings read on the same server answered
in 5 ms. Nothing server-side could name that. `metrics/runtime-sampler.ts` already records ONE aggregate
request-latency ring — it can say the node is slow, not which handler is slow, which is exactly why a 9 s
page was only visible in a browser trace.

WHAT THIS ADDS. One bounded per-route cost map: per route template, a count and p50/p95 of served
durations, exposed at `GET /api/diagnostics/costs`. It is board-side route cost, not a run-audit row —
there is no sink, no migration, and nothing to replay; the process' own memory is the storage, and a
restart clearing it is correct behaviour for a diagnostic.

THE BOUND, stated before the code. Two dimensions must be bounded or a diagnostic becomes the outage it
describes:
  * per route, the duration ring reuses `REQUEST_LATENCY_RING_CAP`, so one hot route cannot grow without
    limit and the percentile stays a recent-window figure rather than an all-time one;
  * across routes, the map itself caps at `ROUTE_COST_MAX_ROUTES` entries and evicts the oldest-inserted
    route, so the key space cannot grow with the URL space. That bound is only honest because the key is
    the ROUTE TEMPLATE (`req.route?.path`, e.g. `/api/tasks/:id/diff`), never a raw URL: a template count
    is dozens on this server, a raw-URL count is every card id ever requested. An unmatched request is
    recorded under one shared sentinel, not under its own path.
*/
import { REQUEST_LATENCY_RING_CAP, percentile } from "./runtime-sampler.js";

/**
 * Cardinality bound on distinct route templates held in process memory.
 *
 * FNXC:RetentionCensus 2026-11-18-12:05 (RUFU-479): the number is written here rather than aliased to
 * `REQUEST_LATENCY_RING_CAP`, and that is a checker requirement, not a style choice. `scripts/check-retention-coverage.mjs`
 * accepts "this collection stops growing" only when it can see a numeric ceiling constant of that name
 * DECLARED IN THIS FILE and read here; an alias it cannot resolve reads as an unclassified module-scope Map.
 * Two bounds that happen to share the value 256 are still two facts - samples per route vs templates per map -
 * and the ring cap stays imported because the sample window genuinely belongs to the sampler's constant.
 */
export const ROUTE_COST_MAX_ROUTES = 256;

/** The single key every unmatched request shares, so 404s cannot mint per-URL entries. */
export const UNMATCHED_ROUTE_TEMPLATE = "<unmatched>";

export interface RouteCostSample {
  /** HTTP method, upper-cased; part of the key so a slow `POST` cannot hide behind a fast `GET`. */
  method: string;
  /** The Express route template, e.g. `/api/tasks/:id/diff`. Never a concrete URL. */
  routeTemplate: string;
  /** Wall-clock duration of the served request, in ms. */
  durationMs: number;
  /** Optional response bytes, for a cost read that wants bytes alongside latency. */
  bytes?: number;
}

export interface RouteCostEntry {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  totalBytes: number;
}

interface RouteState {
  durations: number[];
  /** Ring write cursor, so the bound holds without ever splicing the array. */
  cursor: number;
  /** Every sample ever recorded for this route, unlike `durations`, which is the bounded recent window. */
  count: number;
  totalBytes: number;
  maxMs: number;
}

/*
FNXC:RouteCostAccounting 2026-11-18-07:05 (RUFU-479): the percentile used here is the dashboard's ONE
nearest-rank implementation, exported from `metrics/runtime-sampler.ts` (see the note there for why that
module is its home, and why `reliability-metrics.ts` now imports the same function instead of keeping a
second copy that assumed a sorted input).
*/

// retention-bounded: ROUTE_COST_MAX_ROUTES
const routes = new Map<string, RouteState>();

function routeKey(sample: RouteCostSample): string {
  const template = sample.routeTemplate.trim() === "" ? UNMATCHED_ROUTE_TEMPLATE : sample.routeTemplate;
  return `${sample.method.toUpperCase()} ${template}`;
}

/** Record one served request. O(1) per call; the ring and the map are both pre-bound. */
export function observeRouteCost(sample: RouteCostSample): void {
  if (!Number.isFinite(sample.durationMs) || sample.durationMs < 0) return;
  const key = routeKey(sample);
  let state = routes.get(key);
  if (!state) {
    // Oldest-inserted eviction keeps the ceiling absolute while leaving the hot routes in place: the map
    // is a working set, and a route that stops being requested is the one worth forgetting.
    if (routes.size >= ROUTE_COST_MAX_ROUTES) {
      const oldest = routes.keys().next();
      if (!oldest.done) routes.delete(oldest.value);
    }
    state = { durations: [], cursor: 0, count: 0, totalBytes: 0, maxMs: 0 };
    routes.set(key, state);
  }
  const ringFull = state.durations.length >= REQUEST_LATENCY_RING_CAP;
  if (ringFull) {
    state.durations[state.cursor % REQUEST_LATENCY_RING_CAP] = sample.durationMs;
  } else {
    state.durations.push(sample.durationMs);
  }
  state.cursor = (state.cursor + 1) % REQUEST_LATENCY_RING_CAP;
  state.count += 1;
  state.totalBytes += Number.isFinite(sample.bytes) ? (sample.bytes ?? 0) : 0;
  if (sample.durationMs > state.maxMs) state.maxMs = sample.durationMs;
}

/**
 * The cost table, keyed `METHOD /route/template`.
 *
 * An unrequested route is ABSENT from this map rather than present with zeros: a route never served has
 * no distribution to report, and inventing one with p50 0 would read as "fast" to the operator who is
 * asking the opposite question. `count` distinguishes served-once from served-many.
 */
export function routeCostSnapshot(): Record<string, RouteCostEntry> {
  const out: Record<string, RouteCostEntry> = {};
  for (const [key, state] of routes) {
    out[key] = {
      count: state.count,
      p50Ms: percentile(state.durations, 50),
      p95Ms: percentile(state.durations, 95),
      maxMs: state.maxMs,
      totalBytes: state.totalBytes,
    };
  }
  return out;
}

/** Total samples recorded for one route template across methods, or 0 when it was never served. */
export function routeCostCount(routeTemplate: string): number {
  let total = 0;
  for (const [key, state] of routes) {
    if (key.endsWith(` ${routeTemplate}`)) total += state.count;
  }
  return total;
}

/** Test-only: clears the table so a suite can assert counts without inheriting its neighbours'. */
export function resetRouteCosts(): void {
  routes.clear();
}

/** True when the object behaves like an HTTP response with a `finish` event. */
function isResponseLike(res: unknown): res is { once: (event: string, cb: () => void) => unknown } {
  return typeof res === "object" && res !== null && typeof (res as { once?: unknown }).once === "function";
}

/**
 * Express middleware recording per-route cost on the LIVE serving path.
 *
 * Mounted after the route table exists but timing from the moment the request enters, so the duration is
 * the same full-pipeline figure the aggregate latency ring measures. The template is only known once a
 * handler has matched, which is why the key is read inside the `finish` listener — and why an unmatched
 * request collapses to one sentinel instead of minting an entry per URL.
 */
export function createRouteCostMiddleware() {
  return (
    req: unknown,
    res: unknown,
    next?: () => void,
  ): void => {
    const startedAt = Date.now();
    if (isResponseLike(res)) {
      res.once("finish", () => {
        observeRouteCost({
          method: readMethod(req),
          routeTemplate: readRouteTemplate(req),
          durationMs: Date.now() - startedAt,
          bytes: readBytes(res),
        });
      });
    }
    if (typeof next === "function") next();
  };
}

function readMethod(req: unknown): string {
  const method = (req as { method?: unknown })?.method;
  return typeof method === "string" ? method.toUpperCase() : "UNKNOWN";
}

/*
The key is the matched template plus the mount prefix, so a router mounted under `/api` reports
`/api/tasks/:id` rather than `/tasks/:id` — the same string an operator copies into a search of the route
registrars. `req.path`/`req.url` are deliberately never used: they carry concrete ids, and a cost map
keyed on card ids is an unbounded map with a percentile attached.
*/
function readRouteTemplate(req: unknown): string {
  const r = req as { route?: { path?: unknown; stack?: unknown }; baseUrl?: unknown; originalUrl?: unknown };
  const matched = typeof r?.route?.path === "string" ? r.route.path : undefined;
  if (!matched) return UNMATCHED_ROUTE_TEMPLATE;
  const base = typeof r?.baseUrl === "string" ? r.baseUrl : "";
  if (base === "" || base === "/" || matched.startsWith(base)) return matched.startsWith("/") ? matched : `/${matched}`;
  return `${base.replace(/\/$/, "")}${matched.startsWith("/") ? matched : `/${matched}`}`;
}

/** Response bytes, best-effort: the content-length header when the stack set one. */
function readBytes(res: unknown): number | undefined {
  const r = res as { getHeader?: (name: string) => unknown };
  if (typeof r?.getHeader !== "function") return undefined;
  const header = r.getHeader("content-length");
  const value = typeof header === "string" ? Number(header) : typeof header === "number" ? header : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}
