/*
FNXC:HoldReleaseArmedPriority 2026-11-21-05:52 (RUFU-807):
The behavioural half of the fix: an armed card — one whose Plan Review was already discharged and
which owns an active `waitReason:"capacity"` continuation — must be RELEASED by the first pass after
it is armed, not by the Nth. RUFU-805 measured a card waiting 46.5 minutes across 42 passes while
every pass reported `released=0` and 700 of 873 candidates went unevaluated.

These tests are the assertion the task previously lacked: the rotation-ordering file proves armed ids
are sorted first and deferred last, but a card that is merely *examined* proves nothing about delivery.
Here the release itself is the assertion (`result.released`), and the same board is run twice with one
variable — whether the store exposes the armed reader — so the assertion is non-vacuous at the fixture
level rather than passing because a fixture never enabled the gate.

Both halves of the P1 rule live here: the release is proved, and the Plan Review gate is proved NOT
waived for an armed card whose review is still unsatisfied.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { PLAN_REVIEW_GROUP_ID } from "@fusion/core";

import { runHoldReleaseSweep, resetHoldReleaseInstrumentation } from "../execution/hold-release.js";
import { schedulerLog } from "../logger.js";

const WF = "custom:armed-priority-wf";
const ARMED_ID = "Z-ARMED";
/** A pass spends its wall-clock budget on real work; 25 ms per real reservation attempt is the
 *  stand-in the rotation file uses for the same shape (RUFU-805's real work was a pg round-trip). */
const REAL_RESERVE_MS = 25;
const BUDGET_MS = 60;

function card(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `Card ${id}`,
    description: "planned card",
    column: "todo",
    status: null,
    projectId: "proj-armed-priority-test",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    // A planned prompt with no premises: the plan-premise gate is vacuously satisfied, so the only
    // question left in play is whether this card's turn came up inside the pass's budget.
    prompt: "# Planned\n\n## Mission\nImplement the approved work.\n",
    ...over,
  } as Task;
}

/**
 * A capacity-bearing hold releasing into one WIP-limited column.
 *
 * The Plan Review group node is `defaultOn: false` on purpose. Fillers therefore never enter the
 * review wait at all and stay admissible, which is what keeps the budget burn real; the armed card
 * opts in explicitly through `enabledWorkflowSteps`, so ITS review gate really is enabled and only
 * its passing verdict lets it through. An armed release that rode on a disabled gate would prove
 * nothing about the gate this fix must not waive.
 */
function ir(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    name: "Armed priority",
    columns: [
      { id: "todo", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      {
        id: PLAN_REVIEW_GROUP_ID,
        name: "Plan Review",
        kind: "optional-group",
        column: "todo",
        config: { defaultOn: false, template: { nodes: [], edges: [] } },
      },
      { id: "execute", kind: "prompt", column: "in-progress", config: { prompt: "execute" } },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [],
    artifacts: [],
  } as unknown as WorkflowIr;
}

/** A satisfied Plan Review: the passing verdict the arming transition already published. */
const SATISFIED_REVIEW = [{
  workflowStepId: PLAN_REVIEW_GROUP_ID,
  workflowStepName: "Plan Review",
  status: "passed" as const,
  completedAt: "2026-11-20T00:00:00.000Z",
}];

function storeFor(tasks: Task[], opts: { armedReader: boolean; armedIds?: string[]; activeRow?: boolean }) {
  const selection = { workflowId: WF, stepIds: [] };
  const heldWorkItems = [{
    id: `wi:${ARMED_ID}`,
    taskId: ARMED_ID,
    nodeId: "step-execute",
    state: "held",
    waitReason: "capacity",
    sourceColumn: "todo",
  }];
  const store = {
    getSettings: vi.fn(async () => ({ maxConcurrent: 10 })),
    listTasks: vi.fn(async () => tasks),
    moveTaskIf: vi.fn(async (id: string, column: string) => {
      const cur = tasks.find((t) => t.id === id)!;
      cur.column = column;
      return { task: cur, moved: true };
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    updateTask: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: ir() })),
    listWorkflowWorkItemsForTask: vi.fn(async (taskId: string) => (
      opts.activeRow === false || taskId !== ARMED_ID ? [] : heldWorkItems
    )),
  } as unknown as TaskStore & Record<string, unknown>;
  if (opts.armedReader) {
    // The real store returns a Set of the projected ids and never answers for a card it was not
    // asked about, so the fake keeps both halves of that contract.
    const armed = opts.armedIds ?? [ARMED_ID];
    store.listActiveTaskContinuationTaskIds = vi.fn(async (ids: readonly string[]) => new Set(ids.filter((id) => armed.includes(id))));
  }
  return store;
}

function clock(startMs = 1_000_000) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/**
 * Every card but the armed one loses its reservation: the field shape RUFU-805 measured, where the
 * lifecycle lane took the slot, board-wide live WIP was 0, and no card ever crossed. A real
 * reservation attempt is still made — and still costs the pass its budget.
 */
function depsFor(tk: ReturnType<typeof clock>) {
  return {
    now: tk.now,
    budgetMs: BUDGET_MS,
    // The real signature hands the sweep the candidate Task, not an id.
    reserveSlot: async (candidate: Task) => {
      tk.advance(REAL_RESERVE_MS);
      return candidate.id === ARMED_ID ? { release: async () => undefined } : null;
    },
  };
}

describe("hold/release sweep: armed cards are released on the pass that arms them", () => {
  let log!: ReturnType<typeof vi.spyOn>;
  let warn!: ReturnType<typeof vi.spyOn>;
  let debug!: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
    log = vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    warn = vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
    debug = vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
  });

  /** The sweep's one-line summary reaches the scheduler log, not the result object. */
  function logLine(containing: string): string | undefined {
    return [...warn.mock.calls, ...debug.mock.calls, ...log.mock.calls]
      .map((call) => String(call[0]))
      .find((line) => line.includes(containing));
  }

  it("releases the last-sorted armed card on pass 1 while every other candidate loses its slot", async () => {
    // 300 candidates: a lane larger than one pass can evaluate, as RUFU-805 measured.
    const fillers = Array.from({ length: 299 }, (_, index) => card(`C-${String(index + 1).padStart(3, "0")}`));
    const armed = card(ARMED_ID, {
      approvedPlanFingerprint: "fp-armed",
      enabledWorkflowSteps: [PLAN_REVIEW_GROUP_ID],
      workflowStepResults: SATISFIED_REVIEW,
    });
    const tasks = [...fillers, armed];
    // Every id sorts before the armed card, so queue order alone puts the armed candidate last.
    expect(tasks.map((task) => task.id).indexOf(ARMED_ID)).toBe(tasks.length - 1);

    const tk = clock();
    const store = storeFor(tasks, { armedReader: true });
    const result = await runHoldReleaseSweep(store, depsFor(tk) as never);

    // The pass-1 release: the assertion the truncation-rotation file did not carry.
    expect(result.released).toEqual([ARMED_ID]);
    expect(armed.column).toBe("in-progress");
    expect(result.armedPriorityCount).toBe(1);
    expect(logLine("armed-first=1")).toBeDefined();
    // Budget spent: the armed release plus the first refusals, then the truncation guard.
    expect(result.budgetTruncated).toBe(true);
    expect(result.unevaluatedCount).toBeGreaterThan(0);
    // Nothing earned a starvation badge once the armed card itself crossed.
    expect(result.starvedArmedCount).toBeUndefined();
  });

  it("does not release that card on pass 1 when the store cannot answer which cards are armed", async () => {
    // The pre-RUFU-807 store, replayed through the SAME code: the seam was the only input that
    // changed, and the field outcome — a pass that releases nothing while the armed card waits —
    // is what this card was filed about.
    const fillers = Array.from({ length: 299 }, (_, index) => card(`C-${String(index + 1).padStart(3, "0")}`));
    const armed = card(ARMED_ID, {
      approvedPlanFingerprint: "fp-armed",
      enabledWorkflowSteps: [PLAN_REVIEW_GROUP_ID],
      workflowStepResults: SATISFIED_REVIEW,
    });
    const tasks = [...fillers, armed];

    const result = await runHoldReleaseSweep(
      storeFor(tasks, { armedReader: false }),
      depsFor(clock()) as never,
    );

    expect(result.released).toEqual([]);
    expect(result.armedPriorityCount).toBeUndefined();
    expect(armed.column).toBe("todo");
    // The armed card sat in the tail no pass reached, which is the starvation being fixed.
    expect(result.held.some((held) => held.taskId === ARMED_ID)).toBe(false);
    expect(result.unevaluatedCount).toBeGreaterThan(0);
  });

  it("withholds the release from a card whose Plan Review is still unsatisfied", async () => {
    /*
    The fix reorders the queue; it must never waive a gate. Two shapes keep the gate shut here, and both
    are asserted: an unsatisfied verdict with no armed capacity row is refused outright, and the refusal
    names the review rather than a slot. (A card with an unsatisfied verdict BUT an armed capacity row is
    the RUFU-1050 discharge state and releases by design — that arm is covered in
    `hold-release-unclaimed-admission.test.ts`, not weakened here.)
    */
    const fillers = Array.from({ length: 5 }, (_, index) => card(`C-00${index + 1}`));
    const armed = card(ARMED_ID, {
      approvedPlanFingerprint: "fp-armed",
      enabledWorkflowSteps: [PLAN_REVIEW_GROUP_ID],
      workflowStepResults: [{
        workflowStepId: PLAN_REVIEW_GROUP_ID,
        workflowStepName: "Plan Review",
        status: "pending" as const,
      }],
    });
    const store = storeFor([...fillers, armed], { armedReader: true, activeRow: false });

    const result = await runHoldReleaseSweep(store, depsFor(clock()) as never);

    expect(result.released).toEqual([]);
    expect(armed.column).toBe("todo");
    const held = result.held.find((row) => row.taskId === ARMED_ID);
    expect(held?.reason).toContain("awaiting-planning:plan-review-pending");
  });

  it("reaches the armed card on pass 1 at the measured RUFU-805 ratio (873 scanned, ~700 unevaluated)", async () => {
    // The production line was `scanned=873 evaluated=173 unevaluated=700 armed-first=0`. The ratio
    // is reproduced here (one pass evaluates a small fraction of the lane) and the armed card is
    // released anyway, because it is evaluated before the budget runs out.
    const fillers = Array.from({ length: 872 }, (_, index) => card(`C-${String(index + 1).padStart(4, "0")}`));
    const armed = card(ARMED_ID, {
      approvedPlanFingerprint: "fp-armed",
      enabledWorkflowSteps: [PLAN_REVIEW_GROUP_ID],
      workflowStepResults: SATISFIED_REVIEW,
    });
    const result = await runHoldReleaseSweep(
      storeFor([...fillers, armed], { armedReader: true }),
      depsFor(clock()) as never,
    );

    expect(result.released).toEqual([ARMED_ID]);
    expect(logLine("budget-truncated")).toBeDefined();
    expect(result.unevaluatedCount).toBeGreaterThanOrEqual(700);
    // The armed card was reached, so no armed card earned a starvation badge this pass.
    expect(result.starvedArmedCount).toBeUndefined();
  });
});
