/*
FNXC:ListTasksDeriveOptOut 2026-09-09-11:35 (RUFU-202):
The hold-release sweep is the engine's release authority, and it decided releases from a full-board
read that measured avg 10.6 s / max 159.8 s live. RUFU-202 converts that read to
`{ derive: false, excludeLog: true }` — a shape that returns NO derived board signals, NO `log`
payload and NO list-side selection hydration.

Two claims had to be pinned to make that safe, and both live here:

1. The argument object is deliberate. The assertion is an EXACT object, not `objectContaining`, so a
   silently-readded `derive`, a dropped `excludeLog`, or a newly-passed option fails this test rather
   than quietly reverting the sweep to the most expensive read in the engine.
2. The read shape cannot move a release decision. The board fixture below is run through the sweep
   twice: once against a mock that mimics the OLD core contract (derived fields present, `log`
   populated, list-side selection hydration) and once against the CONVERTED contract (no derived
   fields, `log: []`, zero hydration). The golden vector below is byte-identical across both, which is
   only true because no release decision reads a derived field or the log. A future consumer that
   starts reading one will diverge here instead of silently releasing differently in production.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBootstrapPrompt, PLAN_REVIEW_GROUP_ID, type Task, type TaskStore, type WorkflowIr } from "@fusion/core";

import { resetHoldReleaseInstrumentation, runHoldReleaseSweep } from "../execution/hold-release.js";
import { getPromptPath } from "../execution/spec-staleness.js";

const roots: string[] = [];

function column(id: string, label: string, trait: string, config: Record<string, unknown> = {}) {
  return { id, label, traits: trait ? [{ trait, config }] : [] };
}

/** Hold → WIP(1) → Done: the capacity-release path with room for exactly one card. */
const capacityIr = {
  version: "v2",
  id: "custom:capacity",
  nodes: [],
  edges: [],
  columns: [
    column("hold", "Hold", "hold", { release: "capacity" }),
    column("wip", "WIP", "wip", { limit: 1 }),
    column("done", "Done", "complete"),
  ],
} as unknown as WorkflowIr;

/** Same shape as `capacityIr`, but its WIP column already has an occupant: capacity refuses. */
const fullIr = {
  version: "v2",
  id: "custom:full",
  nodes: [],
  edges: [],
  columns: [
    column("hold", "Hold", "hold", { release: "capacity" }),
    column("busy", "Busy", "wip", { limit: 1 }),
    column("done", "Done", "complete"),
  ],
} as unknown as WorkflowIr;

const manualIr = {
  version: "v2",
  id: "custom:manual",
  nodes: [],
  edges: [],
  columns: [
    column("hold", "Hold", "hold", { release: "manual" }),
    column("wip", "WIP", "wip", { limit: 4 }),
    column("done", "Done", "complete"),
  ],
} as unknown as WorkflowIr;

const dependencyIr = {
  version: "v2",
  id: "custom:dependency",
  nodes: [],
  edges: [],
  columns: [
    column("waiting", "Waiting", "hold", { release: "dependency" }),
    column("todo", "Todo", ""),
    column("done", "Done", "complete"),
  ],
} as unknown as WorkflowIr;

/**
 * A workflow whose Plan Review group sits on the hold column and defaults on: a planned card there
 * still has no approving plan-gate result row, so release must refuse it even though its PROMPT.md
 * is not a seed prompt.
 */
const gateIr = {
  version: "v2",
  id: "custom:gate",
  nodes: [
    { id: "start", kind: "start", column: "hold" },
    {
      id: PLAN_REVIEW_GROUP_ID,
      name: "Plan Review",
      kind: "optional-group",
      column: "hold",
      config: { defaultOn: true, template: { nodes: [], edges: [] } },
    },
    { id: "execute", kind: "prompt", column: "wip", config: { prompt: "execute" } },
    { id: "end", kind: "end", column: "done" },
  ],
  edges: [],
  columns: [
    column("hold", "Hold", "hold", { release: "capacity" }),
    column("wip", "WIP", "wip", { limit: 1 }),
    column("done", "Done", "complete"),
  ],
} as unknown as WorkflowIr;

const IR_BY_WORKFLOW: Record<string, WorkflowIr> = {
  "custom:capacity": capacityIr,
  "custom:full": fullIr,
  "custom:manual": manualIr,
  "custom:dependency": dependencyIr,
  "custom:gate": gateIr,
};

/** Every card's workflow pool assignment; also how the sweep partitions capacity slots. */
const WORKFLOW_BY_TASK: Record<string, string> = {
  "REL-1": "custom:capacity",
  "SEED-1": "custom:capacity",
  "REPLAN-1": "custom:capacity",
  "MANUAL-1": "custom:manual",
  "WAIT-1": "custom:dependency",
  "DEP-1": "custom:dependency",
  "FULL-1": "custom:full",
  "BUSY-1": "custom:full",
  "GATE-1": "custom:gate",
  "PAUSED-1": "custom:capacity",
  "BACKOFF-1": "custom:capacity",
};

/** Planned cards get a PROMPT.md that is not a seed prompt; seed cards get the bootstrap text. */
const PLANNED_PROMPT = "# Planned\n\n## Mission\nImplement the approved work.\n";

interface SeedCard {
  id: string;
  column: string;
  createdAt: string;
  /** Written to PROMPT.md; a seed card is unplanned (FN-245) and must be refused. */
  seed?: boolean;
  paused?: boolean;
  userPaused?: boolean;
  nextRecoveryAt?: string;
  status?: string;
  dependencies?: string[];
}

/**
 * The board fixture: one of every release-decision branch the sweep can take, ordered by
 * `createdAt` so evaluation order — and therefore the golden vector — is deterministic.
 */
const BOARD: SeedCard[] = [
  { id: "REL-1", column: "hold", createdAt: "2026-01-01T00:00:01.000Z" },
  { id: "SEED-1", column: "hold", createdAt: "2026-01-01T00:00:02.000Z", seed: true },
  { id: "REPLAN-1", column: "hold", createdAt: "2026-01-01T00:00:03.000Z", status: "needs-replan" },
  { id: "MANUAL-1", column: "hold", createdAt: "2026-01-01T00:00:04.000Z" },
  { id: "WAIT-1", column: "waiting", createdAt: "2026-01-01T00:00:05.000Z", dependencies: ["DEP-1"] },
  { id: "DEP-1", column: "todo", createdAt: "2026-01-01T00:00:06.000Z" },
  { id: "FULL-1", column: "hold", createdAt: "2026-01-01T00:00:07.000Z" },
  { id: "BUSY-1", column: "busy", createdAt: "2026-01-01T00:00:08.000Z" },
  { id: "GATE-1", column: "hold", createdAt: "2026-01-01T00:00:11.000Z" },
  { id: "PAUSED-1", column: "hold", createdAt: "2026-01-01T00:00:09.000Z", paused: true },
  { id: "BACKOFF-1", column: "hold", createdAt: "2026-01-01T00:00:10.000Z", nextRecoveryAt: "2099-01-01T00:00:00.000Z" },
];

/**
 * Golden release-decision vector, captured once against the baseline read shape and frozen here.
 * Sorted by task id because the sweep's evaluation order is a separate (tested) concern.
 */
const GOLDEN_VECTOR = {
  released: ["REL-1"],
  held: [
    { taskId: "FULL-1", reason: "downstream-full" },
    { taskId: "GATE-1", reason: "awaiting-planning:plan-review-pending" },
    { taskId: "MANUAL-1", reason: "manual-only" },
    { taskId: "REPLAN-1", reason: "awaiting-planning:needs-replan" },
    { taskId: "SEED-1", reason: "awaiting-planning:seed-prompt" },
    { taskId: "WAIT-1", reason: "deps-unsatisfied" },
  ],
  budgetTruncated: undefined as boolean | undefined,
};

function sortVector(vector: { released: string[]; held: Array<{ taskId: string; reason: string }> }) {
  return {
    released: [...vector.released].sort(),
    held: [...vector.held].sort((a, b) => a.taskId.localeCompare(b.taskId)),
  };
}

function seedTask(card: SeedCard): Task {
  return {
    id: card.id,
    title: `Card ${card.id}`,
    description: `Description for ${card.id}`,
    column: card.column,
    status: card.status ?? null,
    dependencies: card.dependencies ?? [],
    steps: [],
    currentStep: 0,
    log: [],
    paused: card.paused ?? false,
    userPaused: card.userPaused ?? false,
    nextRecoveryAt: card.nextRecoveryAt,
    createdAt: card.createdAt,
    updatedAt: card.createdAt,
    columnMovedAt: card.createdAt,
  } as Task;
}

/**
 * A store whose `listTasks` mimics one core read shape, so the same board can be swept under the
 * baseline and the converted contract. `baseline` behaves exactly as the pre-RUFU-201 core did:
 * it derives the board badges, ships the `log` payload, and hydrates the selection cache from inside
 * the list call (reporting one batched read on the tally). `converted` mimics the shipped core for
 * `{ derive: false, excludeLog: true }`: no derived own-properties, `log: []`, zero hydration.
 */
async function makeBoardStore(board: SeedCard[], shape: "baseline" | "converted") {
  const root = await mkdtemp(join(tmpdir(), "fusion-rufu-202-read-shape-"));
  roots.push(root);
  const tasksDir = join(root, "tasks");
  const tasks = board.map(seedTask);
  for (const card of board) {
    const dir = join(tasksDir, card.id);
    await mkdir(dir, { recursive: true });
    const seed = card.seed ? tasks.find((item) => item.id === card.id)! : undefined;
    await writeFile(
      getPromptPath(tasksDir, card.id),
      seed
        ? buildBootstrapPrompt(seed.id, seed.title, seed.description)
        : PLANNED_PROMPT,
      "utf8",
    );
  }

  const live = new Map(tasks.map((item) => [item.id, item]));
  const selections = new Map(
    tasks.map((item) => [item.id, { workflowId: WORKFLOW_BY_TASK[item.id]!, stepIds: [] }]),
  );
  const listTasks = vi.fn(async (options?: {
    selectionCache?: Map<string, { workflowId: string; stepIds: string[] } | undefined>;
    selectionReadTally?: { batched: number; singles: number };
    derive?: boolean;
    excludeLog?: boolean;
  }) => {
    if (shape === "baseline") {
      // The old core derived per row and prefetched selections inside the list call.
      for (const task of tasks) {
        if (options?.selectionCache) options.selectionCache.set(task.id, selections.get(task.id));
      }
      if (options?.selectionReadTally) Object.assign(options.selectionReadTally, { batched: 1, singles: 0 });
      return tasks.map((task) => ({
        ...task,
        log: [{ timestamp: task.updatedAt, action: "execution.started" }],
        retrySummary: { retries: 0 },
        timedExecutionMs: 0,
      } as Task));
    }
    return tasks.map((task) => ({ ...task, log: [] } as Task));
  });

  const store = {
    getWorkflowSettingsProjectId: () => "project-rufu-202",
    getRootDir: () => root,
    getTasksDir: () => tasksDir,
    on: vi.fn(),
    getSettings: vi.fn(async () => ({ maxConcurrent: 4, autoMerge: true })),
    listTasks,
    getTask: vi.fn(async (id: string) => live.get(id) ?? null),
    getTaskWorkflowSelection: vi.fn((id: string) => selections.get(id)),
    getTaskWorkflowSelectionAsync: vi.fn(async (id: string) => selections.get(id)),
    getTaskWorkflowSelectionsAsync: vi.fn(async (ids: string[]) =>
      new Map(ids.flatMap((id) => {
        const selection = selections.get(id);
        return selection ? [[id, selection] as const] : [];
      }))),
    getWorkflowDefinition: vi.fn(async (workflowId: string) => ({ ir: IR_BY_WORKFLOW[workflowId] })),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    checkAndRecordUnplannedExecutionBlock: vi.fn(async () => true),
    recordRunAuditEvent: vi.fn(async () => undefined),
    moveTaskIf: vi.fn(async (id: string, target: string, predicate?: (live: Task) => boolean) => {
      const task = live.get(id)!;
      if (predicate && !predicate(task)) return { task, moved: false };
      task.column = target;
      return { task, moved: true };
    }),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const task = live.get(id)!;
      Object.assign(task, patch);
      return task;
    }),
  } as unknown as TaskStore;
  return { store, listTasks };
}

async function sweepBoard(board: SeedCard[], shape: "baseline" | "converted", deps = {}) {
  const { store, listTasks } = await makeBoardStore(board, shape);
  const result = await runHoldReleaseSweep(store, { now: () => Date.parse("2026-06-01T00:00:00.000Z"), ...deps });
  return { store, listTasks, result };
}

describe("hold-release sweep read shape (RUFU-202)", () => {
  beforeEach(() => resetHoldReleaseInstrumentation());
  afterEach(async () => {
    while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  });

  it("passes the deliberate read shape to the store list call, exactly", async () => {
    const { store, listTasks } = await sweepBoard(BOARD, "converted");

    // Exact object: an extra option, a dropped opt-out, or a silently-restored `derive` all fail here.
    expect(listTasks).toHaveBeenCalledWith({
      includeArchived: false,
      derive: false,
      excludeLog: true,
      selectionCache: expect.any(Map),
      selectionReadTally: { batched: 0, singles: 0 },
    });
    // The list read performs zero selection reads of its own under `derive: false`, so the sweep's
    // own `missingIds` batch is the pass's single selection read.
    expect(store.getTaskWorkflowSelectionsAsync).toHaveBeenCalledTimes(1);
    expect(store.getTaskWorkflowSelectionAsync).not.toHaveBeenCalled();
  });

  it("keeps every release decision identical between the baseline and the converted read shape", async () => {
    const baseline = await sweepBoard(BOARD, "baseline");
    const converted = await sweepBoard(BOARD, "converted");

    const baselineVector = sortVector(baseline.result);
    const convertedVector = sortVector(converted.result);

    expect(baselineVector).toEqual(GOLDEN_VECTOR);
    expect(convertedVector).toEqual(baselineVector);
    expect(converted.result.budgetTruncated).toBe(baseline.result.budgetTruncated);
    // FN-245 canary: the seed card must still refuse under the narrower row, which is only possible
    // because `prompt`/`description` survive the read shape.
    expect(convertedVector.held).toContainEqual({ taskId: "SEED-1", reason: "awaiting-planning:seed-prompt" });
    expect(convertedVector.released).not.toContain("SEED-1");
  });

  it("refuses a held card whose plan gate has no approving result row under either shape", async () => {
    // GATE-1's PROMPT.md is planned, so only the plan-gate result row can refuse it. If the narrower
    // read shape ever hid the evidence this gate needs, this card would release instead.
    const planGateBoard: SeedCard[] = [
      { id: "GATE-1", column: "hold", createdAt: "2026-01-01T00:00:01.000Z" },
    ];
    const baseline = await sweepBoard(planGateBoard, "baseline");
    const converted = await sweepBoard(planGateBoard, "converted");

    for (const result of [baseline.result, converted.result]) {
      expect(result.released).toEqual([]);
      expect(sortVector(result).held).toEqual([
        { taskId: "GATE-1", reason: "awaiting-planning:plan-review-pending" },
      ]);
    }
  });

  it("never lets budget truncation become the reason a card releases", async () => {
    let clock = 0;
    const { result } = await sweepBoard(BOARD, "converted", {
      budgetMs: 10,
      now: () => (clock += 1) === 1 ? 0 : 20,
    });

    expect(result.released).toEqual([]);
    expect(result.budgetTruncated).toBe(true);
  });

  it("summarizes an empty board without deriving or fetching logs", async () => {
    const { store, result } = await sweepBoard([], "converted");

    expect(result).toMatchObject({ released: [], held: [] });
    expect(store.getTaskWorkflowSelectionsAsync).not.toHaveBeenCalled();
  });

  it("holds every card on an all-held board identically between shapes", async () => {
    const allHeld: SeedCard[] = [
      { id: "MANUAL-1", column: "hold", createdAt: "2026-01-01T00:00:01.000Z" },
      { id: "SEED-1", column: "hold", createdAt: "2026-01-01T00:00:02.000Z", seed: true },
      { id: "PAUSED-1", column: "hold", createdAt: "2026-01-01T00:00:03.000Z", paused: true },
      { id: "USER-PAUSED-1", column: "hold", createdAt: "2026-01-01T00:00:04.000Z", userPaused: true },
      { id: "BACKOFF-1", column: "hold", createdAt: "2026-01-01T00:00:05.000Z", nextRecoveryAt: "2099-01-01T00:00:00.000Z" },
    ];
    const baseline = await sweepBoard(allHeld, "baseline");
    const converted = await sweepBoard(allHeld, "converted");

    expect(baseline.result.released).toEqual([]);
    expect(converted.result.released).toEqual([]);
    expect(sortVector(converted.result)).toEqual(sortVector(baseline.result));
  });
});
