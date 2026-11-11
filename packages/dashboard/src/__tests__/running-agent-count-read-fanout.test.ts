/*
FNXC:RunningAgentCountSelectionBatch 2026-11-11-08:55:
`countRunningAgentsInStore` is a whole-board reader on a 5 s cadence (the metrics domain sampler) plus one
per footer request, and it runs on BOTH deployed hosts because both serve the dashboard server. RUFU-871
narrowed which COLUMNS its `listTasks` pulls; it did not narrow how often it pulls a workflow SELECTION:
`irCache` collapsed IR reads to one per workflow, but every task still resolved its own selection row.

Measured production shape (read-attribution seam + live `pg_stat_activity`): 843 + 310 open cards in the two
registered stores at a 5 s tick ⇒ ~230 single-row `task_workflow_selection` SELECTs per second, 64 953
`workflowSelection` reads in one 5-minute window, and 78 % of all active PostgreSQL time — the largest single
consumer of the main thread on the box. This file asserts the read SHAPE, not the count of work: what matters
is that the batch happened once rather than once per card, and that the number the reader returns does not
move either way.
*/
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR } from "@fusion/core";
import { countRunningAgentsInStore } from "../project-store-resolver.js";

const CARD_COUNT = 120;
/** Cards sitting in the WIP lane; these are the ones the predicate must keep counting. */
const RUNNING_COUNT = 3;
const DEFAULT_WORKFLOW_ID = "builtin:coding";

function makeTasks(): Array<Record<string, unknown>> {
  return Array.from({ length: CARD_COUNT }, (_unused, index) => ({
    id: `FAN-${index + 1}`,
    column: index < RUNNING_COUNT ? "in-progress" : "todo",
    status: null,
    paused: false,
    userPaused: false,
    checkedOutBy: index < RUNNING_COUNT ? "agent-1" : null,
    workflowStepResults: [],
  }));
}

function makeStore(options: { selectionsAsyncAvailable: boolean }) {
  const calls = { selectionsAsync: 0, selectionAsync: 0, selectionSync: 0, workflowDefinition: 0 };
  const tasks = makeTasks();
  const store = {
    listTasks: vi.fn(async () => tasks),
    getWorkflowSettingsProjectId: vi.fn(() => "proj_test"),
    getSettings: vi.fn(async () => ({ defaultWorkflowId: DEFAULT_WORKFLOW_ID })),
    getTaskWorkflowSelectionsAsync: vi.fn(async (taskIds: string[]) => {
      calls.selectionsAsync += 1;
      return new Map(taskIds.map((taskId) => [taskId, { workflowId: DEFAULT_WORKFLOW_ID, stepIds: [] }]));
    }),
    getTaskWorkflowSelectionAsync: vi.fn(async () => {
      calls.selectionAsync += 1;
      return { workflowId: DEFAULT_WORKFLOW_ID, stepIds: [] as string[] };
    }),
    getTaskWorkflowSelection: vi.fn(() => {
      calls.selectionSync += 1;
      return { workflowId: DEFAULT_WORKFLOW_ID, stepIds: [] as string[] };
    }),
    getWorkflowDefinition: vi.fn(async () => {
      calls.workflowDefinition += 1;
      return undefined;
    }),
    getWorkflowPromptOverridesAsync: vi.fn(async () => ({})),
  };

  if (!options.selectionsAsyncAvailable) {
    delete (store as Record<string, unknown>).getTaskWorkflowSelectionsAsync;
  }

  return { store: store as never, calls };
}

describe("countRunningAgentsInStore selection read fan-out", () => {
  it("reads every card's workflow selection in one batched read", async () => {
    const { store, calls } = makeStore({ selectionsAsyncAvailable: true });

    const running = await countRunningAgentsInStore(store);

    expect(running).toBe(RUNNING_COUNT);
    expect(calls.selectionsAsync).toBe(1);
    // The invariant: board size must not multiply round trips. Pre-fix this was CARD_COUNT single reads.
    expect(calls.selectionAsync).toBe(0);
    expect(calls.selectionSync).toBe(0);
  });

  it("counts identically when the store predates the batched reader", async () => {
    const { store, calls } = makeStore({ selectionsAsyncAvailable: false });

    const running = await countRunningAgentsInStore(store);

    // The answer is the reader's contract; the fallback only changes how it is paid for.
    expect(running).toBe(RUNNING_COUNT);
    expect(calls.selectionsAsync).toBe(0);
    expect(calls.selectionAsync).toBe(CARD_COUNT);
  });

  it("counts identically when the batched read fails", async () => {
    const { store, calls } = makeStore({ selectionsAsyncAvailable: true });
    calls.selectionsAsync = 0;
    (store as unknown as { getTaskWorkflowSelectionsAsync: ReturnType<typeof vi.fn> }).getTaskWorkflowSelectionsAsync
      .mockRejectedValueOnce(new Error("pool exhausted"));

    const running = await countRunningAgentsInStore(store);

    // A refused batch must degrade to today's per-task reads, never to a wrong count or a thrown read.
    expect(running).toBe(RUNNING_COUNT);
    expect(calls.selectionAsync).toBe(CARD_COUNT);
  });
});
