// @vitest-environment node

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { registerProjectRoutes } from "../register-project-routes.js";
import {
  PROJECTS_POLL_INTERVAL_MS,
  acrossNodesRequestKey,
  createProjectListCoalescer,
  resolveAcrossNodesTtlMs,
  setAcrossNodesClockForTests,
  setAcrossNodesTtlMsForTests,
} from "../project-list-coalescer.js";

/*
FNXC:ProjectListCoalescing 2026-11-09-10:18 (RUFU-905):
Eight dashboard tabs open for eight different projects were each polling
`GET /api/projects/across-nodes` every 5 s against ONE dashboard process on ONE event loop (verified
with `ss -ltnp` plus `/proc/<pid>/cwd`), so the loop that also serves the board re-ran the whole
cross-project fan-out ~1.6 times per second. Sequential per-project reads over 25 projects measured
1.95, 2.43, 4.07, 9.34, 24.7, 35.6, 57.3 and 59.5 s, with three more hitting a 60 s client cap.

Everything below asserts through the route or the exported coalescing seam, and counts STORE READS —
never wall time — because on a host whose load runs 15-50 a timing assertion proves nothing.
*/

type FakeProject = {
  id: string;
  name: string;
  path: string;
  status: string;
  isolationMode: string;
  createdAt: string;
  updatedAt: string;
  runtimeEnabled?: boolean;
};

function projectRow(id: string, runtimeEnabled?: boolean): FakeProject {
  const row: FakeProject = {
    id,
    name: `Project ${id}`,
    path: `/p/${id}`,
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  if (runtimeEnabled !== undefined) row.runtimeEnabled = runtimeEnabled;
  return row;
}

/** The operator's shape: 25 registered projects, some of them turned off. */
const BOARD_ROWS: FakeProject[] = Array.from({ length: 25 }, (_, index) => projectRow(`p-${index}`));
const OFF_BOARD_IDS = new Set(["p-0", "p-5", "p-15"]);
const BOARD_FLAGS: Record<string, boolean> = Object.fromEntries(
  BOARD_ROWS.map((row) => [row.id, !OFF_BOARD_IDS.has(row.id)]),
);

const NODE_A_ROWS = [projectRow("alpha-shared"), projectRow("alpha-only")];
const NODE_B_ROWS = [projectRow("beta-shared"), projectRow("beta-only")];
const FLAGS_A: Record<string, boolean> = { "alpha-shared": true, "alpha-only": true };
const FLAGS_B: Record<string, boolean> = { "beta-shared": false, "beta-only": false };

const REMOTE_NODE = [{ id: "n-1", type: "remote", status: "online", url: "http://127.0.0.1:1", name: "node-1", apiKey: "k" }];

type CentralState = {
  rows: FakeProject[];
  flags: Record<string, boolean> | null;
  /** When true the fake omits the runtime seam entirely: a CentralCore older than RUFU-871. */
  seamMissing?: boolean;
  remoteNodes?: typeof REMOTE_NODE;
};

/**
 * The route with every underlying read instrumented. `state` is mutable on purpose: flipping it
 * between requests is what proves which computation produced which response.
 */
function buildApp(state: CentralState) {
  const reads = {
    reconcile: vi.fn(async () => undefined),
    listProjects: vi.fn(async () => state.rows),
    listNodes: vi.fn(async () => state.remoteNodes ?? []),
    runtimeFlags: vi.fn(async () => state.flags),
    /** `engineManager.getStore` is the seam a per-project store would be opened through. */
    getStore: vi.fn(() => null),
  };
  const centralCore: Record<string, unknown> = {
    isInitialized: () => true,
    reconcileProjectStatuses: reads.reconcile,
    listProjects: reads.listProjects,
    listNodes: reads.listNodes,
  };
  if (!state.seamMissing) centralCore.getProjectRuntimeEnabledFlags = reads.runtimeFlags;

  const router = express.Router();
  registerProjectRoutes({
    router,
    options: { centralCore, engineManager: { getStore: reads.getStore } },
    runtimeLogger: { child: () => ({ warn: vi.fn() }) },
    prioritizeProjectsForCurrentDirectory: vi.fn((projects: unknown[]) => projects),
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never);

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(error.statusCode ?? 500).json({ error: error.message }),
  );
  return { app, reads, state };
}

function acrossNodes(app: express.Express, headers: Record<string, string> = {}, query = "") {
  return request(app, "GET", `/api/projects/across-nodes${query}`, undefined, headers);
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Deterministic clock: the tests below move time, they never wait for it. */
function fakeClock(startMs: number) {
  let at = startMs;
  return {
    now: () => at,
    advance: (ms: number) => { at += ms; },
  };
}

const DEFAULT_TTL_MS = 2_000;

afterEach(() => {
  setAcrossNodesTtlMsForTests(DEFAULT_TTL_MS);
  setAcrossNodesClockForTests(Date.now);
});

describe("GET /api/projects/across-nodes request coalescing", () => {
  it("runs the cross-project fan-out ONCE for 8 concurrent identical requests", async () => {
    setAcrossNodesTtlMsForTests(DEFAULT_TTL_MS);
    setAcrossNodesClockForTests(fakeClock(1_700_000_000_000).now);
    const { app, reads } = buildApp({ rows: BOARD_ROWS, flags: BOARD_FLAGS });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => acrossNodes(app, bearer("daemon-token"))),
    );

    // The measured failure: 8 tabs, 8 fan-outs. The fix: one.
    expect(reads.listProjects).toHaveBeenCalledTimes(1);
    expect(reads.reconcile).toHaveBeenCalledTimes(1);
    expect(reads.runtimeFlags).toHaveBeenCalledTimes(1);
    // Coalescing the project list must not smuggle in a per-project store open.
    expect(reads.getStore).not.toHaveBeenCalled();

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect((response.body as unknown[]).length).toBe(BOARD_ROWS.length);
      expect(Buffer.compare(response.bodyBuffer, responses[0].bodyBuffer)).toBe(0);
    }
  });

  it("serves a request arriving inside the TTL from the computation already made", async () => {
    const clock = fakeClock(1_700_000_000_000);
    setAcrossNodesTtlMsForTests(DEFAULT_TTL_MS);
    setAcrossNodesClockForTests(clock.now);
    const { app, reads } = buildApp({ rows: BOARD_ROWS, flags: BOARD_FLAGS });

    const first = await acrossNodes(app, bearer("daemon-token"));
    clock.advance(DEFAULT_TTL_MS - 1);
    const second = await acrossNodes(app, bearer("daemon-token"));

    expect(reads.listProjects).toHaveBeenCalledTimes(1);
    expect(Buffer.compare(second.bodyBuffer, first.bodyBuffer)).toBe(0);
  });

  it("does NOT coalesce GET /api/projects, which stays per-request", async () => {
    setAcrossNodesTtlMsForTests(DEFAULT_TTL_MS);
    setAcrossNodesClockForTests(fakeClock(1_700_000_000_000).now);
    const { app, reads } = buildApp({ rows: BOARD_ROWS, flags: BOARD_FLAGS });

    await request(app, "GET", "/api/projects");
    await request(app, "GET", "/api/projects");

    expect(reads.listProjects).toHaveBeenCalledTimes(2);
  });

  /*
  FNXC:ProjectListCoalescing 2026-11-09-10:18 (RUFU-905):
  Project visibility is per-principal and RLS-enforced. One computed board handed to a second
  credential would leak which projects exist to a principal that cannot see them, so the entry identity
  is the credential the request authenticated with, and these two cases are the whole guarantee.
  */
  it("never serves one principal the other principal's computed project list", async () => {
    const clock = fakeClock(1_700_000_000_000);
    setAcrossNodesTtlMsForTests(DEFAULT_TTL_MS);
    setAcrossNodesClockForTests(clock.now);
    const { app, reads, state } = buildApp({ rows: NODE_A_ROWS, flags: FLAGS_A });

    const principalA = await acrossNodes(app, bearer("token-A"));
    expect((principalA.body as Array<Record<string, unknown>>).map((row) => row.id))
      .toEqual(["alpha-shared", "alpha-only"]);

    // The other principal's data becomes what the read would answer now.
    state.rows = NODE_B_ROWS;
    state.flags = FLAGS_B;
    const principalB = await acrossNodes(app, bearer("token-B"));

    // B recomputed: it was never handed A's entry.
    expect(reads.listProjects).toHaveBeenCalledTimes(2);
    const rowsB = principalB.body as Array<Record<string, unknown>>;
    expect(rowsB.map((row) => row.id)).toEqual(["beta-shared", "beta-only"]);
    expect(Buffer.compare(principalB.bodyBuffer, principalA.bodyBuffer)).not.toBe(0);
    // The projected runtime fields resolve per-principal too, not just the row set.
    for (const row of rowsB) {
      expect(row.runtimeState).toBe("disabled");
      expect(row.runtimeEnabled).toBe(false);
    }
    for (const row of principalA.body as Array<Record<string, unknown>>) {
      expect(row.runtimeState).toBe("enabled");
      expect(row.runtimeEnabled).toBe(true);
    }

    // And A is still served from ITS OWN entry while the read would now answer B's rows.
    clock.advance(DEFAULT_TTL_MS - 1);
    const againA = await acrossNodes(app, bearer("token-A"));
    expect(reads.listProjects).toHaveBeenCalledTimes(2);
    expect(Buffer.compare(againA.bodyBuffer, principalA.bodyBuffer)).toBe(0);
  });

  it("counts the same credential as one principal across the bearer header and the fn_token fallback", async () => {
    setAcrossNodesTtlMsForTests(DEFAULT_TTL_MS);
    setAcrossNodesClockForTests(fakeClock(1_700_000_000_000).now);
    const { app, reads } = buildApp({ rows: NODE_A_ROWS, flags: FLAGS_A });

    await acrossNodes(app, bearer("shared-token"));
    await acrossNodes(app, {}, "?fn_token=shared-token");

    // One principal, one fan-out — this is what lets 8 same-token tabs share one entry at all.
    expect(reads.listProjects).toHaveBeenCalledTimes(1);
  });

  it("separates a remote-login session principal from a bearer-token principal", async () => {
    setAcrossNodesTtlMsForTests(DEFAULT_TTL_MS);
    setAcrossNodesClockForTests(fakeClock(1_700_000_000_000).now);
    const { app, reads } = buildApp({ rows: NODE_A_ROWS, flags: FLAGS_A });

    await acrossNodes(app, bearer("shared-token"));
    await acrossNodes(app, { cookie: "fusion_remote_session=session-value-1" });

    expect(reads.listProjects).toHaveBeenCalledTimes(2);
  });

  /*
  FNXC:ProjectListCoalescing 2026-11-09-10:18 (RUFU-905):
  The staleness bound is a TTL and expiry must be a REAL miss. `TaskLaneCache` states the rule this
  honors: a cache miss is UNKNOWN, never EMPTY — so an expired entry is dropped and the work runs
  again, and the recomputed answer reflects the data, not the retained one.
  */
  it("recomputes once the entry is older than the TTL, and the recomputed answer is the new data", async () => {
    const clock = fakeClock(1_700_000_000_000);
    setAcrossNodesTtlMsForTests(DEFAULT_TTL_MS);
    setAcrossNodesClockForTests(clock.now);
    const { app, reads, state } = buildApp({ rows: NODE_A_ROWS, flags: FLAGS_A });

    await acrossNodes(app, bearer("daemon-token"));
    clock.advance(DEFAULT_TTL_MS);
    state.rows = NODE_B_ROWS;
    state.flags = FLAGS_B;
    const staleEdge = await acrossNodes(app, bearer("daemon-token"));

    expect(reads.listProjects).toHaveBeenCalledTimes(2);
    expect((staleEdge.body as Array<Record<string, unknown>>).map((row) => row.id))
      .toEqual(["beta-shared", "beta-only"]);
  });

  it("recomputes every request when the TTL is 0, which is the no-redeploy rollback", async () => {
    setAcrossNodesTtlMsForTests(0);
    setAcrossNodesClockForTests(fakeClock(1_700_000_000_000).now);
    const { app, reads } = buildApp({ rows: BOARD_ROWS, flags: BOARD_FLAGS });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => acrossNodes(app, bearer("daemon-token"))),
    );

    // TTL 0 is the pre-coalescing pass-through: no join, no entry, 8 fan-outs.
    expect(reads.listProjects).toHaveBeenCalledTimes(8);
    for (const response of responses) expect(response.status).toBe(200);
  });

  /*
  The response a client reads must not change at all — same bytes for the populated board, for a
  registry with nothing in it, and for the `unknown` runtime answer (a remote row whose own node predates
  the runtime field, and a local row with no settings row).
  */
  const parityCases: Array<{ label: string; state: () => CentralState }> = [
    { label: "populated board", state: () => ({ rows: BOARD_ROWS, flags: BOARD_FLAGS }) },
    { label: "empty registry", state: () => ({ rows: [], flags: {} }) },
    {
      label: "unknown runtime state",
      state: () => ({ rows: [projectRow("p-no-settings-row"), projectRow("p-off", true)], flags: { "p-off": false } }),
    },
  ];

  for (const testCase of parityCases) {
    it(`answers byte-identically with and without the cache: ${testCase.label}`, async () => {
      setAcrossNodesTtlMsForTests(0);
      setAcrossNodesClockForTests(fakeClock(1_700_000_000_000).now);
      const uncached = buildApp(testCase.state());
      const before = await acrossNodes(uncached.app, bearer("daemon-token"));
      const uncachedReads = uncached.reads.listProjects.mock.calls.length;

      setAcrossNodesTtlMsForTests(DEFAULT_TTL_MS);
      const cached = buildApp(testCase.state());
      const after = await acrossNodes(cached.app, bearer("daemon-token"));

      expect(cached.reads.listProjects.mock.calls.length).toBe(uncachedReads);
      expect(Buffer.compare(after.bodyBuffer, before.bodyBuffer)).toBe(0);
    });
  }

  it("answers byte-identically for a merged remote board, whose unknown runtime row stays unknown", async () => {
    const previousFetch = globalThis.fetch;
    // A node older than the runtime field: its row must project `unknown` and stay `unknown`.
    globalThis.fetch = (async () => new Response(JSON.stringify([projectRow("remote-old-node")]), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    try {
      setAcrossNodesTtlMsForTests(0);
      setAcrossNodesClockForTests(fakeClock(1_700_000_000_000).now);
      const uncached = buildApp({ rows: NODE_A_ROWS, flags: FLAGS_A, remoteNodes: REMOTE_NODE });
      const before = await acrossNodes(uncached.app, bearer("daemon-token"));

      setAcrossNodesTtlMsForTests(DEFAULT_TTL_MS);
      const cached = buildApp({ rows: NODE_A_ROWS, flags: FLAGS_A, remoteNodes: REMOTE_NODE });
      const after = await acrossNodes(cached.app, bearer("daemon-token"));

      const remoteRow = (after.body as Array<Record<string, unknown>>).find((row) => row.id === "remote-old-node");
      expect(remoteRow?.runtimeState).toBe("unknown");
      expect(remoteRow?.runtimeEnabled).toBe(false);
      expect(Buffer.compare(after.bodyBuffer, before.bodyBuffer)).toBe(0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

describe("project-list coalescer seam", () => {
  it("shares one computation with every joiner and returns the same value object", async () => {
    const clock = fakeClock(0);
    const work = vi.fn(async () => ({ rows: ["a"] }));
    const coalescer = createProjectListCoalescer({ ttlMs: 1_000, now: clock.now });

    const [first, second, third] = await Promise.all([
      coalescer.run("k", work),
      coalescer.run("k", work),
      coalescer.run("k", work),
    ]);

    expect(work).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it("joins a computation that outlives the TTL instead of starting a second one", async () => {
    /*
    FNXC:ProjectListCoalescing 2026-11-09-10:18 (RUFU-905):
    The fan-out measured up to 59 s, well past the bound. Piling a second copy onto a loop that is
    already choking on the first would be worse than not coalescing at all, so a live entry is always
    joined; the TTL bounds how long a SETTLED answer may be served, nothing else.
    */
    const clock = fakeClock(0);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const work = vi.fn(async () => { await gate; return { rows: ["a"] }; });
    const coalescer = createProjectListCoalescer({ ttlMs: 1_000, now: clock.now });

    const first = coalescer.run("k", work);
    clock.advance(30_000);
    const joiner = coalescer.run("k", work);
    release();
    await Promise.all([first, joiner]);

    expect(work).toHaveBeenCalledTimes(1);
  });

  it("never retains a failed computation: joiners share the rejection, the next caller retries", async () => {
    const clock = fakeClock(0);
    let attempt = 0;
    const work = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("central registry unavailable");
      return { rows: ["recovered"] };
    });
    const coalescer = createProjectListCoalescer({ ttlMs: 1_000, now: clock.now });

    const [first, second] = await Promise.allSettled([coalescer.run("k", work), coalescer.run("k", work)]);
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("rejected");

    const recovered = await coalescer.run("k", work);
    expect(recovered).toEqual({ rows: ["recovered"] });
    // One call for both joiners, then the retry: the rejection was never retained as an answer.
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("measures staleness from completion, so a slow computation is not born stale", async () => {
    const clock = fakeClock(0);
    const work = vi.fn(async () => {
      clock.advance(1_500);
      return { rows: ["a"] };
    });
    const coalescer = createProjectListCoalescer({ ttlMs: 1_000, now: clock.now });

    await coalescer.run("k", work);
    const served = await coalescer.run("k", work);

    // Completion time is the base, so this second call is inside the window and costs no new read.
    expect(work).toHaveBeenCalledTimes(1);
    expect(served).toEqual({ rows: ["a"] });
  });

  it("keys entries apart by key string alone", async () => {
    const clock = fakeClock(0);
    const work = vi.fn(async () => ({ rows: ["a"] }));
    const coalescer = createProjectListCoalescer({ ttlMs: 1_000, now: clock.now });

    await coalescer.run("principal-a", work);
    await coalescer.run("principal-b", work);

    expect(work).toHaveBeenCalledTimes(2);
  });
});

describe("across-nodes TTL resolution", () => {
  it("defaults when unset, blank, or unparseable", () => {
    expect(resolveAcrossNodesTtlMs(undefined)).toBe(DEFAULT_TTL_MS);
    expect(resolveAcrossNodesTtlMs("  ")).toBe(DEFAULT_TTL_MS);
    expect(resolveAcrossNodesTtlMs("two seconds")).toBe(DEFAULT_TTL_MS);
    expect(resolveAcrossNodesTtlMs("-1")).toBe(DEFAULT_TTL_MS);
  });

  it("honours 0, which is the disable path", () => {
    expect(resolveAcrossNodesTtlMs("0")).toBe(0);
  });

  it("clamps any window above one client poll to one client poll", () => {
    expect(resolveAcrossNodesTtlMs("60000")).toBe(PROJECTS_POLL_INTERVAL_MS);
    expect(resolveAcrossNodesTtlMs(String(PROJECTS_POLL_INTERVAL_MS))).toBe(PROJECTS_POLL_INTERVAL_MS);
    expect(resolveAcrossNodesTtlMs("750")).toBe(750);
  });
});

describe("across-nodes request key", () => {
  it("separates distinct credentials and distinct session ids", () => {
    const a = acrossNodesRequestKey({ url: "/api/projects/across-nodes", headers: { authorization: "Bearer token-A" } });
    const b = acrossNodesRequestKey({ url: "/api/projects/across-nodes", headers: { authorization: "Bearer token-B" } });
    const session = acrossNodesRequestKey({ url: "/api/projects/across-nodes", headers: { cookie: "fusion_remote_session=s-1" } });

    expect(a).not.toBe(b);
    expect(a).not.toBe(session);
  });

  it("never puts the raw credential in the key", () => {
    const key = acrossNodesRequestKey({ url: "/api/projects/across-nodes", headers: { authorization: "Bearer super-secret-token" } });

    expect(key).not.toContain("super-secret-token");
  });

  it("collides the bearer header and the fn_token query form of one credential", () => {
    const viaHeader = acrossNodesRequestKey({ url: "/api/projects/across-nodes", headers: { authorization: "Bearer tok" } });
    const viaQuery = acrossNodesRequestKey({ url: "/api/projects/across-nodes?fn_token=tok", headers: {} });

    expect(viaQuery).toBe(viaHeader);
  });

  it("keys the request's own scoping parameters, order-insensitively", () => {
    const one = acrossNodesRequestKey({ url: "/api/projects/across-nodes?projectId=a&tenant=b" });
    const sameOrder = acrossNodesRequestKey({ url: "/api/projects/across-nodes?tenant=b&projectId=a" });
    const other = acrossNodesRequestKey({ url: "/api/projects/across-nodes?projectId=b&tenant=b" });

    expect(one).toBe(sameOrder);
    expect(one).not.toBe(other);
    // Today's traffic carries no scoping parameter, so all 8 tabs still land on one entry.
    expect(acrossNodesRequestKey({ url: "/api/projects/across-nodes" })).toBe(
      acrossNodesRequestKey({ url: "/api/projects/across-nodes" }),
    );
  });
});
