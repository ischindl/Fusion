/*
FNXC:HoldReleaseArmedPriority 2026-11-21-07:30 (RUFU-807 Step 3):
RUFU-805's card reached `armed_plan_review=true` at 00:21 and was read by a scheduler seam every minute
for five hours without ever being evaluated, because the pass budget died before it reached card 164 of
172 — a state with no persisted trace. RUFU-807 Step 2 reorders the queue so an armed card is reached
early; this file pins the diagnostic half, which exists because an operator cannot wait for the next
reproduction and because an armed card's turn should not depend on whether its predecessors are honest.

The claims under test, in the order the sweep makes them:
 - a card truncated past while HOLDING an armed continuation is named: one key-level
   `sourceMetadataPatch` write and one `task:hold-release-starved` row, never a whole-field write;
 - a card truncated past with NO armed continuation is not named — ordinary scheduling volume, and
   naming it would put a "the dispatcher is not reaching me" chip on 444 cards at once (RUFU-372);
 - a card that WAS evaluated has its stale badge cleared, so the chip cannot outlive the starvation;
 - a sustained starvation re-writes at most once per refresh floor, while the summary keeps counting it;
 - a store that predates the continuation seam behaves exactly as it did before this card.

Fixture decisions that make these deterministic rather than timing-dependent, borrowed from
`hold-release-sweep-truncation-rotation.test.ts`: the deadline dies inside ONE candidate's own evaluation,
`held` is appended in evaluation order, and the clock is injected so no test waits on wall time.
One deviation from that file is required: there, all candidates share ONE dependency, whose handoff marker
is memoised per distinct dependency, so exactly one read — and therefore one blow point — exists per pass.
An armed card sorts to the FRONT of the evaluation order (that is Step 2's whole point), so with a single
read it could only ever be the card that eats the deadline and never the one truncated behind it. Here
every candidate depends on a DIFFERENT blocker, which gives each candidate its own marker read and moves
the blow point to candidate number `blowOnRead`, leaving an armed card behind the break.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { HOLD_RELEASE_STARVATION_METADATA_KEY } from "@fusion/core";

import { resetHoldReleaseInstrumentation, runHoldReleaseSweep } from "../execution/hold-release.js";
import { schedulerLog } from "../logger.js";

const WF = "custom:starve-wf";
/** Rotation and starvation state are keyed by sweep PROJECT, so every fixture store reports one id. */
const PROJECT_ID = "proj-starvation-test";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: "",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    prompt: "# Planned\n\n## Mission\nImplement the approved work.\n",
    ...overrides,
  } as Task;
}

/** Hold column released when dependencies settle; unmet deps keep every candidate `held`. */
function dependencyHoldIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "dependency" } }] },
      { id: "waiting", label: "Waiting", traits: [] },
      { id: "in-progress", label: "In Progress", traits: [{ trait: "wip", config: { limit: 10 } }] },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

/** A hold candidate blocked on its OWN blocker, so its handoff-marker read is its own. */
function dependentTask(id: string, overrides: Partial<Task> = {}): Task {
  return task(id, { dependencies: [`D-${id}`], ...overrides });
}

/** Blockers rest in a non-hold, non-complete lane: genuinely unmet, and never candidates themselves. */
function blockers(candidates: readonly string[]): Task[] {
  return candidates.map((id) => task(`D-${id}`, { column: "waiting" }));
}

/** An episode as an earlier pass persisted it, aged past the refresh floor so a pass may rewrite it. */
function agedEpisode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const stale = new Date(Date.now() - 2 * 3_600_000).toISOString();
  return {
    [HOLD_RELEASE_STARVATION_METADATA_KEY]: {
      code: "release-sweep-budget-starved",
      lastAt: stale,
      firstAt: stale,
      stallCount: 1,
      unevaluatedCount: 2,
      ...overrides,
    },
  };
}

/** A badge stamped THIS instant — inside the refresh floor, so a sustained pass must not re-write it. */
function freshEpisode(): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    [HOLD_RELEASE_STARVATION_METADATA_KEY]: {
      code: "release-sweep-budget-starved",
      lastAt: now,
      firstAt: now,
      stallCount: 4,
    },
  };
}

interface WriteCall {
  taskId: string;
  patch: Record<string, unknown>;
}

interface FixtureOptions {
  /** Advance the sweep clock past the budget during the Nth handoff-marker read. */
  blowOnRead?: number;
  armed?: string[];
  /** Omit to model a store from before `listActiveTaskContinuationTaskIds` existed. */
  withContinuationRead?: boolean;
}

const CANDIDATES = ["R-A", "R-B", "R-C", "R-D"] as const;

function fixture(opts: FixtureOptions = {}): {
  store: TaskStore;
  tasks: Task[];
  writes: WriteCall[];
  audits: Array<Record<string, unknown>>;
  clock: { t: number };
} {
  /*
  The sweep's clock starts at the real epoch, not a small number: the deferred-age measurement subtracts
  each card's `createdAt` (2026-01-01 here), so an artificial `t = 1000` makes that subtraction negative
  and clamps it to zero — the age assertion would then prove nothing about the measurement.
  */
  const clock = { t: Date.now() };
  const tasks: Task[] = [
    ...blockers(CANDIDATES),
    ...CANDIDATES.map((id) => dependentTask(id)),
  ];
  const writes: WriteCall[] = [];
  const audits: Array<Record<string, unknown>> = [];
  let reads = 0;
  const selection = { workflowId: WF, stepIds: [] };

  const store = {
    getWorkflowSettingsProjectId: () => PROJECT_ID,
    getSettings: async () => ({ maxConcurrent: 4 }),
    listTasks: async () => tasks,
    moveTaskIf: async (id: string, column: string) => {
      const cur = tasks.find((t) => t.id === id)!;
      cur.column = column;
      return { task: cur, moved: true };
    },
    logEntry: async () => undefined,
    recordRunAuditEvent: async (input: Record<string, unknown>) => {
      audits.push(input);
    },
    getCompletionHandoffAcceptedMarker: async () => {
      reads += 1;
      if (opts.blowOnRead === reads) clock.t += 11;
      return null;
    },
    getTaskWorkflowSelection: () => selection,
    getTaskWorkflowSelectionAsync: async () => selection,
    getWorkflowDefinition: async () => ({ ir: dependencyHoldIr() }),
    updateTask: async (id: string, patch: Record<string, unknown>) => {
      writes.push({ taskId: id, patch });
      const target = tasks.find((t) => t.id === id);
      const metaPatch = patch.sourceMetadataPatch as Record<string, unknown> | undefined;
      if (target && metaPatch) {
        target.sourceMetadata = { ...(target.sourceMetadata ?? {}), ...metaPatch };
      }
    },
    ...(opts.withContinuationRead === false
      ? {}
      : { listActiveTaskContinuationTaskIds: async () => new Set(opts.armed ?? []) }),
  } as unknown as TaskStore;

  return { store, tasks, writes, audits, clock };
}

const heldOrder = (result: { held: { taskId: string }[] }): string[] => result.held.map((entry) => entry.taskId);

/** Only starvation rows, so an unrelated emit elsewhere in the pass cannot satisfy an assertion. */
const starvationRows = (audits: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
  audits.filter((row) => row.mutationType === "task:hold-release-starved");

/** Only starvation writes, so a stray patch elsewhere cannot satisfy an assertion. */
const starvationWrites = (writes: WriteCall[]): WriteCall[] =>
  writes.filter((write) => {
    const patch = write.patch.sourceMetadataPatch as Record<string, unknown> | undefined;
    return patch && HOLD_RELEASE_STARVATION_METADATA_KEY in patch;
  });

describe("hold-release sweep starvation episode (RUFU-807 Step 3)", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
  });

  /*
  FNXC:HoldReleaseArmedPriority 2026-11-21-07:30 (RUFU-807 Step 3):
  THE shape this card exists for: an armed card the budget died in front of. `armed` puts R-A/R-B/R-D in
  the front partition in queue order, the budget dies during the SECOND of them, and R-D — armed, and
  behind the break — is the card whose five-hour silence this diagnostic removes.
  */
  it("names an armed card the budget died before, with one key-level write and one audit row", async () => {
    const { store, writes, audits, clock } = fixture({ blowOnRead: 2, armed: ["R-A", "R-B", "R-D"] });

    const result = await runHoldReleaseSweep(store, { now: () => clock.t, budgetMs: 10 });

    expect(result.budgetTruncated).toBe(true);
    // Armed cards first (queue order inside the partition), then the non-armed tail; the break falls
    // after the second armed card, so R-B is the last card this pass examined.
    expect(heldOrder(result)).toEqual(["R-A", "R-B"]);
    /*
    `unevaluatedCount` counts the remaining ENTRIES of the evaluation order, which is built over every
    task the sweep loaded — the four blocker cards included — because the loop `continue`s past a card
    with no `hold` trait rather than filtering the list first. RUFU-698's fixture reads the same way:
    that file's blocker is absent from `held` but present in the count.
    */
    expect(result.unevaluatedCount).toBe(6);
    // The starved CLASS is reported, not just a raw truncation count: one armed card sits behind the break.
    expect(result.starvedArmedCount).toBe(1);
    // And the age that separates "a long lane" from "a starved lane" is measured, not guessed.
    expect(result.oldestDeferredAgeMs).toBeGreaterThan(0);

    expect(starvationWrites(writes)).toHaveLength(1);
    expect(starvationWrites(writes)[0]!.taskId).toBe("R-D");
    expect(starvationWrites(writes)[0]!.patch).toEqual({
      sourceMetadataPatch: {
        [HOLD_RELEASE_STARVATION_METADATA_KEY]: expect.objectContaining({
          code: "release-sweep-budget-starved",
          stallCount: 1,
          unevaluatedCount: 6,
        }),
      },
    });
    // Key-level channel only: the wholesale field is never touched, so `duplicateOfTaskIds`,
    // `handoffFrom`, `planAdmissionStall` and `wipAdmissionStall` on the same carrier survive.
    expect(writes.every((write) => !("sourceMetadata" in write.patch))).toBe(true);

    // The emit is fire-and-forget through the bounded seam, so the row is awaited, not assumed.
    await vi.waitFor(() => expect(starvationRows(audits)).toHaveLength(1), { timeout: 2_000 });
    expect(starvationRows(audits)[0]).toMatchObject({
      taskId: "R-D",
      target: "R-D",
      agentId: "scheduler",
      runId: "hold-release:starved:R-D",
      domain: "database",
    });
    /*
    Metadata is ids/counts/fixed enums only (AC6, and this event family's own contract): which OTHER
    cards were deferred is a count, never a list, and no card title or error sentence is representable.
    */
    const metadata = starvationRows(audits)[0]!.metadata as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual([
      "code", "column", "oldestDeferredAgeMs", "stallCount", "taskId", "unevaluatedCount",
    ]);
    expect(metadata.column).toBe("todo");
    expect(metadata.code).toBe("release-sweep-budget-starved");
  });

  it("names nobody for a truncated pass whose deferred cards hold no continuation", async () => {
    const { store, writes, audits, clock } = fixture({ blowOnRead: 2, armed: [] });

    const result = await runHoldReleaseSweep(store, { now: () => clock.t, budgetMs: 10 });

    // Truncation still says so, with its magnitude — and nothing else.
    expect(result.budgetTruncated).toBe(true);
    expect(result.unevaluatedCount).toBeGreaterThan(0);
    expect(result.starvedArmedCount).toBeUndefined();
    expect(result.oldestDeferredAgeMs).toBeGreaterThan(0);
    expect(starvationWrites(writes)).toEqual([]);
    expect(starvationRows(audits)).toEqual([]);
  });

  it("clears the badge of an armed card a later pass actually evaluated, so it cannot outlive the starvation", async () => {
    const { store, tasks, writes, audits, clock } = fixture({ armed: ["R-C"] });
    const target = tasks.find((t) => t.id === "R-C")!;
    target.sourceMetadata = agedEpisode();

    const result = await runHoldReleaseSweep(store, { now: () => clock.t, budgetMs: 10_000 });

    expect(result.budgetTruncated).toBeUndefined();
    expect(starvationWrites(writes)).toEqual([
      { taskId: "R-C", patch: { sourceMetadataPatch: { [HOLD_RELEASE_STARVATION_METADATA_KEY]: null } } },
    ]);
    // A clear is not a starvation: it writes no row, and writes no second opinion about the count.
    expect(starvationRows(audits)).toEqual([]);
    // The key is now null on the row, so the next read shows no chip.
    expect((target.sourceMetadata as Record<string, unknown>)[HOLD_RELEASE_STARVATION_METADATA_KEY]).toBeNull();
  });

  it("leaves an unrelated sourceMetadata key untouched when naming and when clearing", async () => {
    const { store, tasks, writes, clock } = fixture({ blowOnRead: 2, armed: ["R-A", "R-B", "R-D"] });
    const starved = tasks.find((t) => t.id === "R-D")!;
    starved.sourceMetadata = { handoffFrom: "R-ORIGIN", planAdmissionStall: { code: "plan-no-admission", lastAt: "2026-01-01T00:00:00.000Z", firstAt: "2026-01-01T00:00:00.000Z", stallCount: 1 } };

    await runHoldReleaseSweep(store, { now: () => clock.t, budgetMs: 10 });

    const written = (starved.sourceMetadata ?? {}) as Record<string, unknown>;
    expect(written.handoffFrom).toBe("R-ORIGIN");
    expect(written.planAdmissionStall).toBeDefined();
    expect(written[HOLD_RELEASE_STARVATION_METADATA_KEY]).toBeDefined();
    // And the patch that got it there named exactly one key — a wholesale write would have erased both.
    const patch = starvationWrites(writes)[0]!.patch.sourceMetadataPatch as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual([HOLD_RELEASE_STARVATION_METADATA_KEY]);
  });

  it("re-writes a sustained starvation at most once per refresh floor, while the summary keeps counting it", async () => {
    const { store, tasks, writes, audits, clock } = fixture({ blowOnRead: 2, armed: ["R-A", "R-B", "R-D"] });
    tasks.find((t) => t.id === "R-D")!.sourceMetadata = freshEpisode();

    const result = await runHoldReleaseSweep(store, { now: () => clock.t, budgetMs: 10 });

    // The card is still in the starved state and every pass says so…
    expect(result.starvedArmedCount).toBe(1);
    // …but the row and the audit store see nothing new, because the stamp inside the floor proves it.
    // RUFU-393 measured 16 536 rows for one card over 2 d 19 h at a ~3 s poll; this bound is why that
    // cannot be re-authored here at a 10 s one.
    expect(starvationWrites(writes)).toEqual([]);
    expect(starvationRows(audits)).toEqual([]);
  });

  it("names the starved card through the same key-level channel on a store with no CAS seam", async () => {
    // The fixture store has never carried `updateTaskAtomic`; naming must still land, best-effort, on
    // the key-merging `updateTask` — and must never degrade into a whole-field overwrite.
    const { store, writes, audits, clock } = fixture({ blowOnRead: 2, armed: ["R-A", "R-B", "R-D"] });
    expect((store as unknown as { updateTaskAtomic?: unknown }).updateTaskAtomic).toBeUndefined();

    const result = await runHoldReleaseSweep(store, { now: () => clock.t, budgetMs: 10 });

    expect(result.starvedArmedCount).toBe(1);
    expect(starvationWrites(writes).map((write) => write.taskId)).toEqual(["R-D"]);
    expect(writes.every((write) => !("sourceMetadata" in write.patch))).toBe(true);
    await vi.waitFor(() => expect(starvationRows(audits)).toHaveLength(1), { timeout: 2_000 });
  });

  it("behaves exactly as before this card on a store with no continuation read", async () => {
    const { store, writes, audits, clock } = fixture({ blowOnRead: 2, withContinuationRead: false });

    const result = await runHoldReleaseSweep(store, { now: () => clock.t, budgetMs: 10 });

    // Truncation stays visible, the starved class stays unmeasured, and nothing is written. The
    // duck-typed guard, not an empty set, is what keeps the pre-RUFU-807 shape honest here.
    expect(result.budgetTruncated).toBe(true);
    expect(result.unevaluatedCount).toBeGreaterThan(0);
    expect(result.starvedArmedCount).toBeUndefined();
    expect(starvationWrites(writes)).toEqual([]);
    expect(starvationRows(audits)).toEqual([]);
  });

  it("absorbs a store whose write throws: the release decision is never charged to the diagnostic", async () => {
    const { store, audits, clock } = fixture({ blowOnRead: 2, armed: ["R-A", "R-B", "R-D"] });
    const hostile = {
      ...store,
      updateTask: async () => {
        throw new Error("sink down");
      },
    } as unknown as TaskStore;

    const result = await runHoldReleaseSweep(hostile, { now: () => clock.t, budgetMs: 10 });

    // The pass completed and reported its own facts; only the naming degraded.
    expect(result.budgetTruncated).toBe(true);
    expect(result.starvedArmedCount).toBe(1);
    expect(starvationRows(audits)).toEqual([]);
    const warn = (schedulerLog.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => String(call[0]));
    expect(warn.some((line) => line.includes("Hold-release starvation marker write failed"))).toBe(true);
  });

  it("reports the truncation with its starved class in the summary line the operator reads", async () => {
    const warn = vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
    const debug = vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const { store, clock } = fixture({ blowOnRead: 2, armed: ["R-A", "R-B", "R-D"] });

    await runHoldReleaseSweep(store, { now: () => clock.t, budgetMs: 10 });

    const line = [...warn.mock.calls, ...debug.mock.calls]
      .map((call) => String(call[0]))
      .find((l) => l.includes("starved-armed=1"));
    expect(line).toBeDefined();
    // The class never rides alone: raw truncation and rotation stay exactly as RUFU-698 shipped them.
    expect(line).toContain("budget-truncated");
  });
});
