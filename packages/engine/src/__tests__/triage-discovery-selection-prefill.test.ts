import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { TriageProcessor } from "../triage.js";

/*
FNXC:TriageSelectionPrefill 2026-11-05-23:31 (RUFU-584 slice 2) — acceptance.
`discoverReadyPlanningTasks` is the triage poll, the engine's hottest loop. It resolves each candidate's
workflow IR, and every IR resolution begins by reading that card's `task_workflow_selection` row. With only
`irCache` threaded, cards sharing a workflow shared the PARSE but not the selection read, so a pass cost one
selection read per candidate — scaling with the planning backlog, which is exactly what grows on a throttled
board (203 RunFusion cards sat on `plan-no-admission` while this was measured).

These tests count READS, not behavior:
  * a store WITH the batch API must be asked exactly once, and must not be asked per card;
  * the singular count reaching zero also proves the prefilled cache is the SAME object the resolver reads,
    because a second cache would leave every candidate to pay its own read;
  * a store WITHOUT the batch API must still discover every candidate, so the optimization can never drop a
    card — the documented cost is N singular reads, unchanged from before.
*/

const WF = "wf-discovery";

function discoveryIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", name: "done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function card(id: string): Task {
  return {
    id,
    title: id,
    description: "seed",
    column: "todo",
    status: null,
    paused: false,
    userPaused: false,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
  } as Task;
}

/**
 * A store that answers selection reads and counts them by shape.
 * `batchApi: false` removes `getTaskWorkflowSelectionsAsync` entirely, which is what `prefetchWorkflowSelections`
 * is written to survive.
 */
function countingStore(opts: { batchApi: boolean; onBatch?: (ids: readonly string[]) => void }) {
  const counters = { singles: 0, batchedCalls: 0, batchedIds: 0 };
  const selection = { workflowId: WF, stepIds: [] as string[] };
  const ir = discoveryIr();
  const store = {
    on: vi.fn(),
    off: vi.fn(),
    getTask: vi.fn(async () => undefined),
    listTasks: vi.fn(async () => []),
    getSettings: vi.fn().mockResolvedValue({}),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => {
      counters.singles += 1;
      return selection;
    }),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
    logEntry: vi.fn(),
  } as unknown as Record<string, unknown> & TaskStore;
  if (opts.batchApi) {
    store.getTaskWorkflowSelectionsAsync = vi.fn(async (ids: string[]) => {
      counters.batchedCalls += 1;
      counters.batchedIds += ids.length;
      opts.onBatch?.(ids);
      return new Map(ids.map((id) => [id, selection]));
    });
  }
  return { store: store as TaskStore, counters };
}

async function discover(store: TaskStore, tasks: Task[]): Promise<string[]> {
  const processor = new TriageProcessor(store, "/test/project");
  const found = await (processor as unknown as {
    discoverReadyPlanningTasks: (t: Task[], now: number) => Promise<Task[]>;
  }).discoverReadyPlanningTasks(tasks, Date.parse("2026-02-01T00:00:00.000Z"));
  return found.map((t) => t.id);
}

describe("planning discovery prefills workflow selections", () => {
  const cards = ["RUFU-1", "RUFU-2", "RUFU-3", "RUFU-4", "RUFU-5", "RUFU-6"].map(card);

  it("reads every candidate's selection in ONE batch and pays no per-card read", async () => {
    const seenIds: string[] = [];
    const { store, counters } = countingStore({ batchApi: true, onBatch: (ids) => seenIds.push(...ids) });

    const discovered = await discover(store, cards);

    // The fixture must actually exercise the resolver, or a zero read count would prove nothing.
    expect(discovered).toHaveLength(cards.length);
    expect(counters.batchedCalls).toBe(1);
    expect(counters.batchedIds).toBe(cards.length);
    expect(counters.singles).toBe(0);
    expect(new Set(seenIds).size).toBe(cards.length);
  });

  it("degrades to per-card reads rather than dropping cards when the store has no batch API", async () => {
    const { store, counters } = countingStore({ batchApi: false });

    const discovered = await discover(store, cards);

    expect(discovered).toHaveLength(cards.length);
    expect(counters.batchedCalls).toBe(0);
    expect(counters.singles).toBe(cards.length);
  });
});
