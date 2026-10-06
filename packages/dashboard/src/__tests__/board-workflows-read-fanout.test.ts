import { describe, expect, it, vi } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR } from "@fusion/core";
import { buildBoardWorkflowsPayload } from "../routes/board-workflows.js";

/*
FNXC:BoardLoad 2026-10-06-18:55 (RUFU-585):
`GET /tasks/board-workflows` was the slowest remaining board request: measured
13.2 s and 14.2 s for an 11 KB payload on the deployed dashboard, with a second
call still at 10.3 s, so nothing is cached across requests. Two fan-outs were
awaited serially inside `for … of` loops: per-card workflow-selection reads on
the fallback path, and per-workflow IR description. A request therefore paid the
SUM of every round-trip instead of the slowest one.

Live `pg_stat_activity` sampling cannot attribute those reads — the engine and
the dashboard share one process and triage resolves workflow IR per candidate
card on its own poll — so this file is the deterministic version of the same
question: call the payload builder with a counting store and assert the read
SHAPE. What matters is not the number of reads but whether they overlap: N
independent reads issued one-after-another is what made the board look dead.
*/

const CARD_COUNT = 120;
const DEFAULT_WORKFLOW_ID = "builtin:coding";
const CUSTOM_WORKFLOW_ID = "custom:release-train";

function makeTaskIds(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `SANE-${index + 1}`);
}

/** Tracks how many of a reader's calls were in flight at once. */
function makeConcurrencyProbe() {
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    async observe<T>(work: () => Promise<T>): Promise<T> {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await work();
      } finally {
        inFlight -= 1;
      }
    },
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

function makeStore(options: {
  selectionsAsyncAvailable: boolean
  workflowDefinitions?: Array<{ id: string; kind?: string }>;
  taskWorkflowId?: string;
}) {
  const calls = { selectionsAsync: 0, selectionAsync: 0, selectionSync: 0, workflowDefinition: 0 };
  const selectionProbe = makeConcurrencyProbe();
  const describeProbe = makeConcurrencyProbe();
  const workflowId = options.taskWorkflowId ?? DEFAULT_WORKFLOW_ID;

  const store = {
    getWorkflowSettingsProjectId: vi.fn(() => "proj_test"),
    getSettings: vi.fn(async () => ({ defaultWorkflowId: DEFAULT_WORKFLOW_ID })),
    getTaskWorkflowSelectionsAsync: vi.fn(async (taskIds: string[]) => {
      calls.selectionsAsync += 1;
      return new Map(taskIds.map((taskId) => [taskId, { workflowId, stepIds: [] }]));
    }),
    getTaskWorkflowSelectionAsync: vi.fn(async () => {
      calls.selectionAsync += 1;
      return selectionProbe.observe(async () => ({ workflowId, stepIds: [] as string[] }));
    }),
    getTaskWorkflowSelection: vi.fn(() => {
      calls.selectionSync += 1;
      return { workflowId, stepIds: [] as string[] };
    }),
    getWorkflowDefinition: vi.fn(async (id: string) =>
      describeProbe.observe(async () => {
        calls.workflowDefinition += 1;
        const definition = options.workflowDefinitions?.find((entry) => entry.id === id);
        if (!definition) return undefined;
        // A stored definition carries a compiled IR; the payload builder reads
        // `def.ir`, so a bare id/kind row would not survive describeWorkflow.
        return {
          id: definition.id,
          name: definition.id,
          description: "",
          kind: definition.kind ?? "workflow",
          ir: { ...BUILTIN_CODING_WORKFLOW_IR, name: definition.id },
          layout: {},
          createdAt: "2026-10-06T00:00:00.000Z",
          updatedAt: "2026-10-06T00:00:00.000Z",
        };
      }),
    ),
    listWorkflowDefinitions: vi.fn(async () => options.workflowDefinitions ?? []),
    getWorkflowPromptOverridesAsync: vi.fn(async () => ({})),
  };

  if (!options.selectionsAsyncAvailable) {
    delete (store as Record<string, unknown>).getTaskWorkflowSelectionsAsync;
  }

  return { store: store as never, calls, selectionProbe, describeProbe };
}

describe("buildBoardWorkflowsPayload read fan-out (RUFU-585)", () => {
  it("resolves every card's workflow selection in one batched read", async () => {
    const { store, calls } = makeStore({ selectionsAsyncAvailable: true });

    await buildBoardWorkflowsPayload(store, makeTaskIds(CARD_COUNT));

    expect(calls.selectionsAsync).toBe(1);
    expect(calls.selectionAsync).toBe(0);
    expect(calls.selectionSync).toBe(0);
  });

  it("overlaps the per-card selection reads when the store predates the batched reader", async () => {
    const { store, calls, selectionProbe } = makeStore({ selectionsAsyncAvailable: false });

    await buildBoardWorkflowsPayload(store, makeTaskIds(CARD_COUNT));

    // The fallback still reads per card (that is its contract for old stores),
    // but it must not await them one after another: serial reads are what made
    // a 120-card board take N round-trips of latency.
    expect(calls.selectionsAsync).toBe(0);
    expect(calls.selectionAsync + calls.selectionSync).toBeGreaterThan(1);
    expect(selectionProbe.maxInFlight).toBeGreaterThan(1);
  });

  it("overlaps workflow IR description and keeps the described order", async () => {
    const definitions = [
      { id: "custom:a", kind: "workflow" },
      { id: "custom:b", kind: "workflow" },
      { id: "custom:c", kind: "workflow" },
      { id: "custom:d", kind: "workflow" },
    ];
    const { store, describeProbe } = makeStore({ selectionsAsyncAvailable: true, workflowDefinitions: definitions });

    const payload = await buildBoardWorkflowsPayload(store, makeTaskIds(4));

    const ids = payload.workflows.map((workflow) => workflow.id);
    // Insertion order is the listing contract: the default workflow is seeded
    // first and the catalog follows, so a completion-ordered parallel fan-out
    // would visibly reshuffle the workflow picker.
    expect(ids).toEqual([DEFAULT_WORKFLOW_ID, "custom:a", "custom:b", "custom:c", "custom:d"]);
    expect(describeProbe.maxInFlight).toBeGreaterThan(1);
  });

  it("keeps per-card selection reads out of the batched path even for a large board", async () => {
    const { store, calls } = makeStore({
      selectionsAsyncAvailable: true,
      taskWorkflowId: CUSTOM_WORKFLOW_ID,
    });

    const payload = await buildBoardWorkflowsPayload(store, makeTaskIds(CARD_COUNT));

    expect(calls.selectionAsync).toBe(0);
    expect(Object.values(payload.taskWorkflowIds).filter((id) => id === CUSTOM_WORKFLOW_ID)).toHaveLength(CARD_COUNT);
  });
});
