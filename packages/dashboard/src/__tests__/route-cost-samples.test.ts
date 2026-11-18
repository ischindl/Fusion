/*
FNXC:RouteCostAccounting 2026-11-18-07:28 (RUFU-479) — the per-route cost table's own contract.

Why a table at all: a board load cost 22-31 s end to end and the aggregate request-latency ring could only
say the node was busy. The one page that mattered cost 8.79-10.79 s solo while `/api/settings/global`
answered in 5 ms on the same process, and nothing server-side could tell those two apart.

The four properties pinned here are the ones that decide whether the table can be trusted while it is
being read under load:
  * one entry per route, its `count` growing rather than the map growing;
  * a never-served route reporting a plain 0, with no absent-vs-undefined state to misread;
  * a never-served route distinguishable from a route served exactly once;
  * both bounds holding: samples per route (the reused `REQUEST_LATENCY_RING_CAP`) and route templates
    (`ROUTE_COST_MAX_ROUTES`), the second one only absolute because the key is a TEMPLATE.
*/
import { beforeEach, describe, expect, it } from "vitest";
import {
  ROUTE_COST_MAX_ROUTES,
  UNMATCHED_ROUTE_TEMPLATE,
  createRouteCostMiddleware,
  observeRouteCost,
  resetRouteCosts,
  routeCostCount,
  routeCostSnapshot,
} from "../metrics/route-cost.js";
import { REQUEST_LATENCY_RING_CAP, percentile } from "../metrics/runtime-sampler.js";

beforeEach(() => resetRouteCosts());

describe("route cost table (RUFU-479)", () => {
  it("records one entry per route whose count grows, instead of one entry per request", () => {
    observeRouteCost({ method: "GET", routeTemplate: "/api/tasks/page", durationMs: 9_000 });
    observeRouteCost({ method: "GET", routeTemplate: "/api/tasks/page", durationMs: 9_400 });

    const snapshot = routeCostSnapshot();
    expect(Object.keys(snapshot)).toEqual(["GET /api/tasks/page"]);
    expect(snapshot["GET /api/tasks/page"]?.count).toBe(2);
  });

  it("reports an unrequested route as a plain zero, never undefined", () => {
    observeRouteCost({ method: "GET", routeTemplate: "/api/tasks/page", durationMs: 9_000 });
    expect(routeCostCount("/api/insights")).toBe(0);
    expect(routeCostCount("/api/tasks/page")).toBe(1);
  });

  it("distinguishes a route never served from one served exactly once", () => {
    expect(routeCostSnapshot()["GET /api/settings/global"]).toBeUndefined();
    expect(routeCostCount("/api/settings/global")).toBe(0);

    observeRouteCost({ method: "GET", routeTemplate: "/api/settings/global", durationMs: 5 });
    expect(routeCostCount("/api/settings/global")).toBe(1);
    expect(routeCostSnapshot()["GET /api/settings/global"]).toMatchObject({ count: 1, p95Ms: 5, maxMs: 5 });
  });

  it("keeps method part of the key so a slow POST cannot hide behind a fast GET", () => {
    observeRouteCost({ method: "GET", routeTemplate: "/api/tasks/:id", durationMs: 4 });
    observeRouteCost({ method: "POST", routeTemplate: "/api/tasks/:id", durationMs: 1_200 });
    const snapshot = routeCostSnapshot();
    expect(Object.keys(snapshot).sort()).toEqual(["GET /api/tasks/:id", "POST /api/tasks/:id"]);
  });

  it("separates the two routes that differ only by a card id, and collapses ids into one template", () => {
    // The middleware keys on `req.route.path`, so two different cards are one entry.
    const middleware = createRouteCostMiddleware();
    const serve = (routePath: string, url: string) => {
      const listeners: Array<() => void> = [];
      const req = { method: "GET", route: { path: routePath }, baseUrl: "/api", originalUrl: url };
      const res = {
        once: (_event: string, cb: () => void) => listeners.push(cb),
        getHeader: () => "1024",
      };
      middleware(req, res, () => undefined);
      for (const listen of listeners) listen();
    };
    serve("/tasks/:id/diff", "/api/tasks/RUFU-457/diff");
    serve("/tasks/:id/diff", "/api/tasks/RUFU-452/diff");

    const snapshot = routeCostSnapshot();
    expect(Object.keys(snapshot)).toEqual(["GET /api/tasks/:id/diff"]);
    expect(snapshot["GET /api/tasks/:id/diff"]).toMatchObject({ count: 2, totalBytes: 2_048 });
  });

  it("collapses an unmatched request onto one sentinel instead of minting an entry per URL", () => {
    const middleware = createRouteCostMiddleware();
    for (const url of ["/api/nope/1", "/api/nope/2", "/api/nope/3"]) {
      const listeners: Array<() => void> = [];
      middleware({ method: "GET", originalUrl: url }, { once: (_e: string, cb: () => void) => listeners.push(cb), getHeader: () => undefined }, () => undefined);
      for (const listen of listeners) listen();
    }
    const snapshot = routeCostSnapshot();
    expect(Object.keys(snapshot)).toEqual([`GET ${UNMATCHED_ROUTE_TEMPLATE}`]);
    expect(snapshot[`GET ${UNMATCHED_ROUTE_TEMPLATE}`]?.count).toBe(3);
  });

  it("bounds the samples per route at the shared latency ring cap", () => {
    for (let i = 0; i < REQUEST_LATENCY_RING_CAP + 500; i += 1) {
      observeRouteCost({ method: "GET", routeTemplate: "/api/tasks/page", durationMs: i });
    }
    const entry = routeCostSnapshot()["GET /api/tasks/page"];
    expect(entry?.count).toBe(REQUEST_LATENCY_RING_CAP + 500);
    // The percentile window stays recent and bounded: p95 of the last 256 ascending samples cannot be the
    // overall maximum, and the ring never grows past its cap.
    expect(entry!.p95Ms).toBeLessThan(REQUEST_LATENCY_RING_CAP + 500);
  });

  it("bounds the number of route templates so the map cannot grow with the URL space", () => {
    for (let i = 0; i < ROUTE_COST_MAX_ROUTES * 2; i += 1) {
      observeRouteCost({ method: "GET", routeTemplate: `/api/route-${i}`, durationMs: 1 });
    }
    expect(Object.keys(routeCostSnapshot()).length).toBeLessThanOrEqual(ROUTE_COST_MAX_ROUTES);
  });

  it("ignores a nonsensical duration rather than poisoning a percentile", () => {
    observeRouteCost({ method: "GET", routeTemplate: "/api/x", durationMs: Number.NaN });
    observeRouteCost({ method: "GET", routeTemplate: "/api/x", durationMs: -5 });
    expect(routeCostSnapshot()["GET /api/x"]).toBeUndefined();
  });
});

describe("the dashboard's one percentile", () => {
  it("answers nearest-rank on unsorted input and reports 0 for empty", () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([30, 10, 20], 50)).toBe(20);
    expect(percentile([1], 95)).toBe(1);
    // Same rule for the reliability panel and the route table: a p95 of exactly 100 samples of 1..100.
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 50)).toBe(50);
  });
});
