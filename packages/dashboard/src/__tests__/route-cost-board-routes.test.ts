import { beforeEach, describe, expect, it } from "vitest";
import {
  observeRouteCost,
  resetRouteCosts,
  routeCostCount,
  routeCostSnapshot,
} from "../metrics/route-cost.js";

/*
FNXC:RouteCostBound 2026-11-18-10:55 (RUFU-479) — the three handlers the plan names must be NAMED in the table.

Step 3 made route cost a query; this case makes it a query about specific routes. `auth/status`, the
board-workflows feed and the GitHub tracking-status handler are the three whose cost the step must bound, and
the bound is only real if the table answers a question about them by name — a metric that aggregates every
request into one number cannot tell you which handler froze the loop.

The keying claim is the load-bearing one: entries are keyed by METHOD + matched ROUTE TEMPLATE, so
`/api/tasks/RUFU-457/diff` and `/api/tasks/RUFU-452/diff` are one row and cannot inflate the cardinality of
the table, while a route nobody requested is ABSENT rather than present-with-zero. Absence and zero are two
different facts and the surface must not merge them: a requested-but-fast route reports count > 0, an
unrequested one reports nothing in the snapshot and 0 from the counter, and "we never asked" must never be
readable as "it is fast".

What this file deliberately does NOT do is assert a p95 number. The historical `auth/status` figures (9.39 s
and 10.92 s) predate the probe memoization, and the deployed node is not reachable from this worktree, so a
green assertion on an invented bound would be the falsest possible witness. The bound is recorded as a named
constant so the re-measurement is a diff against a number rather than a fresh decision.
*/

/** The historical `auth/status` figures, recorded as the ceiling a re-measurement must beat. */
const AUTH_STATUS_HISTORICAL_P95_MS = 10_920;

const NAMED_ROUTES = [
  "GET /api/auth/status",
  "GET /api/tasks/board-workflows",
  "GET /api/tasks/:id/github-tracking-status",
] as const;

beforeEach(() => {
  resetRouteCosts();
});

describe("route cost table names the handlers under bound", () => {
  it("records each named handler under its method plus route template, not under a concrete URL", () => {
    observeRouteCost({ method: "GET", routeTemplate: "/api/auth/status", durationMs: 40, bytes: 9_219 });
    observeRouteCost({ method: "GET", routeTemplate: "/api/tasks/board-workflows", durationMs: 120, bytes: 4_000 });
    observeRouteCost({ method: "GET", routeTemplate: "/api/tasks/:id/github-tracking-status", durationMs: 60, bytes: 300 });
    // The same template hit twice more: one row, three observations.
    observeRouteCost({ method: "GET", routeTemplate: "/api/auth/status", durationMs: 30, bytes: 9_219 });
    observeRouteCost({ method: "POST", routeTemplate: "/api/auth/status", durationMs: 800 });

    const snapshot = routeCostSnapshot();
    for (const named of NAMED_ROUTES) {
      expect(snapshot[named], `named route missing from the cost table: ${named}`).toBeDefined();
      expect(snapshot[named]?.p95Ms).toBeTypeOf("number");
    }

    // Method is part of the key: a slow POST may not hide behind a fast GET on the same path.
    expect(snapshot["GET /api/auth/status"]?.count).toBe(2);
    expect(snapshot["POST /api/auth/status"]?.count).toBe(1);
    // Bytes are accumulated per route, which is how a 12 KB-per-card page becomes visible as a number.
    expect(snapshot["GET /api/auth/status"]?.totalBytes).toBe(18_438);
  });

  it("leaves a never-requested route absent from the table while its counter honestly reports 0", () => {
    observeRouteCost({ method: "GET", routeTemplate: "/api/auth/status", durationMs: 40 });
    const snapshot = routeCostSnapshot();

    expect(snapshot["GET /api/auth/status"]).toBeDefined();
    expect("GET /api/tasks/:id/diff" in snapshot).toBe(false);
    expect(routeCostCount("/api/tasks/:id/diff")).toBe(0);
  });

  it("exposes a bound the named handlers must be measured against, as a number rather than prose", () => {
    // Re-measure on the deployed node and compare p95Ms against this constant; the memoized probes
    // (auth-probe-cache.test.ts) are what should move the number, and the table is what proves it moved.
    expect(AUTH_STATUS_HISTORICAL_P95_MS).toBeGreaterThan(0);
    observeRouteCost({ method: "GET", routeTemplate: "/api/auth/status", durationMs: 35 });
    expect(routeCostSnapshot()["GET /api/auth/status"]?.p95Ms).toBeLessThan(AUTH_STATUS_HISTORICAL_P95_MS);
  });
});
