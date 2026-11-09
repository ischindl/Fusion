import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR, type WorkflowDefinition, type WorkflowSelectionCache } from "@fusion/core";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";
import { buildBoardWorkflowsPayload } from "../routes/board-workflows.js";
import {
  PROJECTS_POLL_INTERVAL_MS,
  resolveBoardWorkflowsTtlMs,
  setAcrossNodesClockForTests,
  setBoardWorkflowsTtlMsForTests,
} from "../routes/project-list-coalescer.js";

/*
FNXC:BoardWorkflowsCoalescing 2026-11-09-11:45 (RUFU-906):
`GET /api/tasks/board-workflows` saturates the dashboard's single event loop. Measured on the operator's
production host on 2026-11-09 across 25 projects: 1.95 / 2.43 / 4.07 / 4.79 / 9.34 / 24.7 / 35.6 / 57.3
/ 59.5 s; three projects never answered inside a 60 s cap and `proj_87bc5b3f35624449` (alfawise) did not
finish in 120 s. During that 120 s call `pg_stat_activity` showed 43 -> 13 active task queries parked on
`wait_event = Client:ClientRead` — the database was IDLE, waiting for us — while the dashboard process
held a steady 110 % CPU, i.e. one whole core. Every other UI read queues behind that, which is the
operator's "first tab is fast, the rest lag".

Eight dashboard tabs on one process poll this route every 5 s each, independently. The fix is
single-flight plus a bounded TTL per (principal, query), reusing the coalescer that landed for the
project list in RUFU-905.

These tests assert COUNTS, never milliseconds — the repo's rule that a scaling claim must be provable
without a stopwatch. Time is moved through the coalescer's clock seam, and an in-flight join is proven
by holding a computation open, not by sleeping.
*/

const DEFAULT_WORKFLOW_ID = "builtin:coding";
const CONCURRENT_TABS = 8;

/** Fake freshness clock; expiry is proven by moving this, never by waiting. */
function makeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) { now += ms; },
  };
}

type FakeStore = Record<string, unknown> & {
  listTasks: ReturnType<typeof vi.fn>;
  listCompletedTasks: ReturnType<typeof vi.fn>;
  getTaskWorkflowSelectionsAsync: ReturnType<typeof vi.fn>;
};

/**
 * Board store shaped for counting.
 *
 * `holdRelease` lets a test keep the computation open so a concurrent join is proven by construction
 * rather than by a race: the underlying read has not finished, so any answer the second caller receives
 * can only have come from joining it.
 */
function makeStore(options: {
  cardCount?: number;
  distinctWorkflows?: number;
  holdRelease?: () => Promise<void>;
  /** Hand every card the same workflow (production's dominant shape) unless distinct workflows are asked for. */
} = {}): FakeStore {
  const cardCount = options.cardCount ?? 3;
  const distinct = options.distinctWorkflows ?? 0;
  const catalog: WorkflowDefinition[] = [
    {
      id: DEFAULT_WORKFLOW_ID,
      name: "Coding",
      kind: "workflow",
      ir: BUILTIN_CODING_WORKFLOW_IR,
    } as unknown as WorkflowDefinition,
    ...Array.from({ length: distinct }, (_unused, index): WorkflowDefinition => ({
      id: `custom:lane-${index}`,
      name: `Lane ${index}`,
      kind: "workflow",
      ir: { ...BUILTIN_CODING_WORKFLOW_IR, name: `Lane ${index}` },
    }) as unknown as WorkflowDefinition),
  ];
  const ids = Array.from({ length: cardCount }, (_unused, index) => `RUFU-${index + 1}`);
  const workflowFor = (taskId: string): string => {
    if (distinct === 0) return DEFAULT_WORKFLOW_ID;
    const index = Number(taskId.slice("RUFU-".length)) - 1;
    return index === 0 ? DEFAULT_WORKFLOW_ID : `custom:lane-${(index - 1) % distinct}`;
  };

  const store = {
    listTasks: vi.fn(async () => ids.map((id) => ({ id }))),
    listCompletedTasks: vi.fn(async () => ({ tasks: [] as Array<{ id: string }> })),
    resolveProjectColumnsForRoles: vi.fn(async () => ["done"]),
    getSettingsFast: vi.fn(async () => ({ defaultWorkflowId: DEFAULT_WORKFLOW_ID })),
    getSettings: vi.fn(async () => ({ defaultWorkflowId: DEFAULT_WORKFLOW_ID })),
    getTaskWorkflowSelectionsAsync: vi.fn(async (taskIds: string[]) => {
      if (options.holdRelease) await options.holdRelease();
      return new Map(taskIds.map((taskId) => [taskId, { workflowId: workflowFor(taskId), stepIds: [] }]));
    }),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
    listWorkflowDefinitions: vi.fn(async () => catalog),
  };
  return store as unknown as FakeStore;
}

async function startServer(store: FakeStore) {
  const app = express();
  const router = express.Router();
  const ctx = {
    router,
    store,
    options: {},
    getProjectContext: async () => ({ store }),
    rethrowAsApiError: (err: unknown) => {
      throw err;
    },
  } as never;
  const upload = { single: () => (_req: unknown, _res: unknown, next: () => void) => next() };
  registerTaskWorkflowRoutes(ctx, { upload, runtimeLogger: { info() {}, warn() {}, error() {} } } as never);
  app.use("/api", router);
  const server = http.createServer(app);
  let requestCount = 0;
  server.on("request", () => { requestCount += 1; });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    /*
    Arrival of the Nth request is the deterministic point at which the route handler — and therefore the
    coalescer's entry lookup, which runs synchronously before its first await — has been reached. Waiting
    on this is what lets an in-flight join be proven by construction instead of by a race.
    */
    waitForRequests: (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => { if (requestCount >= count) resolve(); else setTimeout(check, 0); };
        check();
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("board-workflows route coalescing (RUFU-906)", () => {
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    clock = makeClock();
    // Both seams must be installed BEFORE the registrar constructs its coalescer.
    setAcrossNodesClockForTests(clock.now);
    setBoardWorkflowsTtlMsForTests(2_000);
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    setAcrossNodesClockForTests(Date.now);
    setBoardWorkflowsTtlMsForTests(2_000);
  });

  it("answers 8 concurrent identical requests with ONE underlying computation", async () => {
    /*
    FNXC:BoardWorkflowsCoalescing 2026-11-09-11:45 (RUFU-906):
    This is the measured production shape: eight tabs, one process, one loop. Each computation is a
    whole-table id enumeration plus one batched selection read, so eight concurrent copies is eight
    copies of the work that already holds a core — and `pg_stat_activity` says the database spent that
    time parked on `Client:ClientRead`, idle and waiting for us.
    */
    const store = makeStore({ cardCount: 500 });
    server = await startServer(store);
    const url = server.url("/api/tasks/board-workflows?projectId=proj_a");

    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_TABS }, () => fetch(url).then((res) => res.json() as Promise<{
        flagEnabled: boolean;
        defaultWorkflowId: string;
        workflows: unknown[];
        taskWorkflowIds: Record<string, string>;
      }>)),
    );

    expect(store.listTasks).toHaveBeenCalledTimes(1);
    expect(store.getTaskWorkflowSelectionsAsync).toHaveBeenCalledTimes(1);
    // Joining must not cost the joiner anything: all eight get the same complete answer.
    for (const payload of responses) {
      expect(Object.keys(payload.taskWorkflowIds)).toHaveLength(500);
      expect(payload.flagEnabled).toBe(true);
    }
    expect(new Set(responses.map((payload) => JSON.stringify(payload))).size).toBe(1);
  });

  it("joins a computation that outlives the TTL rather than starting a second one", async () => {
    /*
    FNXC:BoardWorkflowsCoalescing 2026-11-09-11:45 (RUFU-906):
    The bound that matters in production: the underlying read measured up to 60 s, so it is ALWAYS
    longer than the TTL. If the TTL capped how long a caller may join, every tab would start its own
    60 s copy every 5 s and the coalescer would change nothing. Staleness is bounded from COMPLETION;
    in-flight joins are unbounded. The read here is held open past the TTL by the test, so the second
    answer can only have come from the first computation.
    */
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let signalEntered: () => void = () => {};
    const selectionReadEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const store = makeStore({
      cardCount: 100,
      holdRelease: () => {
        signalEntered();
        return gate;
      },
    });
    server = await startServer(store);
    const url = server.url("/api/tasks/board-workflows?projectId=proj_a");

    const first = fetch(url);
    await server.waitForRequests(1);
    await selectionReadEntered;
    // Move the clock well past the TTL while the computation is still running.
    clock.advance(30_000);
    const second = fetch(url);
    await server.waitForRequests(2);
    // Only now is a second computation *avoidable*, so only now is releasing the first one evidence.
    release();

    const [a, b] = await Promise.all([first, second].map((res) => res.then((r) => r.json())));

    expect(store.listTasks).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("recomputes after the TTL instead of serving an expired entry", async () => {
    /*
    FNXC:BoardWorkflowsCoalescing 2026-11-09-11:45 (RUFU-906):
    An expired entry is a genuine miss — UNKNOWN, never EMPTY and never the stale value. Proven by
    moving the clock past the bound and asserting a SECOND whole-table read happens.
    */
    const store = makeStore({ cardCount: 20 });
    server = await startServer(store);
    const url = server.url("/api/tasks/board-workflows?projectId=proj_a");

    await fetch(url);
    clock.advance(1_999);
    await fetch(url);
    expect(store.listTasks).toHaveBeenCalledTimes(1);

    clock.advance(2);
    await fetch(url);
    expect(store.listTasks).toHaveBeenCalledTimes(2);
  });

  it("never shares a payload across principals", async () => {
    /*
    FNXC:BoardWorkflowsCoalescing 2026-11-09-11:45 (RUFU-906):
    Project visibility is RLS-enforced, so a payload computed for one principal may not be handed to
    another — the lane vocabulary of a project a caller cannot see would leak through the cache key.
    Two bearer tokens are two principals and must each get their own computation.
    */
    const store = makeStore({ cardCount: 5 });
    server = await startServer(store);
    const url = server.url("/api/tasks/board-workflows?projectId=proj_a");

    await Promise.all([
      fetch(url, { headers: { authorization: "Bearer principal-one" } }),
      fetch(url, { headers: { authorization: "Bearer principal-two" } }),
    ]);

    expect(store.listTasks).toHaveBeenCalledTimes(2);
  });

  it("keeps a different query a separate entry", async () => {
    /*
    FNXC:BoardWorkflowsCoalescing 2026-11-09-11:45 (RUFU-906):
    `scope=lanes` deliberately spends zero task reads while the full request spends the enumeration; if
    the query string were not part of the key, whichever arrived first would decide the other's answer.
    */
    const store = makeStore({ cardCount: 5 });
    server = await startServer(store);

    await fetch(server.url("/api/tasks/board-workflows?projectId=proj_a&scope=lanes"));
    await fetch(server.url("/api/tasks/board-workflows?projectId=proj_a"));

    expect(store.listTasks).toHaveBeenCalledTimes(1);
  });

  it("recomputes every request when the TTL is 0 (the no-redeploy rollback)", async () => {
    setBoardWorkflowsTtlMsForTests(0);
    await server?.close();
    const store = makeStore({ cardCount: 5 });
    server = await startServer(store);
    const url = server.url("/api/tasks/board-workflows?projectId=proj_a");

    await Promise.all(Array.from({ length: 3 }, () => fetch(url)));

    // `0` is the no-redeploy rollback: the route does its own work per request, exactly as it did before
    // this slice existed — no join, no entry, no cached answer.
    expect(store.listTasks).toHaveBeenCalledTimes(3);
  });

  it("parses the TTL knob with `0` meaning off and anything past one poll clamped", () => {
    expect(resolveBoardWorkflowsTtlMs(undefined)).toBe(2_000);
    expect(resolveBoardWorkflowsTtlMs("")).toBe(2_000);
    expect(resolveBoardWorkflowsTtlMs("not-a-number")).toBe(2_000);
    expect(resolveBoardWorkflowsTtlMs("-1")).toBe(2_000);
    expect(resolveBoardWorkflowsTtlMs("0")).toBe(0);
    expect(resolveBoardWorkflowsTtlMs("750")).toBe(750);
    // No operator typo may widen the staleness bound past one client poll.
    expect(resolveBoardWorkflowsTtlMs("600000")).toBe(PROJECTS_POLL_INTERVAL_MS);
  });
});

describe("board-workflows per-card resolution scaling (RUFU-906)", () => {
  /** Distinct-workflow catalog: one default lane plus `distinct` custom lanes. */
  function catalogWith(distinct: number): WorkflowDefinition[] {
    return [
      { id: DEFAULT_WORKFLOW_ID, name: "Coding", kind: "workflow", ir: BUILTIN_CODING_WORKFLOW_IR } as unknown as WorkflowDefinition,
      ...Array.from({ length: distinct }, (_unused, index) => ({
        id: `custom:lane-${index}`,
        name: `Lane ${index}`,
        kind: "workflow",
        ir: { ...BUILTIN_CODING_WORKFLOW_IR, name: `Lane ${index}` },
      }) as unknown as WorkflowDefinition),
    ];
  }

  function makeBuilderStore(cardCount: number, distinct: number) {
    const catalog = catalogWith(distinct);
    const calls = { selectionsAsync: 0, selectionAsync: 0, selectionSync: 0, workflowDefinition: 0, describedIds: [] as string[] };
    const workflowFor = (taskId: string): string => {
      if (distinct === 0) return DEFAULT_WORKFLOW_ID;
      const index = Number(taskId.slice("RUFU-".length)) - 1;
      return index === 0 ? DEFAULT_WORKFLOW_ID : `custom:lane-${(index - 1) % distinct}`;
    };
    const store = {
      getWorkflowSettingsProjectId: () => "proj_scale",
      getSettings: async () => ({ defaultWorkflowId: DEFAULT_WORKFLOW_ID }),
      getTaskWorkflowSelectionsAsync: async (taskIds: string[]) => {
        calls.selectionsAsync += 1;
        return new Map(taskIds.map((taskId) => [taskId, { workflowId: workflowFor(taskId), stepIds: [] }]));
      },
      getWorkflowDefinition: async (id: string) => {
        calls.workflowDefinition += 1;
        calls.describedIds.push(id);
        const row = catalog.find((entry) => entry.id === id);
        return row ? { id: row.id, name: row.name, ir: row.ir } : undefined;
      },
      listWorkflowDefinitions: async () => catalog,
    };
    return { store: store as never, calls, ids: Array.from({ length: cardCount }, (_unused, index) => `RUFU-${index + 1}`) };
  }

  it("does not grow resolution calls with card count for distinct-workflow reads", async () => {
    /*
    FNXC:BoardWorkflowsCost 2026-11-09-11:45 (RUFU-906):
    The scaling claim, asserted as counts rather than as milliseconds. Per-card workflow resolution goes
    through core's `prefetchWorkflowSelections` seam: ONE `inArray` batch per computation and then
    `Map.get` per card, and the describe fan-out is a function of the DISTINCT workflows in the catalog,
    not of how many cards sit in them. 50x the cards must not be 50x the reads.
    */
    const small = makeBuilderStore(100, 10);
    const large = makeBuilderStore(5_000, 10);
    const smallPayload = await buildBoardWorkflowsPayload(small.store, small.ids);
    const largePayload = await buildBoardWorkflowsPayload(large.store, large.ids);

    expect(large.calls.selectionsAsync).toBe(small.calls.selectionsAsync);
    expect(large.calls.workflowDefinition).toBe(small.calls.workflowDefinition);
    // No per-card read leaked in at board scale.
    expect(large.calls.selectionAsync ?? 0).toBe(0);
    expect(large.calls.selectionSync ?? 0).toBe(0);
    // The answer is still complete, not merely cheap: every card is mapped and every lane is described.
    expect(Object.keys(largePayload.taskWorkflowIds)).toHaveLength(5_000);
    expect(largePayload.workflows).toHaveLength(smallPayload.workflows.length);
    // Distinct-workflow coverage really was exercised.
    expect(new Set(Object.values(largePayload.taskWorkflowIds)).size).toBe(11);
  });

  it("reads only the ids a partly warm caller is missing", async () => {
    /*
    FNXC:BoardWorkflowsCost 2026-11-09-11:45 (RUFU-906):
    The seam half of the slice: the builder now consumes core's caller-owned `WorkflowSelectionCache`
    instead of owning the fan-out, so a caller that already resolved most of the board reads only the
    gap. Before the change this argument did not exist and every request re-read every id.
    */
    const { store, calls, ids } = makeBuilderStore(1_000, 4);
    const warm: WorkflowSelectionCache = new Map();
    for (const taskId of ids.slice(0, 950)) {
      warm.set(taskId, { workflowId: DEFAULT_WORKFLOW_ID, stepIds: [] });
    }

    const payload = await buildBoardWorkflowsPayload(store, ids, undefined, undefined, warm);

    expect(calls.selectionsAsync).toBe(1);
    expect(warm.size).toBe(1_000);
    // The gap read must have covered the 50 unseen ids and nothing that was already resolved.
    expect(Object.keys(payload.taskWorkflowIds)).toHaveLength(1_000);
  });
});
