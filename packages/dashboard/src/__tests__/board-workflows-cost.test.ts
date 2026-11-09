import { describe, expect, it } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR, type WorkflowDefinition, type WorkflowSelectionCache } from "@fusion/core";
import { buildBoardWorkflowsPayload } from "../routes/board-workflows.js";

/*
FNXC:BoardWorkflowsCost 2026-11-09-11:20 (RUFU-906):
`GET /api/tasks/board-workflows` saturates the dashboard's ONE event loop. Measured on the operator's
production host on 2026-11-09 across 25 projects: 1.95 / 2.43 / 4.07 / 4.79 / 9.34 / 24.7 / 35.6 / 57.3
/ 59.5 s, with three projects never answering inside a 60 s cap and `proj_87bc5b3f35624449` (alfawise)
not finishing inside 120 s.

Postgres was NOT the cause. During the 120 s call, `pg_stat_activity` showed 43 -> 13 active task
queries whose `wait_event` was `Client:ClientRead` — the DB was IDLE, waiting for us — while the
dashboard process held a steady 110 % CPU, i.e. one whole core. One loop, so every other UI read queues
behind it: the operator's "first tab is fast, the rest lag".

This file is the measurement half, in the counting-harness shape this repo already accepted
(`packages/core/src/task-store/__tests__/row-hydration-cost.test.ts` and `read-column-cost.test.ts`):
the expensive report is env-gated so CI never pays for it, and the counts it prints are what decide
which leg is O(cards) and which is O(workflows):

  FUSION_BOARD_WORKFLOWS_BENCH=1 nice -n 10 pnpm --filter @fusion/dashboard exec vitest run \
    src/__tests__/board-workflows-cost.test.ts --silent=passed-only --reporter=basic

The store is production-shaped, not production: it answers without I/O so the numbers attribute to
event-loop work rather than to the network. A fake that returns instantly is the honest floor for the
question "what does the REQUEST PATH cost per card?", and it is deliberately not a mock-the-world shell —
the builder is the real function and the reads are the real read shapes it issues.
*/

/** Production's catalog size on the measured host; the lane vocabulary is bounded by this, not by cards. */
const CATALOG_SIZE = 11;
const DEFAULT_WORKFLOW_ID = "builtin:coding";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** One catalog entry shaped like `listWorkflowDefinitions()` output: id, name, kind, compiled IR. */
function catalogEntry(index: number): WorkflowDefinition {
  const id = index === 0 ? DEFAULT_WORKFLOW_ID : `custom:workflow-${index}`;
  return {
    id,
    name: id,
    description: "",
    kind: "workflow",
    ir: { ...BUILTIN_CODING_WORKFLOW_IR, name: id },
    layout: {},
    createdAt: "2026-11-09T00:00:00.000Z",
    updatedAt: "2026-11-09T00:00:00.000Z",
  } as unknown as WorkflowDefinition;
}

function makeCardIds(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `RUFU-${index + 1}`);
}

/**
 * Production-shaped read counter.
 *
 * The selection reader builds a Map of one entry per card because that is what the real batched reader
 * does (`getTaskWorkflowSelectionsAsyncImpl` maps result rows into a Map); omitting that would flatter
 * the per-card leg. Cards are spread across the catalog so the distinct-workflow count is realistic.
 */
function makeBenchStore(cardCount: number, catalog: WorkflowDefinition[]) {
  const calls = {
    selectionsAsync: 0,
    selectionAsync: 0,
    selectionSync: 0,
    workflowDefinition: 0,
    /** The id list the ONE batched read was asked for — what a partly warm cache must shrink. */
    selectionIds: [] as string[],
  };
  const store = {
    getWorkflowSettingsProjectId: () => "proj_bench",
    getSettings: async () => ({ defaultWorkflowId: DEFAULT_WORKFLOW_ID }),
    getTaskWorkflowSelectionsAsync: async (taskIds: string[]) => {
      calls.selectionsAsync += 1;
      calls.selectionIds = taskIds;
      const map = new Map<string, { workflowId: string; stepIds: string[] }>();
      for (const taskId of taskIds) {
        const index = Number(taskId.slice("RUFU-".length)) - 1;
        map.set(taskId, { workflowId: catalog[index % catalog.length]!.id, stepIds: [] });
      }
      return map;
    },
    // A listing row is allowed to be an id/kind stub, so a catalog hit must still be describable.
    getWorkflowDefinition: async (id: string) => {
      calls.workflowDefinition += 1;
      const row = catalog.find((entry) => entry.id === id);
      return row ? { id: row.id, name: row.name, ir: row.ir } : undefined;
    },
    listWorkflowDefinitions: async () => catalog,
    getWorkflowPromptOverridesAsync: async () => ({}),
  };
  return { store: store as never, calls };
}

const REPEATS = 7;

type Sample = {
  cardCount: number;
  ms: number;
  usPerCard: number;
  selectionsAsync: number;
  workflowDefinitionReads: number;
  payloadBytes: number;
};

async function sample(cardCount: number, catalog: WorkflowDefinition[]): Promise<Sample> {
  const ids = makeCardIds(cardCount);
  const runOnce = async () => {
    const { store, calls } = makeBenchStore(cardCount, catalog);
    const t0 = performance.now();
    const payload = await buildBoardWorkflowsPayload(store, ids);
    const ms = performance.now() - t0;
    return { ms, calls, payload };
  };
  await runOnce(); // warm
  const timings: number[] = [];
  let last = await runOnce();
  for (let pass = 0; pass < REPEATS; pass += 1) {
    last = await runOnce();
    timings.push(last.ms);
  }
  const ms = median(timings);
  return {
    cardCount,
    ms: round(ms, 1),
    usPerCard: round((ms * 1000) / cardCount, 2),
    selectionsAsync: last.calls.selectionsAsync,
    workflowDefinitionReads: last.calls.workflowDefinition,
    payloadBytes: JSON.stringify(last.payload).length,
  };
}

describe.skipIf(!process.env.FUSION_BOARD_WORKFLOWS_BENCH)(
  "board-workflows payload — per-card cost report (report-only, FUSION_BOARD_WORKFLOWS_BENCH=1)",
  () => {
    it("reports us/card and total ms for 100 / 1 000 / 5 000 cards", async () => {
      const catalog = Array.from({ length: CATALOG_SIZE }, (_unused, index) => catalogEntry(index));
      const samples: Sample[] = [];
      for (const cardCount of [100, 1_000, 5_000]) {
        samples.push(await sample(cardCount, catalog));
      }

      const lines = [
        "",
        `=== BOARD-WORKFLOWS PAYLOAD COST (median of ${REPEATS} passes, catalog ${CATALOG_SIZE} workflows) ===`,
        "cards   total ms   us/card   selection-reads   definition-reads   payload KB",
        ...samples.map((s) =>
          `${String(s.cardCount).padStart(5)}   ${String(s.ms).padStart(8)}   ${String(s.usPerCard).padStart(7)}   ${String(s.selectionsAsync).padStart(15)}   ${String(s.workflowDefinitionReads).padStart(16)}   ${String(round(s.payloadBytes / 1024, 1)).padStart(10)}`,
        ),
        "",
        `scaling 100 -> 5000 cards: ${round(samples[2]!.ms / Math.max(samples[0]!.ms, 1e-6), 1)}x time for 50x cards`,
        `us/card 100 -> 5000 cards: ${round(samples[2]!.usPerCard / Math.max(samples[0]!.usPerCard, 1e-6), 2)}x`,
        `definition reads stay at the catalog size regardless of card count: ${[...new Set(samples.map((s) => s.workflowDefinitionReads))].join(", ")}`,
        "",
      ];
      // eslint-disable-next-line no-console
      console.log(lines.join("\n"));

      // The report is only meaningful if the shape it describes is the shape production has: one
      // batched selection read, zero per-card reads, and per-workflow describes bounded by the catalog.
      for (const s of samples) {
        expect(s.selectionsAsync).toBe(1);
        expect(s.workflowDefinitionReads).toBeLessThanOrEqual(CATALOG_SIZE);
      }
    });
  },
);

describe("board-workflows payload — read shape (always-on, no timing)", () => {
  it("issues one batched selection read and no per-card read at board size", async () => {
    const catalog = Array.from({ length: CATALOG_SIZE }, (_unused, index) => catalogEntry(index));
    const { store, calls } = makeBenchStore(1_000, catalog);
    const payload = await buildBoardWorkflowsPayload(store, makeCardIds(1_000));

    expect(calls.selectionsAsync).toBe(1);
    expect(calls.selectionSync).toBe(0);
    expect(payload.taskWorkflowIds["RUFU-1"]).toBeDefined();
    expect(payload.workflows.length).toBeGreaterThanOrEqual(CATALOG_SIZE);
  });

  it("keeps describe calls off the card count", async () => {
    const catalog = Array.from({ length: CATALOG_SIZE }, (_unused, index) => catalogEntry(index));
    const small = makeBenchStore(10, catalog);
    const large = makeBenchStore(5_000, catalog);
    const smallPayload = await buildBoardWorkflowsPayload(small.store, makeCardIds(10));
    const largePayload = await buildBoardWorkflowsPayload(large.store, makeCardIds(5_000));

    // Distinct workflows are a property of the catalog, so the describe fan-out must not move.
    expect(large.calls.workflowDefinition).toBe(small.calls.workflowDefinition);
    expect(largePayload.workflows.map((w) => w.id).sort())
      .toEqual(smallPayload.workflows.map((w) => w.id).sort());
  });

  it("serves a caller that already resolved these cards without any selection read", async () => {
    /*
    FNXC:BoardWorkflowsCost 2026-11-09-11:35 (RUFU-906):
    The seam half of the slice. Before it, `buildBoardWorkflowsPayload` owned its selection pass
    entirely: a caller that had ALREADY resolved these ids — a board hydration pass, or the same card
    set one poll later — could not hand what it had over, and every request re-read every id. The
    caller-owned `WorkflowSelectionCache` is core's existing shape for exactly this, so the builder now
    consumes it instead of re-deriving the fan-out. A warm cache must mean ZERO store reads.
    */
    const catalog = Array.from({ length: CATALOG_SIZE }, (_unused, index) => catalogEntry(index));
    const ids = makeCardIds(200);
    const warm: WorkflowSelectionCache = new Map();
    for (const [index, taskId] of ids.entries()) {
      warm.set(taskId, { workflowId: catalog[index % catalog.length]!.id, stepIds: [] });
    }
    const { store, calls } = makeBenchStore(200, catalog);
    const payload = await buildBoardWorkflowsPayload(store, ids, undefined, catalog, warm);

    expect(calls.selectionsAsync).toBe(0);
    expect(calls.selectionSync).toBe(0);
    // Warm must mean identical: the cache changes how the answer is obtained, never what it is.
    const cold = makeBenchStore(200, catalog);
    const coldPayload = await buildBoardWorkflowsPayload(cold.store, ids, undefined, catalog);
    expect(payload.taskWorkflowIds).toEqual(coldPayload.taskWorkflowIds);
    expect(cold.calls.selectionsAsync).toBe(1);
  });

  it("reads only the ids a partly warm cache is still missing", async () => {
    /*
    FNXC:BoardWorkflowsCost 2026-11-09-11:35 (RUFU-906):
    Partial warmth is the common case — the route already resolved the board's current cards and the
    newest Done page arrives as extra ids. The seam reads the gap, not the whole id list.
    */
    const catalog = Array.from({ length: CATALOG_SIZE }, (_unused, index) => catalogEntry(index));
    const ids = makeCardIds(300);
    const missing = ids.slice(250);
    const warm: WorkflowSelectionCache = new Map();
    for (const taskId of ids.slice(0, 250)) warm.set(taskId, { workflowId: DEFAULT_WORKFLOW_ID, stepIds: [] });
    const { store, calls } = makeBenchStore(300, catalog);

    await buildBoardWorkflowsPayload(store, ids, undefined, catalog, warm);

    expect(calls.selectionsAsync).toBe(1);
    // The read set is exactly the gap. Compared against the gap captured BEFORE the call, because the
    // seam writes what it reads back into the same cache, so `warm.has(id)` is true for the new ids too.
    expect([...calls.selectionIds].sort()).toEqual([...missing].sort());
  });

});
