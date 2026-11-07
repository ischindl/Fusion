import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../scheduler.js";
import { seedPlannedSpec } from "./_planned-spec-fixture.js";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";

/*
FNXC:ProjectRuntimeOff 2026-11-07-15:56:
THE PRODUCT CLAIM OF THE RUNTIME SWITCH, PINNED AT THE PASS ENTRY.

Measured before this feature: ~435 DB transactions/second with zero UI requests, 1107 sampled
scheduler passes averaging 51–183 s per project (max 584 s) with ~25 projects in one process, and
`/api/tasks/page` answering in 11–26 s while `/api/health` — which reads nothing — answered in
0.09 s. `globalPause` / `enginePaused` do not help because `schedule()` never consults them at
entry: they stop dispatch at the END of a pass, so the pass and every read it performs still run.

So the assertion is not "no dispatch happened" and not "the log says skipped". It is a count of
store calls for one tick: ZERO reads with the gate closed, MORE THAN ZERO with it open. A tick
that also wrote no column and no lifecycle row is the second test, and a card whose runtime is off
while its board is still readable is the third (see project-runtime-off-read-path.test.ts).

Driven through `schedule()` and through the real `ProjectEngine.start()`, never by calling the
gate predicate, so a gate that stops being consulted at the entry cannot pass.
*/

const WF = "custom:runtime-off";

const IR = {
  version: "v2",
  id: WF,
  nodes: [],
  edges: [],
  columns: [
    { id: "todo", label: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "in-review", label: "Review", traits: [{ trait: "humanReview" }, { trait: "mergeBlocker" }] },
    { id: "done", label: "Done", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

function makeTask(): Task {
  return {
    id: "FN-RUNTIME-OFF",
    title: "ready card",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    workflowStepResults: [{
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      status: "passed" as const,
      source: "node" as const,
      phase: "pre-merge" as const,
    }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Task;
}

type CallLog = { reads: string[]; writes: string[]; all: string[] };

/** Store lifecycle plumbing, not engine work — never counted as a read or a write. */
const NON_ENGINE_CALLS = new Set(["on", "off", "emitEvent", "getRootDir", "getTasksDir"]);

/** Writes that would move a card or mutate its history — the lifecycle surface a skipped pass must not touch. */
const WRITE_METHODS = new Set(["updateTask", "moveTask", "moveTaskIf", "logEntry", "updateSettings", "logEntryOnce"]);

/**
 * A fake store that records EVERY method call by name. Counting all calls (rather than spying on a
 * hand-picked few) is what makes "zero reads" mean zero reads: a new read added to the pass body
 * lands in the tally without the test being updated.
 */
function createStore(task: Task, log: CallLog, settings: Partial<Settings> = {}): TaskStore & {
  mocks: { moveTask: ReturnType<typeof vi.fn>; moveTaskIf: ReturnType<typeof vi.fn>; updateTask: ReturnType<typeof vi.fn> };
} {
  const resolved = {
    maxConcurrent: 10,
    maxWorktrees: 10,
    groupOverlappingFiles: false,
    runtimeEnabled: true,
    ...settings,
  };
  const selection = { workflowId: WF, stepIds: [] };
  const tasksDir = mkdtempSync(join(tmpdir(), "fusion-runtime-off-"));
  const moveTask = vi.fn(async (_id: string, column: Task["column"]) => {
    task.column = column;
    return task;
  });
  const moveTaskIf = vi.fn(async (
    id: string,
    column: Task["column"],
    predicate: (live: Task) => boolean | Promise<boolean>,
  ) => {
    if (!(await predicate(task)) || task.column === column) return { task, moved: false };
    return { task: await moveTask(id, column), moved: true };
  });
  const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch));
  const base = {
    listTasks: vi.fn(async () => [task]),
    listTasksInLaneRoles: vi.fn(async () => [task]),
    getSettings: vi.fn(async () => resolved),
    updateSettings: vi.fn(async () => resolved),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    updateTask,
    moveTask,
    moveTaskIf,
    getTask: vi.fn(async () => task),
    logEntry: vi.fn(async () => undefined),
    on: vi.fn(),
    off: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: IR })),
  };
  const instrumented: Record<string, unknown> = {};
  for (const [name, impl] of Object.entries(base)) {
    instrumented[name] = (...args: unknown[]) => {
      if (!NON_ENGINE_CALLS.has(name)) {
        log.all.push(name);
        if (WRITE_METHODS.has(name)) log.writes.push(name);
        else log.reads.push(name);
      }
      return (impl as (...a: unknown[]) => unknown)(...args);
    };
  }
  instrumented.getRootDir = () => "/tmp/project";
  instrumented.getTasksDir = () => tasksDir;
  const store = instrumented as unknown as TaskStore & {
    mocks: { moveTask: ReturnType<typeof vi.fn>; moveTaskIf: ReturnType<typeof vi.fn>; updateTask: ReturnType<typeof vi.fn> };
  };
  store.mocks = { moveTask, moveTaskIf, updateTask } as unknown as typeof store.mocks;
  // A real planned spec: without it the hold→wip release refuses the card as an unplanned seed and
  // the "more than zero reads" control would pass for the wrong reason.
  seedPlannedSpec(store as unknown as { getTasksDir(): string }, task.id, { title: task.title, description: task.description });
  return store;
}

function schedulerWithGate(store: TaskStore, gateOpen: boolean): Scheduler {
  const scheduler = new Scheduler(store);
  scheduler.setRuntimeGate(gateOpen);
  (scheduler as unknown as { running: boolean }).running = true;
  return scheduler;
}

describe("runtimeEnabled: false skips the project's pass entirely", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(
      Scheduler.prototype as never as { validateTaskFilesystem: () => unknown },
      "validateTaskFilesystem",
    ).mockResolvedValue({ valid: true } as never);
  });

  it("one tick with the gate open reads the board (control for the zero-read claim)", async () => {
    const log: CallLog = { reads: [], writes: [], all: [] };
    await schedulerWithGate(createStore(makeTask(), log), true).schedule();
    expect(log.reads.length).toBeGreaterThan(0);
    expect(log.reads).toContain("listTasks");
  });

  it("one tick of a runtime-off project issues ZERO store reads", async () => {
    const log: CallLog = { reads: [], writes: [], all: [] };
    await schedulerWithGate(createStore(makeTask(), log, { runtimeEnabled: false }), false).schedule();
    expect(log.reads).toEqual([]);
    expect(log.all).toEqual([]);
  });

  it("the skipped tick performs no column or lifecycle write either", async () => {
    const log: CallLog = { reads: [], writes: [], all: [] };
    const store = createStore(makeTask(), log, { runtimeEnabled: false });
    await schedulerWithGate(store, false).schedule();
    expect(log.writes).toEqual([]);
    expect(store.mocks.moveTask).not.toHaveBeenCalled();
    expect(store.mocks.moveTaskIf).not.toHaveBeenCalled();
    expect(store.mocks.updateTask).not.toHaveBeenCalled();
  });

  it("closing the gate clears the poll interval, so a disabled project is never woken", () => {
    const log: CallLog = { reads: [], writes: [], all: [] };
    const scheduler = new Scheduler(createStore(makeTask(), log, { runtimeEnabled: false }));
    scheduler.start();
    const armed = (scheduler as unknown as { pollInterval: ReturnType<typeof setInterval> | null }).pollInterval;
    expect(armed).not.toBeNull();

    scheduler.setRuntimeGate(false);
    expect((scheduler as unknown as { pollInterval: unknown }).pollInterval).toBeNull();
    expect((scheduler as unknown as { running: boolean }).running).toBe(false);
  });
});
