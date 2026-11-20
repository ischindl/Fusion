// @vitest-environment node

/*
FNXC:TasksListReadScope 2026-11-20-07:40 (RUFU-585):
`GET /api/tasks` changed its READ SHAPE twice on this card and neither change is visible in the
response:

1. `definitionsOnce` (register-task-workflow-routes.ts) — one `listWorkflowDefinitions()` read per
   request, shared by the `excludeDone=1` complete-lane resolution and the hold-lane resolution in
   the enrichment block. Before the memo, the dashboard's DEFAULT board load (`excludeDone=1`) paid
   TWO catalog reads plus two `parseWorkflowIr` validation passes over every definition in the
   project, because the two resolutions sit in different blocks and each called
   `resolveProjectColumnsForRoles(store, …)` on the raw store.
2. `prefetchWorkflowSelections` — one batched selection read for the enrichment loop instead of one
   awaited `getTaskWorkflowSelection` per row. The loop shares an IR cache but had no selection
   cache, and the resolver's documented rule without one is to read live per call and cache
   nothing, so a 20-card hold page on ONE workflow issued 20 selection reads.

Both are invisible on the wire — the payload is byte-identical, which is the card's own hard
requirement — so no payload assertion can own them. The route's own FNXC note states the symptom of
having no such test: the one-read contract was broken silently, on the most-called path, because
"nothing was incorrect per se, which is exactly why only a read count catches it."

These are therefore read-COUNT ratchets on the real route over a real ephemeral HTTP server, driven
in the shape the dashboard actually calls it, plus one payload-parity test that keeps the ratchet
from being paid for in changed behaviour. Same discipline as
`board-workflows-read-cost.test.ts`, for the same stated reason: a timing assertion on a loaded box
fails for the wrong reason and passes for no reason, so nothing here measures duration.
*/

import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  TASK_LIFECYCLE_FIELD,
  buildBootstrapPrompt,
  isTaskAwaitingPlanning,
} from "@fusion/core";
import { evaluateTaskReleaseGate } from "@fusion/engine";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";

const HOLD_LANE = "todo";
const WIP_LANE = "in-progress";

/**
 * Two CUSTOM workflow ids, not built-ins: a `builtin:*` id resolves from the in-process registry and
 * never reaches `getWorkflowDefinition`, so a fixture built on built-ins could not tell a shared IR
 * cache from a per-row definition read. Both carry a copy of the shipped coding graph, which is the
 * lane vocabulary the fixture rows sit in (`todo` holds, `in-progress` counts toward WIP).
 */
const WORKFLOW_IDS = ["WF-001", "WF-002"];

function workflowRow(id: string) {
  return {
    id,
    name: `name:${id}`,
    description: "",
    kind: "workflow",
    ir: { ...BUILTIN_CODING_WORKFLOW_IR, name: id },
    layout: {},
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
  };
}

const CATALOG = WORKFLOW_IDS.map((id) => workflowRow(id));

/** Deterministic per-card selection: the page alternates across both workflows. */
function selectionFor(taskId: string) {
  const index = Number.parseInt(taskId.slice(taskId.lastIndexOf("-") + 1), 10);
  return { workflowId: WORKFLOW_IDS[(Number.isFinite(index) ? index : 0) % WORKFLOW_IDS.length]!, stepIds: [] };
}

interface BoardRow {
  id: string;
  title: string;
  description: string;
  column: string;
  status: string | null;
  createdAt: string;
  updatedAt: string;
  workflowStepResults: Array<Record<string, unknown>>;
}

/**
 * A card resting at the hold door with its Plan Review gate satisfied. The satisfied row is not
 * decoration: `evaluateUnplannedForExecution` refuses on `plan-review-pending` before it ever reads
 * PROMPT.md, and without it every hold-lane row in this fixture would return the same verdict for
 * the same unrelated reason — the prompt-seed distinction the enrichment block exists to publish
 * would be unobservable.
 */
function boardRow(id: string, column: string): BoardRow {
  return {
    id,
    title: `Card ${id}`,
    description: `The original request recorded on ${id}.`,
    column,
    status: null,
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
    workflowStepResults: [{ workflowStepId: "plan-review", status: "passed", completedAt: "2026-11-20T00:00:00.000Z" }],
  };
}

/** The store surface `/api/tasks` actually touches, with every read it can issue represented. */
function makeStore(rows: BoardRow[], tasksDir: string) {
  return {
    listTasks: vi.fn(async () => rows.map((row) => ({ ...row }))),
    searchTasks: vi.fn(async () => []),
    getBranchProgressByTask: vi.fn(async () => new Map()),
    listWorkflowDefinitions: vi.fn(async () => CATALOG),
    getWorkflowDefinition: vi.fn(async (id: string) => CATALOG.find((row) => row.id === id)),
    getWorkflowSettingsProjectId: vi.fn(() => "proj_test"),
    getTaskWorkflowSelectionsAsync: vi.fn(async (taskIds: string[]) => new Map(
      taskIds.map((taskId) => [taskId, selectionFor(taskId)]),
    )),
    // A stray per-row read must still answer CORRECTLY: the enrichment block swallows every error
    // into an un-enriched payload, so a throwing fake would let a regression hide as a missing badge.
    // The invariant is the CALL COUNT, asserted below, not whether the read succeeds.
    getTaskWorkflowSelectionAsync: vi.fn(async (taskId: string) => selectionFor(taskId)),
    getTaskWorkflowSelection: vi.fn((taskId: string) => selectionFor(taskId)),
    // The engine's prompt leaf reaches the file through `getTasksDir` (see `readPromptObs`), while
    // the route's own read goes through `getTaskDir`. Both are provided so the fixture is a faithful
    // narrow store and `getTaskDir` counts exactly the route's per-row PROMPT.md reads.
    getTasksDir: vi.fn(() => tasksDir),
    getTaskDir: vi.fn((taskId: string) => join(tasksDir, taskId)),
  };
}

type FakeStore = ReturnType<typeof makeStore>;

const calls = (store: FakeStore, method: keyof FakeStore): number =>
  ((store[method] as { mock?: { calls?: unknown[] } }).mock?.calls?.length ?? 0);

/**
 * The reads that must stay flat in the page size — one per request, or one per DISTINCT workflow.
 * `getTaskDir` is deliberately excluded: the route's own contract is one PROMPT.md read per hold-lane
 * row and that scaling is asserted where it is the subject, not hidden in an aggregate.
 */
function sharedReadCount(store: FakeStore): number {
  return calls(store, "listWorkflowDefinitions")
    + calls(store, "getWorkflowDefinition")
    + calls(store, "getTaskWorkflowSelectionsAsync")
    + calls(store, "getTaskWorkflowSelectionAsync")
    + calls(store, "getTaskWorkflowSelection");
}

let tasksRoot = "";

beforeAll(() => {
  tasksRoot = mkdtempSync(join(tmpdir(), "rufu585-routes-read-cost-"));
});

afterAll(() => {
  rmSync(tasksRoot, { recursive: true, force: true });
});

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

/** Materialise one card's PROMPT.md; `null` leaves the directory absent, the ENOENT state. */
function writePrompt(taskId: string, content: string | null): void {
  if (content === null) return;
  mkdirSync(join(tasksRoot, taskId), { recursive: true });
  writeFileSync(join(tasksRoot, taskId, "PROMPT.md"), content, "utf-8");
}

const REAL_SPEC = [
  "# RUFU-902: A card that already has its specification",
  "",
  "## What This Delivers",
  "",
  "A real spec body — not the bootstrap stub — so the shared seed detector says 'planned'.",
  "",
].join("\n");

describe("GET /api/tasks per-request read cost (RUFU-585)", () => {
  let server: Awaited<ReturnType<typeof startServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("reads the workflow catalog ONCE for the default board load that asks for two lane vocabularies", async () => {
    const rows = [boardRow("RUFU-900", HOLD_LANE), boardRow("RUFU-901", HOLD_LANE)];
    rows.forEach((row) => writePrompt(row.id, REAL_SPEC));
    const store = makeStore(rows, tasksRoot);
    server = await startServer(store);

    const res = await fetch(server.url("/api/tasks?excludeDone=1&limit=20"));
    expect(res.status).toBe(200);

    // The defect: `excludeDone=1` resolves `complete` (for the WHERE clause) AND `hold` (for
    // enrichment), so the default board load issued two catalog reads and two full IR validation
    // passes. The memo is per-request, so one request still answers both vocabularies.
    expect(store.listWorkflowDefinitions).toHaveBeenCalledTimes(1);
    // And the two answers must stay SEPARATE — unioning them would hide hold-lane cards, which is a
    // correctness loss the memo was explicitly not allowed to buy.
    expect(store.listTasks).toHaveBeenCalledTimes(1);
    const listOptions = store.listTasks.mock.calls[0]![0] as { excludeColumns?: string[]; limit?: number };
    expect(listOptions.excludeColumns).toContain("done");
    expect(listOptions.limit).toBe(20);
  });

  it("answers a 20-card hold-lane page with one batched selection read and zero per-row selection reads", async () => {
    const rows = Array.from({ length: 20 }, (_unused, index) => boardRow(`RUFU-10${index}`, HOLD_LANE));
    rows.forEach((row) => writePrompt(row.id, REAL_SPEC));
    const store = makeStore(rows, tasksRoot);
    server = await startServer(store);

    const res = await fetch(server.url("/api/tasks?excludeDone=1&limit=20"));
    const payload = await res.json() as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(20);

    // One batched read, and it names the whole page — the batch is only real if it carries every id.
    expect(store.getTaskWorkflowSelectionsAsync).toHaveBeenCalledTimes(1);
    expect(store.getTaskWorkflowSelectionsAsync).toHaveBeenCalledWith(rows.map((row) => row.id));
    // The regression this pins: the resolver's no-selection-cache branch reads live per call.
    expect(store.getTaskWorkflowSelectionAsync).toHaveBeenCalledTimes(0);
    expect(store.getTaskWorkflowSelection).toHaveBeenCalledTimes(0);
    // O(1) per DISTINCT workflow, not per row: 20 rows across 2 workflows is 2 definition reads.
    expect(store.getWorkflowDefinition).toHaveBeenCalledTimes(WORKFLOW_IDS.length);
    // And at most one PROMPT.md read per returned row — exactly one for an all-hold page.
    expect(store.getTaskDir).toHaveBeenCalledTimes(20);
    // One catalog read + one definition read per distinct workflow + one batched selection read.
    expect(sharedReadCount(store)).toBe(1 + WORKFLOW_IDS.length + 1);
  });

  it("bounds PROMPT.md reads to the hold-lane rows returned, never to the whole page", async () => {
    // Surface Enumeration's worst case for the parse path is an all-hold page; the shape that proves
    // the BOUND is a page where most rows are elsewhere. 5 hold cards inside a 20-card page must cost
    // 5 reads, which is what makes the claim "never more than the page's rows" a real bound.
    const rows = [
      ...Array.from({ length: 5 }, (_unused, index) => boardRow(`RUFU-20${index}`, HOLD_LANE)),
      ...Array.from({ length: 15 }, (_unused, index) => boardRow(`RUFU-2${index}9`, WIP_LANE)),
    ];
    rows.forEach((row) => writePrompt(row.id, REAL_SPEC));
    const store = makeStore(rows, tasksRoot);
    server = await startServer(store);

    const res = await fetch(server.url("/api/tasks?excludeDone=1&limit=20"));
    expect(res.status).toBe(200);

    expect(store.getTaskDir).toHaveBeenCalledTimes(5);
    expect(store.getTaskDir.mock.calls.length).toBeLessThanOrEqual(20);
    // Rows outside the hold lanes carry neither enrichment key, so their payload is untouched.
    const payload = await res.json() as Array<Record<string, unknown>>;
    const wipRow = payload.find((row) => row.column === WIP_LANE)!;
    expect(wipRow).not.toHaveProperty("awaitingPlanning");
    expect(wipRow).not.toHaveProperty("releaseGate");
    expect(Object.keys(wipRow).sort()).toEqual([...Object.keys(boardRow("RUFU-209", WIP_LANE)), TASK_LIFECYCLE_FIELD].sort());
  });

  it("keeps shared reads flat as the page grows from 5 cards to 20", async () => {
    const build = (count: number) => Array.from({ length: count }, (_unused, index) => boardRow(`RUFU-3${String(index).padStart(2, "0")}`, HOLD_LANE));

    const smallRows = build(5);
    smallRows.forEach((row) => writePrompt(row.id, REAL_SPEC));
    const smallStore = makeStore(smallRows, tasksRoot);
    server = await startServer(smallStore);
    const smallRes = await fetch(server.url("/api/tasks?excludeDone=1&limit=20"));
    expect(await smallRes.json()).toHaveLength(5);
    const smallShared = sharedReadCount(smallStore);
    await server.close();
    server = undefined;

    const bigRows = build(20);
    bigRows.forEach((row) => writePrompt(row.id, REAL_SPEC));
    const bigStore = makeStore(bigRows, tasksRoot);
    server = await startServer(bigStore);
    const bigRes = await fetch(server.url("/api/tasks?excludeDone=1&limit=20"));
    expect(await bigRes.json()).toHaveLength(20);

    // 4x the cards, identical shared reads. Growth here means per-row fan-out is back.
    expect(sharedReadCount(bigStore)).toBe(smallShared);
    expect(calls(bigStore, "getTaskWorkflowSelectionsAsync")).toBe(1);
    expect(calls(bigStore, "getTaskWorkflowSelectionsAsync")).toBe(calls(smallStore, "getTaskWorkflowSelectionsAsync"));
    expect(calls(bigStore, "getTaskWorkflowSelectionAsync")).toBe(0);
    expect(calls(bigStore, "getTaskWorkflowSelection")).toBe(0);
    // The one read that legitimately scales is bounded to exactly one per hold row.
    expect(calls(bigStore, "getTaskDir")).toBe(20);
    expect(calls(bigStore, "getTaskDir")).toBe(4 * calls(smallStore, "getTaskDir"));
  });

  /*
  FNXC:TasksListReadScope 2026-11-20-07:40 (RUFU-585):
  The ratchet may not be paid for in behaviour. Three PROMPT.md states are carried on purpose:
  the bootstrap stub (unplanned), a real spec (planned), and no file at all (ENOENT, which the route
  encodes as "missing spec means unplanned"). The fourth row sits outside the hold lanes and must
  arrive byte-identical to what the store returned plus the lifecycle stamp, because the card's hard
  requirement is that the browser needs NO change at any breakpoint.
  */
  it("publishes the same enrichment the shared helpers answer, and leaves non-hold rows byte-identical", async () => {
    const seedRow = boardRow("RUFU-400", HOLD_LANE);
    const plannedRow = boardRow("RUFU-401", HOLD_LANE);
    const missingRow = boardRow("RUFU-402", HOLD_LANE);
    const wipRow = boardRow("RUFU-403", WIP_LANE);
    writePrompt(seedRow.id, buildBootstrapPrompt(seedRow.id, seedRow.title, seedRow.description));
    writePrompt(plannedRow.id, REAL_SPEC.replace("RUFU-902", "RUFU-401"));
    writePrompt(missingRow.id, null);
    writePrompt(wipRow.id, REAL_SPEC.replace("RUFU-902", "RUFU-403"));

    const store = makeStore([seedRow, plannedRow, missingRow, wipRow], tasksRoot);
    server = await startServer(store);
    const res = await fetch(server.url("/api/tasks?excludeDone=1&limit=20"));
    expect(res.status).toBe(200);
    const payload = await res.json() as Array<Record<string, unknown>>;
    const byId = Object.fromEntries(payload.map((row) => [row.id as string, row]));

    // awaitingPlanning is the shared predicate's answer over the file the route actually read.
    expect(byId[seedRow.id]!.awaitingPlanning).toBe(
      isTaskAwaitingPlanning(seedRow, buildBootstrapPrompt(seedRow.id, seedRow.title, seedRow.description)),
    );
    expect(byId[seedRow.id]!.awaitingPlanning).toBe(true);
    expect(byId[plannedRow.id]!.awaitingPlanning).toBe(
      isTaskAwaitingPlanning(plannedRow, REAL_SPEC.replace("RUFU-902", "RUFU-401")),
    );
    expect(byId[plannedRow.id]!.awaitingPlanning).toBe(false);
    expect(byId[missingRow.id]!.awaitingPlanning).toBe(isTaskAwaitingPlanning(missingRow, null));
    expect(byId[missingRow.id]!.awaitingPlanning).toBe(true);

    // The release gate is the engine's own verdict for the same row and the same resolved IR, not a
    // route-side restatement of it: a seed card is held, a specified card is not.
    const directGate = await evaluateTaskReleaseGate(
      store as never,
      seedRow as never,
      { ir: workflowRow(selectionFor(seedRow.id).workflowId).ir as never },
    );
    expect(directGate).toBeDefined();
    expect({ ...(directGate as object), evaluatedAt: undefined })
      .toEqual({ ...(byId[seedRow.id]!.releaseGate as object), evaluatedAt: undefined });
    expect((byId[seedRow.id]!.releaseGate as Record<string, unknown>).reason).toBe("seed-prompt");
    expect((byId[seedRow.id]!.releaseGate as Record<string, unknown>).promoteBlocked).toBe(true);
    expect((byId[plannedRow.id]!.releaseGate as Record<string, unknown>).reason).toBeNull();
    expect((byId[plannedRow.id]!.releaseGate as Record<string, unknown>).promoteBlocked).toBe(false);
    // Both hold cards name the same WIP target, so the badge pair is about the same door.
    expect((byId[plannedRow.id]!.releaseGate as Record<string, unknown>).releaseTargetColumn).toBe(WIP_LANE);
    expect((byId[plannedRow.id]!.releaseGate as Record<string, unknown>).targetCountsTowardWip).toBe(true);

    // Byte-compat: the untouched row carries exactly the store's keys plus the lifecycle stamp.
    expect(Object.keys(byId[wipRow.id]!).sort())
      .toEqual([...Object.keys(wipRow), TASK_LIFECYCLE_FIELD].sort());
    expect(byId[wipRow.id]![TASK_LIFECYCLE_FIELD]).toBe("live");
  });
});
