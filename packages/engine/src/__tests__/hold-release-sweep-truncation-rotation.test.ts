/*
FNXC:HoldReleaseTruncationRotation 2026-10-16-22:35 (RUFU-698 Step 3):
Field evidence: `Hold-release sweep: project=proj_9326d74a133b421a: 30038ms (… evaluate 27126ms over
642 tasks (…)), released=0, held=3, budget-truncated unevaluated=444, budgetOverrunMs=20038` — the same
`unevaluated=444` on EVERY pass. A truncated pass stops at `breakIndex` and the next pass re-sorts the
SAME list into the SAME order (`sortTasksByQueueOrder` is deterministic), so the cards behind the break
are re-skipped forever while `capacity_refused=0` says the pool is not full. The fix hands the deferred
tail their turn first.

These tests pin the fairness contract, not the perf:
 - the tail a truncated pass never reached is evaluated FIRST on the next pass (`rotated-deferred`);
 - a pass that finishes inside its budget ends the inversion, so the pass after it runs in plain queue
   order — the priority inversion is bounded to one pass, by construction;
 - a deferred id that left the board shifts nothing but its own absence.
Two fixture decisions make this deterministic rather than timing-dependent:
 - no card is ever released or moved by the blow-deadline fixtures, so `result.held` — pushed in
   evaluation order — IS the evaluation order, asserted on the result object;
 - the deadline is blown inside ONE CANDIDATE'S OWN evaluation, so exactly the card that triggered it
   is evaluated and every card behind it is the deferred tail.

FNXC:HoldReleaseTruncationRotation 2026-11-08-06:00 (RUFU-871):
The blow point used to be the first `getWorkflowDefinition` read, which RUFU-871's IR hoist moved OUT of
the candidate loop (one concurrent prefetch over the board's DISTINCT workflows now runs before it). A
deadline blown there truncates at index 0, which would leave this file asserting a pass that evaluated
nothing and a rotation of the whole board — a no-op ordering that proves nothing. So the trigger moved
to a call that is genuinely per-candidate and still is: the `release: "dependency"` arm's
`getCompletionHandoffAcceptedMarker` read, reached inside that one card's `release-config` evaluation.
The fairness contract under test is unchanged and the assertions are byte-identical — one card
evaluated, three deferred, the deferred tail served first on the next pass.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { resetHoldReleaseInstrumentation, runHoldReleaseSweep } from "../execution/hold-release.js";
import { schedulerLog } from "../logger.js";

const WF = "custom:rotate-wf";
/*
Rotation state is keyed by SWEEP PROJECT, not by store object (a central deployment holds several store
instances for one project's rows). Every fixture store here must therefore report the same project id,
or each pass would rotate a different project's tail and the test would observe nothing.
*/
const PROJECT_ID = "proj-rotation-test";

/*
FNXC:HoldReleaseTruncationRotation 2026-11-08-06:00 (RUFU-871): the deadline blow point. Every
`release: "dependency"` candidate depends on this one card, which rests in a column that is neither
`complete` nor a legacy terminal id, so the dependency is genuinely unmet and no candidate is ever
released. Because the sweep memoises the verdict per DISTINCT dependency, its handoff-marker read
happens exactly once per pass — inside the FIRST candidate's evaluation — which is the deterministic,
per-candidate moment this file needs the budget to die.
*/
const BLOCKER_ID = "D-BLOCK";

function task(id: string): Task {
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
    /*
    A card released into processing must pass the plan-premise gate (RUFU-145 / RUFU-246) and this
    store exposes no `getTasksDir`, so the gate reads `task.prompt`. The manual-hold column below never
    reaches that gate, but the field keeps the fixture honest for any future release-path assertion.
    */
    prompt: "# Planned\n\n## Mission\nImplement the approved work.\n",
  } as Task;
}

/** A hold column released when its dependencies settle. */
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

/** A `todo` hold card blocked on {@link BLOCKER_ID}, i.e. refused inside its own evaluation. */
function dependentTask(id: string): Task {
  const candidate = task(id);
  candidate.dependencies = [BLOCKER_ID];
  return candidate;
}

/** The blocker itself: not a hold card, so the sweep skips it and never holds or moves it. */
function blockerTask(): Task {
  const blocker = task(BLOCKER_ID);
  blocker.column = "waiting";
  return blocker;
}

/** A capacity hold with room to spare, so a refusal here is never a shortage. */
function capacityIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", label: "In Progress", traits: [{ trait: "wip", config: { limit: 10 } }] },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

/**
 * `blowDeadline` advances the shared clock past the sweep budget during the FIRST handoff-marker read,
 * which the dependency arm performs inside the first candidate's own evaluation: that candidate is
 * refused and counted, the next top-of-loop deadline check truncates, and everything behind it becomes
 * the deferred tail.
 */
function storeWith(
  tasks: Task[],
  clock: { t: number },
  opts: { blowDeadline?: boolean; ir?: WorkflowIr; armed?: string[]; armedReads?: { n: number } } = {},
): TaskStore {
  const selection = { workflowId: WF, stepIds: [] };
  let reads = 0;
  return {
    getWorkflowSettingsProjectId: () => PROJECT_ID,
    getSettings: vi.fn(async () => ({ maxConcurrent: 4 })),
    listTasks: vi.fn(async () => tasks),
    moveTaskIf: vi.fn(async (id: string, column: string) => {
      const cur = tasks.find((t) => t.id === id)!;
      cur.column = column;
      return { task: cur, moved: true };
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => {
      reads += 1;
      if (opts.blowDeadline && reads === 1) clock.t += 11;
      return null;
    }),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: opts.ir ?? dependencyHoldIr() })),
    /*
    FNXC:HoldReleaseArmedPriority 2026-11-21-04:28 (RUFU-807 Step 2):
    The armed-continuation seam, opt-in per fixture. Boards that do not pass `armed` get NO method at all,
    which is the pre-RUFU-807 store shape the existing RUFU-698 assertions must keep passing against — the
    duck-typed guard, not an empty set, is what leaves those orders byte-identical.
    */
    ...(opts.armed
      ? {
        listActiveTaskContinuationTaskIds: vi.fn(async () => {
          if (opts.armedReads) opts.armedReads.n += 1;
          return new Set(opts.armed);
        }),
      }
      : {}),
  } as unknown as TaskStore;
}

/** `held` is appended in evaluation order, so its ids are the order the sweep actually walked. */
const heldOrder = (result: { held: { taskId: string }[] }): string[] => result.held.map((entry) => entry.taskId);

describe("hold-release sweep truncation rotation (RUFU-698)", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
  });

  it("evaluates the tail a truncated pass never reached first on the next pass", async () => {
    const debug = vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
    // Equal createdAt everywhere → `sortTasksByQueueOrder` falls through to id. D-BLOCK sorts first and
    // is skipped (its column carries no hold trait), so the candidates walk in R-A…R-D order.
    const tasks = [blockerTask(), dependentTask("R-A"), dependentTask("R-B"), dependentTask("R-C"), dependentTask("R-D")];
    const clock = { t: 1_000 };
    const deps = { now: () => clock.t };

    // Pass 1: the deadline dies inside R-A's dependency arm, so B/C/D are the deferred tail.
    const first = await runHoldReleaseSweep(storeWith(tasks, clock, { blowDeadline: true }), { ...deps, budgetMs: 10 });
    expect(first.budgetTruncated).toBe(true);
    expect(first.unevaluatedCount).toBe(3);
    expect(heldOrder(first)).toEqual(["R-A"]);
    expect(first.rotatedDeferredCount).toBeUndefined();

    // Pass 2: the deferred tail competes first, and R-A goes back to the end it should have had.
    const second = await runHoldReleaseSweep(storeWith(tasks, clock), deps);
    expect(second.budgetTruncated).toBeUndefined();
    expect(second.rotatedDeferredCount).toBe(3);
    expect(heldOrder(second)).toEqual(["R-B", "R-C", "R-D", "R-A"]);

    const line = [...warn.mock.calls, ...debug.mock.calls]
      .map((call) => String(call[0]))
      .find((l) => l.includes("rotated-deferred=3"));
    expect(line).toBeDefined();

    /*
    Pass 3: pass 2 finished inside its budget, which DELETES the recorded tail — the priority
    inversion is bounded to one pass and cannot become a permanent starvation of the queue head.
    */
    const third = await runHoldReleaseSweep(storeWith(tasks, clock), deps);
    expect(third.rotatedDeferredCount).toBeUndefined();
    expect(heldOrder(third)).toEqual(["R-A", "R-B", "R-C", "R-D"]);
  });

  /*
  FNXC:HoldReleaseTruncationRotation 2026-10-16-21:00 (RUFU-698 Step 4 — symptom verification):
  ORIGINAL SYMPTOM: `Hold-release sweep … 30038ms … released=0, held=3, budget-truncated
  unevaluated=444` on EVERY pass of a 642-task project, with `capacity_refused=0`, i.e. capacity was
  free and the same 444 cards were never examined twice.

  EXACT REPRODUCTION: a capacity-releasable board whose reservation leg spends the sweep budget, a
  queue head whose admission is refused, and a tail behind the break. The fake clock advances inside
  `reserveSlot` (25 ms per call, 60 ms budget), which is what the field sweep measured at seconds per
  call, so truncation is deterministic rather than timing-dependent.

  ASSERTION IT IS GONE: the shape `truncated AND released nothing` may appear once, but it must not
  survive a second pass while capacity is free — the deferred tail is served first and releases.
  */
  it("releases the starved tail on the next pass while capacity is free", async () => {
    const warn = vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
    const clock = { t: 1_000 };
    const tasks: Task[] = [];
    for (let index = 0; index < 60; index += 1) tasks.push(task(`FILL-${String(index).padStart(3, "0")}`));
    for (let index = 1; index <= 12; index += 1) tasks.push(task(`C-${String(index).padStart(2, "0")}`));
    for (const filler of tasks) filler.column = filler.id.startsWith("C-") ? "todo" : "done";
    const store = storeWith(tasks, clock, { ir: capacityIr() });

    /*
    The first three cards lose admission (the field case: a higher-priority lifecycle lane took the
    slot), and each attempt spends 25 ms of a 60 ms budget — the leg is what exhausts it, not the count.
    */
    const refusedHeadIds = new Set(["C-01", "C-02", "C-03"]);
    const reserveSlot = async (candidate: Task) => {
      clock.t += 25;
      return refusedHeadIds.has(candidate.id) ? null : { release: () => undefined };
    };
    const deps = { now: () => clock.t, budgetMs: 60, reserveSlot };

    // Pass 1 reproduces the report exactly: truncated, and nothing released despite free capacity.
    const first = await runHoldReleaseSweep(store, deps);
    expect(first.budgetTruncated).toBe(true);
    expect((first.unevaluatedCount ?? 0)).toBeGreaterThan(0);
    expect(first.released).toEqual([]);

    // Pass 2: the deferred tail is served first and releases — the pairing is broken.
    const second = await runHoldReleaseSweep(store, deps);
    expect(second.rotatedDeferredCount).toBeGreaterThan(0);
    expect(second.released.length).toBeGreaterThan(0);
    expect(second.released).toContain("C-04");
    const line = [...warn.mock.calls].map((call) => String(call[0])).find((l) => l.includes("rotated-deferred="));
    expect(line).toBeDefined();
  });

  it("a deferred id that left the board shifts nothing else", async () => {
    const tasks = [blockerTask(), dependentTask("S-A"), dependentTask("S-B"), dependentTask("S-C")];
    const clock = { t: 1_000 };
    const store = storeWith(tasks, clock, { blowDeadline: true });

    const first = await runHoldReleaseSweep(store, { now: () => clock.t, budgetMs: 10 });
    expect(first.budgetTruncated).toBe(true);
    expect(heldOrder(first)).toEqual(["S-A"]);

    // The deferred id S-B leaves the board before the next pass; only S-C survives out of the tail.
    tasks.splice(tasks.findIndex((t) => t.id === "S-B"), 1);
    const second = await runHoldReleaseSweep(store, { now: () => clock.t });
    // The stale id is ignored silently — no error, and the surviving deferred card still leads.
    expect(second.rotatedDeferredCount).toBe(1);
    expect(heldOrder(second)).toEqual(["S-C", "S-A"]);
  });

  /*
  FNXC:HoldReleaseArmedPriority 2026-11-21-04:38 (RUFU-807 Step 2):
  ORIGINAL SYMPTOM (field): a card whose Plan Review APPROVED sits in `todo` holding a live continuation
  while every pass prints `Hold-release sweep … budget-truncated unevaluated=700, scanned=873` and every
  release surface keeps answering "Plan Review is now queued for this card and will run". WIP slots were
  mostly free, so the sweep's own budget was the gate, and the armed card always landed in the tail.

  EXACT REPRODUCTION here, in the real sequence: pass 1 truncates with the card NOT yet armed, leaving it
  in the deferred tail; Plan Review then approves and the card owns a continuation. Under RUFU-698's single
  rotation window the NEXT pass serves the non-armed deferred card first, spends its one evaluation on it,
  and refuses the armed card again.

  ASSERTION IT IS GONE: the pass after the arming evaluates the ARMED card first — ahead of the deferred
  non-armed tail — and a later full pass proves the partitions are disjoint (every card exactly once).
  */
  it("evaluates an armed card inside the next pass's budget, ahead of the deferred non-armed tail", async () => {
    const warn = vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
    // Queue order (equal createdAt) falls through to id: A-PLAIN-1 < A-PLAIN-2 < ARMED-1 < D-BLOCK.
    const tasks = [blockerTask(), dependentTask("A-PLAIN-1"), dependentTask("A-PLAIN-2"), dependentTask("ARMED-1")];
    const armed = ["ARMED-1"];
    const clock = { t: 1_000 };
    const deps = { now: () => clock.t, budgetMs: 10 };

    /*
    Pass 1, PRE-arming: the store exposes no armed seam at all, which is both the pre-RUFU-807 shape and
    the real sequence — a card is only armed once Plan Review's approval releases its continuation. Plain
    queue order evaluates A-PLAIN-1, its arm blows the deadline, and three entries defer, ARMED-1 among
    them (D-BLOCK sorts last and is skipped by the loop but still occupies an index).
    */
    const first = await runHoldReleaseSweep(storeWith(tasks, clock, { blowDeadline: true }), deps);
    expect(first.budgetTruncated).toBe(true);
    expect(first.unevaluatedCount).toBe(3);
    expect(heldOrder(first)).toEqual(["A-PLAIN-1"]);
    expect(first.armedPriorityCount).toBeUndefined();

    /*
    Pass 2 is the whole defect: ARMED-1 has just been armed. Pre-RUFU-807 this order was
    [A-PLAIN-2, ARMED-1, D-BLOCK, A-PLAIN-1] — the non-armed deferred card wins, the deadline dies in ITS
    arm, and ARMED-1 is refused for a second pass running. Post-fix the armed partition wins and ARMED-1 is
    the one evaluation this pass gets.
    */
    const second = await runHoldReleaseSweep(storeWith(tasks, clock, { blowDeadline: true, armed }), deps);
    expect(second.budgetTruncated).toBe(true);
    expect(heldOrder(second)).toEqual(["ARMED-1"]);
    expect(second.armedPriorityCount).toBe(1);
    // RUFU-698's window is intact: the non-armed deferred cards still rotate, just BEHIND the armed one.
    expect(second.rotatedDeferredCount).toBe(2);

    /*
    Pass 3 runs the whole board inside its budget: armed partition, then the deferred non-armed tail, then
    the queue head. Exactly three entries, each once, proves no card sits in two partitions and that
    RUFU-698's tail still gets its turn — the armed partition is a priority, not a replacement for the
    fairness fix. Within the deferred partition the cards keep QUEUE order (RUFU-698's own rule), which is
    why A-PLAIN-1 precedes A-PLAIN-2 here even though A-PLAIN-2 was deferred one pass earlier.
    */
    const third = await runHoldReleaseSweep(storeWith(tasks, clock, { armed }), deps);
    expect(third.budgetTruncated).toBeUndefined();
    expect(heldOrder(third)).toEqual(["ARMED-1", "A-PLAIN-1", "A-PLAIN-2"]);
    expect(new Set(heldOrder(third)).size).toBe(3);
    // All three deferred entries from pass 2 rotate, D-BLOCK included — it is rotated and then skipped by
    // its own column check, which is why it never appears in `held`.
    expect(third.rotatedDeferredCount).toBe(3);

    const line = [...warn.mock.calls].map((call) => String(call[0])).find((l) => l.includes("armed-first="));
    expect(line).toContain("armed-first=1");
  });

  /*
  FNXC:HoldReleaseArmedPriority 2026-11-21-04:28 (RUFU-807 Step 2):
  An armed POPULATION — the shape RUFU-698 was written for, now with continuations on every card. The
  armed partition rotates under the same one-pass-bounded inversion and stays BOUNDED by
  MAX_ARMED_PRIORITY_IDS (200), so a 400-card armed wave cannot permanently starve the queue head: the
  cards past the cap are still evaluated, in queue order, in the third partition.
  */
  it("rotates inside the armed partition and bounds it at the armed-priority cap", async () => {
    const armedIds = Array.from({ length: 400 }, (_unused, index) => `ARM-${String(index).padStart(3, "0")}`);
    const tasks = [blockerTask(), ...armedIds.map((id) => dependentTask(id))];
    const clock = { t: 1_000 };
    const deps = { now: () => clock.t, budgetMs: 10 };

    /*
    Pass 1: the armed front holds exactly the cap (ARM-000…ARM-199) and ARM-200…ARM-399 fall to the third
    partition in queue order. ARM-000's arm blows the deadline, so 400 of the 401 entries defer.
    */
    const first = await runHoldReleaseSweep(storeWith(tasks, clock, { blowDeadline: true, armed: armedIds }), deps);
    expect(first.armedPriorityCount).toBe(200);
    expect(first.unevaluatedCount).toBe(400);
    expect(heldOrder(first)).toEqual(["ARM-000"]);

    /*
    Pass 2: 399 armed cards deferred, so the recorded armed tail is the CAP (ARM-001…ARM-200) and not the
    399 — the bound is what holds — while the remainder rotates behind it under RUFU-698's window.
    */
    const second = await runHoldReleaseSweep(storeWith(tasks, clock, { blowDeadline: true, armed: armedIds }), deps);
    expect(second.armedPriorityCount).toBe(200);
    expect(second.rotatedDeferredCount).toBeGreaterThan(0);
    expect(second.rotatedDeferredCount).toBeLessThan(201);
    // The armed front is queue-ordered, and the deadline dies in the first one's arm.
    expect(heldOrder(second)).toEqual(["ARM-001"]);

    /*
    A full pass evaluates every one of the 400 exactly once — the partitions never overlap. The head is
    ARM-000 (deferred again by pass 2, and queue-first), while ARM-001 — the card pass 2 actually spent its
    evaluation on — has LEFT the armed tail: the rotation advances by real progress, not by a fixed step.
    */
    const third = await runHoldReleaseSweep(storeWith(tasks, clock, { armed: armedIds }), deps);
    expect(third.budgetTruncated).toBeUndefined();
    expect(heldOrder(third)).toHaveLength(400);
    expect(new Set(heldOrder(third)).size).toBe(400);
    expect(heldOrder(third).slice(0, 2)).toEqual(["ARM-000", "ARM-002"]);
  });

  /*
  FNXC:HoldReleaseArmedPriority 2026-11-21-04:28 (RUFU-807 Step 2):
  The armed read is a NEW database read in a sweep whose whole history (RUFU-201, RUFU-871) is spending
  reads it did not need. An empty-candidate pass must issue none: a pass whose only card is skipped
  before IR resolution evaluates nothing, so ordering nothing must not cost a query. Asserted as a number
  because "the sweep got one cheap read" is exactly the regression nobody would notice in the field.
  */
  it("issues no armed read on a pass with no candidate to order", async () => {
    const skipped = dependentTask("P-PAUSED");
    skipped.dependencies = [];
    skipped.paused = true;
    const armedReads = { n: 0 };
    const store = storeWith([skipped], { t: 1_000 }, { armed: ["P-PAUSED"], armedReads });

    const result = await runHoldReleaseSweep(store, { now: () => Date.now(), budgetMs: 10 });

    expect(result.budgetTruncated).toBeUndefined();
    expect(armedReads.n).toBe(0);
    expect(result.armedPriorityCount).toBeUndefined();
  });
});
