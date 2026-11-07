import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPromptOverridesToIr, BUILTIN_CODING_WORKFLOW_IR, enumeratePromptBearingWorkflowNodes, getBuiltinWorkflow } from "@fusion/core";
import { buildBoardWorkflowsPayload } from "../routes/board-workflows.js";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";

/*
FNXC:BoardWorkflows 2026-11-07-12:41 (RUFU-871):
`GET /api/tasks/board-workflows` stopped answering inside 30 s on the deployed node (curl exit 000,
0 bytes) while its sibling routes answered slowly but surely (`/api/tasks/page?limit=100`: 2.21 MB in
18.4 s). Two route-specific costs were named from measurement, not guessed:

1. The payload builder paid ONE awaited read per workflow it described. Measured live against a
   9.4 KB response describing 11 workflows: 9 single-row `getWorkflowPromptOverridesAsync` reads plus
   2 `getWorkflowDefinition` reads — 11 of the route's ~20 round trips. With the shared
   3-connection pool saturated, a single round trip costs seconds on that process (a repeat of the
   same `?partial=1` call measured 15.1 s and 3.5 s, and `pg_stat_activity` showed ZERO queries
   older than 300 ms in 30 of 32 samples — so the wait is the Node process, not SQL). A request
   shaped like "N round trips in series" therefore has no upper bound.

2. The unparameterized route materialised every current-task row as a fully hydrated `Task` purely
   to read `task.id`. `slim` sheds the `log` column and nothing else, so the SELECT still shipped
   ~10.8 MB for this project's 613 current rows (3.9 MB workflow_step_results, 2.7 MB description,
   2.4 MB comments/steering_comments, 1.4 MB source_*, 304 KB steps, 52 KB summary) and `rowToTask`
   hydrated all of it — the ~0.58 GiB-per-board allocation recorded on the RUFU-627 heap profile, and
   the reason GC sat at 12-19% of CPU samples during board load.

These tests are read-COUNT ratchets, not timing assertions: a timing test on a box this loaded fails
for the wrong reason and passes for no reason. Every assertion below is about how many store
round trips a request spends and on what shape of row, so it fails on the defect and nothing else.
*/

/** The 11 workflows the live project describes: 9 enabled built-ins plus 2 custom rows. */
const LIVE_BUILTIN_IDS = [
  "builtin:coding",
  "builtin:coding-ideas",
  "builtin:legacy-coding",
  "builtin:quick-fix",
  "builtin:review-heavy",
  "builtin:marketing",
  "builtin:stepwise-coding",
  "builtin:design",
  "builtin:lead-generation",
];
const LIVE_CATALOG = [...LIVE_BUILTIN_IDS, "WF-001", "WF-003"].map((id) => ({ id }));

function makeTaskIds(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `RUFU-${index + 1}`);
}

/**
 * A catalog row as `listWorkflowDefinitions()` really returns it: built-ins come from the shipped
 * `BUILTIN_WORKFLOWS` objects, customs from the `project.workflows` row. A fake that gave a built-in
 * some other IR would let the ratchet pass on a payload the route would never send.
 */
function catalogRow(id: string) {
  const builtin = getBuiltinWorkflow(id);
  return {
    id,
    name: `name:${id}`,
    description: "",
    kind: "workflow",
    ir: builtin ? builtin.ir : { ...BUILTIN_CODING_WORKFLOW_IR, name: id },
    layout: {},
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
  };
}

/** A store that counts every read the payload builder can issue. */
function makeCountingStore(options: {
  catalog: Array<{ id: string }>;
}) {
  const catalogRows = options.catalog.map((entry) => catalogRow(entry.id));
  const reads = {
    settings: 0,
    selectionsAsync: 0,
    listWorkflowDefinitions: 0,
    workflowDefinition: 0,
    promptOverrides: 0,
  };
  const store = {
    getWorkflowSettingsProjectId: vi.fn(() => "proj_test"),
    getSettings: vi.fn(async () => {
      reads.settings += 1;
      return { defaultWorkflowId: "builtin:coding" };
    }),
    getTaskWorkflowSelectionsAsync: vi.fn(async (taskIds: string[]) => {
      reads.selectionsAsync += 1;
      return new Map(taskIds.map((taskId) => [taskId, { workflowId: "builtin:coding", stepIds: [] }]));
    }),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    listWorkflowDefinitions: vi.fn(async () => {
      reads.listWorkflowDefinitions += 1;
      return catalogRows;
    }),
    getWorkflowDefinition: vi.fn(async (id: string) => {
      reads.workflowDefinition += 1;
      return catalogRows.find((row) => row.id === id);
    }),
    getWorkflowPromptOverridesAsync: vi.fn(async () => {
      reads.promptOverrides += 1;
      return {};
    }),
  };
  const totalReads = () => Object.values(reads).reduce((sum, value) => sum + value, 0);
  return { store: store as never, reads, catalogRows, totalReads };
}

describe("board-workflows payload read cost (RUFU-871)", () => {
  it("describes every catalogued workflow without issuing one read per workflow", async () => {
    const { store, reads } = makeCountingStore({ catalog: LIVE_CATALOG });

    const payload = await buildBoardWorkflowsPayload(store, makeTaskIds(1));

    // The described set is the whole point of the payload, so the ratchet may not be satisfied by
    // describing less: every catalogued workflow still has to arrive.
    expect(payload.workflows).toHaveLength(LIVE_CATALOG.length);
    // The defect: this pair used to equal 9 + 2 — one awaited round trip per described workflow.
    expect(reads.promptOverrides).toBe(0);
    expect(reads.workflowDefinition).toBe(0);
  });

  it("keeps total store reads constant as the board grows in cards AND in workflows", async () => {
    // Workflow axis: a 3-workflow project against a 12-workflow project. Each extra catalogued
    // workflow used to add exactly one awaited round trip to the request.
    const small = makeCountingStore({ catalog: [{ id: "builtin:coding" }, { id: "WF-001" }, { id: "WF-002" }] });
    await buildBoardWorkflowsPayload(small.store, makeTaskIds(1));
    const large = makeCountingStore({ catalog: [...LIVE_CATALOG, { id: "WF-004" }] });
    await buildBoardWorkflowsPayload(large.store, makeTaskIds(1));
    expect(large.totalReads()).toBe(small.totalReads());
    expect(large.catalogRows.length).toBeGreaterThan(small.catalogRows.length);

    // Card axis: 120 visible cards against 960, all resolving through one batched selection read.
    const few = makeCountingStore({ catalog: LIVE_CATALOG });
    await buildBoardWorkflowsPayload(few.store, makeTaskIds(120));
    const many = makeCountingStore({ catalog: LIVE_CATALOG });
    await buildBoardWorkflowsPayload(many.store, makeTaskIds(960));
    expect(many.totalReads()).toEqual(few.totalReads());
    expect(many.reads.selectionsAsync).toBe(1);
  });

  /*
  FNXC:BoardWorkflows 2026-11-07-12:41 (RUFU-871):
  This is the evidence that deleting the per-built-in prompt-override read is not a behaviour change.
  `applyPromptOverridesToIr` rewrites `nodes[].config.prompt` and nothing else; the payload describes a
  workflow from `ir.columns` and `ir.fields` only. So an IR that differs from another ONLY in node
  prompt text must describe identically — and if a future change ever puts prompt text, or anything
  derived from a node, on this wire, this test goes red and the deleted read has to come back.
  */
  it("describes a workflow identically whether or not a prompt override was applied to its IR", async () => {
    const builtinId = "builtin:coding";
    const baselineIr = getBuiltinWorkflow(builtinId)!.ir!;
    const targetNodeId = enumeratePromptBearingWorkflowNodes(baselineIr)[0]?.nodeId;
    expect(targetNodeId, "the built-in coding IR must expose a prompt/gate node for this invariant").toBeTruthy();

    // The override must genuinely land, or the comparison proves nothing.
    const overriddenIr = applyPromptOverridesToIr(baselineIr, { [targetNodeId!]: "OPERATOR OVERRIDE" });
    expect(overriddenIr).not.toBe(baselineIr);
    expect(JSON.stringify(overriddenIr)).toContain("OPERATOR OVERRIDE");

    const plain = makeCountingStore({ catalog: LIVE_CATALOG });
    const plainPayload = await buildBoardWorkflowsPayload(plain.store, makeTaskIds(1));

    const overridden = makeCountingStore({ catalog: LIVE_CATALOG });
    const overriddenCatalog = overridden.catalogRows.map((row) =>
      row.id === builtinId ? { ...row, ir: overriddenIr } : row,
    );
    const overriddenPayload = await buildBoardWorkflowsPayload(
      overridden.store,
      makeTaskIds(1),
      undefined,
      overriddenCatalog as never,
    );

    expect(overriddenPayload.workflows).toEqual(plainPayload.workflows);
    // The blunt form of the same claim: prompt text has no path onto this wire at all.
    expect(JSON.stringify(plainPayload)).not.toContain("OPERATOR OVERRIDE");
  });

  it("still resolves a selected workflow the catalog does not list through the per-workflow read", async () => {
    // A card may select a since-deleted custom workflow. That id has no catalog row, so the read is
    // the honest answer and the fail-soft to the catalog default IR must survive.
    const { store, reads } = makeCountingStore({ catalog: LIVE_CATALOG });
    store.getTaskWorkflowSelectionsAsync = vi.fn(async (taskIds: string[]) => new Map(
      taskIds.map((taskId) => [taskId, { workflowId: "WF-DELETED", stepIds: [] }]),
    )) as never;

    const payload = await buildBoardWorkflowsPayload(store, makeTaskIds(1));

    expect(reads.workflowDefinition).toBe(1);
    expect(payload.taskWorkflowIds["RUFU-1"]).toBe("WF-DELETED");
  });
});

/* ------------------------------------------------------------------ route seam */

type FakeStore = Record<string, ReturnType<typeof vi.fn>>;

/**
 * A store whose task rows carry `id` and NOTHING else, which is the assertion: if the route reads a
 * member beyond `id` off the enumeration, the response loses that card and this suite goes red.
 */
function makeRouteStore(cardCount: number): FakeStore {
  const cardIds = makeTaskIds(cardCount);
  const store: FakeStore = {
    getSettingsFast: vi.fn(async () => ({ defaultWorkflowId: "builtin:coding" })),
    getSettings: vi.fn(async () => ({ defaultWorkflowId: "builtin:coding" })),
    listTasks: vi.fn(async () => cardIds.map((id) => ({ id }))),
    listCompletedTasks: vi.fn(async (options: { limit?: number } = {}) => ({
      tasks: Array.from({ length: Math.min(options.limit ?? 50, 50) }, (_unused, index) => ({ id: `RUFU-DONE-${index}` })),
    })),
    listWorkflowDefinitions: vi.fn(async () => LIVE_CATALOG.map((entry) => catalogRow(entry.id))),
    getWorkflowDefinition: vi.fn(async () => undefined),
    getWorkflowPromptOverridesAsync: vi.fn(async () => ({})),
    getWorkflowSettingsProjectId: vi.fn(() => "proj_test"),
    getTaskWorkflowSelectionsAsync: vi.fn(async (taskIds: string[]) => new Map(
      taskIds.map((taskId) => [taskId, { workflowId: "builtin:coding", stepIds: [] }]),
    )),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => undefined),
  };
  return store;
}

function countRouteReads(store: FakeStore): number {
  return Object.values(store).reduce(
    (sum, fn) => sum + ((fn as { mock?: { calls?: unknown[] } }).mock?.calls?.length ?? 0),
    0,
  );
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("GET /tasks/board-workflows enumeration cost (RUFU-871)", () => {
  let server: Awaited<ReturnType<typeof startServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("asks the store for an id-only row instead of a whole board row", async () => {
    const store = makeRouteStore(3);
    server = await startServer(store);
    const res = await fetch(server.url("/api/tasks/board-workflows"));
    expect(res.status).toBe(200);

    expect(store.listTasks).toHaveBeenCalledTimes(1);
    // `fields: []` declares "none of the wide fields", so the SELECT stops shipping the ~10.8 MB of
    // description/steps/workflowStepResults/comments/source_* this route throws away, and the
    // per-card PROMPT.md re-parse is skipped. `derive: false` drops the nine per-row derivations and
    // their pass-level feeders, including a workflow-selection prefetch this route never consumes.
    expect(store.listTasks).toHaveBeenCalledWith(expect.objectContaining({ fields: [], derive: false }));
  });

  it("reads the workflow catalog once per request", async () => {
    const store = makeRouteStore(3);
    server = await startServer(store);
    await fetch(server.url("/api/tasks/board-workflows"));

    // The complete-lane vocabulary and the payload builder each issued their own catalog read before
    // RUFU-871, and `listWorkflowDefinitions()` re-reads settings and re-runs the plugin gate inside.
    expect(store.listWorkflowDefinitions).toHaveBeenCalledTimes(1);
  });

  it("spends the same number of store reads on a 300-card board as on a 3-card board", async () => {
    const smallStore = makeRouteStore(3);
    server = await startServer(smallStore);
    const smallRes = await fetch(server.url("/api/tasks/board-workflows"));
    const smallPayload = await smallRes.json();
    const smallReads = countRouteReads(smallStore);
    await server.close();
    server = undefined;

    const bigStore = makeRouteStore(300);
    server = await startServer(bigStore);
    const bigRes = await fetch(server.url("/api/tasks/board-workflows"));
    const bigPayload = await bigRes.json();
    const bigReads = countRouteReads(bigStore);

    expect(bigReads).toBe(smallReads);
    // And it still answers for every card while doing so — the ratchet may not be paid for in holes.
    expect(Object.keys(bigPayload.taskWorkflowIds)).toHaveLength(300 + 50);
    expect(Object.keys(smallPayload.taskWorkflowIds)).toHaveLength(3 + 50);
  });
});
