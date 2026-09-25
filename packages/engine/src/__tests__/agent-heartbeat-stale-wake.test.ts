/*
FNXC:AssigneeTransferAtomicity 2026-09-21 (RUFU-260 Step 4) — written against the current
implementation and observed FAILING first.

RUFU-251 fan-out symptom 4: a board re-assignment handed the card to agent B while agent A still
had a wake in flight, and B's heartbeat opened a session whose goal AND cwd were still A's card —
`Complete task: RUFU-251` inside RUFU-251's worktree. Three defects compose into that shape:

1. Heartbeat worktree acquisition never consulted the task disposal barrier, so a wake could
   acquire (and hand over) a checkout while the previous owner's teardown was still running.
2. The deferred-assignment drain carried the taskId captured at enqueue time and revalidated only
   liveness/pause/parallel state — never whether the card still belonged to that agent.
3. `agent:assigned` fires from the tool paths only, so a board write to the assignee never woke the
   new owner and never pruned the old owner's deferred wake.

Coverage required here (spec Step 4): the barrier is awaited strictly before acquisition; after the
barrier the wake is dropped when the card's owner changed or the card moved into a lane where its
assignee cannot execute; the review-dispatch wake (a reviewer woken for a card they are not assigned
to) is NOT swallowed; and a deferred wake for a transferred card never reaches the wake callback
with the old explicit task id.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type {
  Agent,
  AgentHeartbeatRun,
  AgentStore,
  TaskAssigneeChangedEvent,
  TaskStore,
  WorkflowIr,
} from "@fusion/core";
import { HeartbeatMonitor, HeartbeatTriggerScheduler } from "../agent-heartbeat.js";
import * as worktreeAcquisition from "../worktree/worktree-acquisition.js";
import {
  hasTaskDisposalBarrier,
  registerTaskDisposal,
  resetTaskDisposalBarrierForTests,
} from "../executor/task-disposal-barrier.js";
import { createBudgetStatus } from "./heartbeat-test-helpers.js";

const sessionFactory = vi.hoisted(() => ({
  createResolvedAgentSession: vi.fn(),
  promptWithFallback: vi.fn(async (session: { prompt(text: string): Promise<unknown> }, text: string) => {
    await session.prompt(text);
  }),
}));

/**
 * The heartbeat builds its session through `createResolvedAgentSession`, so that is the seam that
 * receives the acquired worktree path. Mocking it (rather than pi.js) keeps the run off the real
 * provider/runtime stack while still asserting what the session was actually handed.
 */
vi.mock("../agents/agent-session-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-session-helpers.js")>()),
  createResolvedAgentSession: sessionFactory.createResolvedAgentSession,
}));

vi.mock("../pi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pi.js")>()),
  promptWithFallback: sessionFactory.promptWithFallback,
}));

const WF = "custom:handoff";

/** Lifecycle board with distinctly named lanes: only `building` is the executable (WIP) lane. */
function handoffIr(): WorkflowIr {
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

const taskFixture = (patch: Record<string, unknown> = {}) => ({
  id: "FN-1",
  title: "Handoff card",
  description: "d",
  prompt: "# PROMPT",
  column: "building",
  assignedAgentId: "agent-a",
  worktree: "/wt/FN-1",
  branch: "fusion/fn-1",
  dependencies: [],
  steps: [],
  log: [],
  ...patch,
});

const agentFixture = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  name: id,
  role: "executor",
  state: "active",
  taskId: "FN-1",
  createdAt: "",
  updatedAt: "",
  metadata: {},
  ...patch,
}) as unknown as Agent;

function createAgentStore(overrides: Record<string, unknown> = {}): AgentStore {
  const run = {
    id: "run-1",
    agentId: "agent-a",
    status: "active",
    startedAt: new Date().toISOString(),
    endedAt: null,
  } as unknown as AgentHeartbeatRun;
  return {
    getAgent: vi.fn().mockResolvedValue(agentFixture("agent-a")),
    getAgentsByTaskId: vi.fn().mockResolvedValue([]),
    startHeartbeatRun: vi.fn().mockResolvedValue(run),
    // `completeRun` persists through saveRun and the caller re-reads via getRunDetail, so the fake
    // must land the written fields on the same object getRunDetail returns — otherwise a completed
    // run's resultJson is invisible to the assertions below.
    saveRun: vi.fn(async (written: AgentHeartbeatRun) => {
      Object.assign(run, written);
      return run;
    }),
    getRunDetail: vi.fn().mockResolvedValue(run),
    endHeartbeatRun: vi.fn(),
    updateAgentState: vi.fn(),
    updateAgent: vi.fn(),
    assignTask: vi.fn(),
    recordHeartbeat: vi.fn(),
    getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
    getCachedAgent: vi.fn().mockReturnValue(null),
    getLastBlockedState: vi.fn().mockResolvedValue(null),
    setLastBlockedState: vi.fn(),
    clearLastBlockedState: vi.fn(),
    appendRunLog: vi.fn(),
    getAgentsByReportsTo: vi.fn().mockResolvedValue([]),
    getRecentRuns: vi.fn().mockResolvedValue([]),
    getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as AgentStore;
}

function createTaskStore(overrides: Record<string, unknown> = {}): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    getTask: vi.fn().mockResolvedValue(taskFixture()),
    getTasksByAssignedAgent: vi.fn().mockResolvedValue([]),
    listTasks: vi.fn().mockResolvedValue([]),
    selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
    moveTask: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: WF, stepIds: [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: WF, stepIds: [] })),
    getWorkflowDefinition: vi.fn(async () => ({ ir: handoffIr() })),
    ...overrides,
  } as unknown as TaskStore;
}

/** Drain every pending microtask/macrotask without a real time wait (no timer sleep in tests). */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("heartbeat acquisition awaits the task disposal barrier", () => {
  let store: AgentStore;
  let taskStore: TaskStore;
  let monitor: HeartbeatMonitor;
  let acquireSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetTaskDisposalBarrierForTests();
    vi.clearAllMocks();
    store = createAgentStore();
    taskStore = createTaskStore();
    monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    acquireSpy = vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockImplementation(
      async () => ({ mode: "new", worktreePath: "/wt/FN-1", refreshedBase: "abcdef" }) as never,
    );
    sessionFactory.createResolvedAgentSession.mockImplementation(async () => ({
      session: {
        prompt: vi.fn(async () => {}),
        dispose: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTaskDisposalBarrierForTests();
  });

  it("acquires only after the pending teardown resolves, in that strict order", async () => {
    const order: string[] = [];
    acquireSpy.mockImplementation(async () => {
      order.push("acquire");
      return { mode: "new", worktreePath: "/wt/FN-1", refreshedBase: "abcdef" } as never;
    });
    let releaseTeardown!: () => void;
    const teardown = new Promise<void>((resolve) => {
      releaseTeardown = resolve;
    }).then(() => {
      order.push("teardown-resolved");
    });
    // This is what the lifecycle listener publishes when a transfer aborts a live session.
    registerTaskDisposal("FN-1", teardown);
    expect(hasTaskDisposalBarrier("FN-1")).toBe(true);

    const wake = monitor.executeHeartbeat({ agentId: "agent-a", source: "assignment", taskId: "FN-1" });
    let settled = false;
    void wake.then(() => {
      settled = true;
    });

    /*
     * Drain generously instead of polling on time: the wake needs a bounded number of microtask
     * hops to reach the acquisition seam, so a fixed drain is deterministic and cannot flake on a
     * slow machine. While the teardown is pending the wake must be parked — no acquisition, and the
     * run must not settle. A heartbeat that ignores the barrier reaches acquisition here and fails.
     */
    for (let i = 0; i < 60; i++) await settle();

    expect(acquireSpy).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    expect(store.endHeartbeatRun).not.toHaveBeenCalled();

    releaseTeardown();
    await wake;

    expect(order).toEqual(["teardown-resolved", "acquire"]);
    expect(acquireSpy).toHaveBeenCalledTimes(1);
  });

  it("neither stalls nor skips the wake when the disposal has no live session", async () => {
    // A transfer with nothing to abort publishes an already-settled teardown. The wake must flow.
    registerTaskDisposal("FN-1", Promise.resolve());

    await monitor.executeHeartbeat({ agentId: "agent-a", source: "assignment", taskId: "FN-1" });

    expect(acquireSpy).toHaveBeenCalledTimes(1);
    const completedRuns = (store.endHeartbeatRun as ReturnType<typeof vi.fn>).mock.calls;
    expect(completedRuns.length).toBeGreaterThan(0);
    expect(completedRuns[0][0].status).not.toBe("failed");
  });

  it("drops the assignment wake when the owner changed while the barrier was held", async () => {
    let releaseTeardown!: () => void;
    registerTaskDisposal("FN-1", new Promise<void>((resolve) => {
      releaseTeardown = resolve;
    }));

    const wake = monitor.executeHeartbeat({ agentId: "agent-a", source: "assignment", taskId: "FN-1" });
    for (let i = 0; i < 60; i++) await settle();

    // The transfer lands while the wake is still waiting on the teardown: the card now belongs to
    // agent-b, so the goal this wake is carrying is stale.
    (taskStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      taskFixture({ assignedAgentId: "agent-b" }),
    );
    releaseTeardown();

    const run = await wake;

    expect(acquireSpy).not.toHaveBeenCalled();
    expect(sessionFactory.createResolvedAgentSession).not.toHaveBeenCalled();
    expect(taskStore.moveTask).not.toHaveBeenCalled();
    expect(run.resultJson).toMatchObject({ reason: "wake_superseded", detail: "assignee-transferred" });
  });

  it("drops the assignment wake when the card left the executable lane while the barrier was held", async () => {
    let releaseTeardown!: () => void;
    registerTaskDisposal("FN-1", new Promise<void>((resolve) => {
      releaseTeardown = resolve;
    }));

    const wake = monitor.executeHeartbeat({ agentId: "agent-a", source: "assignment", taskId: "FN-1" });
    for (let i = 0; i < 60; i++) await settle();

    // Still owned by agent-a, but the card has been promoted into the review lane while the wake
    // waited: its assignee cannot execute from there, so the wake carries a stale goal.
    (taskStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      taskFixture({ column: "assessing" }),
    );
    releaseTeardown();

    const run = await wake;

    expect(acquireSpy).not.toHaveBeenCalled();
    expect(sessionFactory.createResolvedAgentSession).not.toHaveBeenCalled();
    expect(taskStore.moveTask).not.toHaveBeenCalled();
    expect(run.resultJson).toMatchObject({ reason: "wake_superseded", detail: "lane-not-executable" });
  });

  it("proceeds with the correct goal and worktree when the assignee still matches", async () => {
    registerTaskDisposal("FN-1", Promise.resolve());

    await monitor.executeHeartbeat({ agentId: "agent-a", source: "assignment", taskId: "FN-1" });

    expect(acquireSpy).toHaveBeenCalledTimes(1);
    const sessionParams = sessionFactory.createResolvedAgentSession.mock.calls[0]
      [0] as { cwd?: string };
    expect(sessionParams.cwd).toBe("/wt/FN-1");
    const promptText = sessionFactory.promptWithFallback.mock.calls[0][1] as string;
    expect(promptText).toContain("FN-1");
  });

  it("does not apply the ownership guard to a review-dispatch wake (reviewer is not the assignee)", async () => {
    // Scheduling/review-dispatch-sweep.ts wakes the bound reviewer with source "automation" for a
    // card it is NOT assigned to. The RUFU-260 guard must key on wake provenance, never on the
    // bare presence of a task id, or every code-review dispatch would be silently dropped.
    (taskStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      taskFixture({ assignedAgentId: "agent-a", column: "assessing" }),
    );
    (store.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(agentFixture("reviewer-1"));

    await monitor.executeHeartbeat({ agentId: "reviewer-1", source: "automation", taskId: "FN-1" });

    expect(acquireSpy).toHaveBeenCalledTimes(1);
  });
});

describe("assignment wake provenance stays bound to the card owner", () => {
  type SchedulerStore = EventEmitter & {
    getAgent: ReturnType<typeof vi.fn>;
    getActiveHeartbeatRun: ReturnType<typeof vi.fn>;
    getBudgetStatus: ReturnType<typeof vi.fn>;
    getRecentRuns: ReturnType<typeof vi.fn>;
    listAgents: ReturnType<typeof vi.fn>;
  };
  type SchedulerTaskStore = EventEmitter & {
    getTask: ReturnType<typeof vi.fn>;
    getSettings: ReturnType<typeof vi.fn>;
  };

  let schedulerStore: SchedulerStore;
  let schedulerTaskStore: SchedulerTaskStore;
  let callback: ReturnType<typeof vi.fn>;
  let scheduler: HeartbeatTriggerScheduler | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    callback = vi.fn().mockResolvedValue(undefined);
    schedulerStore = Object.assign(new EventEmitter(), {
      getAgent: vi.fn().mockResolvedValue(agentFixture("agent-a", { taskId: undefined })),
      getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
      getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
      getRecentRuns: vi.fn().mockResolvedValue([]),
      listAgents: vi.fn().mockResolvedValue([]),
    }) as unknown as SchedulerStore;
    schedulerTaskStore = Object.assign(new EventEmitter(), {
      getTask: vi.fn().mockResolvedValue(taskFixture()),
      getSettings: vi.fn().mockResolvedValue({}),
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: WF, stepIds: [] })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: WF, stepIds: [] })),
      getWorkflowDefinition: vi.fn(async () => ({ ir: handoffIr() })),
    }) as unknown as SchedulerTaskStore;
  });

  afterEach(() => {
    scheduler?.stop();
    vi.useRealTimers();
  });

  const startScheduler = () => {
    scheduler = new HeartbeatTriggerScheduler(
      schedulerStore as unknown as AgentStore,
      callback,
      schedulerTaskStore as unknown as TaskStore,
    );
    scheduler.start();
  };

  const emitTransfer = (event: TaskAssigneeChangedEvent) => {
    (schedulerTaskStore as unknown as EventEmitter).emit("task:assignee-changed", event);
  };

  /** Park an assignment wake by making the agent busy, then free it for the drain. */
  async function parkDeferredWake(taskId: string, agentId = "agent-a"): Promise<void> {
    (schedulerStore.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "run-live" });
    (schedulerStore as unknown as EventEmitter).emit("agent:assigned", agentFixture(agentId), taskId);
    await vi.advanceTimersByTimeAsync(10);
    // The wake must have been deferred, not fired.
    expect(callback).not.toHaveBeenCalled();
    (schedulerStore.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  }

  it("prunes a deferred wake when the card is transferred away and never re-fires the old task id", async () => {
    startScheduler();
    await parkDeferredWake("FN-1");

    // `task:assignee-changed` fires AFTER the write, so the row already names the new owner.
    (schedulerStore.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(agentFixture("agent-b"));
    (schedulerTaskStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      taskFixture({ assignedAgentId: "agent-b" }),
    );
    emitTransfer({ taskId: "FN-1", previousOwnerId: "agent-a", newOwnerId: "agent-b" });
    await vi.advanceTimersByTimeAsync(10);

    // Drain on the next completion-driven edge: the stale goal must be gone, not re-fired.
    await scheduler!.drainPendingAssignment("agent-a");

    // The previous owner is never woken for a card it no longer owns. (The NEW owner's wake is
    // asserted by its own case below; asserting `not.toHaveBeenCalled()` here would hide it.)
    expect(callback.mock.calls.filter((call) => call[0] === "agent-a")).toEqual([]);
  });

  it("drops a deferred wake at drain time when the card no longer belongs to the agent", async () => {
    // No transfer event observed: the drain must re-read the card itself.
    startScheduler();
    await parkDeferredWake("FN-1");
    (schedulerTaskStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      taskFixture({ assignedAgentId: "agent-b" }),
    );

    await scheduler!.drainPendingAssignment("agent-a");

    expect(callback).not.toHaveBeenCalled();
  });

  it("drops a deferred wake at drain time when the card moved into the review lane", async () => {
    startScheduler();
    await parkDeferredWake("FN-1");
    (schedulerTaskStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      taskFixture({ column: "assessing" }),
    );

    await scheduler!.drainPendingAssignment("agent-a");

    expect(callback).not.toHaveBeenCalled();
  });

  it("keeps a deferred wake whose card is still owned and in the executable lane", async () => {
    startScheduler();
    await parkDeferredWake("FN-1");

    await scheduler!.drainPendingAssignment("agent-a");

    expect(callback).toHaveBeenCalledWith("agent-a", "assignment", expect.objectContaining({
      taskId: "FN-1",
      wakeReason: "assignment",
    }));
  });

  it("wakes the new owner through the assignment trigger when the transferred card is executable", async () => {
    startScheduler();
    (schedulerStore.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(agentFixture("agent-b"));
    (schedulerTaskStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      taskFixture({ assignedAgentId: "agent-b" }),
    );

    emitTransfer({ taskId: "FN-1", previousOwnerId: "agent-a", newOwnerId: "agent-b" });
    await vi.advanceTimersByTimeAsync(10);

    expect(callback).toHaveBeenCalledWith("agent-b", "assignment", expect.objectContaining({
      taskId: "FN-1",
      wakeReason: "assignment",
    }));
  });

  it("does not wake the new owner when the card is outside the executable lane", async () => {
    startScheduler();
    (schedulerStore.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(agentFixture("agent-b"));
    (schedulerTaskStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      taskFixture({ assignedAgentId: "agent-b", column: "assessing" }),
    );

    emitTransfer({ taskId: "FN-1", previousOwnerId: "agent-a", newOwnerId: "agent-b" });
    await vi.advanceTimersByTimeAsync(10);

    expect(callback).not.toHaveBeenCalled();
  });

  it("does not wake anyone when the transfer clears the assignee", async () => {
    startScheduler();

    emitTransfer({ taskId: "FN-1", previousOwnerId: "agent-a", newOwnerId: undefined });
    await vi.advanceTimersByTimeAsync(10);

    expect(callback).not.toHaveBeenCalled();
  });
});
