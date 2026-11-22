import { describe, expect, it, vi } from "vitest";
import type { TaskStore, WorkflowIr } from "@fusion/core";

import { Scheduler } from "../scheduler.js";
import { flushAsyncHandlers } from "./_flush-async-handlers.js";

const WORKFLOW_ID = "custom:capacity-wake";

function workflow(wipColumns = ["in-progress"]): WorkflowIr {
  return {
    version: "v2",
    id: WORKFLOW_ID,
    name: "Capacity wake",
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", name: "Planning", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      ...wipColumns.map((id) => ({ id, name: id, traits: [{ trait: "wip" as const }] })),
      { id: "in-review", name: "Review", traits: [{ trait: "merge" }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function task(column: string) {
  return {
    id: "FN-242",
    title: "Capacity wake",
    description: "",
    column,
    status: null,
    paused: false,
    userPaused: false,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    columnMovedAt: "2026-08-28T21:24:00.000Z",
    createdAt: "2026-08-28T21:00:00.000Z",
    updatedAt: "2026-08-28T21:24:00.000Z",
  };
}

function createHarness(ir = workflow(), running = true) {
  const listeners = new Map<string, Array<(payload: any) => unknown>>();
  const selection = { workflowId: WORKFLOW_ID, stepIds: [] };
  const store = {
    on: vi.fn((event: string, listener: (payload: any) => unknown) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    off: vi.fn(),
    getRootDir: vi.fn(() => "/test/project"),
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
    listTasks: vi.fn(async () => []),
    updateTask: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
  } as unknown as TaskStore;
  const onCapacityReleased = vi.fn();
  const scheduler = new Scheduler(store, { onCapacityReleased });
  const schedule = vi.spyOn(scheduler, "schedule").mockResolvedValue(undefined);
  (scheduler as unknown as { running: boolean }).running = running;

  return {
    scheduler,
    schedule,
    onCapacityReleased,
    emit: async (from: string, to: string, source = "engine") => {
      const payload = { task: task(to), from, to, source };
      for (const listener of listeners.get("task:moved") ?? []) await listener(payload);
      await flushAsyncHandlers();
    },
  };
}

describe("Scheduler capacity-release event wakes", () => {
  it("wakes once when the default WIP lane is vacated", async () => {
    const { emit, schedule, onCapacityReleased } = createHarness();

    await emit("in-progress", "in-review");

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(onCapacityReleased).toHaveBeenCalledOnce();
    expect(onCapacityReleased).toHaveBeenCalledWith("wip-column");
  });

  it("resolves a renamed capacity lane from workflow traits", async () => {
    const { emit, schedule, onCapacityReleased } = createHarness(workflow(["building"]));

    await emit("building", "in-review");

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(onCapacityReleased).toHaveBeenCalledWith("wip-column");
  });

  it("does not wake between two capacity lanes but wakes when leaving their membership", async () => {
    const { emit, schedule, onCapacityReleased } = createHarness(workflow(["build-a", "build-b"]));

    await emit("build-a", "build-b");
    expect(schedule).not.toHaveBeenCalled();
    expect(onCapacityReleased).not.toHaveBeenCalled();

    await emit("build-b", "in-review");
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(onCapacityReleased).toHaveBeenCalledTimes(1);
  });

  it("coalesces the capacity and hold wake arms into one scheduling pass", async () => {
    const { scheduler, emit, schedule, onCapacityReleased } = createHarness();

    await emit("in-progress", "todo", "engine");

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(onCapacityReleased).toHaveBeenCalledTimes(1);
    expect((scheduler as unknown as { recentEngineTodoRequeues: Map<string, string> }).recentEngineTodoRequeues.has("FN-242")).toBe(true);
  });

  it("does not report capacity release when moving into a WIP lane", async () => {
    const { emit, schedule, onCapacityReleased } = createHarness();

    await emit("todo", "in-progress");

    expect(onCapacityReleased).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("does not wake after the scheduler is stopped", async () => {
    const { emit, schedule, onCapacityReleased } = createHarness(workflow(), false);

    await emit("in-progress", "in-review");

    expect(schedule).not.toHaveBeenCalled();
    expect(onCapacityReleased).not.toHaveBeenCalled();
  });

  /*
  FNXC:WipAdmissionParkCooldown 2026-11-19-22:35 (RUFU-558):
  RUFU-558 bounds how often the hold/release sweep re-pays for a `move-rejected-or-no-slot` refusal, and it
  deliberately does that INSIDE the sweep rather than by suppressing wakes here. Two reasons this file pins
  the wake as UNCHANGED rather than adding a bypass:

  1. the wake's evidence is that a COLUMN-lane slot vacated, which is the fact `downstream-full` is refused
     on — and that arm is already re-derived live every pass at zero DB reads. A fair-probe bypass driven by
     this wake would therefore re-run the expensive leg for the bounded class on a busy board and re-open the
     very loop RUFU-558 closes;
  2. the fairness contract RUFU-393 owns (`hold-release-capacity-release-crosses.test.ts`) is held by the
     live lane sample, which a wake cannot improve — a wake cannot make the sample newer than it already is.

  So a burst of vacating moves stays N real scheduling passes: the scheduler neither coalesces them away nor
  hands any of them a waiver. Whether each pass then pays for the refused card is the sweep's decision, and
  `hold-release-capacity-cooldown.test.ts` case (h) pins that a burst inside one refresh floor costs that
  class exactly one expensive attempt.
  */
  it("lets a burst of capacity-vacating wakes through as N passes, with no waiver and no coalescing (RUFU-558)", async () => {
    const { emit, schedule, onCapacityReleased } = createHarness();

    for (let occupant = 0; occupant < 5; occupant += 1) {
      await emit("in-progress", "in-review");
    }

    // Every vacating move still schedules: the bound is not here.
    expect(schedule).toHaveBeenCalledTimes(5);
    expect(onCapacityReleased).toHaveBeenCalledTimes(5);
  });
});
