import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";

/*
FNXC:ProjectRuntimeOff 2026-11-07-15:56:
A runtime-off project must stop DOING things without stopping BEING readable.

The measured failure this guards: ~435 DB transactions/second with zero UI requests, scheduler
passes of 51–183 s per project across ~25 projects in one process, `/api/tasks/page` at 11–26 s
against `/api/health` at 0.09 s. Unloading the runtime is the fix only if it actually unloads —
so this file counts ARMED TIMERS, not log lines: with the switch off, `ProjectEngine.start()` must
arm none; with it on it must arm some (the planner-overseer poll alone is one per project).

The read path is asserted in the same breath, because it is the acceptance condition: the same
engine whose lanes are disarmed still answers `listTasks()` for the board, cards, and history.
Dashboard read routes resolve the store through `getTaskStore()` (`routes/context.ts`
`resolveStoreForProjectId`), which is why the gate disarms lanes instead of skipping engine startup
— skipping startup would have taken the store, and with it the board, down with it.
*/

const mocks = vi.hoisted(() => ({
  store: undefined as any,
  runtimeStart: vi.fn(async () => undefined),
  runtimeStop: vi.fn(async () => undefined),
  runtimeGatePushed: [] as boolean[],
}));

vi.mock("../spec-drift-reconciler.js", () => ({
  SpecDriftReconciler: vi.fn().mockImplementation(function () { return { enqueue: vi.fn(), stop: vi.fn() }; }),
  createStoreSpecDriftRepository: vi.fn(() => ({})),
}));

vi.mock("../runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(function () {
    return {
      start: mocks.runtimeStart,
      stop: mocks.runtimeStop,
      getTaskStore: () => mocks.store,
      // The engine pushes its decision here; recording it proves the runtime is told, not just logged.
      setRuntimeEnabled: (enabled: boolean) => { mocks.runtimeGatePushed.push(enabled); },
      isRuntimeEnabled: () => true,
      getMessageStore: () => undefined,
      getPluginRunner: () => undefined,
      getAgentStore: () => undefined,
      getRoutineStore: () => undefined,
      getRoutineRunner: () => undefined,
      getHeartbeatMonitor: () => undefined,
      getTriggerScheduler: () => undefined,
      getSelfHealingManager: () => undefined,
      getExecutor: () => undefined,
      setActiveMergeTaskIdProvider: vi.fn(),
      setActiveMergeStartedAtMsProvider: vi.fn(),
      setActiveMergeAborter: vi.fn(),
      setMergeEnqueuer: vi.fn(),
      setMergeActiveClearer: vi.fn(),
      setMergePendingProvider: vi.fn(),
      setMergeRequester: vi.fn(),
      configurePrMonitoring: vi.fn(),
      resumeAfterUnpause: vi.fn(),
    };
  }),
}));

import { ProjectEngine } from "../project-engine.js";

const task = (id: string): Task => ({ id, title: id, description: "d", column: "todo", log: [] } as Task);

function createStore(runtimeEnabled: boolean) {
  const board = [task("FN-READ-1"), task("FN-READ-2")];
  return {
    getSettings: vi.fn(async () => ({
      autoMerge: false,
      pollIntervalMs: 60_000,
      maintenanceIntervalMs: 60_000,
      runtimeEnabled,
    })),
    listTasks: vi.fn(async () => board),
    getAsyncLayer: vi.fn(() => undefined),
    getAutomationStore: vi.fn(() => undefined),
    on: vi.fn(),
    off: vi.fn(),
  };
}

async function startEngine(runtimeEnabled: boolean) {
  const store = createStore(runtimeEnabled);
  mocks.store = store;
  mocks.runtimeGatePushed.length = 0;
  const intervals = vi.spyOn(globalThis, "setInterval");
  intervals.mockClear();
  const engine = new ProjectEngine(
    { projectId: "proj-runtime-off", workingDirectory: "/tmp/rufu-871", isolationMode: "in-process", maxConcurrent: 1, maxWorktrees: 1 },
    {} as never,
    { skipNotifier: true },
  );
  await engine.start();
  return { engine, store, armedIntervals: intervals.mock.calls.length };
}

describe("a runtime-off project arms no timer and still serves reads", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("arms zero recurring timers when the project runtime is off", async () => {
    const { engine, armedIntervals } = await startEngine(false);
    expect(engine.isRuntimeEnabled()).toBe(false);
    expect(armedIntervals).toBe(0);
    expect(mocks.runtimeGatePushed).toEqual([false]);
  });

  it("arms the periodic lanes when the project runtime is on (control)", async () => {
    const { engine, armedIntervals } = await startEngine(true);
    expect(engine.isRuntimeEnabled()).toBe(true);
    expect(armedIntervals).toBeGreaterThan(0);
    expect(mocks.runtimeGatePushed).toEqual([true]);
  });

  it("still answers the board read for a runtime-off project", async () => {
    const { engine } = await startEngine(false);
    const board = await engine.getTaskStore().listTasks({ slim: true, derive: false, excludeLog: true });
    expect(board.map((t: Task) => t.id)).toEqual(["FN-READ-1", "FN-READ-2"]);
  });

  /*
  The load-bearing claim after "zero reads per tick": disarming means the interval is GONE, not
  that it fires and no-ops. One hour of fake clock must produce no store traffic at all, while the
  same hour on a loaded runtime produces some. Fake timers, no sleeps, no wall-clock polling.
  */
  it("produces no store traffic across an hour of clock with the runtime off, and some with it on", async () => {
    const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

    vi.useFakeTimers();
    try {
      const off = await startEngine(false);
      const baselineOff = off.store.listTasks.mock.calls.length + off.store.getSettings.mock.calls.length;
      vi.advanceTimersByTime(60 * 60 * 1000);
      await flush();
      const offTraffic = off.store.listTasks.mock.calls.length + off.store.getSettings.mock.calls.length - baselineOff;
      expect(offTraffic).toBe(0);
    } finally {
      vi.useRealTimers();
    }

    vi.useFakeTimers();
    try {
      const on = await startEngine(true);
      const baselineOn = on.store.listTasks.mock.calls.length + on.store.getSettings.mock.calls.length;
      vi.advanceTimersByTime(60 * 60 * 1000);
      await flush();
      expect(on.store.listTasks.mock.calls.length + on.store.getSettings.mock.calls.length)
        .toBeGreaterThan(baselineOn);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a settings write that re-asserts the current value changes nothing", async () => {
    const { engine } = await startEngine(false);
    const before = engine.isRuntimeEnabled();
    await (engine as unknown as {
      applyRuntimeGate(v: boolean): Promise<void>;
    }).applyRuntimeGate(false);
    expect(engine.isRuntimeEnabled()).toBe(before);
  });
});
