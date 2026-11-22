/*
FNXC:WipAdmissionParkCooldown 2026-11-19-20:35 (RUFU-558):
The operator's SKEN board livelocked on ONE card: 91-97 "capacity suspends" attributed to SKEN-009 in a
30-minute window (next-busiest 0-14) while `moves/30m` sat at 1-3 for hours, and a query over
`run_audit_events` for that card returned ZERO rows. The two halves have different owners: the AUDIT
absence is RUFU-1055's (the sweep arm discards `auditRowWarranted`, so a sweep-driven loop legitimately
writes nothing about itself), and the counted graph-suspend emission is bounded by RUFU-442 and RUFU-393.
What is still live, and is THIS file's subject, is the WORK loop: the hold/release sweep is a pure WRITER
of `sourceMetadata.wipAdmissionStall` and never reads it back, so a card refused by the one arm that has
no cheap live re-check pays for that refusal on every pass at the poll cadence (~15 s plus every event
wake), forever.

Both refusal arms produce the SAME held reason `move-rejected-or-no-slot`:
  (a) `deps.reserveSlot` returned null — no reservable worktree/semaphore slot, the probe named in this
      card's own title; and
  (b) the in-transaction move threw `TransitionRejectionError(capacity-exhausted)` — the card lost the
      race for the slot, the reservation is released, and it stays held.
Both land in an early-return or a `catch` whose only narration is a debug line ("staying held"), beside a
comment already admitting "capacity races re-hit every sweep while full".

What this file deliberately does NOT weaken is the fairness contract, which case (c) restates and
`hold-release-capacity-release-crosses.test.ts` owns: `downstream-full` is re-derived from an in-memory
count over rows the pass already listed (zero DB reads), so the live lane sample still releases a parked
card in the very pass its occupant leaves. The skip RUFU-558 adds sits strictly AFTER that sample and is
scoped by the sweep's own held REASON, never by the episode's gate label - case (d) is the proof that the
label cannot be the key, because `moreSpecificWipAdmissionGate` sharpens it upward only.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildManualRetryResetPatch,
  clearWipAdmissionStallPatch,
  PLAN_REVIEW_GROUP_ID,
  TransitionRejectionError,
  WIP_ADMISSION_STALL_METADATA_KEY,
  WIP_ADMISSION_STALL_REFRESH_FLOOR_MS,
  type Task,
  type TaskStore,
  type TransitionRejection,
  type WorkflowIr,
} from "@fusion/core";

import {
  promoteHeldTask,
  releaseHeldTaskByEvent,
  resetHoldReleaseInstrumentation,
  runHoldReleaseSweep,
  type HoldReleasePass,
} from "../execution/hold-release.js";
import { getPromptPath } from "../execution/spec-staleness.js";
import { schedulerLog } from "../logger.js";

/*
Count PROMPT.md reads at the `readFile` seam, exactly as the RUFU-209 attribution suite does, so "zero
reads on a skipped pass" measures the readiness leg rather than asserting about a spy the code could route
around. The mock is a pass-through; only the counter is added.
*/
const fsCounts = vi.hoisted(() => ({ promptReads: new Map<string, number>() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const path = typeof args[0] === "string" ? args[0] : String(args[0]);
      if (path.endsWith("/PROMPT.md")) fsCounts.promptReads.set(path, (fsCounts.promptReads.get(path) ?? 0) + 1);
      return actual.readFile(...args);
    },
  };
});

const WF = "custom:rufu-558";
const SIBLING_WF = "custom:rufu-558-sibling";
/*
FNXC:WipAdmissionParkCooldown 2026-11-19-22:45 (RUFU-558):
A hold column that releases on an EXTERNAL EVENT, so the second operator surface —
`releaseHeldTaskByEvent` — can be pinned against a card whose episode would excuse the automatic sweep.
That helper refuses anything not authored as an `external-event` hold, so without this workflow the pin
would assert a refusal for the wrong reason and prove nothing about memo-gating.
*/
const EVENT_WF = "custom:rufu-558-event";
/** A third shape: capacity hold PLUS an enabled pre-release Plan Review, so the unplanned gate is live. */
const UNPLANNED_WF = "custom:rufu-558-unplanned";
const HOUR = 60 * 60_000;
/** The scheduler's real cadence: `pollIntervalMs ?? 15_000` — the source of the observed ~20 s period. */
const PASS_MS = 15_000;
/** Pre-fix, one hour at that cadence paid for one refusal this many times. */
const PASSES_PER_HOUR = HOUR / PASS_MS;
const T0 = Date.parse("2026-11-19T00:00:00.000Z");

/** A planned PROMPT.md with no premises, so the plan-premise gate never substitutes itself for the
 *  capacity question under test (same fixture shape the RUFU-393 park-marker harness uses). */
const PLANNED_PROMPT = "# Planned\n\n## Mission\nImplement the approved work.\n";

/**
 * Per-card answers for the expensive leg: which cards the pool refuses a slot for (arm (a)), and which
 * cards reserve a slot but then lose the in-transaction move (arm (b)). A card named in neither moves.
 * Refusal is per CARD, not global, so one board can hold a hot card and an uncool sibling at once.
 */
interface PoolMode {
  refuseFor?: string[];
  raceLostFor?: string[];
}

function column(id: string, label: string, trait: string, config: Record<string, unknown> = {}) {
  return { id, label, traits: trait ? [{ trait, config }] : [] };
}

/** `todo` = hold(release: capacity), `in-progress` = wip(limit 4), `done` = complete: the default shape. */
function capacityIr(id: string, wipLimit = 4): WorkflowIr {
  return {
    version: "v2",
    id,
    nodes: [],
    edges: [],
    columns: [
      column("todo", "Todo", "hold", { release: "capacity" }),
      column("in-progress", "In Progress", "wip", { limit: wipLimit }),
      column("done", "Done", "complete"),
    ],
  } as unknown as WorkflowIr;
}

/** The same shape, but the hold column waits on a webhook rather than on capacity. */
function eventHoldIr(id: string): WorkflowIr {
  return {
    version: "v2",
    id,
    nodes: [],
    edges: [],
    columns: [
      column("todo", "Todo", "hold", { release: "external-event" }),
      column("in-progress", "In Progress", "wip", { limit: 4 }),
      column("done", "Done", "complete"),
    ],
  } as unknown as WorkflowIr;
}

/**
 * Capacity hold with an ENABLED pre-release Plan Review in the hold column, so a card with no plan is
 * refused as `unplanned-for-execution` and FN-7648's durable refusal recorder runs. Needed because that
 * recorder only fires behind a plan-review node; a minimal IR cannot reach it at all.
 */
function unplannedIr(id: string): WorkflowIr {
  return {
    version: "v2",
    id,
    edges: [],
    columns: [
      column("todo", "Todo", "hold", { release: "capacity" }),
      column("in-progress", "In Progress", "wip", { limit: 4 }),
      column("done", "Done", "complete"),
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      {
        id: PLAN_REVIEW_GROUP_ID,
        name: "Plan Review",
        kind: "optional-group" as const,
        column: "todo",
        config: { defaultOn: true, template: { nodes: [], edges: [] } },
      },
      { id: "execute", kind: "prompt", column: "in-progress", config: { prompt: "execute" } },
      { id: "end", kind: "end", column: "done" },
    ],
  } as unknown as WorkflowIr;
}

function clock(startMs = T0) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** A `move-rejected-or-no-slot` episode exactly as the sweep leaves it: fresh, same column, real sample. */
function refusedEpisode(nowMs: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [WIP_ADMISSION_STALL_METADATA_KEY]: {
      code: "move-rejected-or-no-slot",
      signature: "capacity|todo->in-progress",
      firstAt: new Date(nowMs).toISOString(),
      lastAt: new Date(nowMs).toISOString(),
      stallCount: 3,
      fromColumn: "todo",
      toColumn: "in-progress",
      nodeId: "hold-release-sweep",
      poolId: WF,
      occupants: 0,
      limit: 4,
      ...over,
    },
  };
}

interface Harness {
  store: TaskStore;
  tasks: Task[];
  /** Expensive-leg counters — the work this task bounds. */
  reserveCalls: string[];
  moveCalls: string[];
  workItemReads: string[];
  /** Every episode patch the sweep wrote, in order (the applying fake records what it applied). */
  markerPatches: Array<Record<string, unknown>>;
  promptReadsFor: (taskId: string) => number;
  /** The pool stub, exposed so an operator-surface test can pass the SAME refusing pool to promote. */
  reserveSlotOf: (task: Task) => Promise<{ release: () => void } | null>;
}

async function makeHarness(
  cards: Array<{ id: string; column?: string; workflow?: string; wip?: boolean; sourceMetadata?: Record<string, unknown>; prompt?: string }>,
  mode: PoolMode = {},
): Promise<Harness> {
  const refuseFor = new Set(mode.refuseFor ?? []);
  const raceLostFor = new Set(mode.raceLostFor ?? []);
  const root = await mkdtemp(join(tmpdir(), "rufu-558-cooldown-"));
  roots.push(root);
  const tasksDir = join(root, "tasks");
  const tasks = cards.map((card) => ({
    id: card.id,
    title: `card ${card.id}`,
    description: "",
    column: card.column ?? "todo",
    workspaceKind: null,
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    paused: false,
    userPaused: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    sourceMetadata: card.sourceMetadata,
    prompt: card.prompt ?? PLANNED_PROMPT,
  } as unknown as Task));
  for (const [index, task] of tasks.entries()) {
    const dir = join(tasksDir, task.id);
    await mkdir(dir, { recursive: true });
    await writeFile(getPromptPath(tasksDir, task.id), cards[index]!.prompt ?? PLANNED_PROMPT, "utf8");
  }

  const workflowOf = new Map(tasks.map((task, index) => [task.id, cards[index]!.workflow ?? WF]));
  const irs = new Map<string, WorkflowIr>([
    [WF, capacityIr(WF)],
    [SIBLING_WF, capacityIr(SIBLING_WF)],
    [EVENT_WF, eventHoldIr(EVENT_WF)],
    [UNPLANNED_WF, unplannedIr(UNPLANNED_WF)],
  ]);
  const markerPatches: Array<Record<string, unknown>> = [];
  const reserveCalls: string[] = [];
  const moveCalls: string[] = [];
  const workItemReads: string[] = [];

  const store = {
    getWorkflowSettingsProjectId: () => "proj-rufu-558",
    getRootDir: () => root,
    getTasksDir: () => tasksDir,
    getSettings: vi.fn(async () => ({ maxConcurrent: 4 })),
    listTasks: vi.fn(async () => tasks.slice()),
    getTask: vi.fn(async (id: string) => tasks.find((task) => task.id === id) ?? null),
    getTaskWorkflowSelection: vi.fn((id: string) => ({ workflowId: workflowOf.get(id), stepIds: [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async (id: string) => ({ workflowId: workflowOf.get(id), stepIds: [] })),
    getWorkflowDefinition: vi.fn(async (workflowId: string) => ({ ir: irs.get(workflowId) })),
    listWorkflowWorkItemsForTask: vi.fn(async (taskId: string) => {
      workItemReads.push(taskId);
      return [];
    }),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    logEntryOnce: vi.fn(async () => true),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    /*
    The RUFU-393 harness lesson: the fake store must APPLY `sourceMetadataPatch`. A store that drops what
    the sweep wrote makes every pass look like the first refusal, and floor arithmetic is then untestable.
    */
    updateTask: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const cur = tasks.find((task) => task.id === id);
      const metaPatch = patch?.sourceMetadataPatch;
      if (cur && metaPatch && typeof metaPatch === "object") {
        cur.sourceMetadata = { ...(cur.sourceMetadata ?? {}), ...(metaPatch as Record<string, unknown>) };
        if (WIP_ADMISSION_STALL_METADATA_KEY in (metaPatch as object)) markerPatches.push(metaPatch as Record<string, unknown>);
      }
      return cur ?? undefined;
    }),
    moveTaskIf: vi.fn(async (id: string, target: string) => {
      moveCalls.push(id);
      const cur = tasks.find((task) => task.id === id)!;
      if (raceLostFor.has(id)) {
        throw new TransitionRejectionError({ code: "capacity-exhausted" } as TransitionRejection, "capacity exhausted");
      }
      cur.column = target;
      return { task: cur, moved: true };
    }),
  } as unknown as TaskStore;

  const reserveSlot = async (task: Task, _target: string, _pass?: HoldReleasePass) => {
    reserveCalls.push(task.id);
    // (a) the pool answers "no reservable slot"; (b) hands one over and lets the move transaction refuse.
    return refuseFor.has(task.id) ? null : { release: () => {} };
  };

  return {
    store,
    tasks,
    reserveCalls,
    moveCalls,
    workItemReads,
    markerPatches,
    promptReadsFor: (taskId) => fsCounts.promptReads.get(getPromptPath(tasksDir, taskId)) ?? 0,
    reserveSlotOf: reserveSlot,
    deps: (now) => ({ now, isTaskActive: () => false, reserveSlot }),
  };
}

const roots: string[] = [];

const episodeOf = (patch: Record<string, unknown> | undefined): Record<string, unknown> | undefined =>
  patch?.[WIP_ADMISSION_STALL_METADATA_KEY] as Record<string, unknown> | undefined;

describe("hold/release sweep stops re-paying for a move-rejected-or-no-slot refusal every pass (RUFU-558)", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
    fsCounts.promptReads.clear();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  });

  it("(a) reserves at most once per refresh floor across an hour when the pool has no reservable slot", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const harness = await makeHarness([{ id: "HOT" }], { refuseFor: ["HOT"] });
    const time = clock();

    // Pass 1 has no episode yet: it MUST attempt, or this would be a lock rather than a bound.
    const first = await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(first.held).toContainEqual({ taskId: "HOT", reason: "move-rejected-or-no-slot" });
    expect(harness.reserveCalls).toHaveLength(1);
    expect(episodeOf(harness.markerPatches.at(-1))).toMatchObject({ code: "move-rejected-or-no-slot" });

    // A whole hour at the real poll cadence.
    for (let elapsed = PASS_MS; elapsed < HOUR; elapsed += PASS_MS) {
      time.advance(PASS_MS);
      await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    }

    /*
    The arithmetic stated rather than waved at: attempts land at t=0 and at each floor crossing
    (15, 30, 45 min), because `ageMs >= FLOOR` is what ends the deferral — exactly 4 in an hour where the
    pre-fix loop paid PASSES_PER_HOUR. The bound is RUFU-393's existing floor, not a new constant.
    */
    expect(harness.reserveCalls).toHaveLength(HOUR / WIP_ADMISSION_STALL_REFRESH_FLOOR_MS);
    expect(harness.reserveCalls.length).toBeLessThan(PASSES_PER_HOUR / 40);
    // The wait stays ANNOUNCED: one episode record per floor, the counter growing, the age preserved.
    expect(harness.markerPatches).toHaveLength(HOUR / WIP_ADMISSION_STALL_REFRESH_FLOOR_MS);
    const episode = episodeOf(harness.markerPatches.at(-1))!;
    expect(Number(episode.stallCount)).toBeGreaterThan(1);
    expect(String(episode.firstAt)).toBe(new Date(T0).toISOString());
    // A skipped pass reports the CARRIED reason, so `heldSince` keeps its clock and no new vocabulary
    // enters SWEEP_ARM_TO_PARK_CODE.
    expect(harness.markerPatches.every((patch) => episodeOf(patch)?.code === "move-rejected-or-no-slot")).toBe(true);
  });

  it("(a2) performs zero readiness, prompt, reservation or move work on a skipped pass", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const harness = await makeHarness([{ id: "HOT" }], { refuseFor: ["HOT"] });
    const time = clock();

    await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    const attemptsAfterFirst = harness.reserveCalls.length;
    const movesAfterFirst = harness.moveCalls.length;
    const promptsAfterFirst = harness.promptReadsFor("HOT");
    const workItemsAfterFirst = harness.workItemReads.length;
    expect(attemptsAfterFirst).toBe(1);
    expect(promptsAfterFirst).toBeGreaterThan(0); // the readiness leg really read PROMPT.md

    // The very next pass, 15 s later, against the episode the sweep itself wrote on the row.
    time.advance(PASS_MS);
    const second = await runHoldReleaseSweep(harness.store, harness.deps(time.now));

    expect(harness.reserveCalls).toHaveLength(attemptsAfterFirst);
    expect(harness.moveCalls).toHaveLength(movesAfterFirst);
    expect(harness.promptReadsFor("HOT")).toBe(promptsAfterFirst);
    expect(harness.workItemReads).toHaveLength(workItemsAfterFirst);
    // The card rests where it stands, explained, with no lifecycle change.
    expect(second.held).toContainEqual({ taskId: "HOT", reason: "move-rejected-or-no-slot" });
    expect(second.released).not.toContain("HOT");
    expect(harness.tasks.find((task) => task.id === "HOT")!.column).toBe("todo");
  });

  it("(b) bounds the in-transaction capacity-exhausted race arm the same way", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const harness = await makeHarness([{ id: "HOT" }], { raceLostFor: ["HOT"] });
    const time = clock();
    // The reservation SUCCEEDS here; the move transaction is what refuses — that is the second arm.

    const first = await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(first.held).toContainEqual({ taskId: "HOT", reason: "move-rejected-or-no-slot" });
    expect(harness.moveCalls).toHaveLength(1);

    time.advance(PASS_MS);
    await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(harness.moveCalls).toHaveLength(1);
    expect(episodeOf(harness.markerPatches.at(-1))).toMatchObject({ code: "move-rejected-or-no-slot" });
  });

  it("(c) still crosses a card whose FRESH downstream-full episode names a lane that just freed up", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    // The lane is genuinely full: four occupants against a wip limit of 4, so `downstream-full` is the
    // live sample's own verdict and nothing about the episode has to be believed.
    const harness = await makeHarness([
      { id: "PARKED", sourceMetadata: refusedEpisode(T0, { code: "downstream-full", occupants: 4, limit: 4 }) },
      { id: "LIVE-A", column: "in-progress" },
      { id: "LIVE-B", column: "in-progress" },
      { id: "LIVE-C", column: "in-progress" },
      { id: "LIVE-D", column: "in-progress" },
    ]);
    const time = clock();

    // Lane full: the live sample owns this refusal and the card stays put.
    const blocked = await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(blocked.held).toContainEqual({ taskId: "PARKED", reason: "downstream-full" });
    expect(harness.reserveCalls).not.toContain("PARKED");

    // ONE occupant leaves. The next pass — not one floor later — must carry the card across.
    harness.tasks.find((task) => task.id === "LIVE-A")!.column = "done";
    time.advance(PASS_MS);
    const freed = await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(freed.released).toContain("PARKED");
    expect(harness.tasks.find((task) => task.id === "PARKED")!.column).toBe("in-progress");
  });

  /*
  FNXC:WipAdmissionParkCooldown 2026-11-22-05:18 (RUFU-558):
  THE INERTNESS COUNTER-PROOF, and the reason this case is mandatory rather than nice to have. The first cut
  of this bound keyed on the episode's gate code, which `moreSpecificWipAdmissionGate` sharpens UPWARD ONLY:
  `downstream-full` and `column-capacity` rank 4, `move-rejected-or-no-slot` ranks 3, so a card that ever
  reported a rank-4 label keeps it through every later codeless refusal and a code-keyed skip never fires for
  it again. That is the majority of the measured population (about 60 of ~138 `wipAdmissionStall` cards sat
  in `todo` labeled `downstream-full`), so a design that passes every other case in this file can still be a
  no-op on the real board. The card here is given exactly that shape: a rank-4 label, a lane sample that does
  NOT refuse, and a real refusal through the codeless arm.
  */
  for (const sharpenedCode of ["downstream-full", "column-capacity"] as const) {
    it(`(d) inertness counter-proof: the bound engages on a card whose episode label reads ${sharpenedCode}`, async () => {
      vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
      vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
      // occupants 0 / limit 4: the LIVE lane sample deliberately does not refuse, so the only thing that
      // could keep this card from the pool is the bound under test.
      const harness = await makeHarness(
        [{ id: "HOT", sourceMetadata: refusedEpisode(T0, { code: sharpenedCode, occupants: 0, limit: 4 }) }],
        { refuseFor: ["HOT"] },
      );
      const time = clock();

      const first = await runHoldReleaseSweep(harness.store, harness.deps(time.now));
      expect(first.held).toContainEqual({ taskId: "HOT", reason: "move-rejected-or-no-slot" });
      expect(harness.reserveCalls).toHaveLength(1);

      time.advance(PASS_MS);
      await runHoldReleaseSweep(harness.store, harness.deps(time.now));
      // The bound engages DESPITE the rank-4 label. A `code`-keyed design reserves again here.
      expect(harness.reserveCalls).toHaveLength(1);

      // And the label stays rank-4 across a REFRESH that was really earned by a codeless refusal, which is
      // what proves the code-keyed design could never recover on its own, rather than merely starting wrong.
      time.advance(WIP_ADMISSION_STALL_REFRESH_FLOOR_MS - PASS_MS);
      await runHoldReleaseSweep(harness.store, harness.deps(time.now));
      expect(harness.reserveCalls).toHaveLength(2);
      const refreshed = episodeOf(harness.markerPatches.at(-1));
      expect(refreshed).toBeDefined();
      expect(String(refreshed?.code)).toBe(sharpenedCode);
    });
  }

  it("(d2) releases an uncool sibling in the SAME pass that skips the hot card", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    /*
    The clock is warmed by a real refusal rather than pre-written, because under the shipped design the bound
    keys on `heldSince` and no row bytes can manufacture one — which is also the fail-open proof: a card that
    arrives with only a durable marker is still attempted. The sibling takes a slot and MOVES, so the pass
    that skips the hot card must still reach and release it.
    */
    const harness = await makeHarness(
      [{ id: "HOT" }, { id: "SIBLING", workflow: SIBLING_WF }],
      { refuseFor: ["HOT"] },
    );
    const time = clock();

    // Pass 1: the hot card pays for its refusal, the sibling crosses.
    await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(harness.reserveCalls).toContain("HOT");
    expect(harness.tasks.find((task) => task.id === "SIBLING")!.column).toBe("in-progress");

    // Reset the sibling so pass 2 has a real crossing left to make, then advance one poll.
    harness.tasks.find((task) => task.id === "SIBLING")!.column = "todo";
    time.advance(PASS_MS);
    const second = await runHoldReleaseSweep(harness.store, harness.deps(time.now));

    // The hot card never reaches the pool again, yet the sibling is still REACHED in the same pass.
    expect(harness.reserveCalls.filter((id) => id === "HOT")).toHaveLength(1);
    expect(second.held).toContainEqual({ taskId: "HOT", reason: "move-rejected-or-no-slot" });
    expect(second.released).toContain("SIBLING");
    expect(harness.tasks.find((task) => task.id === "SIBLING")!.column).toBe("in-progress");
  });

  it("(e) re-probes the moment the held clock ages out, so the bound cannot become a lock", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const harness = await makeHarness([{ id: "HOT" }], { refuseFor: ["HOT"] });
    const time = clock();

    // The first pass has no clock entry, so it MUST attempt, or this would be a lock rather than a bound.
    await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(harness.reserveCalls).toHaveLength(1);

    // Up to one millisecond before the floor it still rests.
    time.advance(WIP_ADMISSION_STALL_REFRESH_FLOOR_MS - 1);
    await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(harness.reserveCalls).toHaveLength(1);

    // One millisecond later the refusal is stale and the expensive leg runs again.
    time.advance(1);
    await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(harness.reserveCalls).toHaveLength(2);
  });

  it("(f) an episode naming a DIFFERENT column, and no episode at all, both evaluate normally", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const wrongColumn = refusedEpisode(T0, { fromColumn: "in-review" });
    const harness = await makeHarness([
      { id: "STRAY", sourceMetadata: wrongColumn },
      { id: "FRESH" },
    ], { refuseFor: ["STRAY", "FRESH"] });
    const time = clock();

    await runHoldReleaseSweep(harness.store, harness.deps(time.now));

    // Neither card is held back by an episode that does not describe it, or by no episode at all.
    expect([...harness.reserveCalls].sort()).toEqual(["FRESH", "STRAY"]);
  });

  it("(g) a malformed or legacy-shaped episode degrades to evaluate-normally (fail open)", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const malformed = {
      [WIP_ADMISSION_STALL_METADATA_KEY]: {
        code: "move-rejected-or-no-slot",
        // No signature, no node, no instants: `readWipAdmissionStallEpisode` must answer "no episode".
        fromColumn: "todo",
      },
    };
    const harness = await makeHarness([{ id: "LEGACY", sourceMetadata: malformed }], { refuseFor: ["LEGACY"] });
    const time = clock();

    await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(harness.reserveCalls).toContain("LEGACY");
  });

  it("(h) a wake burst of extra passes inside one floor still costs exactly one expensive attempt", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const harness = await makeHarness([{ id: "HOT" }], { refuseFor: ["HOT"] });
    const time = clock();

    await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(harness.reserveCalls).toHaveLength(1);

    // Five wakes in the same window: a `vacatedCapacitySlot` burst must not multiply the attempt.
    for (let wake = 0; wake < 5; wake += 1) {
      time.advance(1_000);
      await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    }
    expect(harness.reserveCalls).toHaveLength(1);
  });

  it("(j) the operator surfaces still probe immediately against a live bound and keep their durable refusal", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    /*
    FNXC:WipAdmissionParkCooldown 2026-11-22-05:18 (RUFU-558):
    The bound is now established by a REAL refusal through the sweep, not by pre-writing an episode. The
    shipped cadence key is `heldSince`, so a pre-written marker defers nothing, and the old fixture would
    have pinned an operator surface against a bound that was never live. An operator pressing promote, or a
    webhook arriving, is a different authority on the same card, and a bound that swallowed that request
    would be worse than no bound at all - it would turn a wait the operator can override into one they
    cannot. Neither `promoteHeldTask` nor `releaseHeldTaskByEvent` consults the predicate at all.
    */
    const harness = await makeHarness(
      [{ id: "OPERATOR" }, { id: "WEBHOOK", workflow: EVENT_WF }, { id: "UNPLANNED", workflow: UNPLANNED_WF, prompt: "" }],
      { refuseFor: ["OPERATOR", "WEBHOOK", "UNPLANNED"] },
    );
    const pool = { reserveSlot: (task: Task) => harness.reserveSlotOf(task) };
    const of = (id: string) => harness.reserveCalls.filter((called) => called === id).length;
    const time = clock();

    // Warm a genuine bound: refuse the card once through the sweep, then prove the next pass rests.
    await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(of("OPERATOR")).toBe(1);
    time.advance(PASS_MS);
    await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(of("OPERATOR")).toBe(1);

    const promoted = await promoteHeldTask(harness.store, "OPERATOR", pool);

    // Promote reached the pool WHILE THAT BOUND WAS LIVE: it was NOT memo-gated.
    expect(of("OPERATOR")).toBe(2);
    expect(promoted.released).toBe(false);
    // The pool still refuses, and the operator is told the honest reason rather than a silent no-op.
    expect(promoted.rejection).toBe("capacity-exhausted-or-no-slot");
    expect(harness.tasks.find((card) => card.id === "OPERATOR")!.column).toBe("todo");

    // A second explicit request is a second real attempt: the bound counts sweep passes, never requests.
    await promoteHeldTask(harness.store, "OPERATOR", pool);
    expect(of("OPERATOR")).toBe(3);

    // The webhook surface releases an `external-event` hold, and reaches the pool on its own card.
    const event = await releaseHeldTaskByEvent(harness.store, "WEBHOOK", "deploy-done", pool);
    expect(of("WEBHOOK")).toBe(1);
    expect(event.released).toBe(false);
    expect(event.rejection).toBe("capacity-exhausted-or-no-slot");

    /*
    FN-7648's durable refusal record is the other half of this pin. The recorder only fires behind an
    enabled pre-release Plan Review, so this third card sits on a workflow that has one and carries no plan.
    FN-7648's own suite (`hold-release-awaiting-planning.test.ts`) owns that contract; what THIS case owes
    is the narrower claim that a live capacity bound does not DISPLACE the recorder - the bound must bound
    repetition, never delete evidence an operator already asked for.
    */
    const recorder = vi.fn(async () => undefined);
    (harness.store as unknown as Record<string, unknown>).checkAndRecordUnplannedExecutionBlock = recorder;

    const refused = await promoteHeldTask(harness.store, "UNPLANNED", pool);

    expect(refused.released).toBe(false);
    expect(refused.rejection).toBe("unplanned-for-execution");
    expect(recorder).toHaveBeenCalledTimes(1);
    // Refused for being unplanned, so capacity was never asked - and that is the pre-existing contract.
    expect(of("UNPLANNED")).toBe(0);
  });

  it("(k) a readiness park is still evaluated every pass, so planning keeps running (RUFU-393 P0)", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    /*
    FNXC:WipAdmissionParkCooldown 2026-11-22-05:18 (RUFU-558):
    The RUFU-393 code-review P0 was a deferral derived from the marker that froze cards whose remaining work
    lives IN the refused column. The previous version of this case faked the shape by stamping an
    `awaiting-planning` code onto a card that was already planned, so it proved only that a label was being
    ignored. This card is GENUINELY unplanned on a workflow with an enabled pre-release Plan Review, so its
    held reason really is `awaiting-planning:<reason>` and the readiness leg is the thing that must keep
    running. The bound is reason-scoped, and a planning wait is not in its one-wide allowlist; the
    `awaiting-approval` half of the reason matrix is covered by the predicate unit tests, which is where a
    reason-scope claim belongs.
    */
    const harness = await makeHarness(
      [{ id: "PLAN", workflow: UNPLANNED_WF, prompt: "" }],
      { refuseFor: ["PLAN"] },
    );
    const time = clock();

    for (let pass = 0; pass < 4; pass += 1) {
      const result = await runHoldReleaseSweep(harness.store, harness.deps(time.now));
      expect(
        result.held.some((held) => held.taskId === "PLAN" && held.reason.startsWith("awaiting-planning:")),
      ).toBe(true);
      time.advance(PASS_MS);
    }

    // Every pass paid the readiness leg, so a plan landing is noticed on the pass it lands.
    expect(harness.promptReadsFor("PLAN")).toBeGreaterThan(3);
    // Readiness precedes the pool, so capacity was never asked - this refusal is a planning gate, not this one.
    expect(harness.reserveCalls).not.toContain("PLAN");
  });


  it("(l) a skip frees pass budget: a rotation-long board still releases its tail in the same pass", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    /*
    A skip must not consume or reorder the pass's `expired()` budget or the RUFU-698 rotation. Eight hot
    cards are refused for real on the warm-up pass, so the pass under test walks past all eight and still
    reaches the one releasable card at the END of the queue.
    */
    const cooled = Array.from({ length: 8 }, (_, index) => `HOT-${index}`);
    const harness = await makeHarness(
      [...cooled.map((id) => ({ id })), { id: "TAIL", workflow: SIBLING_WF }],
      { refuseFor: cooled },
    );
    const time = clock();

    /*
    FNXC:WipAdmissionParkCooldown 2026-11-22-05:18 (RUFU-558):
    Pass 1 warms the clock by being refused for real, and the tail crosses on that pass too. The claim under
    test is pass 2: a pass that walks past eight cooled cards must still reach the card at the END of the
    queue in the same pass, with the `expired()` budget and the RUFU-698 rotation untouched by the skips. The
    tail is put back into its hold column first, so pass 2 has a real crossing left to make. A pre-written
    episode can no longer warm this state, because the shipped cadence key is the sweep's held clock.
    */
    await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    const tail = harness.tasks.find((task) => task.id === "TAIL")!;
    expect(tail.column).toBe("in-progress");
    tail.column = "todo";
    const callsAfterWarmup = harness.reserveCalls.length;

    time.advance(PASS_MS);
    const result = await runHoldReleaseSweep(harness.store, harness.deps(time.now));

    // None of the eight hot cards reached the pool again...
    expect(harness.reserveCalls.filter((id) => id.startsWith("HOT-"))).toHaveLength(8);
    // ...the only new pool visit is the tail, and it still crossed in this same pass.
    expect(harness.reserveCalls).toHaveLength(callsAfterWarmup + 1);
    expect(result.released).toContain("TAIL");
    expect(tail.column).toBe("in-progress");
    for (const id of cooled) {
      expect(result.held).toContainEqual({ taskId: id, reason: "move-rejected-or-no-slot" });
    }
  });

  it("(m) a workspace card with per-repo state produces ONE card-level episode and ONE skip", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const harness = await makeHarness([{ id: "WS" }], { refuseFor: ["WS"] });
    const ws = harness.tasks.find((task) => task.id === "WS")!;
    ws.workspaceWorktrees = [
      { repoPath: "repo-a", branch: "fusion/ws", worktreePath: "/tmp/rufu-558-a" },
      { repoPath: "repo-b", branch: "fusion/ws", worktreePath: "/tmp/rufu-558-b" },
    ] as unknown as Task["workspaceWorktrees"];
    const time = clock();

    await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(harness.markerPatches).toHaveLength(1);

    time.advance(PASS_MS);
    await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(harness.reserveCalls).toHaveLength(1);
    expect(harness.markerPatches).toHaveLength(1);
  });

  /*
  FNXC:WipAdmissionParkCooldown 2026-11-22-05:18 (RUFU-558):
  Restart semantics, restated honestly. The bound keys on `heldSince`, an in-process Map, while the episode it
  announces is durable on the row, so the semantics are fail-OPEN: the first pass in a new process attempts
  once and the pass after it rests again inside the floor. One extra probe per restart is the deliberate price
  of adding no new durable state and no migration. The alternatives are both worse: reading the durable episode
  for cadence is the design this commit removed as inert, and a persistent seen-cache would be new durable
  state costing the same restart probe while owning a lifecycle field this task is forbidden to add. Modelled
  by handing the later sweep fresh instrumentation over the SAME row bytes.
  */
  it("(n) an engine restart pays exactly one re-probe: the clock is process-local, the episode is durable", async () => {
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const harness = await makeHarness([{ id: "HOT", sourceMetadata: refusedEpisode(T0) }], { refuseFor: ["HOT"] });
    const time = clock();

    // A durable episode alone defers nothing: pass one in a fresh process MUST attempt.
    await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(harness.reserveCalls).toHaveLength(1);

    // "Restart": forget the in-process clock, keep the row, advance one poll — still deep inside the floor.
    resetHoldReleaseInstrumentation();
    const restartTime = clock(T0 + PASS_MS);
    const restartedStore = harness.store;
    await runHoldReleaseSweep(restartedStore, harness.deps(restartTime.now));
    expect(harness.reserveCalls).toHaveLength(2); // the fail-open re-probe

    // And only now does the new process rest: the bound is intact one pass after the restart, not lost.
    restartTime.advance(PASS_MS);
    const resting = await runHoldReleaseSweep(restartedStore, harness.deps(restartTime.now));
    expect(harness.reserveCalls).toHaveLength(2);
    expect(resting.held).toContainEqual({ taskId: "HOT", reason: "move-rejected-or-no-slot" });
  });

  it("(o) an operator column move still clears the episode, and a cleared marker fabricates no bound", async () => {
    /*
    FNXC:WipAdmissionParkCooldown 2026-11-22-05:18 (RUFU-558):
    RUFU-393 put the clear at the ONE move seam (core `moves.ts`, `clearWipAdmissionStallPatch`) and this task
    leaves it there, unmodified. What changed is what the clear ACHIEVES: it is episode hygiene, not the lever
    that re-arms an attempt, because the cadence lives in `heldSince` and not in the marker. Asserting both
    halves keeps a future reader from re-keying the bound onto the marker to "fix" a card that is resting: the
    re-probe owners are the refresh floor and a held-reason change (case (r)), and an operator who wants to
    force an attempt has promote, which is never gated.
    */
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const clearedKeyPatch = clearWipAdmissionStallPatch();
    expect(clearedKeyPatch).toEqual({ [WIP_ADMISSION_STALL_METADATA_KEY]: null });

    const harness = await makeHarness(
      [{ id: "HOT", sourceMetadata: { ...refusedEpisode(T0), ...clearedKeyPatch } }],
      { refuseFor: ["HOT"] },
    );
    const time = clock();

    const pass = await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    // Key cleared at the move seam => no marker at all => the card attempts the leg on this very pass.
    expect(harness.reserveCalls).toEqual(["HOT"]);
    expect(pass.held).toContainEqual({ taskId: "HOT", reason: "move-rejected-or-no-slot" });
  });

  it("(r) a reason the cheap arms report re-arms the attempt, and the bound expires on its own", async () => {
    /*
    FNXC:WipAdmissionParkCooldown 2026-11-22-05:18 (RUFU-558):
    The two directions the bound has to be honest about, in the shape an operator can check.
    (1) FAIRNESS: a held-reason change observed by any arm UPSTREAM of the skip - here the in-memory lane
    sample going full and then freeing - re-arms the attempt on the very next pass, because the reported
    reason no longer matches the allowlist. The bound therefore adds no floor of latency to a condition the
    pass could measure for free, which is RUFU-393's fairness contract surviving this change rather than being
    quietly traded away for quietness.
    (2) BOUNDED BLINDNESS: a card whose remedy changes from "the pool has no slot" to "nobody has planned
    me" can only be discovered BY the expensive leg this skip withholds, so such a change costs a floor to
    notice. This harness cannot stage that transition, because readiness refuses an unplanned card only behind
    an enabled pre-release Plan Review - and a card on such a workflow never reaches the pool-refusal arm in
    the first place. So the guarantee is carried by case (k) (a genuine `awaiting-planning:*` park is
    evaluated every pass) and by the predicate matrix in `execution/__tests__/wip-admission-park.test.ts`,
    not by an assertion that would only look like it tested something. What IS pinned below is the consequence
    that makes the cost bounded rather than permanent: the bound expires on its own.
    */
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const harness = await makeHarness(
      [{ id: "CARD" }, { id: "F1" }, { id: "F2" }, { id: "F3" }, { id: "F4" }],
      { refuseFor: ["CARD", "F1", "F2", "F3", "F4"] },
    );
    const callsFor = (id: string) => harness.reserveCalls.filter((called) => called === id).length;
    const moveLane = (ids: string[], column: string) => {
      for (const id of ids) harness.tasks.find((card) => card.id === id)!.column = column;
    };
    const time = clock();

    // Pass 1: three occupants, room in the lane, so the expensive leg answers - and refuses.
    await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(callsFor("CARD")).toBe(1);
    time.advance(PASS_MS);
    await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(callsFor("CARD")).toBe(1); // bound warm, 15 s after a real refusal

    // The lane fills (cheap arm, no leg spent), then frees again one poll later.
    moveLane(["F1", "F2", "F3", "F4"], "in-progress");
    time.advance(PASS_MS);
    const full = await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(full.held).toContainEqual({ taskId: "CARD", reason: "downstream-full" });
    moveLane(["F1", "F2", "F3", "F4"], "todo");

    time.advance(PASS_MS);
    await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    // 45 s after its last attempt - a quarter of a floor. A bound keyed on elapsed hold time rests here.
    expect(callsFor("CARD")).toBe(2);

    /*
    And the bound expires. `lastAt` moves only when `publishWipAdmissionHold` accepts a write, which is itself
    one acceptance per floor, so the anchor is the last RECORDED refusal rather than the last attempt: one
    floor after that record, a card nobody has released is asked again on its own.
    */
    time.advance(PASS_MS);
    await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(callsFor("CARD")).toBe(2); // resting again, on the reason this card is really held by

    time.advance(WIP_ADMISSION_STALL_REFRESH_FLOOR_MS);
    await runHoldReleaseSweep(harness.store, harness.deps(time.now));
    expect(callsFor("CARD")).toBe(3);
  });

  it("(p) a manual Retry does NOT clear the episode — Retry re-grants budgets, not a capacity wait", async () => {
    /*
    `buildManualRetryResetPatch` clears five episodes (plan-premise, planning-admission, branch-conflict,
    deterministic-spec, stranded-reclaim) because each of those parks on a refusal the operator is overruling.
    `wipAdmissionStall` is deliberately absent: its release owner is the hold/release sweep, and clearing it
    on Retry would let a click-loop re-pay the expensive leg once per click — the storm this card closes.
    Asserted on the patch shape so a future edit cannot confuse the two families.
    */
    const patch = buildManualRetryResetPatch({ resetMergeRetries: true });
    const sm = patch.sourceMetadataPatch ?? {};
    expect(Object.keys(sm)).not.toContain(WIP_ADMISSION_STALL_METADATA_KEY);
    // The branch-conflict family IS cleared there: a refusal register the operator overrules, not a pool state.
    expect(Object.keys(sm).length).toBeGreaterThan(0);
  });

  it("(q) the bound is spelled in ONE module: the sweep holds no second opinion on freshness or class", () => {
    /*
    Anti-duplication ratchet. Three authorities read this one episode (sweep, graph entry, operator
    surfaces), which is why RUFU-393's floor lives in `@fusion/core`. The moment one of them re-derives
    `now - lastAt` or re-types the gate code, the lanes disagree in ways no behavioural test localises — the
    RUFU-372 reason-split lesson. A textual scan is the honest seam here because what is forbidden IS a
    second spelling, not a second behaviour.

    FNXC:WipAdmissionParkCooldown 2026-11-22-05:18 (RUFU-558):
    The scan runs over COMMENT-FREE source. Both files legitimately name `lastAt`, `heldSince` and the floor
    while explaining the design, so an unstripped scan reports its own documentation as a violation — which is
    how the first draft of this case failed. Code constructs are the subject; prose never is.
    */
    const stripProse = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    const here = dirname(fileURLToPath(import.meta.url));
    const sweep = stripProse(readFileSync(resolve(here, "../execution/hold-release.ts"), "utf8"));
    const park = stripProse(readFileSync(resolve(here, "../execution/wip-admission-park.ts"), "utf8"));

    // The sweep asks the predicate; it never touches the freshness fields itself.
    expect(sweep).toContain("wipAdmissionReleaseAttemptIsCooling");
    expect(sweep.match(/lastAt/g) ?? []).toHaveLength(0);
    expect(sweep).not.toContain("WIP_ADMISSION_STALL_REFRESH_FLOOR_MS");
    /*
    Both dead designs are barred by name, not merely absent by accident: the first cut keyed cadence on the
    durable episode's gate code (inert on the measured population), and the correction's first draft keyed it
    on `heldSince.sinceMs` (bounded exactly one floor, then nothing). Reading the marker for cadence belongs to
    the park module alone, so the sweep may not call its reader or its freshness test.
    */
    expect(sweep).not.toContain("wipAdmissionParkDefersReleaseAttempt");
    expect(sweep).not.toMatch(/readWipAdmissionStallEpisode|wipAdmissionStallAgeMs|wipAdmissionParkDefersDispatch/);
    // The sweep names the code ONLY to report a refusal it just observed. It must never TEST an episode's
    // code against that literal — the class test belongs to the predicate, or the two lanes disagree.
    expect(sweep).toContain("move-rejected-or-no-slot");
    expect(sweep).not.toMatch(/code\s*===?\s*["']move-rejected-or-no-slot["']/);
    expect(sweep).not.toMatch(/["']move-rejected-or-no-slot["']\s*===?\s*.*code/);
    // The bounded class is declared exactly once, in the park module, as a one-wide allowlist.
    const declarations = park.match(/const WIP_ADMISSION_HELD_REASONS_WITHOUT_CHEAP_RECHECK/g) ?? [];
    expect(declarations).toHaveLength(1);
    // And the allowlist really is one reason wide - widening it silently stops other gates being re-measured.
    const allowlist = park.match(/WIP_ADMISSION_HELD_REASONS_WITHOUT_CHEAP_RECHECK: readonly[^=]+= \[([\s\S]*?)\]/)?.[1] ?? "";
    expect(allowlist.match(/"[a-z-]+"/g)).toHaveLength(1);
    // `downstream-full` is the code that must NEVER join it: its cheap live re-check is the release signal.
    expect(allowlist).not.toContain("downstream-full");
    // And the floor is not re-declared as a new constant anywhere in either authority.
    expect((park.match(/FLOOR_MS\s*[:=]\s*\d/g) ?? []).length).toBe(0);
  });
});
