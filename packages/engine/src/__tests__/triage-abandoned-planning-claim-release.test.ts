/*
FNXC:AbandonedPlanningClaim 2026-11-06-03:45 (RUFU-470):
`releaseAbandonedPlanningClaim` is the seam that lets an abandoned planner turn be reclaimed at all,
and its whole reason to exist is that `evictStaleProcessing` may NOT cover this population. That
eviction is delete-only and sound only because its `hasLivePlanningWork` retention guard has already
excluded every card holding a live handle. The cards this seam serves are defined by failing exactly
that guard — a planner whose turn fell silent with its handle still in `activeSessions` (RUFU-467:
`status:"planning"` for hours on a live engine, freed only when the hung await happened to return 73
minutes later).

So every test here asserts CALL COUNTS AND ORDER, never "the map is now empty": an empty map reached
by a bare `Map.delete` is the FN-1312 double-planner defect this seam exists to prevent, not a pass.

The refusal half matters as much as the release half: an unprovable termination must leave the card
exactly as it was — still pinned, still refused by re-discovery — because the alternative is a second
planner starting behind an un-cancelled first one.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { TriageProcessor } from "../triage.js";
import {
  clearPreHeldExecutorSlotsForTests,
  hasPreHeldExecutorSlot,
  registerPreHeldExecutorSlot,
} from "../concurrency/concurrency.js";

const WF = "builtin:coding";
const TASK_ID = "FN-470";
const ABORT_BOUND_MS = 5_000;

/** The merged intake+hold planning column, resolved through traits rather than a literal id. */
function planningIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "WIP", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function planningCard(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "abandoned planner",
    description: "d",
    column: "todo",
    status: "planning",
    paused: false,
    userPaused: false,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-10-01T13:00:00.000Z",
    updatedAt: "2026-10-01T13:58:52.000Z",
    columnMovedAt: "2026-10-01T13:00:00.000Z",
    ...overrides,
  } as Task;
}

function createStore(): TaskStore {
  const ir = planningIr();
  const selection = { workflowId: WF, stepIds: [] };
  return {
    on: vi.fn(),
    off: vi.fn(),
    getTask: vi.fn(async () => undefined),
    listTasks: vi.fn(async () => []),
    getSettings: vi.fn().mockResolvedValue({}),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
    logEntry: vi.fn(async () => undefined),
  } as unknown as TaskStore;
}

interface ProcessorState {
  processing: Set<string>;
  processingSince: Map<string, number>;
  activeSessions: Map<string, { dispose: () => void }>;
  activeSubagentSessions: Map<string, Set<unknown>>;
  finalizing: Set<string>;
  pauseAborted: Set<string>;
  stuckAborted: Set<string>;
  coordinatorAdmittedTaskIds: Set<string>;
  hasLivePlanningWork: (taskId: string) => boolean;
}

const stateOf = (processor: TriageProcessor): ProcessorState =>
  processor as unknown as ProcessorState;

/** A session handle that records every interaction plus the bookkeeping visible at that moment. */
interface FakeHandle {
  calls: string[];
  dispose: () => void;
  abort?: () => Promise<void>;
  seenAtAbort: { stuckAborted: boolean; untrackedBeforeAbort: boolean; stillClaimed: boolean };
  seenAtDispose: { stillInActiveSessions: boolean };
}

/**
 * The handle is the witness: it snapshots triage's own bookkeeping at the instant it is called, so
 * "terminate before clearing" is proved by what the handle could SEE, not by what the maps look like
 * afterwards.
 */
function makeHandle(
  processor: TriageProcessor,
  untrackCalls: string[],
  abortSettle: "settles" | "never" | "rejects" | "absent" = "settles",
): FakeHandle {
  const handle: FakeHandle = {
    calls: [],
    seenAtAbort: { stuckAborted: false, untrackedBeforeAbort: false, stillClaimed: false },
    seenAtDispose: { stillInActiveSessions: false },
    dispose: () => {
      handle.calls.push("dispose");
      handle.seenAtDispose.stillInActiveSessions = stateOf(processor).activeSessions.has(TASK_ID);
    },
  };
  if (abortSettle !== "absent") {
    handle.abort = () => {
      handle.calls.push("abort");
      const state = stateOf(processor);
      handle.seenAtAbort.stuckAborted = state.stuckAborted.has(TASK_ID);
      handle.seenAtAbort.untrackedBeforeAbort = untrackCalls.includes(TASK_ID);
      handle.seenAtAbort.stillClaimed = state.processing.has(TASK_ID) && state.activeSessions.has(TASK_ID);
      if (abortSettle === "rejects") return Promise.reject(new Error("abort exploded"));
      if (abortSettle === "never") return new Promise<void>(() => undefined);
      return Promise.resolve();
    };
  }
  return handle;
}

interface Harness {
  processor: TriageProcessor;
  handle: FakeHandle;
  untrackCalls: string[];
}

function harness(options: {
  abortSettle?: "settles" | "never" | "rejects" | "absent";
  withHandle?: boolean;
  withClaim?: boolean;
} = {}): Harness {
  const untrackCalls: string[] = [];
  const processor = new TriageProcessor(createStore(), "/test/rufu-470", {
    semaphore: { release: vi.fn() } as never,
    stuckTaskDetector: { untrackTask: vi.fn((taskId: string) => { untrackCalls.push(taskId); }) } as never,
  });
  const handle = makeHandle(processor, untrackCalls, options.abortSettle ?? "settles");
  const state = stateOf(processor);
  if (options.withClaim !== false) {
    state.processing.add(TASK_ID);
    state.processingSince.set(TASK_ID, Date.now());
    state.coordinatorAdmittedTaskIds.add(TASK_ID);
  }
  if (options.withHandle !== false) state.activeSessions.set(TASK_ID, handle);
  return { processor, handle, untrackCalls };
}

/** The real re-discovery predicate, driven through the method the poll and the coordinator share. */
async function rediscoveryAdmits(processor: TriageProcessor, card: Task): Promise<boolean> {
  const found = await (processor as unknown as {
    discoverReadyPlanningTasks: (tasks: Task[], now: number) => Promise<Task[]>;
  }).discoverReadyPlanningTasks([card], Date.parse("2026-10-01T15:00:00.000Z"));
  return found.some((task) => task.id === card.id);
}

describe("releaseAbandonedPlanningClaim (RUFU-470)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearPreHeldExecutorSlotsForTests();
  });

  afterEach(() => {
    clearPreHeldExecutorSlotsForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("terminate-then-release ordering", () => {
    it("aborts, awaits, then disposes the retained handle before dropping any entry", async () => {
      const h = harness();
      registerPreHeldExecutorSlot(TASK_ID);

      const verdict = await h.processor.releaseAbandonedPlanningClaim(TASK_ID, {
        abortSettleBoundMs: ABORT_BOUND_MS,
      });

      expect(verdict).toEqual({ verdict: "released", terminatedSessionCount: 1 });
      // abort before dispose, exactly once each.
      expect(h.handle.calls).toEqual(["abort", "dispose"]);
      // The turn was proven cancelled BEFORE anything was dropped.
      expect(h.handle.seenAtAbort.stillClaimed).toBe(true);
      expect(h.handle.seenAtDispose.stillInActiveSessions).toBe(true);
      // `stuckAborted` is marked and the detector untracked BEFORE the abort, so a turn that settles
      // later routes to the stuck-requeue branch, and the detector cannot kill a generation of a
      // session it no longer owns.
      expect(h.handle.seenAtAbort.stuckAborted).toBe(true);
      expect(h.handle.seenAtAbort.untrackedBeforeAbort).toBe(true);
      expect(h.untrackCalls).toEqual([TASK_ID]);

      const state = stateOf(h.processor);
      expect(state.processing.has(TASK_ID)).toBe(false);
      expect(state.processingSince.has(TASK_ID)).toBe(false);
      expect(state.activeSessions.has(TASK_ID)).toBe(false);
      expect(state.coordinatorAdmittedTaskIds.has(TASK_ID)).toBe(false);
      // `stuckAborted` STAYS marked: it routes the late-settling turn and cannot re-pin the card once
      // `activeSessions` is gone.
      expect(state.stuckAborted.has(TASK_ID)).toBe(true);
      // No live planner is reported any more, so the poll sweep and re-discovery can act.
      expect(state.hasLivePlanningWork(TASK_ID)).toBe(false);
    });

    it("never sets `pauseAborted`, whose late restore would null the caller's re-drive", async () => {
      const h = harness();
      await h.processor.releaseAbandonedPlanningClaim(TASK_ID, { abortSettleBoundMs: ABORT_BOUND_MS });
      expect(stateOf(h.processor).pauseAborted.has(TASK_ID)).toBe(false);
    });

    it("releases the pre-held executor slot paired with exactly one semaphore release", async () => {
      const release = vi.fn();
      const processor = new TriageProcessor(createStore(), "/test/rufu-470", {
        semaphore: { release } as never,
        stuckTaskDetector: { untrackTask: vi.fn() } as never,
      });
      const state = stateOf(processor);
      state.processing.add(TASK_ID);
      state.processingSince.set(TASK_ID, Date.now());
      state.activeSessions.set(TASK_ID, makeHandle(processor, []));
      registerPreHeldExecutorSlot(TASK_ID);

      await expect(processor.releaseAbandonedPlanningClaim(TASK_ID, { abortSettleBoundMs: ABORT_BOUND_MS }))
        .resolves.toMatchObject({ verdict: "released" });

      expect(release).toHaveBeenCalledTimes(1);
      expect(hasPreHeldExecutorSlot(TASK_ID)).toBe(false);
    });

    it("does not release a semaphore unit when no pre-held slot was registered", async () => {
      const release = vi.fn();
      const processor = new TriageProcessor(createStore(), "/test/rufu-470", {
        semaphore: { release } as never,
        stuckTaskDetector: { untrackTask: vi.fn() } as never,
      });
      const state = stateOf(processor);
      state.processing.add(TASK_ID);
      state.processingSince.set(TASK_ID, Date.now());
      state.activeSessions.set(TASK_ID, makeHandle(processor, []));

      await expect(processor.releaseAbandonedPlanningClaim(TASK_ID, { abortSettleBoundMs: ABORT_BOUND_MS }))
        .resolves.toMatchObject({ verdict: "released" });

      // `dropPreHeldExecutorSlot` reports whether it dropped a registration; releasing on `false`
      // would INFLATE capacity (FNXC:CapacityModel 2026-07-29-17:10).
      expect(release).not.toHaveBeenCalled();
    });
  });

  describe("unprovable termination mutates nothing", () => {
    it("an `abort()` that never settles refuses with zero clears, zero releases, and no marker", async () => {
      const h = harness({ abortSettle: "never" });
      registerPreHeldExecutorSlot(TASK_ID);

      const pending = h.processor.releaseAbandonedPlanningClaim(TASK_ID, { abortSettleBoundMs: ABORT_BOUND_MS });
      await vi.advanceTimersByTimeAsync(ABORT_BOUND_MS);

      await expect(pending).resolves.toEqual({ verdict: "retained-live", reason: "abort-unproven" });
      const state = stateOf(h.processor);
      expect(state.processing.has(TASK_ID)).toBe(true);
      expect(state.processingSince.has(TASK_ID)).toBe(true);
      expect(state.activeSessions.has(TASK_ID)).toBe(true);
      expect(state.coordinatorAdmittedTaskIds.has(TASK_ID)).toBe(true);
      expect(hasPreHeldExecutorSlot(TASK_ID)).toBe(true);
      // The marker is rolled back: leaving it set would flip `hasLivePlanningWork` to false and
      // license the DELETE-ONLY eviction to drop the very handle this call failed to cancel.
      expect(state.stuckAborted.has(TASK_ID)).toBe(false);
      expect(state.hasLivePlanningWork(TASK_ID)).toBe(true);
      // Never disposed — a possibly-streaming planner keeps its resources.
      expect(h.handle.calls).toEqual(["abort"]);
    });

    it("an `abort()` that rejects refuses the same way", async () => {
      const h = harness({ abortSettle: "rejects" });
      registerPreHeldExecutorSlot(TASK_ID);

      await expect(h.processor.releaseAbandonedPlanningClaim(TASK_ID, { abortSettleBoundMs: ABORT_BOUND_MS }))
        .resolves.toEqual({ verdict: "retained-live", reason: "abort-unproven" });

      const state = stateOf(h.processor);
      expect(state.processing.has(TASK_ID)).toBe(true);
      expect(state.activeSessions.has(TASK_ID)).toBe(true);
      expect(state.stuckAborted.has(TASK_ID)).toBe(false);
      expect(hasPreHeldExecutorSlot(TASK_ID)).toBe(true);
      expect(h.handle.calls).toEqual(["abort"]);
    });

    it("a dispose-only handle has no provable cancellation", async () => {
      const h = harness({ abortSettle: "absent" });

      await expect(h.processor.releaseAbandonedPlanningClaim(TASK_ID, { abortSettleBoundMs: ABORT_BOUND_MS }))
        .resolves.toEqual({ verdict: "retained-live", reason: "abort-unproven" });

      // `dispose()` alone is exactly what the stuck detector already tried on RUFU-467 and it did not
      // stop the turn, so disposing here and clearing the claim would be the orphan.
      expect(h.handle.calls).toEqual([]);
      expect(stateOf(h.processor).activeSessions.has(TASK_ID)).toBe(true);
    });
  });

  describe("legs that are never this seam's to terminate", () => {
    it.each(["active-session", "executing-lock", "task-active"] as const)(
      "the canonical liveness leg `%s` vetoes absolutely, even with a retained handle",
      async (liveness) => {
        const h = harness();
        registerPreHeldExecutorSlot(TASK_ID);

        await expect(
          h.processor.releaseAbandonedPlanningClaim(TASK_ID, { liveness, abortSettleBoundMs: ABORT_BOUND_MS }),
        ).resolves.toEqual({ verdict: "retained-live", reason: "liveness-signal" });

        expect(h.handle.calls).toEqual([]);
        expect(h.untrackCalls).toEqual([]);
        const state = stateOf(h.processor);
        expect(state.processing.has(TASK_ID)).toBe(true);
        expect(state.activeSessions.has(TASK_ID)).toBe(true);
        expect(state.hasLivePlanningWork(TASK_ID)).toBe(true);
      },
    );

    it("a card whose finalize handoff is in flight is refused untouched", async () => {
      const h = harness();
      stateOf(h.processor).finalizing.add(TASK_ID);

      await expect(h.processor.releaseAbandonedPlanningClaim(TASK_ID, { abortSettleBoundMs: ABORT_BOUND_MS }))
        .resolves.toEqual({ verdict: "retained-live", reason: "finalize-in-flight" });

      // A stuck-kill mid-finalize destroyed an already-approved plan once (FN-1312).
      expect(h.handle.calls).toEqual([]);
      expect(stateOf(h.processor).finalizing.has(TASK_ID)).toBe(true);
    });

    it("a card with a live Plan Review subagent is refused untouched", async () => {
      const h = harness();
      stateOf(h.processor).activeSubagentSessions.set(TASK_ID, new Set([{}]));

      await expect(h.processor.releaseAbandonedPlanningClaim(TASK_ID, { abortSettleBoundMs: ABORT_BOUND_MS }))
        .resolves.toEqual({ verdict: "retained-live", reason: "finalize-in-flight" });

      expect(h.handle.calls).toEqual([]);
      expect(stateOf(h.processor).activeSubagentSessions.get(TASK_ID)?.size).toBe(1);
    });

    it("an empty subagent set is not a leg and does not veto", async () => {
      const h = harness();
      stateOf(h.processor).activeSubagentSessions.set(TASK_ID, new Set());

      await expect(h.processor.releaseAbandonedPlanningClaim(TASK_ID, { abortSettleBoundMs: ABORT_BOUND_MS }))
        .resolves.toMatchObject({ verdict: "released" });
    });
  });

  it("returns `not-claimed` with zero mutation for a card no planner bookkeeping names", async () => {
    const h = harness({ withClaim: false, withHandle: false });

    await expect(h.processor.releaseAbandonedPlanningClaim(TASK_ID, { abortSettleBoundMs: ABORT_BOUND_MS }))
      .resolves.toEqual({ verdict: "not-claimed" });

    expect(h.handle.calls).toEqual([]);
    expect(h.untrackCalls).toEqual([]);
  });

  it("releases a claim that has no handle at all, with zero terminations", async () => {
    const h = harness({ withHandle: false });

    await expect(h.processor.releaseAbandonedPlanningClaim(TASK_ID, { abortSettleBoundMs: ABORT_BOUND_MS }))
      .resolves.toEqual({ verdict: "released", terminatedSessionCount: 0 });

    expect(stateOf(h.processor).processing.has(TASK_ID)).toBe(false);
  });

  describe("the re-drive is consumable only after the release", () => {
    /*
    This is the pair the first revision lacked: a `needs-replan` written while the pin still stands is
    DECORATIVE — triage's own re-discovery refuses the card, so nothing observable changed. The release
    seam, not an edit to the discovery predicate, is what makes the predicate admit.
    */
    it("re-discovery refuses the card while the claim stands and admits it after the release", async () => {
      const h = harness();
      const card = planningCard({ status: "needs-replan" });

      expect(await rediscoveryAdmits(h.processor, card)).toBe(false);

      await h.processor.releaseAbandonedPlanningClaim(TASK_ID, { abortSettleBoundMs: ABORT_BOUND_MS });

      expect(await rediscoveryAdmits(h.processor, card)).toBe(true);
    });

    it("an unproven termination leaves the card refused by re-discovery — no second planner", async () => {
      const h = harness({ abortSettle: "never" });
      const card = planningCard({ status: "needs-replan" });

      const pending = h.processor.releaseAbandonedPlanningClaim(TASK_ID, { abortSettleBoundMs: ABORT_BOUND_MS });
      await vi.advanceTimersByTimeAsync(ABORT_BOUND_MS);
      await pending;

      expect(await rediscoveryAdmits(h.processor, card)).toBe(false);
    });
  });
});
