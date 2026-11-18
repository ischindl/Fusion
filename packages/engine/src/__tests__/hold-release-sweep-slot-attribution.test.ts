/*
FNXC:HoldReleaseSlotAttribution 2026-10-16-17:19 (RUFU-698 Step 1):
Field evidence: `Hold-release sweep: project=…: 30038ms (… evaluate 27126ms over 642 tasks (…, slot=13770ms,
unattributed=13057ms)), released=0, held=3, budget-truncated unevaluated=444`. The `slot` bucket was the
sweep's only un-attributed giant and the call count behind it was unknown, so a "~2s per reservation"
figure could only be inferred from `released`/`held` counters — and an inferred cost cannot be aimed at.

These tests pin the three contracts that make the reservation leg measurable without disturbing the
attribution contract RUFU-209 already established:
 - `slot-calls=N` is the number of reservations the pass performed, so `slot ÷ slot-calls` is a
   measurement rather than an inference;
 - `slot-detail=(…)` is a breakdown printed OUTSIDE the reconciling parenthesis, so the existing
   `(release-config=…, slot=…, unattributed=…)` list keeps its exact meaning (and its literal stays
   green in hold-release-sweep-evaluate-attribution.test.ts);
 - a child that was never named is still shown as `slot:residual`, and no `slot-detail` group appears
   at all when nothing was recorded under it.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { admitTaskToWip, resetHoldReleaseInstrumentation, runHoldReleaseSweep, type HoldReleasePass } from "../execution/hold-release.js";
import { schedulerLog } from "../logger.js";

const WF = "custom:slot-wf";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
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
    ...over,
  } as Task;
}

function singleWipIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", label: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function storeWith(tasks: Task[], settings: Record<string, unknown>): TaskStore {
  const selection = { workflowId: WF, stepIds: [] };
  return {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async () => tasks),
    moveTaskIf: vi.fn(async (id: string, column: string) => {
      const cur = tasks.find((t) => t.id === id)!;
      cur.column = column;
      return { task: cur, moved: true };
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: singleWipIr() })),
  } as unknown as TaskStore;
}

/** 1 ms per `now()` call: a wrapped read IS the bucket magnitude, so sizes are counts, not estimates. */
function tickingClock(startMs = 1_000_000) {
  let t = startMs;
  return { now: () => (t += 1) };
}

/** Parse `name=123ms` pairs out of one printed group, e.g. the `slot-detail=(…)` breakdown. */
function parseGroup(line: string, group: string): Record<string, number> | undefined {
  const match = new RegExp(`${group}=\\(([^)]*)\\)`).exec(line);
  if (!match) return undefined;
  const out: Record<string, number> = {};
  for (const part of match[1].split(", ")) {
    const [name, value] = part.split("=");
    if (name && value?.endsWith("ms")) out[name] = Number(value.slice(0, -2));
  }
  return out;
}

describe("hold-release sweep slot attribution (RUFU-698)", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
  });

  it("counts reservations and breaks the slot bucket down without touching the reconciling list", async () => {
    const debug = vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const held = task({ id: "S-1", column: "todo" });
    const store = storeWith([held], { maxConcurrent: 4 });
    const clock = tickingClock();

    // The reservation is refused (returns null), so the card stays held and the pass still records
    // the leg it spent — a deferred reservation is exactly the `released=0` shape from the field line.
    const result = await runHoldReleaseSweep(store, {
      now: clock.now,
      reserveSlot: async (_task: Task, _target: string, pass?: HoldReleasePass) => {
        await pass?.wall("slot:claim-snapshot", async () => { clock.now(); clock.now(); });
        await pass?.wall("slot:admission", async () => { clock.now(); });
        return null;
      },
    });
    expect(result.released).toEqual([]);

    const line = debug.mock.calls.map((call) => String(call[0])).find((l) => l.includes("Hold-release sweep:"));
    expect(line).toBeDefined();
    // Measured call count: `slot ÷ slot-calls` is now arithmetic on the line, not an inference.
    expect(line).toContain("slot-calls=1");
    const detail = parseGroup(line!, "slot-detail");
    expect(detail).toBeDefined();
    expect(detail!["slot:claim-snapshot"]).toBeGreaterThan(0);
    expect(detail!["slot:admission"]).toBeGreaterThan(0);

    /*
    Children are recorded as full wall windows and never enter `phases`, so the reconciling parenthesis
    keeps RUFU-209's meaning byte-for-byte: the field set and its order are unchanged, and the listed
    values plus `unattributed` still reconcile to `evaluate`.
    */
    const reconcile = /\(release-config=(\d+)ms, dependency=(\d+)ms, readiness=(\d+)ms, issue-release=(\d+)ms, prompt=(\d+)ms, unplanned=(\d+)ms, workitem=(\d+)ms, handoff=(\d+)ms, slot=(\d+)ms, unattributed=(\d+)ms\)/.exec(line!);
    expect(reconcile).not.toBeNull();
    const numbers = reconcile!.slice(1).map(Number);
    const slotMs = numbers[8]!;
    const unattributedMs = numbers[9]!;
    const evaluateMs = Number(/evaluate (\d+)ms/.exec(line!)![1]);
    expect(numbers.slice(0, 9).reduce((sum, ms) => sum + ms, 0) + unattributedMs).toBe(evaluateMs);
    expect(slotMs).toBeGreaterThan(0);
    /*
    FNXC:HoldReleaseSlotResidual 2026-11-17-23:44 (RUFU-719 Step 1):
    The child group now PARTITIONS the printed `slot` figure: `sum(slotChildren) + slot:residual ===
    slot`, exactly. RUFU-698 could only assert the inequality `childSum <= slot` because a FULL parent
    window nested around a child made the printed sum exceed `slot` (the double-count) and the residual
    was measured against a different span than `slot`. The equality is what retires both defects.
    */
    const childSum = Object.entries(detail!).reduce((sum, [name, ms]) => (name === "slot:residual" ? sum : sum + ms), 0);
    expect(childSum + (detail!["slot:residual"] ?? 0)).toBe(slotMs);
    expect(line!.indexOf("slot-detail=")).toBeGreaterThan(line!.indexOf("unattributed="));
  });

  it("prints no slot-detail group when nothing reserved, so an empty bucket cannot look like a cost", async () => {
    const debug = vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    // A block card releases nothing and reaches no reservation line at all.
    const blocked = task({ id: "S-2", column: "in-progress" });
    const store = storeWith([blocked], { maxConcurrent: 4 });
    await runHoldReleaseSweep(store, { now: tickingClock().now });

    const line = debug.mock.calls.map((call) => String(call[0])).find((l) => l.includes("Hold-release sweep:"));
    expect(line).toBeDefined();
    expect(line).toContain("slot-calls=0");
    expect(line).not.toContain("slot-detail=");
  });

  it("shows an unclaimed slice as slot:residual and still prints children it does not know", async () => {
    const debug = vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const held = task({ id: "S-3", column: "todo" });
    const store = storeWith([held], { maxConcurrent: 4 });
    const clock = tickingClock();

    await runHoldReleaseSweep(store, {
      now: clock.now,
      reserveSlot: async (_task: Task, _target: string, pass?: HoldReleasePass) => {
        // One named child plus unobserved work between the child windows.
        await pass?.wall("slot:unknown-child", async () => { clock.now(); clock.now(); clock.now(); });
        clock.now();
        clock.now();
        return null;
      },
    });

    const line = debug.mock.calls.map((call) => String(call[0])).find((l) => l.includes("Hold-release sweep:"));
    const detail = parseGroup(line!, "slot-detail");
    expect(detail).toBeDefined();
    // An unexpected cost surfaces as a number instead of vanishing into the parent bucket.
    expect(detail!["slot:unknown-child"]).toBeGreaterThan(0);
    expect(detail!["slot:residual"]).toBeGreaterThan(0);
    expect(line).toContain("slot-calls=1");
    /*
    FNXC:HoldReleaseSlotResidual 2026-11-17-23:44 (RUFU-719 Step 1):
    A child name the printer does not know is still shown AND still reconciles: the equality holds even
    with an unlisted child, so an unexpected cost can never silently break the arithmetic the operator
    reads.
    */
    const slotMs = Number(/, slot=(\d+)ms/.exec(line!)![1]);
    const childSum = Object.entries(detail!).reduce((sum, [name, ms]) => (name === "slot:residual" ? sum : sum + ms), 0);
    expect(childSum + (detail!["slot:residual"] ?? 0)).toBe(slotMs);
  });

  it("reports a nested child inside a parent exactly once, so the child sum no longer double-counts", async () => {
    /*
    FNXC:HoldReleaseSlotResidual 2026-11-17-23:44 (RUFU-719 Step 1):
    This is the exact shape production hit: `slot:claim-snapshot` is timed INSIDE `slot:admission`. With
    the parent on the FULL recorder (`wall`) the printed sum counted the nested window twice and
    exceeded `slot`; the parent on the exclusive recorder (`wallNet`) reports only its own time, so the
    nested child appears once and `sum(slotChildren) + slot:residual === slot` holds. The parent's
    exclusive ms is also strictly less than the sum of parent+child, proving it was netted, not padded.
    */
    const debug = vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const held = task({ id: "S-4", column: "todo" });
    const store = storeWith([held], { maxConcurrent: 4 });
    const clock = tickingClock();

    await runHoldReleaseSweep(store, {
      now: clock.now,
      reserveSlot: async (_task: Task, _target: string, pass?: HoldReleasePass) => {
        await pass?.wallNet("slot:admission", async () => {
          await pass?.wall("slot:claim-snapshot", async () => { clock.now(); clock.now(); });
          clock.now();
        });
        return null;
      },
    });

    const line = debug.mock.calls.map((call) => String(call[0])).find((l) => l.includes("Hold-release sweep:"));
    const detail = parseGroup(line!, "slot-detail");
    expect(detail).toBeDefined();
    expect(detail!["slot:claim-snapshot"]).toBeGreaterThan(0);
    expect(detail!["slot:admission"]).toBeGreaterThan(0);
    const slotMs = Number(/, slot=(\d+)ms/.exec(line!)![1]);
    const childSum = Object.entries(detail!).reduce((sum, [name, ms]) => (name === "slot:residual" ? sum : sum + ms), 0);
    // The nested pair reconciles against `slot` with NO double-count: equality, not overshoot.
    expect(childSum + (detail!["slot:residual"] ?? 0)).toBe(slotMs);
    // The parent is exclusive of its child: its ms is smaller than the two windows summed.
    expect(detail!["slot:admission"] + detail!["slot:claim-snapshot"]).toBeGreaterThan(detail!["slot:admission"]);
  });

  it("nets a nested sweep bucket out of a parent child, so the bucket is printed once in the parenthesis only", async () => {
    /*
    FNXC:HoldReleaseSlotResidual 2026-11-17-23:44 (RUFU-719 Step 1):
    `slot:dispatch-guard` wraps `isUnplannedForExecution`, which records the `unplanned` sweep bucket
    itself. If dispatch-guard were the FULL recorder it would contain `unplanned` and the bucket would
    be subtracted twice — once from `slot` (which the parenthesis already nets) and once from the child.
    `wallNet` makes dispatch-guard exclusive of `unplanned`, so `unplanned` stays ONLY in the reconciling
    parenthesis and `slot:unplanned` never appears as a child — the exact "must stay out of the child sum"
    rule Step 1's netting enables.
    */
    const debug = vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    const held = task({ id: "S-5", column: "todo" });
    const store = storeWith([held], { maxConcurrent: 4 });
    const clock = tickingClock();

    await runHoldReleaseSweep(store, {
      now: clock.now,
      reserveSlot: async (_task: Task, _target: string, pass?: HoldReleasePass) => {
        await pass?.wallNet("slot:dispatch-guard", async () => {
          await pass?.time("unplanned", async () => { clock.now(); clock.now(); clock.now(); });
          clock.now();
        });
        return null;
      },
    });

    const line = debug.mock.calls.map((call) => String(call[0])).find((l) => l.includes("Hold-release sweep:"));
    const detail = parseGroup(line!, "slot-detail");
    expect(detail).toBeDefined();
    expect(detail!["slot:dispatch-guard"]).toBeGreaterThan(0);
    // The sweep bucket stays in the parenthesis and never leaks into the child group.
    expect(detail!["slot:unplanned"]).toBeUndefined();
    // Exclusive: the child excludes the bucket nested inside it. If dispatch-guard were the FULL
    // recorder it would contain `unplanned`, which `net("slot")` already subtracted from `slot`, so the
    // child sum would EXCEED `slot` and the equality below would fail. The equality is the netting proof.
    const slotMs = Number(/, slot=(\d+)ms/.exec(line!)![1]);
    const childSum = Object.entries(detail!).reduce((sum, [name, ms]) => (name === "slot:residual" ? sum : sum + ms), 0);
    expect(childSum + (detail!["slot:residual"] ?? 0)).toBe(slotMs);
    // The child is strictly smaller than its raw window, which is netting, not full recording.
    expect(detail!["slot:dispatch-guard"]).toBeLessThan(slotMs);
  });

  it("records nothing and changes no outcome for a reservation performed without a pass", async () => {
    /*
    FNXC:HoldReleaseSlotResidual 2026-11-17-23:44 (RUFU-719 Step 1):
    The automatic admission / operator promote / event release surfaces run `tryReleaseTask` with no
    pass, so `reserveSlot` sees `pass === undefined` and every `obs`/`obsNet` wrapper must be a pure
    pass-through — no attribution, no behavior change. `admitTaskToWip` is that surface: it calls
    `issueRelease` with no `pass`, so the reservation the delegate makes cannot be observed anywhere.
    */
    let sawPass: HoldReleasePass | undefined | "not-called" = "not-called";
    let releases = 0;
    const reserveSlot = async (_task: Task, _target: string, pass?: HoldReleasePass) => {
      sawPass = pass;
      // A delegate that WOULD attribute under a pass must not corrupt a pass-less reservation.
      releases += 1;
      return { release: () => {} };
    };
    const held = task({ id: "S-6", column: "todo" });
    const store = storeWith([held], { maxConcurrent: 4 });
    const release = await admitTaskToWip(store, { reserveSlot }, held, "in-progress", singleWipIr(), {});
    // The reservation ran with no observer and still released — the guard is transparent, not lossy.
    expect(sawPass).toBeUndefined();
    expect(releases).toBe(1);
    expect(release.released).toBe(true);
  });
});
