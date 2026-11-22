/*!
FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
The dispatch deferral is what actually stops the measured storm: one card wrote 16 536
`task:workflow-run-suspended` rows over 2 d 19 h because every scheduler pass entered the graph, re-parked at
the same hold→WIP boundary, and re-recorded a refusal for a condition only a release can change.

Two things are pinned here, because the failure mode this design answers (RUFU-1511 / PR #3317) was a guard
that survived a refactor by moving to a surface where it never fired:
1. the predicate's three conjuncts, each on its own — a marker that no longer describes reality must never
   hold a card back, and a marker that does must survive repeated dispatches;
2. that the OUTER dispatch surface (`executeCore`) really consults it before claiming graph routing, since
   the hot loop enters through that surface and a guard placed only on the inner graph-entry path would be
   exactly the bug that already happened once.

FNXC:WipAdmissionPark 2026-11-02-09:21 (RUFU-393 code-review P0):
Both DIRECTIONS of one decision are now pinned, because the first version of this file asserted only the
first and the second shipped as a freeze: a card parked by the sweep with `awaiting-planning` had its
planning dispatch dropped by the very guard meant to spare it a doomed re-approach, so it was never planned,
never crossed, and re-stamped its own marker forever. Deferral (`storm bound`) and non-deferral (`in-lane
work`) are the same function read from two sides, and a suite that tests one side cannot see the other break.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, WorkflowIr } from "@fusion/core";
import { WIP_ADMISSION_STALL_METADATA_KEY, WIP_ADMISSION_STALL_REFRESH_FLOOR_MS } from "@fusion/core";
import { executeCore, type ExecuteCoreDeps } from "../executor/execute-core.js";
import { buildExecuteCoreDeps } from "../executor/deps-bags.js";
import {
  wipAdmissionGateHasInLaneRemedy,
  wipAdmissionInLaneWork,
  wipAdmissionInLaneWorkProbe,
  wipAdmissionParkDefersDispatch,
  wipAdmissionParkDefersGraphEntry,
  wipAdmissionReleaseAttemptIsCooling,
} from "../execution/wip-admission-park.js";

const TASK_ID = "RUFU-393";
/*
FNXC:WipAdmissionParkCooldown 2026-11-19-22:55 (RUFU-558):
This anchor was a frozen literal (`Date.parse("2026-11-02T12:00:00.000Z")`) while the marker it stamps is
read against the WALL CLOCK. `wipAdmissionParkDefersDispatch` answers freshness as
`now - lastAt < WIP_ADMISSION_STALL_REFRESH_FLOOR_MS`, and the surfaces under test - `executeCore` and the
column-boundary hooks - call it with `Date.now()` and no injected clock. A fixture 15 minutes wide cannot
survive a calendar: seventeen days after it was written, every `episode()` in this file aged out, and three
`executeCore` cases went red because the PRODUCTION code correctly refused to trust a stale marker. The
defect was in the fixture's clock, not in the guard.

This is the same trap the file already names further down - "The deferral clock is wall-clock Date.now(),
so 'old' must be expressed relative to real now" - which had been applied to the one aged case and not to
the anchor every FRESH case inherits. Anchoring `NOW` to the real clock fixes both directions at once: a
fresh `lastAt` stays fresh and `NOW - REFRESH_FLOOR` stays exactly at the floor, and every predicate case
that injects `NOW` explicitly stays deterministic because its margins are 60 s and 15 min, not
milliseconds.
*/
const NOW = Date.now();

function episode(overrides: Record<string, unknown> = {}) {
  return {
    code: "scheduler-seam",
    signature: "capacity|todo->in-progress",
    nodeId: "hold-release-sweep",
    fromColumn: "todo",
    toColumn: "in-progress",
    lastAt: new Date(NOW - 60_000).toISOString(),
    firstAt: new Date(NOW - 3 * 60 * 60_000).toISOString(),
    stallCount: 12,
    ...overrides,
  };
}

function parkedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "parked at the seam",
    column: "todo",
    sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode() },
    ...overrides,
  } as Task;
}

function buildDeps() {
  const executeWorkflowGraph = vi.fn(async () => undefined);
  return {
    graphRouting: new Set<string>(),
    completionFinalizedTaskIds: new Set<string>(),
    releaseSemaphore: vi.fn(),
    clearStalePauseAbortBeforeDispatch: vi.fn(async () => undefined),
    blockOuterDispatchWhenDependenciesUnmet: vi.fn(async () => false),
    blockOuterDispatchWhenFileScopeLeaseHeld: vi.fn(async () => false),
    /*
    FNXC:WipAdmissionPark 2026-11-02-09:21 (RUFU-393 code-review P0):
    These cases pin the MARKER conjuncts, so the second authority is pinned to the answer that keeps them
    meaningful: nothing to run in this column. Left undefined the decision fails open and every deferral
    assertion below would be vacuously green.
    */
    hasInLaneWorkflowWork: vi.fn(async () => false),
    executeWorkflowGraph,
  };
}

describe("wipAdmissionParkDefersDispatch — the shared predicate", () => {
  it("defers while a fresh marker names the column the card is standing in", () => {
    const deferred = wipAdmissionParkDefersDispatch(parkedTask(), NOW);
    expect(deferred?.episode.signature).toBe("capacity|todo->in-progress");
    expect(deferred?.ageMs).toBe(60_000);
  });

  it("defers on every repeated dispatch, which is the loop it exists to stop", () => {
    const task = parkedTask();
    for (let i = 0; i < 50; i += 1) expect(wipAdmissionParkDefersDispatch(task, NOW)).toBeTruthy();
  });

  it("dispatches once the marker stops being refreshed past one floor, because a stale marker is not evidence", () => {
    const task = parkedTask({
      sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode({ lastAt: new Date(NOW - WIP_ADMISSION_STALL_REFRESH_FLOOR_MS).toISOString() }) },
    });
    expect(wipAdmissionParkDefersDispatch(task, NOW)).toBeUndefined();
  });

  it("dispatches when the marker names a different column, so a card that moved on is never held back", () => {
    const task = parkedTask({
      sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode({ fromColumn: "hold" }) },
    });
    expect(wipAdmissionParkDefersDispatch(task, NOW)).toBeUndefined();
  });

  it("dispatches a card with no marker, and one whose marker is unreadable", () => {
    expect(wipAdmissionParkDefersDispatch({ id: TASK_ID, column: "todo", sourceMetadata: undefined }, NOW)).toBeUndefined();
    const junk = { id: TASK_ID, column: "todo", sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: { code: "nonsense" } } };
    expect(wipAdmissionParkDefersDispatch(junk, NOW)).toBeUndefined();
  });

  it("dispatches when lastAt is unparseable, failing open rather than parking a card forever", () => {
    const task = parkedTask({
      sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode({ lastAt: "not-a-date" }) },
    });
    expect(wipAdmissionParkDefersDispatch(task, NOW)).toBeUndefined();
  });
});

describe("executeCore — the outer dispatch surface honors the marker", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("defers dispatch without claiming graph routing", async () => {
    const deps = buildDeps();

    await executeCore(deps as never, parkedTask({ updatedAt: new Date(NOW).toISOString() }));

    // The whole point: the graph is never entered to re-discover a boundary it cannot cross.
    expect(deps.executeWorkflowGraph).not.toHaveBeenCalled();
    // A deferral that stranded the claim would wedge the task against every later dispatch.
    expect(deps.graphRouting.has(TASK_ID)).toBe(false);
    // Gates that write or await must not run for a card that is only waiting.
    expect(deps.clearStalePauseAbortBeforeDispatch).not.toHaveBeenCalled();
    expect(deps.blockOuterDispatchWhenDependenciesUnmet).not.toHaveBeenCalled();
    expect(deps.blockOuterDispatchWhenFileScopeLeaseHeld).not.toHaveBeenCalled();
  });

  it("keeps deferring across repeated dispatches, which is the hot loop it exists to stop", async () => {
    const deps = buildDeps();
    const task = parkedTask({ updatedAt: new Date(NOW).toISOString() });

    for (let i = 0; i < 5; i += 1) await executeCore(deps as never, task);

    expect(deps.executeWorkflowGraph).not.toHaveBeenCalled();
  });

  it("dispatches a card whose marker never existed, so the guard is not a permanent block", async () => {
    const deps = buildDeps();

    await executeCore(deps as never, { id: TASK_ID, title: "no marker", column: "todo" } as Task);

    expect(deps.executeWorkflowGraph).toHaveBeenCalledTimes(1);
  });

  it("dispatches once the marker is older than the refresh floor, so a release is never waited out by a stale row", async () => {
    const deps = buildDeps();
    const stale = parkedTask({
      updatedAt: new Date(NOW).toISOString(),
      sourceMetadata: {
        [WIP_ADMISSION_STALL_METADATA_KEY]: episode({
          // The deferral clock is wall-clock `Date.now()`, so "old" must be expressed relative to real now.
          lastAt: new Date(Date.now() - WIP_ADMISSION_STALL_REFRESH_FLOOR_MS - 1_000).toISOString(),
        }),
      },
    });

    await executeCore(deps as never, stale);

    expect(deps.executeWorkflowGraph).toHaveBeenCalledTimes(1);
  });
});

/*
FNXC:WipAdmissionPark 2026-11-02-09:21 (RUFU-393 code-review P0):
The other side of the same decision, and the side the first cut of this file never tested — which is exactly
why the bug shipped. A deferral that reads ONLY the marker freezes a card whose remaining work lives in the
refused column, and on the shipped builtin IRs that work is the planning-lane family: `plan`, `plan-review`,
`plan-replan` and `plan-review-no-op` all carry `column: "todo"`, the same column a hold→WIP refusal names as
`fromColumn`. So the sweep parks an unplanned card with `awaiting-planning`, the planning-continuation drain
calls `execute()`, and a marker-only deferral drops the one dispatch that could ever have planned it — while
the sweep re-stamps `lastAt` every floor, so the wait never expires and no audit row or History line is ever
written. These cases pin both released halves of the decision: the gate identity (does this gate's remedy
live in this column at all?) and the card's own pending work items.
*/

/** The Coding shape, nodes included: planning-lane nodes authored in `todo`, implementation in `in-progress`. */
function codingIr(): WorkflowIr {
  return {
    version: "v2",
    id: "builtin:coding",
    nodes: [
      { id: "plan", kind: "prompt", column: "todo" },
      { id: "plan-review", kind: "prompt", column: "todo" },
      { id: "parse", kind: "prompt", column: "in-progress" },
      { id: "implement", kind: "prompt", column: "in-progress" },
      { id: "code-review", kind: "prompt", column: "in-review" },
    ],
    edges: [],
    columns: [
      { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", label: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "in-review", label: "In Review", traits: [{ trait: "review" }] },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

/**
 * A store shaped like the real one for the two reads the probe makes: the task's workflow selection plus its
 * work items. `ir` is injectable so a malformed/unresolvable workflow is expressible.
 */
function probeStore(opts: {
  items?: Array<{ nodeId: string; state: string }>;
  ir?: WorkflowIr | null;
  throwOnList?: boolean;
  omitList?: boolean;
}) {
  const store: Record<string, unknown> = {
    getTaskWorkflowSelection: () => ({ workflowId: "builtin:coding", stepIds: [] }),
    getTaskWorkflowSelectionAsync: async () => ({ workflowId: "builtin:coding", stepIds: [] }),
    getWorkflowDefinition: async () => (opts.ir === null ? undefined : { ir: opts.ir ?? codingIr() }),
  };
  if (!opts.omitList) {
    store.listWorkflowWorkItemsForTask = vi.fn(async () =>
      (opts.items ?? []).map((item, index) => ({
        taskId: TASK_ID,
        nodeId: item.nodeId,
        kind: "task",
        state: item.state,
        ordinal: index,
        attempt: 1,
      })),
    );
    if (opts.throwOnList) {
      store.listWorkflowWorkItemsForTask = vi.fn(async () => {
        throw new Error("store unreachable");
      });
    }
  }
  return store;
}

describe("wipAdmissionInLaneWork — the second authority the deferral must consult", () => {
  it("reports work pending when an active work item sits at a node authored in the card's own column", async () => {
    // The P0's exact card: parked in `todo` by the sweep, still holding a runnable Plan Review.
    const store = probeStore({ items: [{ nodeId: "plan-review", state: "runnable" }] });
    await expect(wipAdmissionInLaneWork(store as never, { id: TASK_ID, column: "todo" })).resolves.toBe(true);
  });

  it("reports nothing pending when the only active work is at a node in another column", async () => {
    // A card parked at the seam whose continuation lives in the column it is being refused ENTRY to: this is
    // the re-approach-the-boundary loop, and it is the one case allowed to defer.
    const store = probeStore({ items: [{ nodeId: "parse", state: "runnable" }] });
    await expect(wipAdmissionInLaneWork(store as never, { id: TASK_ID, column: "todo" })).resolves.toBe(false);
  });

  it("counts a held work item as pending, because held rows are waiting on a decision, not finished", async () => {
    const store = probeStore({ items: [{ nodeId: "plan-review", state: "held" }] });
    await expect(wipAdmissionInLaneWork(store as never, { id: TASK_ID, column: "todo" })).resolves.toBe(true);
  });

  it("reports nothing pending when every work item is terminal, so a finished card cannot spin", async () => {
    const store = probeStore({ items: [{ nodeId: "plan", state: "succeeded" }, { nodeId: "plan-review", state: "failed" }] });
    await expect(wipAdmissionInLaneWork(store as never, { id: TASK_ID, column: "todo" })).resolves.toBe(false);
  });

  it("reports nothing pending when the card has no work items at all", async () => {
    const store = probeStore({ items: [] });
    await expect(wipAdmissionInLaneWork(store as never, { id: TASK_ID, column: "todo" })).resolves.toBe(false);
  });

  it("fails open when the store cannot answer, because an unanswerable question must not drop real work", async () => {
    await expect(wipAdmissionInLaneWork(probeStore({ throwOnList: true }) as never, { id: TASK_ID, column: "todo" })).resolves.toBe(true);
    await expect(wipAdmissionInLaneWork(undefined, { id: TASK_ID, column: "todo" })).resolves.toBe(true);
    // A store without the work-item reader at all (minimal adapters, fakes) is the same unknown.
    await expect(wipAdmissionInLaneWork(probeStore({ omitList: true }) as never, { id: TASK_ID, column: "todo" })).resolves.toBe(true);
  });

  it("fails open when the workflow is unresolvable or the IR is not the graph the probe understands", async () => {
    await expect(
      wipAdmissionInLaneWork(probeStore({ ir: null, items: [{ nodeId: "plan", state: "runnable" }] }) as never, { id: TASK_ID, column: "todo" }),
    ).resolves.toBe(true);
    const v1 = { version: "v1", nodes: [], edges: [], columns: [] } as unknown as WorkflowIr;
    await expect(
      wipAdmissionInLaneWork(probeStore({ ir: v1, items: [{ nodeId: "plan", state: "runnable" }] }) as never, { id: TASK_ID, column: "todo" }),
    ).resolves.toBe(true);
  });

  it("fails open for a work item at a node the IR does not declare or that declares no column", async () => {
    // foreach template instances carry template node ids the IR does not declare, and the graph re-enters
    // those at their column's resume node — which IS work in this column.
    await expect(
      wipAdmissionInLaneWork(probeStore({ items: [{ nodeId: "step-execute#2", state: "runnable" }] }) as never, { id: TASK_ID, column: "todo" }),
    ).resolves.toBe(true);
    const noColumn = {
      version: "v2",
      id: "x",
      nodes: [{ id: "start", kind: "start" }],
      edges: [],
      columns: [],
    } as unknown as WorkflowIr;
    await expect(
      wipAdmissionInLaneWork(probeStore({ ir: noColumn, items: [{ nodeId: "start", state: "runnable" }] }) as never, { id: TASK_ID, column: "todo" }),
    ).resolves.toBe(true);
  });
});

describe("wipAdmissionGateHasInLaneRemedy — gates whose remedy is a graph run", () => {
  it("never defers for a gate whose own remedy is planning or approval work", () => {
    expect(wipAdmissionGateHasInLaneRemedy("awaiting-planning")).toBe(true);
    expect(wipAdmissionGateHasInLaneRemedy("awaiting-approval")).toBe(true);
    // Capacity gates genuinely have nothing to run: only a release can move these cards.
    expect(wipAdmissionGateHasInLaneRemedy("downstream-full")).toBe(false);
    expect(wipAdmissionGateHasInLaneRemedy("column-capacity")).toBe(false);
    expect(wipAdmissionGateHasInLaneRemedy("scheduler-seam")).toBe(false);
    expect(wipAdmissionGateHasInLaneRemedy("move-rejected-or-no-slot")).toBe(false);
  });
});

describe("wipAdmissionParkDefersGraphEntry — the shared entry decision", () => {
  it("never drops a dispatch for `awaiting-planning`, even with zero work items to run", async () => {
    // The reviewer's case 1. Zero work items is the shape the planning drain hands over: the marker is the
    // sweep's verdict about READINESS, not a statement that the card has nothing left to do.
    const task = parkedTask({ sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode({ code: "awaiting-planning" }) } });
    const probe = probeStore({ items: [] });
    await expect(wipAdmissionParkDefersGraphEntry(task, wipAdmissionInLaneWorkProbe(probe as never), NOW)).resolves.toBeUndefined();
    // A capacity gate's answer is unchanged: the marker alone still defers, which is the storm bound.
    await expect(wipAdmissionParkDefersGraphEntry(parkedTask(), async () => false, NOW)).resolves.toBeDefined();
  });

  it("never drops a dispatch for `awaiting-approval`", async () => {
    const task = parkedTask({ sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode({ code: "awaiting-approval" }) } });
    await expect(wipAdmissionParkDefersGraphEntry(task, async () => false, NOW)).resolves.toBeUndefined();
  });

  it("dispatches a capacity-parked card that still has Plan Review work in its own column", async () => {
    // The reviewer's case 2, and the combination the sweep really produces: `downstream-full` is recorded
    // BEFORE readiness is ever consulted, so a full WIP column plus a pending Plan Review is the ordinary
    // state of a healthy board, not a rare one.
    const task = parkedTask({ sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode({ code: "downstream-full" }) } });
    const probe = wipAdmissionInLaneWorkProbe(probeStore({ items: [{ nodeId: "plan-review", state: "runnable" }] }) as never);
    await expect(wipAdmissionParkDefersGraphEntry(task, probe, NOW)).resolves.toBeUndefined();
  });

  it("defers a capacity-parked card whose only active work is the refused crossing itself", async () => {
    // The reviewer's case 3: the storm bound survives. The continuation lives at `parse`, in the column the
    // card is being refused entry to, so re-entering re-discovers the same boundary — the 16 536-row loop.
    const task = parkedTask({ sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode({ code: "downstream-full" }) } });
    const probe = wipAdmissionInLaneWorkProbe(probeStore({ items: [{ nodeId: "parse", state: "runnable" }] }) as never);
    const deferred = await wipAdmissionParkDefersGraphEntry(task, probe, NOW);
    expect(deferred?.episode.code).toBe("downstream-full");
  });

  it("dispatches when no surface can answer the work question", async () => {
    await expect(wipAdmissionParkDefersGraphEntry(parkedTask(), undefined, NOW)).resolves.toBeUndefined();
  });

  it("does not consult the work probe for a card the marker already released", async () => {
    // Cost ordering is part of the contract: the two extra reads are paid only for a card the seam refused.
    const probe = vi.fn(async () => true);
    const stale = parkedTask({
      sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode({ lastAt: new Date(NOW - WIP_ADMISSION_STALL_REFRESH_FLOOR_MS).toISOString() }) },
    });
    await expect(wipAdmissionParkDefersGraphEntry(stale, probe, NOW)).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("executeCore — the outer surface never starves in-lane work", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("enters the graph for a fresh `awaiting-planning` marker, which is what plans the card", async () => {
    const deps = buildDeps();
    const task = parkedTask({
      updatedAt: new Date(NOW).toISOString(),
      sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode({ code: "awaiting-planning", signature: "held|awaiting-planning:seed-prompt" }) },
    });

    await executeCore(deps as never, task);

    expect(deps.executeWorkflowGraph).toHaveBeenCalledTimes(1);
  });

  it("enters the graph when a capacity marker names a card with a pending Plan Review", async () => {
    const deps = buildDeps();
    deps.hasInLaneWorkflowWork = wipAdmissionInLaneWorkProbe(
      probeStore({ items: [{ nodeId: "plan-review", state: "runnable" }] }) as never,
    );
    const task = parkedTask({
      updatedAt: new Date(NOW).toISOString(),
      sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode({ code: "downstream-full" }) },
    });

    await executeCore(deps as never, task);

    expect(deps.executeWorkflowGraph).toHaveBeenCalledTimes(1);
  });

  it("still defers a card with no in-lane work, on every pass — the storm bound is intact", async () => {
    const deps = buildDeps();
    deps.hasInLaneWorkflowWork = wipAdmissionInLaneWorkProbe(
      probeStore({ items: [{ nodeId: "parse", state: "runnable" }] }) as never,
    );
    const task = parkedTask({
      updatedAt: new Date(NOW).toISOString(),
      sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode({ code: "downstream-full" }) },
    });

    for (let i = 0; i < 20; i += 1) await executeCore(deps as never, task);

    expect(deps.executeWorkflowGraph).not.toHaveBeenCalled();
    expect(deps.graphRouting.has(TASK_ID)).toBe(false);
  });

  it("wires the probe through the real deps bag, so the routing surface is not shipped without its second authority", () => {
    const host = { store: probeStore({ items: [] }), graphRouting: new Set<string>(), completionFinalizedTaskIds: new Set<string>(), options: {} };
    const deps = buildExecuteCoreDeps(host as never) as unknown as ExecuteCoreDeps;
    expect(typeof deps.hasInLaneWorkflowWork).toBe("function");
  });
});

/*
FNXC:WipAdmissionParkCooldown 2026-11-19-23:05 (RUFU-558):
One episode, two lanes, two DIFFERENT rules — and that asymmetry is the design, so it is pinned rather than
assumed. RUFU-393 gave the executor/graph lane a deferral (`wipAdmissionParkDefersGraphEntry`, called from
`executeCore` and the continuation drain) and RUFU-558 gave the mover a bound. Both read the SAME
`sourceMetadata.wipAdmissionStall` key, and neither lane may narrow the other:

- a boundary capacity park (the hold→wip seam, and the in-review → in-progress remediation crossing) writes
  the same one episode a sweep refusal writes, so there is exactly ONE per-card refusal state on the row;
- the graph lane defers a DISPATCH on it whatever the gate code, because re-entering the graph to re-discover
  one refusal is the 16 536-row storm this key exists to stop;
- the release lane bounds a re-ATTEMPT only for the one code with no cheap live re-check, because the live
  lane sample is what releases a card the pass its occupant leaves.

The paired assertions below are what stops a future edit from unifying the two rules and silently breaking
whichever lane the other test does not cover.
*/
describe("one episode, two lanes: the graph defers a dispatch on any gate, the sweep bounds only the no-cheap-recheck class", () => {
  /** Every gate code the row may carry, from the same closed vocabulary the writer validates against. */
  const ALL_GATE_CODES = [
    "scheduler-seam",
    "column-capacity",
    "capacity-rejection-without-facts",
    "downstream-full",
    "move-rejected-or-no-slot",
    "no-downstream-capacity-column",
    "awaiting-planning",
    "awaiting-approval",
  ] as const;

  it("the graph lane defers entry for EVERY gate code, including the boundary parks' own codes", () => {
    for (const code of ALL_GATE_CODES) {
      const parked = wipAdmissionParkDefersDispatch(parkedTask({
        sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode({ code }) },
      }), NOW);
      expect(parked, `graph lane must defer a dispatch on ${code}`).toBeTruthy();
    }
  });

  it("the release lane bounds exactly ONE held reason, so the graph's breadth cannot leak into the mover", () => {
    /*
    FNXC:WipAdmissionParkCooldown 2026-11-22-05:18 (RUFU-558):
    The two lanes read the same row on DIFFERENT axes, and that asymmetry is the whole design: the graph lane
    asks the marker (any gate), the mover asks its own held reason (one gate). This case used to enumerate
    gate CODES on both sides, which is exactly what made the first cut inert - `moreSpecificWipAdmissionGate`
    sharpens a label upward only, so a code-keyed sweep bound never fires for the ~60-of-138 cards whose
    marker reads `downstream-full`. The mover's axis is therefore its reported held reason, and the row's
    marker is held constant here because it decides only WHEN and the Rule-2 veto.
    */
    const ALL_HELD_REASONS = [
      "move-rejected-or-no-slot",
      "downstream-full",
      "column-capacity",
      "scheduler-seam",
      "capacity-rejection-without-facts",
      "no-downstream-capacity-column",
      "no-release-target",
      "deps-unsatisfied",
      "timer-not-elapsed",
      "awaiting-planning:seed-prompt",
      "awaiting-approval",
    ] as const;
    const bounded: string[] = [];
    const notBounded: string[] = [];
    for (const reason of ALL_HELD_REASONS) {
      const task = parkedTask({
        sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode({ code: "move-rejected-or-no-slot" }) },
      });
      (wipAdmissionReleaseAttemptIsCooling(task, reason, NOW) ? bounded : notBounded).push(reason);
    }
    // Exactly one, and it is the arm whose re-derivation costs the whole expensive leg.
    expect(bounded).toEqual(["move-rejected-or-no-slot"]);
    // Every live-sampled class - including both boundary parks' - stays re-measured every pass.
    expect(notBounded).toContain("scheduler-seam");
    expect(notBounded).toContain("column-capacity");
    expect(notBounded).toContain("downstream-full");
    expect(notBounded).toHaveLength(ALL_HELD_REASONS.length - 1);
  });

  it("a boundary capacity park and a sweep refusal leave the row the same single episode key", () => {
    /*
    The review-lane twin of the bound: a card parked by the in-review → in-progress `capacity-exhausted`
    remediation crossing carries `column-capacity`, which the sweep will NOT memo-skip. What still protects
    it is the graph deferral, and what still explains it is the one shared key. Asserting the key count is
    how a future second state gets caught here rather than in production.
    */
    const reviewParked = parkedTask({
      column: "in-review",
      sourceMetadata: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode({
        code: "column-capacity",
        fromColumn: "in-review",
        toColumn: "in-progress",
      }) },
    });

    expect(Object.keys(reviewParked.sourceMetadata ?? {})).toEqual([WIP_ADMISSION_STALL_METADATA_KEY]);
    // The review/executor lane still declines a re-dispatch of this parked card...
    expect(wipAdmissionParkDefersDispatch(reviewParked, NOW)).toBeTruthy();
    // ...while the sweep keeps re-measuring it. The mover's axis is its OWN held reason, and a lane whose
    // occupancy is live-sampled reports `downstream-full` / `column-capacity`, both outside the one-wide
    // allowlist; a card the sweep never refused through the pool cannot be paced by this bound at all.
    expect(wipAdmissionReleaseAttemptIsCooling(reviewParked, "downstream-full", NOW)).toBe(false);
    expect(wipAdmissionReleaseAttemptIsCooling(reviewParked, "column-capacity", NOW)).toBe(false);
  });
});
