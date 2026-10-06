import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchRun, ResearchStore } from "@fusion/core";
import type { ResearchOrchestrator } from "../research/research-orchestrator.js";
import { ResearchRunDispatcher } from "../research/research-dispatcher.js";

/*
FNXC:ResearchDispatcher 2026-08-04-00:03:
This is a pure timer-driven polling unit test (no subprocess, no network), so it uses
FAKE TIMERS instead of real `sleep()` waits per AGENTS.md "Do Not Add Slow Tests" /
"Prefer fake timers over real polling/time waits". The previous real-sleep version was
both slow (~200ms of wall-clock waits) AND weaker: the dispatcher clamps tickIntervalMs
to a 100ms floor, so 30-40ms real sleeps never let the interval re-fire — only the
immediate `void this.tick()` in start() ran. The double-dispatch and stop-cancels-timer
cases therefore never exercised a SECOND tick. Advancing fake timers past the 100ms
interval now deterministically fires follow-up ticks, so those invariants are genuinely
asserted. stop()'s drain loop only spins when inFlight is non-empty, so every test drains
inFlight (immediate/resolved runs) before stop, keeping the fake-timer clock from stalling
in that real-`setTimeout` loop.
*/
describe("ResearchRunDispatcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createStore(runs: ResearchRun[]): ResearchStore {
    return {
      listRuns: vi.fn(() => runs),
    } as unknown as ResearchStore;
  }

  it("dispatches queued runs", async () => {
    vi.useFakeTimers();
    const runs = [{ id: "RR-1", query: "hello", status: "queued" } as ResearchRun];
    const store = createStore(runs);
    const startRun = vi.fn(async () => ({ id: "RR-1" } as ResearchRun));
    const orchestrator = { startRun } as unknown as ResearchOrchestrator;

    const dispatcher = new ResearchRunDispatcher({ store, orchestrator, tickIntervalMs: 10 });
    dispatcher.start();
    // Flush the immediate `void this.tick()` chain (await listRuns -> startRun).
    await vi.advanceTimersByTimeAsync(0);

    expect(startRun).toHaveBeenCalledWith("RR-1", "hello", expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
    await dispatcher.stop();
  });

  it("does not double-dispatch in-flight runs", async () => {
    vi.useFakeTimers();
    const runs = [{ id: "RR-1", query: "hello", status: "queued" } as ResearchRun];
    const store = createStore(runs);
    let resolveRun: (() => void) | undefined;
    const startRun = vi.fn(() => new Promise<ResearchRun>((resolve) => {
      resolveRun = () => resolve({ id: "RR-1" } as ResearchRun);
    }));
    const orchestrator = { startRun } as unknown as ResearchOrchestrator;

    const dispatcher = new ResearchRunDispatcher({ store, orchestrator, tickIntervalMs: 10 });
    dispatcher.start();
    // Immediate tick dispatches RR-1 and marks it in-flight (startRun stays pending).
    await vi.advanceTimersByTimeAsync(0);
    expect(startRun).toHaveBeenCalledTimes(1);

    // Fire a follow-up interval tick (100ms floor): the in-flight guard must skip RR-1.
    await vi.advanceTimersByTimeAsync(100);
    expect(startRun).toHaveBeenCalledTimes(1);

    resolveRun?.();
    await vi.advanceTimersByTimeAsync(0);
    await dispatcher.stop();
  });

  it("survives startRun rejection", async () => {
    vi.useFakeTimers();
    const runs = [{ id: "RR-1", query: "hello", status: "queued" } as ResearchRun];
    const store = createStore(runs);
    const startRun = vi.fn(async () => {
      throw new Error("boom");
    });
    const orchestrator = { startRun } as unknown as ResearchOrchestrator;

    const dispatcher = new ResearchRunDispatcher({ store, orchestrator, tickIntervalMs: 10 });
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(startRun).toHaveBeenCalled();
    await dispatcher.stop();
  });

  it("stop cancels timer", async () => {
    vi.useFakeTimers();
    const runs = [{ id: "RR-1", query: "hello", status: "queued" } as ResearchRun];
    const store = createStore(runs);
    const startRun = vi.fn(async () => ({ id: "RR-1" } as ResearchRun));
    const orchestrator = { startRun } as unknown as ResearchOrchestrator;

    const dispatcher = new ResearchRunDispatcher({ store, orchestrator, tickIntervalMs: 10 });
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);
    await dispatcher.stop();

    const callsAfterStop = startRun.mock.calls.length;
    // Advancing well past several intervals must produce no further ticks once stopped.
    await vi.advanceTimersByTimeAsync(300);
    expect(startRun).toHaveBeenCalledTimes(callsAfterStop);
  });

  it("does not stack store reads while a pass is suspended", async () => {
    /*
    FNXC:ResearchDispatcher 2026-10-06-09:34 (RUFU-588 follow-up):
    Regression for the measured pile: a live heap snapshot at 25 minutes of process life held
    1 125 suspended `listResearchRuns` frames because every interval fired another poll while the
    previous one was still awaiting the store. This asserts the invariant, not the repro: a suspended
    pass must never admit a second concurrent store read, and the poll must resume afterwards.
    */
    vi.useFakeTimers();
    let resolveList: ((value: ResearchRun[]) => void) | undefined;
    const listRuns = vi.fn(() => new Promise<ResearchRun[]>((resolve) => { resolveList = () => resolve([]); }));
    const store = { listRuns } as unknown as ResearchStore;
    const startRun = vi.fn(async () => ({ id: "RR-none" } as ResearchRun));
    const orchestrator = { startRun } as unknown as ResearchOrchestrator;

    const dispatcher = new ResearchRunDispatcher({ store, orchestrator, tickIntervalMs: 10 });
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(listRuns).toHaveBeenCalledTimes(1);

    // Twenty minutes of intervals while the first read is still in flight: still exactly one read.
    await vi.advanceTimersByTimeAsync(1_200_000);
    expect(listRuns).toHaveBeenCalledTimes(1);

    resolveList?.([]);
    const resumedFrom = listRuns.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    // The exact tick count depends on where the interval boundary lands after the resolution, so the
    // invariant asserted here is "polling resumed", not a counted number of ticks.
    expect(listRuns.mock.calls.length).toBeGreaterThan(resumedFrom);
    await dispatcher.stop();
  });

  it("resumes polling after a failing read instead of wedging the overlap guard", async () => {
    vi.useFakeTimers();
    let fail = true;
    const listRuns = vi.fn(async () => {
      if (fail) throw new Error("connection pool timeout");
      return [] as ResearchRun[];
    });
    const store = { listRuns } as unknown as ResearchStore;
    const orchestrator = { startRun: vi.fn(async () => ({ id: "RR-none" } as ResearchRun)) } as unknown as ResearchOrchestrator;

    const dispatcher = new ResearchRunDispatcher({ store, orchestrator, tickIntervalMs: 10 });
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(listRuns).toHaveBeenCalledTimes(1);

    // The guard must be released on the throwing path too, or one bad read stops polling forever.
    fail = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listRuns.mock.calls.length).toBeGreaterThan(1);
    await dispatcher.stop();
  });
});
