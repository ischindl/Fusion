/*
FNXC:AssignmentWakeDedup 2026-11-04-21:07 (RUFU-411) — written against the implementation and observed
FAILING first.

The field symptom (production, 2026-09-29, measured from the surviving durable evidence): the `engineer`
lane exited 109 heartbeat runs against one card (`todo`, unassigned, no steering comments) inside 18 minutes,
each 8-17 s after the previous `fn_heartbeat_done`, with foreign-lane writes on the card at exactly zero —
the agent correctly reported "nothing to do" every single time. The observable card state never moved, yet
the identical wake delta re-fired every cycle and the assigned agent had no capacity left for real work.

The invariant fixed here is:

  One delivered wake per (agent, goal, observable delta) per window; any change to that delta wakes
  immediately, in the same dispatch cycle, with no window to wait out.

Both delivery arms are covered because the evidence pins the carrier (the retained deferred entry re-fired
at the run-completion edge) but cannot pin the arm-level refill — run-audit and heartbeat_run rows for that
window are past the operational retention window — and the shipped policy is "both arms guarded".
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Agent, AgentHeartbeatRun, AgentStore, TaskStore, WorkflowIr } from "@fusion/core";
import { HeartbeatTriggerScheduler } from "../agent-heartbeat.js";
import { createBudgetStatus } from "./heartbeat-test-helpers.js";

const WF = "custom:dedup";
const AGENT = "agent-a";
const CARD = "RUFU-409";

/** Lifecycle board with distinctly named lanes; only `building` counts as work-in-progress. */
function boardIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "inbox", name: "inbox", traits: [{ trait: "intake" }] },
      { id: "queued", name: "queued", traits: [{ trait: "hold", config: { release: "manual" } }] },
      { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "assessing", name: "assessing", traits: [{ trait: "merge-blocker" }] },
      { id: "shipped", name: "shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

const agentFixture = (patch: Record<string, unknown> = {}): Agent => ({
  id: AGENT,
  name: AGENT,
  role: "executor",
  state: "active",
  taskId: CARD,
  runtimeConfig: { enabled: true },
  createdAt: "",
  updatedAt: "",
  metadata: {},
  ...patch,
}) as unknown as Agent;

const taskFixture = (patch: Record<string, unknown> = {}) => ({
  id: CARD,
  title: "Runaway wake card",
  description: "d",
  prompt: "# PROMPT",
  column: "building",
  assignedAgentId: AGENT,
  worktree: "/wt/RUFU-409",
  branch: "fusion/rufu-409",
  dependencies: [],
  steps: [],
  log: [],
  steeringComments: [],
  ...patch,
});

type Wake = { source: string; taskId: string | null; commentIds?: string[] };

/**
 * Capture the wakes the lane delivers. The scheduler callback is `(agentId, source, context)` — the goal
 * travels INSIDE the context, so a harness reading the third positional argument as a bare task id reads
 * the whole context object instead (measured on this file's first run: an assertion expected "RUFU-409" and
 * received `{ budgetStatus, wakeReason, triggerDetail, taskId }`).
 */
function captureWake(wakes: Wake[]) {
  return async (_agentId: string, source: string, context: { taskId?: string; triggeringCommentIds?: string[] }): Promise<void> => {
    wakes.push({ source, taskId: context?.taskId ?? null, commentIds: context?.triggeringCommentIds });
  };
}

function createStore(overrides: Record<string, unknown> = {}) {
  const run = {
    id: "run-1",
    agentId: AGENT,
    status: "completed",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  } as unknown as AgentHeartbeatRun;

  const store = Object.assign(new EventEmitter(), {
    getAgent: vi.fn().mockResolvedValue(agentFixture()),
    getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
    getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
    getRecentRuns: vi.fn().mockResolvedValue([run]),
    listAgents: vi.fn().mockResolvedValue([]),
    startHeartbeatRun: vi.fn().mockResolvedValue(run),
    saveRun: vi.fn().mockResolvedValue(run),
    getRunDetail: vi.fn().mockResolvedValue(run),
    endHeartbeatRun: vi.fn(),
    updateAgentState: vi.fn(),
    recordHeartbeat: vi.fn(),
    ...overrides,
  }) as unknown as AgentStore & EventEmitter;
  return store;
}

function createTaskStore(overrides: Record<string, unknown> = {}) {
  return Object.assign(new EventEmitter(), {
    getTask: vi.fn().mockResolvedValue(taskFixture()),
    getSettings: vi.fn().mockResolvedValue({}),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: WF, stepIds: [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: WF, stepIds: [] })),
    getWorkflowDefinition: vi.fn(async () => ({ ir: boardIr() })),
    // The TaskStore is the run-audit sink (the AgentStore has no audit surface).
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as unknown as TaskStore & EventEmitter;
}

/** Every suppression row the lane wrote, straight off the TaskStore audit sink. */
function suppressionRows(taskStore: TaskStore): Array<Record<string, unknown>> {
  const recorder = (taskStore as unknown as { recordRunAuditEvent: { mock: { calls: unknown[][] } } }).recordRunAuditEvent;
  return recorder.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((row) => row?.mutationType === "agent:assignment-wake-suppressed");
}

/*
Drain pending work without a real time wait. `setImmediate` sits under the suite's control alongside
`Date.now()`, so the flush has to go through the fake clock — an immediate-based settle hung this whole file
(measured: 15/15 tests timing out at 30 s on its first run).
*/
const settle = async (ticks = 4): Promise<void> => {
  for (let i = 0; i < ticks; i += 1) await vi.advanceTimersByTimeAsync(0);
};

describe("assignment wake dedupe (RUFU-411)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("symptom: the identical delta must stop re-firing", () => {
    it("delivers the first wake for a delta immediately", async () => {
      const store = createStore();
      const wakes: Wake[] = [];
      const scheduler = new HeartbeatTriggerScheduler(store, captureWake(wakes), createTaskStore());
      scheduler.start();

      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();

      expect(wakes).toEqual([{ source: "assignment", taskId: CARD, commentIds: undefined }]);
      scheduler.stop();
    });

    it("delivers exactly one wake across eight identical re-arrivals inside the window", async () => {
      const store = createStore();
      const wakes: Wake[] = [];
      const scheduler = new HeartbeatTriggerScheduler(store, captureWake(wakes), createTaskStore());
      scheduler.start();

      // The recorded failure shape: the same card, the same agent state, no comments, again and again.
      for (let cycle = 0; cycle < 8; cycle += 1) {
        store.emit("agent:assigned", agentFixture(), CARD);
        await settle();
        vi.advanceTimersByTime(15_000);
      }

      expect(wakes).toHaveLength(1);
      expect(wakes[0].taskId).toBe(CARD);
      scheduler.stop();
    });

    it("consumes the pending wake at the completion edge so the edge cannot re-arm the loop", async () => {
      const store = createStore();
      const taskStore = createTaskStore();
      const wakes: Wake[] = [];
      const scheduler = new HeartbeatTriggerScheduler(store, captureWake(wakes), taskStore);
      scheduler.start();

      // An active run defers the arrival, exactly as the field case had it: the card was executing.
      const active = { id: "run-active", agentId: AGENT, status: "active", startedAt: new Date().toISOString(), endedAt: null };
      (store.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue(active as unknown as AgentHeartbeatRun);
      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();
      expect(wakes).toEqual([]);

      // The run completes: one delivery, and the entry is spent rather than retained-and-refired.
      (store.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      scheduler.drainPendingAssignment(AGENT);
      await settle();
      expect(wakes).toHaveLength(1);

      // Every later completion edge of the same agent — the shape that sustained 109 no-op sessions.
      for (let cycle = 0; cycle < 8; cycle += 1) {
        scheduler.drainPendingAssignment(AGENT);
        await settle();
      }

      expect(wakes).toHaveLength(1);
      expect(suppressionRows(taskStore).length).toBeLessThanOrEqual(1);
      scheduler.stop();
    });

    it("suppresses the deferred arm too, and consumes the entry rather than re-arming it", async () => {
      const store = createStore();
      const taskStore = createTaskStore();
      const wakes: Wake[] = [];
      const scheduler = new HeartbeatTriggerScheduler(store, captureWake(wakes), taskStore);
      scheduler.start();

      // Deliver once through the immediate arm...
      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();
      expect(wakes).toHaveLength(1);

      // ...then a re-park of the very same delta arrives at the completion edge.
      const active = { id: "run-active", agentId: AGENT, status: "active", startedAt: new Date().toISOString(), endedAt: null };
      (store.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue(active as unknown as AgentHeartbeatRun);
      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();
      (store.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      scheduler.drainPendingAssignment(AGENT);
      await settle();
      scheduler.drainPendingAssignment(AGENT);
      await settle();

      expect(wakes).toHaveLength(1);
      const rows = suppressionRows(taskStore);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({ outcome: "unchanged-delta", arm: "drain", taskId: CARD });
      expect(Number(rows[0].metadata!.suppressedCount)).toBeGreaterThanOrEqual(1);
      scheduler.stop();
    });

    it("writes exactly one suppression row for an eight-arrival episode, never zero", async () => {
      const store = createStore();
      const taskStore = createTaskStore();
      const wakes: Wake[] = [];
      const scheduler = new HeartbeatTriggerScheduler(store, captureWake(wakes), taskStore);
      scheduler.start();

      for (let cycle = 0; cycle < 8; cycle += 1) {
        store.emit("agent:assigned", agentFixture(), CARD);
        await settle();
      }

      expect(wakes).toHaveLength(1);
      expect(suppressionRows(taskStore)).toHaveLength(1);
      scheduler.stop();
    });

    it("records the suppression as ids, counts, and fixed enums only, and a hostile sink cannot change dispatch", async () => {
      const store = createStore();
      const taskStore = createTaskStore({
        recordRunAuditEvent: vi.fn().mockRejectedValue(new Error("audit store down")),
      });
      const wakes: Wake[] = [];
      const scheduler = new HeartbeatTriggerScheduler(store, captureWake(wakes), taskStore);
      scheduler.start();

      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();
      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();

      // One delivery, one suppression attempt, and the attempted write proves the row was shaped before the sink refused it.
      expect(wakes).toHaveLength(1);
      const recorder = (taskStore as unknown as { recordRunAuditEvent: { mock: { calls: unknown[][] } } }).recordRunAuditEvent;
      expect(recorder).toHaveBeenCalled();
      const written = recorder.mock.calls.map((call) => call[0] as Record<string, unknown>);
      expect(written.some((row) => row.mutationType === "agent:assignment-wake-suppressed")).toBe(true);
      const keys = written
        .filter((row) => row.mutationType === "agent:assignment-wake-suppressed")
        .flatMap((row) => Object.keys((row.metadata ?? {}) as object));
      expect([...new Set(keys)].sort()).toEqual(["arm", "outcome", "priorFiredAt", "suppressedCount", "taskId"]);
      scheduler.stop();
    });
  });

  describe("inverse: a changed delta must never be withheld", () => {
    it("wakes immediately on a new steering comment for the same card, with no window to wait out", async () => {
      /*
      One shared task row that this test mutates: the comment appears only BETWEEN the two arrivals, so the
      two deltas genuinely differ. (`getRecentRuns` is empty, so any comment on the card counts as new to
      this agent — the lane filters steering comments against the last run's start time.)
      */
      const card = taskFixture();
      const store = createStore({ getRecentRuns: vi.fn().mockResolvedValue([]) });
      const taskStore = createTaskStore({ getTask: vi.fn(async () => card) });
      const wakes: Wake[] = [];
      const scheduler = new HeartbeatTriggerScheduler(store, captureWake(wakes), taskStore);
      scheduler.start();

      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();
      (card.steeringComments as unknown[]).push({ id: "c-new", type: "steering", createdAt: new Date().toISOString() });
      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();

      expect(wakes.map((wake) => wake.commentIds)).toEqual([undefined, ["c-new"]]);
      expect(wakes).toHaveLength(2);
      expect(suppressionRows(taskStore)).toHaveLength(0);
      scheduler.stop();
    });

    it("wakes immediately when the agent is re-bound to a different card", async () => {
      const store = createStore();
      const wakes: Wake[] = [];
      const scheduler = new HeartbeatTriggerScheduler(store, captureWake(wakes), createTaskStore());
      scheduler.start();

      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();
      store.emit("agent:assigned", agentFixture({ taskId: "RUFU-410" }), "RUFU-410");
      await settle();

      expect(wakes.map((wake) => wake.taskId)).toEqual([CARD, "RUFU-410"]);
      scheduler.stop();
    });

    it("wakes immediately when the observable agent state changes", async () => {
      const store = createStore();
      const wakes: Wake[] = [];
      const scheduler = new HeartbeatTriggerScheduler(store, captureWake(wakes), createTaskStore());
      scheduler.start();

      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();
      // Same goal, same comments, but the agent came off a pause — an operator action must never be deaf.
      store.emit("agent:assigned", agentFixture({ state: "idle" }), CARD);
      await settle();

      expect(wakes).toHaveLength(2);
      scheduler.stop();
    });

    it("wakes again for a card transferred back after being transferred away", async () => {
      const store = createStore();
      const taskStore = createTaskStore();
      const wakes: Wake[] = [];
      const scheduler = new HeartbeatTriggerScheduler(store, captureWake(wakes), taskStore);
      scheduler.watchAssignments();
      scheduler.start();

      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();
      expect(wakes).toHaveLength(1);

      // The card leaves the agent: any owed wake is pruned and the suppression memory with it.
      taskStore.emit("task:assignee-changed", { taskId: CARD, previousOwnerId: AGENT, newOwnerId: "agent-b" });
      await settle();

      // ...and comes straight back, which is a real hand-off, not a repeat.
      (taskStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(taskFixture({ assignedAgentId: AGENT }));
      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();

      expect(wakes).toHaveLength(2);
      scheduler.stop();
    });

    it("wakes on the first arrival after the window has elapsed", async () => {
      const store = createStore();
      const wakes: Wake[] = [];
      const scheduler = new HeartbeatTriggerScheduler(store, captureWake(wakes), createTaskStore());
      scheduler.start();

      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();
      vi.advanceTimersByTime(6 * 60 * 1000);
      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();

      expect(wakes).toHaveLength(2);
      scheduler.stop();
    });

    it("delivers one wake per distinct card when two goals are assigned back to back", async () => {
      const store = createStore();
      const wakes: Wake[] = [];
      const scheduler = new HeartbeatTriggerScheduler(store, captureWake(wakes), createTaskStore());
      scheduler.start();

      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();
      store.emit("agent:assigned", agentFixture(), "RUFU-410");
      await settle();

      expect(wakes.map((wake) => wake.taskId)).toEqual([CARD, "RUFU-410"]);
      scheduler.stop();
    });
  });

  describe("guard ordering: suppression is the last word, never the first", () => {
    it("leaves no delivery marker for a wake the eligibility guards never delivered", async () => {
      const store = createStore();
      const wakes: Wake[] = [];
      const scheduler = new HeartbeatTriggerScheduler(store, captureWake(wakes), createTaskStore());
      scheduler.start();

      // Budget exhaustion is terminal for the wake: it clears, and it must not claim a delivery.
      (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(createBudgetStatus({ isOverBudget: true }));
      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();
      expect(wakes).toEqual([]);

      (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(createBudgetStatus());
      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();

      expect(wakes).toHaveLength(1);
      expect(wakes[0].taskId).toBe(CARD);
      scheduler.stop();
    });

    it("anchors the window to the real delivery, not to the arrivals it withheld", async () => {
      const store = createStore();
      const wakes: Wake[] = [];
      const scheduler = new HeartbeatTriggerScheduler(store, captureWake(wakes), createTaskStore());
      scheduler.start();

      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();
      // Half-way through the window an identical arrival is withheld...
      vi.advanceTimersByTime(3 * 60 * 1000);
      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();
      // ...and 6 minutes after the ONLY real delivery the next identical arrival is outside the window.
      vi.advanceTimersByTime(3 * 60 * 1000);
      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();

      expect(wakes).toHaveLength(2);
      scheduler.stop();
    });

    it("drops the suppression record with the agent registration so a re-registration always wakes", async () => {
      const store = createStore();
      const wakes: Wake[] = [];
      const scheduler = new HeartbeatTriggerScheduler(store, captureWake(wakes), createTaskStore());
      scheduler.start();

      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();
      scheduler.unregisterAgent(AGENT);
      store.emit("agent:assigned", agentFixture(), CARD);
      await settle();

      expect(wakes).toHaveLength(2);
      scheduler.stop();
    });
  });
});
