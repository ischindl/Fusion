/*
FNXC:HoldReleaseEvaluateCost 2026-11-08-05:53 (RUFU-871):
STEP 2 MEASUREMENT — how many store round trips one hold/release sweep issues, per pass and per task.

A real engine line, not an estimate:

    [scheduler] Hold-release sweep: project=proj_1849a8ac5d5842ac: 11733ms (prefetch 3430ms,
    ir-resolve 1464ms, evaluate 6839ms over 235 tasks)

`evaluate` = 6 839 ms over 235 tasks = **29 ms per task**, on the same Node process that serves the
dashboard UI. Allocation sampling on that process measured 788 MB / 60 s with ~90 % inside the
Postgres driver materializing full rows (`DataRow` 417 MB, `fromJson` 276 MB), and the same
attribution window reported `seam: workflowSelection, calls: 20395`.

Latency is not measurable here (this box is not the operator's box, and standing rule FN-5048 forbids
wall-clock assertions), so this file measures the one quantity that explains latency and is
deterministic: the NUMBER of store round trips and the number of SEQUENTIAL AWAITS a sweep performs
per task. The seam is a counting Proxy over the whole `TaskStore`, so it counts reads the sweep's own
`reads(...)` tally does not cover (`updateTask`, `getTask`, `moveTaskIf`, the episode/History writes)
— the same counting-seam shape the repo accepted the same day in
`packages/engine/src/worktree/__tests__/git-proof-fork-count.test.ts` and
`packages/core/src/task-store/__tests__/row-hydration-cost.test.ts`.

WHAT THE MEASUREMENT FOUND (before any product change):

1. The sweep's *store reads* are already per-pass constants — `listTasks` 1, `getSettings` 1, one
   batched selection hydration, one definition read per distinct workflow. Per-task reads are ZERO on
   both measured arms. So 6 839 ms is NOT N round trips to PostgreSQL.
2. What IS per-task is the AWAIT: every card on the board, held or not, crossed the event loop for
   its own `resolveWorkflowIrForTask`. The measured witness is
   `getWorkflowSettingsProjectId`, which that resolver calls once per resolution: **25 calls for a
   24-card board** (one per card + the sweep's project key). On a process whose loop is saturated by
   row hydration, N sequential awaits — not N queries — is what multiplies into seconds. The
   `ir-resolve` token measures those awaits directly (1 464 ms / 235 = 6.2 ms per card) and the cards
   that are NOT held pay it for nothing, since their only per-task work is that one resolution.
3. The RUFU-393 episode write is correctly bounded: a pass that finds an unchanged episode inside the
   refresh floor performs **zero** writes (measured `updateTask` 8 → 0 on the second pass). Any change
   that makes pass 2 write again has broken the floor and must not merge.

FNXC:HoldReleaseSweepSoleMover 2026-11-08-05:53 (RUFU-871):
This file is also the ratchet on the sweep's lifecycle authority. `updateTask` below RAISES on any
patch carrying `column`, so a lane change through anything other than the fenced
`moveTaskIf`/`moveTask` seam is a test failure rather than a production behaviour change. That is the
mechanical form of the invariant `hold-release.ts` alone owns the `hold → wip` crossing.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLAN_REVIEW_GROUP_ID,
  buildBootstrapPrompt,
  resolveWorkflowIrById,
  type Task,
  type TaskStore,
  type WorkflowIr,
} from "@fusion/core";

import { resetHoldReleaseInstrumentation, runHoldReleaseSweep } from "../execution/hold-release.js";
import { schedulerLog } from "../logger.js";
import { getPromptPath } from "../execution/spec-staleness.js";

const roots: string[] = [];

function column(id: string, label: string, traits: string, configs: Record<string, Record<string, unknown>> = {}) {
  return {
    id,
    label,
    traits: traits
      ? traits.split(",").map((trait) => ({ trait: trait.trim(), config: configs[trait.trim()] ?? {} }))
      : [],
  };
}

/*
The measured board shape: one hold column that releases on capacity, one WIP column, one review lane,
one terminal lane. The WIP limit decides which arm refuses the held cards — `downstream-full` at the
capacity boundary, or `awaiting-planning` inside the readiness gate.
*/
function boardIr(wipLimit: number): WorkflowIr {
  return {
    version: "v2",
    id: "custom:cost",
    nodes: [],
    edges: [],
    columns: [
      column("ideas", "Ideas", "hold,intake", { hold: { release: "capacity" } }),
      column("wip", "WIP", "wip", { wip: { limit: wipLimit } }),
      column("review", "Review", "review"),
      column("done", "Done", "complete"),
    ],
  } as unknown as WorkflowIr;
}

/** Same board, plus a Plan Review gate authored ON the hold column: the `awaiting-planning` arm. */
function gatedIr(wipLimit: number): WorkflowIr {
  return {
    version: "v2",
    id: "custom:cost-gated",
    nodes: [
      { id: "start", kind: "start", column: "ideas" },
      { id: "plan", kind: "prompt", column: "ideas", config: { prompt: "plan" } },
      {
        id: PLAN_REVIEW_GROUP_ID,
        name: "Plan Review",
        kind: "optional-group",
        column: "ideas",
        config: { defaultOn: true, template: { nodes: [], edges: [] } },
      },
      { id: "execute", kind: "prompt", column: "wip", config: { prompt: "execute" } },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [],
    columns: [
      column("ideas", "Ideas", "hold,intake", { hold: { release: "capacity" } }),
      column("wip", "WIP", "wip", { wip: { limit: wipLimit } }),
      column("review", "Review", "review"),
      column("done", "Done", "complete"),
    ],
  } as unknown as WorkflowIr;
}

const PLANNED_PROMPT = "# Planned\n\n## Mission\nImplement the approved work.\n";

interface SeedCard {
  id: string;
  column: string;
  createdAt: string;
}

/** Board generator: `hold` cards resting in the hold column, `occupants` filling WIP, plus a tail of
 *  finished cards — the shape that makes a real board 235 rows wide and mostly NOT candidates. */
function buildBoard(hold: number, occupants: number, finished: number): SeedCard[] {
  const board: SeedCard[] = [];
  let n = 0;
  const stamp = (): string => new Date(Date.UTC(2026, 0, 1, 0, 0, ++n)).toISOString();
  for (let i = 0; i < hold; i += 1) board.push({ id: `HOLD-${i}`, column: "ideas", createdAt: stamp() });
  for (let i = 0; i < occupants; i += 1) board.push({ id: `RUN-${i}`, column: "wip", createdAt: stamp() });
  for (let i = 0; i < finished; i += 1) board.push({ id: `DONE-${i}`, column: "done", createdAt: stamp() });
  return board;
}

function seedTask(card: SeedCard): Task {
  return {
    id: card.id,
    title: `Card ${card.id}`,
    description: `Description for ${card.id}`,
    column: card.column,
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    paused: false,
    userPaused: false,
    createdAt: card.createdAt,
    updatedAt: card.createdAt,
    columnMovedAt: card.createdAt,
  } as Task;
}

/**
 * A store whose every method passes through a counting Proxy, so a per-task read cannot hide behind a
 * helper the sweep's own tally does not instrument. The Proxy may only ADD a tally: it forwards to the
 * real implementation and preserves the receiver, so a method that reaches another method still
 * behaves identically.
 *
 * `updateTask` refuses a `column` patch: the sweep's authority is the fenced move seam, and a lane
 * change written through an update is exactly the second mover this file exists to catch.
 */
async function makeCountingStore(options: { board: SeedCard[]; ir: WorkflowIr; seedIds?: Set<string> }) {
  const root = await mkdtemp(join(tmpdir(), "fusion-hold-cost-"));
  roots.push(root);
  const tasksDir = join(root, "tasks");
  const tasks = options.board.map(seedTask);
  for (const card of options.board) {
    await mkdir(join(tasksDir, card.id), { recursive: true });
    const task = tasks.find((item) => item.id === card.id)!;
    await writeFile(
      getPromptPath(tasksDir, card.id),
      options.seedIds?.has(card.id) ? buildBootstrapPrompt(task.id, task.title, task.description) : PLANNED_PROMPT,
      "utf8",
    );
  }
  const live = new Map(tasks.map((item) => [item.id, item]));
  const selections = new Map(tasks.map((item) => [item.id, { workflowId: options.ir.id, stepIds: [] }]));

  const counts = new Map<string, number>();
  const record = (name: string): void => counts.set(name, (counts.get(name) ?? 0) + 1);

  const impl = {
    getWorkflowSettingsProjectId: () => "project-cost",
    getRootDir: () => root,
    getTasksDir: () => tasksDir,
    on: () => undefined,
    getSettings: async () => ({ maxConcurrent: 4, autoMerge: true }) as Record<string, unknown>,
    // Mirrors the shipped core contract for `{ derive: false, excludeLog: true }`: the list read does
    // NOT hydrate the selection cache, so the sweep's own batch read is the only hydration.
    listTasks: async () => tasks.map((task) => ({ ...task })),
    getTask: async (id: string) => live.get(id) ?? null,
    getTaskWorkflowSelection: (id: string) => selections.get(id),
    getTaskWorkflowSelectionAsync: async (id: string) => selections.get(id),
    getTaskWorkflowSelectionsAsync: async (ids: string[]) =>
      new Map(ids.flatMap((id) => {
        const selection = selections.get(id);
        return selection ? [[id, selection] as const] : [];
      })),
    getWorkflowDefinition: async () => ({ ir: options.ir }),
    listWorkflowWorkItemsForTask: async () => [],
    getCompletionHandoffAcceptedMarker: async () => null,
    checkAndRecordUnplannedExecutionBlock: async () => true,
    recordRunAuditEvent: async () => undefined,
    logEntry: async () => undefined,
    logEntryOnce: async () => true,
    moveTaskIf: async (id: string, target: string, predicate?: (live: Task) => boolean) => {
      const task = live.get(id)!;
      if (predicate && !(await predicate(task))) return { task, moved: false };
      task.column = target;
      return { task, moved: true };
    },
    updateTask: async (id: string, patch: Record<string, unknown>) => {
      if ("column" in patch) throw new Error(`hold-release wrote column=${String(patch.column)} through updateTask`);
      const task = live.get(id)!;
      const { sourceMetadataPatch, ...rest } = patch as { sourceMetadataPatch?: Record<string, unknown> };
      if (sourceMetadataPatch) {
        task.sourceMetadata = {
          ...(task.sourceMetadata ?? {}),
          ...sourceMetadataPatch,
        } as Task["sourceMetadata"];
      }
      Object.assign(task, rest);
      return task;
    },
  };

  const store = new Proxy(impl, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        record(String(property));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as TaskStore;

  return {
    store,
    reset: (): void => counts.clear(),
    /** Zero for a method that was never called, so `expect(tally.foo).toBe(0)` reads honestly. */
    tally: (): Record<string, number> => Object.fromEntries([...counts.entries()].sort()),
    columnOf: (id: string): string => live.get(id)!.column,
  };
}

/** Run one pass and capture the sweep's own `reads(...)` summary line. */
async function runOnce(store: TaskStore) {
  // A monotonic counter clock: phase buckets are meaningless under it (this file measures CALLS, not
  // ms, per FN-5048), but the sweep's budget/expiry logic must never see time go backwards.
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const debug = vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
  const warn = vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
  const result = await runHoldReleaseSweep(store, { now: () => (clock += 1) });
  const line = [...debug.mock.calls, ...warn.mock.calls]
    .map((call) => String(call[0]))
    .find((text) => text.includes("Hold-release sweep:"));
  debug.mockRestore();
  warn.mockRestore();
  return { result, line: line ?? "" };
}

const readField = (line: string, key: string): number => {
  const match = new RegExp(`${key}=(\\d+)`).exec(line);
  return match ? Number(match[1]) : Number.NaN;
};

describe("hold-release sweep evaluate cost (RUFU-871 Step 2 measurement)", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
  });
  afterEach(async () => {
    while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
  });

  it("MEASURED: a capacity-refusing pass issues no per-task store read and no per-task await", async () => {
    // 8 held cards, WIP limit 1 already occupied → every held card is refused `downstream-full`;
    // 15 finished cards make the board 24 wide so the per-task rate is readable.
    const board = buildBoard(8, 1, 15);
    const { store, reset, tally, columnOf } = await makeCountingStore({ board, ir: boardIr(1) });

    reset();
    const first = await runOnce(store);
    const pass1 = tally();
    reset();
    const second = await runOnce(store);
    const pass2 = tally();

    expect(first.result.released).toEqual([]);
    expect(first.result.held).toHaveLength(8);
    expect(new Set(first.result.held.map((held) => held.reason))).toEqual(new Set(["downstream-full"]));
    expect(second.result.released).toEqual([]);
    for (const card of board) expect(columnOf(card.id)).toBe(card.column);

    // (1) Per-pass constants. These do not grow with the board.
    expect(pass1.listTasks).toBe(1);
    expect(pass1.getSettings).toBe(1);
    expect(pass1.getTaskWorkflowSelectionsAsync).toBe(1);
    expect(pass1.getWorkflowDefinition).toBe(1);
    expect(pass2.getWorkflowDefinition).toBe(1);

    // (2) Zero per-task reads, on either pass.
    expect(pass1.getTaskWorkflowSelection ?? 0).toBe(0);
    expect(pass1.getTaskWorkflowSelectionAsync ?? 0).toBe(0);
    expect(pass1.getTask ?? 0).toBe(0);
    expect(pass1.listWorkflowWorkItemsForTask ?? 0).toBe(0);
    expect(pass1.getCompletionHandoffAcceptedMarker ?? 0).toBe(0);

    // (3) The per-task AWAIT witness. `resolveWorkflowIrForTask` used to be called once per card and
    // read the project scope inside itself, so a 24-card board issued 25 of these — one per card plus
    // the sweep's own project key. That is the count behind `ir-resolve 1464ms / 235 tasks` = 6.2 ms of
    // pure await per card, paid by every card including the 16 that are not candidates at all.
    //
    // MEASURED AFTER the hoist: 3 per pass — the sweep's own project key, the one inside the hoisted
    // `prefetchWorkflowIrs` resolution, and the one inside `createCachedWorkflowIrReader`. It no longer
    // contains the word "tasks", so any regression that puts a per-card IR resolution back grows this
    // number and fails here rather than in the field.
    expect(pass1.getWorkflowSettingsProjectId).toBe(3);
    expect(pass2.getWorkflowSettingsProjectId).toBe(3);

    // (4) RUFU-393's refresh floor: pass 1 authors an episode per refused card; pass 2 sees the same
    // signature inside the floor and must write NOTHING.
    expect(pass1.updateTask).toBe(8);
    expect(pass1.logEntryOnce).toBe(8);
    expect(pass2.updateTask ?? 0).toBe(0);
    expect(pass2.logEntryOnce ?? 0).toBe(0);

    // (5) The sweep's own honest tally must agree with the seam.
    expect(readField(first.line, "selections")).toBe(0);
    expect(readField(first.line, "definitions")).toBe(1);
    expect(readField(first.line, "tasks")).toBe(1);
    expect(readField(first.line, "heldCandidates")).toBe(8);
  });

  it("MEASURED: an awaiting-planning pass reads work items once per refused candidate, per pass", async () => {
    // WIP has room, so every held card reaches the readiness gate; the Plan Review gate authored on
    // the hold column has no approving result row, so all eight are refused `plan-review-pending`.
    const board = buildBoard(4, 0, 4);
    const { store, reset, tally } = await makeCountingStore({ board, ir: gatedIr(4) });

    reset();
    const first = await runOnce(store);
    const pass1 = tally();
    reset();
    const second = await runOnce(store);
    const pass2 = tally();

    expect(second.result.released).toEqual([]);
    expect(new Set(second.result.held.map((held) => held.reason))).toEqual(
      new Set(["awaiting-planning:plan-review-pending"]),
    );

    // One work-item list per refused candidate, never twice for the same card (the pass memo holds
    // the read), and none for the eight cards the sweep skipped as non-candidates.
    expect(pass1.listWorkflowWorkItemsForTask).toBe(4);
    expect(pass2.listWorkflowWorkItemsForTask).toBe(4);
    expect(readField(first.line, "workItems")).toBe(4);
    // One PROMPT.md read per candidate that reached the seed-prompt branch.
    expect(readField(first.line, "prompts")).toBe(4);
    // Same refusal on pass 2, same floor-bound silence on the durable episode.
    expect(pass1.updateTask).toBe(4);
    expect(pass2.updateTask ?? 0).toBe(0);
  });

  /*
  FNXC:WorkflowIrHoist 2026-11-08-05:57 (RUFU-871):
  The scheduler's `runHoldReleaseSweepPass` resolves every distinct workflow on the board into
  `wipIrCache` for its own WIP/review/terminal predicates BEFORE it calls the sweep, and now hands that
  Map in as `deps.irCache`. This is the case that pins the sharing: a warm cache means the sweep reads
  `workflow_definitions` ZERO times, and the release verdicts are unchanged.
  */
  it("reuses a caller-owned warm IR cache and reads no workflow definition at all", async () => {
    const board = buildBoard(3, 1, 4);
    const ir = boardIr(1);
    const { store, reset, tally } = await makeCountingStore({ board, ir });
    const irCache = new Map<string, WorkflowIr>();
    // Warm it exactly the way the scheduler pass does, OUTSIDE the counted window.
    await resolveWorkflowIrById(store, ir.id, irCache);

    reset();
    const first = await runHoldReleaseSweep(store, { now: () => Date.parse("2026-01-01T00:00:00.000Z"), irCache });
    const pass = tally();

    expect(first.held.map((held) => held.reason)).toEqual(Array(3).fill("downstream-full"));
    expect(pass.getWorkflowDefinition ?? 0).toBe(0);
    expect(pass.listTasks).toBe(1);
    // Same board-size-independent constant as the first case: the project key, the resolution inside
    // the hoisted prefetch, and the reader's own — three whether the board is 4 cards or 235.
    expect(pass.getWorkflowSettingsProjectId).toBe(3);
  });

  /*
  FNXC:WorkflowIrHoist 2026-11-08-05:57 (RUFU-871):
  The constraint the whole optimisation must not violate: a slot that is free IN THIS PASS releases the
  parked card IN THIS PASS. A cache that makes the first look at a card come back "not resolvable"
  would delay every release by one sweep, and the sweep is the only thing that ever moves these cards.
  Released here on a cold cache, on the first pass, with no prior episode and no warm IR cache.
  */
  it("releases into a free slot on the same pass the slot is free, cold cache and first pass", async () => {
    const board = buildBoard(2, 0, 2);
    const { store, reset, tally, columnOf } = await makeCountingStore({ board, ir: boardIr(4) });

    reset();
    const first = await runOnce(store);
    const pass = tally();

    expect(first.result.released.sort()).toEqual(["HOLD-0", "HOLD-1"]);
    expect(first.result.held).toEqual([]);
    expect(columnOf("HOLD-0")).toBe("wip");
    expect(columnOf("HOLD-1")).toBe("wip");
    // The move went through the fenced seam, once per released card — and nothing else touched a column
    // (`updateTask` raises on a `column` patch, so a second mover fails this pass outright).
    expect(pass.moveTaskIf).toBe(2);
    expect(pass.updateTask ?? 0).toBe(0); // nothing was held, so the pass authored no episode
  });
});
