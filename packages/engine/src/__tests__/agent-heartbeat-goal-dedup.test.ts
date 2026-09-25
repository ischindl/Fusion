/*
FNXC:AssigneeTransferAtomicity 2026-09-21-22:45 (RUFU-260 Step 5) — written against the current
implementation and observed FAILING first.

RUFU-251 fan-out produced two live sessions for ONE (agent, goal): `withAgentStartLock` serializes
run starts, so the queued second wake did not race the first — it ran immediately after it and
`startRun` then TERMINATED the still-relevant active run as "previous run was stale" before opening
a fresh one on the same card. One goal, two sessions, one killed. The guard therefore has to dedupe
by GOAL (agent + bound task id), not by agent, and it has to decide BEFORE the run opens, because
opening is the act that destroys the run being deduped against.

The exclusions are load-bearing, not decoration. A review-dispatch wake (`source: "automation"`) is
the review lane's recovery path: its stalled-attempt buckets deliberately re-dispatch a card whose
previous dispatch never produced work, so a database row that merely looks active (a zombie from a
dead process) must never swallow it. An idle/no-task wake has no goal at all and must never be
swallowed either. And a deduped wake must not be mistaken for a disposal-barrier release — the two
waits are orthogonal mechanisms over the same card.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Agent, AgentHeartbeatRun, AgentStore, TaskStore, WorkflowIr } from "@fusion/core";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
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
 * `createResolvedAgentSession` is the seam that actually receives the acquired worktree, so counting
 * its calls counts real sessions. Mocking it (rather than `pi.js`) keeps the run off the provider
 * stack while still proving a second session was never opened.
 */
vi.mock("../agents/agent-session-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-session-helpers.js")>()),
  createResolvedAgentSession: sessionFactory.createResolvedAgentSession,
}));

vi.mock("../pi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pi.js")>()),
  promptWithFallback: sessionFactory.promptWithFallback,
}));

const WF = "custom:dedup";

/** Distinctly named lanes: the executable lane is `building`, so no literal "in-progress" may work. */
function dedupIr(): WorkflowIr {
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
  title: "Goal card",
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

/**
 * The run-row fake keeps one live row per agent and mirrors `startRun`'s real persistence shape:
 * `contextSnapshot.taskId` is where the bound goal is recorded, which is what a wake arriving from
 * another entry point has to compare against.
 */
function createAgentStore(overrides: Record<string, unknown> = {}): AgentStore {
  const live: { run?: AgentHeartbeatRun } = {};
  const newRun = (): AgentHeartbeatRun => ({
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "agent-a",
    status: "active",
    startedAt: new Date().toISOString(),
    endedAt: null,
  } as unknown as AgentHeartbeatRun);
  return {
    getAgent: vi.fn().mockResolvedValue(agentFixture("agent-a")),
    getAgentsByTaskId: vi.fn().mockResolvedValue([]),
    startHeartbeatRun: vi.fn(async () => {
      live.run = newRun();
      return live.run;
    }),
    saveRun: vi.fn(async (written: AgentHeartbeatRun) => {
      if (live.run) Object.assign(live.run, written);
      else live.run = written;
      return live.run;
    }),
    getRunDetail: vi.fn(async () => live.run),
    // A real store keeps the completed row readable; only `getActiveHeartbeatRun` hides it.
    endHeartbeatRun: vi.fn(async () => {
      if (live.run) {
        live.run = { ...live.run, endedAt: new Date().toISOString(), status: "completed" } as AgentHeartbeatRun;
      }
    }),
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
    getActiveHeartbeatRun: vi.fn(async () => (live.run && !live.run.endedAt ? live.run : null)),
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
    getWorkflowDefinition: vi.fn(async () => ({ ir: dedupIr() })),
    // The TaskStore is the run-audit sink (the AgentStore has no audit surface).
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as TaskStore;
}

/** Every audit row whose event name marks a heartbeat wake dedupe, read from the TaskStore sink. */
function dedupAuditRows(taskStore: TaskStore): Array<{ mutationType: string; metadata: Record<string, unknown> }> {
  const recorder = (taskStore as unknown as { recordRunAuditEvent: { mock: { calls: unknown[][] } } }).recordRunAuditEvent;
  const rows = recorder.mock.calls.map((call) => call[0] as { mutationType: string; metadata: Record<string, unknown> });
  return rows.filter((row) => String(row?.mutationType ?? "").includes("dedup"));
}

/** Drain pending micro/macrotasks without a real time wait (no sleeps in these tests). */
const settle = async (ticks = 3): Promise<void> => {
  for (let i = 0; i < ticks; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Gate the session prompt so a wake can be held in flight deterministically. */
function gatedPrompt() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prompt = vi.fn(async () => {
    await gate;
    return { messages: [] };
  });
  return { prompt, release };
}

function armSession(prompt: ReturnType<typeof gatedPrompt>["prompt"]) {
  sessionFactory.createResolvedAgentSession.mockImplementation(async () => ({
    session: {
      agent: {},
      subscribe: () => () => {},
      prompt,
      dispose: vi.fn(),
    },
  }));
}

describe("one in-flight heartbeat session per (agent, goal)", () => {
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
    acquireSpy = vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockResolvedValue({
      mode: "new",
      worktreePath: "/wt/FN-1",
    } as never);
    const { prompt, release } = gatedPrompt();
    release();
    armSession(prompt);
  });

  afterEach(() => {
    resetTaskDisposalBarrierForTests();
    vi.restoreAllMocks();
  });

  it("opens exactly one session for two wakes bound to the same card and returns the in-flight run", async () => {
    const { prompt, release } = gatedPrompt();
    armSession(prompt);
    sessionFactory.createResolvedAgentSession.mockImplementation(async () => {
      return {
        session: { agent: {}, subscribe: () => () => {}, prompt, dispose: vi.fn() },
      } as never;
    });

    const first = monitor.executeHeartbeat({
      agentId: "agent-a",
      source: "assignment",
      triggerDetail: "task-assigned",
      taskId: "FN-1",
    });
    await settle(1);
    // The first wake owns the goal; the second arrives while that session is still in flight.
    const second = monitor.executeHeartbeat({
      agentId: "agent-a",
      source: "assignment",
      triggerDetail: "task-assigned",
      taskId: "FN-1",
    });
    await settle(2);

    release();
    const [firstRun, secondRun] = await Promise.all([first, second]);

    expect(sessionFactory.createResolvedAgentSession).toHaveBeenCalledTimes(1);
    expect(secondRun.id).toBe(firstRun.id);
    // The deduped wake must never reach acquisition for the goal it did not take.
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect((store as any).endHeartbeatRun).toHaveBeenCalledTimes(1);
  });

  it("does not swallow a second wake bound to a different card", async () => {
    const { prompt, release } = gatedPrompt();
    armSession(prompt);
    taskStore.getTask = vi.fn(async (id: string) =>
      taskFixture({ id, assignedAgentId: "agent-a", worktree: `/wt/${id}` })) as never;

    const first = monitor.executeHeartbeat({
      agentId: "agent-a",
      source: "assignment",
      triggerDetail: "task-assigned",
      taskId: "FN-1",
    });
    await settle(1);
    const second = monitor.executeHeartbeat({
      agentId: "agent-a",
      source: "assignment",
      triggerDetail: "task-assigned",
      taskId: "FN-2",
    });
    await settle(2);

    release();
    const [firstRun, secondRun] = await Promise.all([first, second]);

    expect(sessionFactory.createResolvedAgentSession).toHaveBeenCalledTimes(2);
    expect(secondRun.id).not.toBe(firstRun.id);
    expect(dedupAuditRows(taskStore)).toHaveLength(0);
  });

  it("does not swallow an idle no-task wake while a task-bound wake is in flight", async () => {
    const { prompt, release } = gatedPrompt();
    armSession(prompt);
    // An idle agent has no bound goal, so the guard has nothing to dedupe against.
    (store.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(agentFixture("agent-a", { taskId: null }));

    const taskWake = monitor.executeHeartbeat({
      agentId: "agent-a",
      source: "assignment",
      triggerDetail: "task-assigned",
      taskId: "FN-1",
    });
    await settle(1);
    const idleWake = monitor.executeHeartbeat({
      agentId: "agent-a",
      source: "timer",
      triggerDetail: "scheduler",
    });
    await settle(2);

    release();
    const [taskRun, idleRun] = await Promise.all([taskWake, idleWake]);

    // A wake with no goal has nothing to dedupe against: it opens its own run (and takes its own
    // no-assignment exit) instead of being handed the in-flight task session's identity.
    expect(idleRun.id).not.toBe(taskRun.id);
    expect((store as any).startHeartbeatRun).toHaveBeenCalledTimes(2);
    expect(dedupAuditRows(taskStore)).toHaveLength(0);
    expect(acquireSpy).toHaveBeenCalledTimes(1);
  });

  it("never swallows a review-dispatch automation wake, even when a row looks active on that card", async () => {
    const { prompt, release } = gatedPrompt();
    armSession(prompt);
    // Another entry point's zombie: a live run row bound to the very card the sweep re-dispatches.
    (store.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "run-zombie",
      agentId: "agent-a",
      status: "active",
      contextSnapshot: { taskId: "FN-1" },
    });

    const dispatched = monitor.executeHeartbeat({
      agentId: "agent-a",
      source: "automation",
      triggerDetail: "review-lane dispatch sweep",
      taskId: "FN-1",
    });
    await settle(3);
    release();
    const run = await dispatched;

    expect(sessionFactory.createResolvedAgentSession).toHaveBeenCalledTimes(1);
    expect(run.id).not.toBe("run-zombie");
    expect(dedupAuditRows(taskStore)).toHaveLength(0);
  });

  it("dedupes a task-bound wake arriving from another entry point against the DB-backed active run", async () => {
    const { prompt, release } = gatedPrompt();
    armSession(prompt);
    const liveRun = {
      id: "run-other-entry",
      agentId: "agent-a",
      status: "active",
      endedAt: null,
      contextSnapshot: { taskId: "FN-1" },
    } as unknown as AgentHeartbeatRun;
    (store.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue(liveRun);
    (store.getRunDetail as ReturnType<typeof vi.fn>).mockResolvedValue(liveRun);

    const wake = monitor.executeHeartbeat({
      agentId: "agent-a",
      source: "assignment",
      triggerDetail: "task-assigned",
      taskId: "FN-1",
    });
    await settle(3);
    release();
    const run = await wake;

    expect(sessionFactory.createResolvedAgentSession).not.toHaveBeenCalled();
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(run.id).toBe("run-other-entry");
    // Deduping must not destroy the run it deduped against.
    expect((store as any).endHeartbeatRun).not.toHaveBeenCalled();
  });

  it("records the dedup as ids-and-outcome only", async () => {
    const { prompt, release } = gatedPrompt();
    armSession(prompt);
    const liveRun = {
      id: "run-live",
      agentId: "agent-a",
      status: "active",
      endedAt: null,
      contextSnapshot: { taskId: "FN-1" },
    } as unknown as AgentHeartbeatRun;
    (store.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue(liveRun);
    (store.getRunDetail as ReturnType<typeof vi.fn>).mockResolvedValue(liveRun);

    const wake = monitor.executeHeartbeat({
      agentId: "agent-a",
      source: "assignment",
      triggerDetail: "task-assigned",
      taskId: "FN-1",
    });
    await settle(3);
    release();
    await wake;

    const dedupRows = dedupAuditRows(taskStore);
    expect(dedupRows).toHaveLength(1);
    expect(dedupRows[0].metadata).toMatchObject({ outcome: "deduped", taskId: "FN-1", runId: "run-live" });
    // ids and the fixed outcome only — no agent name, trigger detail, or error prose.
    expect(Object.keys(dedupRows[0].metadata).sort()).toEqual(["outcome", "runId", "taskId"]);
  });

  it("dedupes from the monitor's own in-flight claim when the active-run lookup returns nothing", async () => {
    const { prompt, release } = gatedPrompt();
    armSession(prompt);
    // The durable index is not the only truth: the wake must still be refused when the session is
    // demonstrably running in this process and the run row is not (yet) visible to the query.
    (store.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const first = monitor.executeHeartbeat({
      agentId: "agent-a",
      source: "assignment",
      triggerDetail: "task-assigned",
      taskId: "FN-1",
    });
    await settle(1);
    const second = monitor.executeHeartbeat({
      agentId: "agent-a",
      source: "assignment",
      triggerDetail: "task-assigned",
      taskId: "FN-1",
    });
    await settle(2);
    release();
    const [firstRun, secondRun] = await Promise.all([first, second]);

    expect(sessionFactory.createResolvedAgentSession).toHaveBeenCalledTimes(1);
    expect(secondRun.id).toBe(firstRun.id);
    expect(dedupAuditRows(taskStore)).toHaveLength(1);
  });

  it("dedupes a wake whose goal comes from the async agent read (no sync cache)", async () => {
    // PostgreSQL-shaped: `getCachedAgent` returns null, so the bound card is only knowable from the
    // async agent read. The goal still has to be resolved before the lock, or the queued duplicate
    // cannot be inspected until the first session has already ended.
    const { prompt, release } = gatedPrompt();
    armSession(prompt);
    (store.getCachedAgent as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (store.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(
      agentFixture("agent-a", { taskId: "FN-1" }),
    );

    const first = monitor.executeHeartbeat({
      agentId: "agent-a",
      source: "timer",
      triggerDetail: "scheduler",
    });
    await settle(3);
    const second = monitor.executeHeartbeat({
      agentId: "agent-a",
      source: "timer",
      triggerDetail: "scheduler",
    });
    await settle(3);
    release();
    const [firstRun, secondRun] = await Promise.all([first, second]);

    expect(sessionFactory.createResolvedAgentSession).toHaveBeenCalledTimes(1);
    expect(secondRun.id).toBe(firstRun.id);
    expect(dedupAuditRows(taskStore)).toHaveLength(1);
  });

  it("still dedupes an automation wake whose session is genuinely running in this process", async () => {
    const { prompt, release } = gatedPrompt();
    armSession(prompt);
    (store.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const first = monitor.executeHeartbeat({
      agentId: "agent-a",
      source: "automation",
      triggerDetail: "review-lane dispatch sweep",
      taskId: "FN-1",
    });
    await settle(1);
    const second = monitor.executeHeartbeat({
      agentId: "agent-a",
      source: "automation",
      triggerDetail: "review-lane dispatch sweep",
      taskId: "FN-1",
    });
    await settle(2);
    release();
    const [firstRun, secondRun] = await Promise.all([first, second]);

    // The zombie exemption exists for a run row with no session behind it. With a live session, a
    // second dispatch would only interrupt the review the first one started.
    expect(sessionFactory.createResolvedAgentSession).toHaveBeenCalledTimes(1);
    expect(secondRun.id).toBe(firstRun.id);
  });

  it("releases the goal when the run ends, so a later wake for the same card runs again", async () => {
    const { prompt, release } = gatedPrompt();
    armSession(prompt);

    const started = monitor.executeHeartbeat({
      agentId: "agent-a",
      source: "assignment",
      triggerDetail: "task-assigned",
      taskId: "FN-1",
    });
    await settle(2);
    release();
    const first = await started;

    const second = await monitor.executeHeartbeat({
      agentId: "agent-a",
      source: "assignment",
      triggerDetail: "task-assigned",
      taskId: "FN-1",
    });

    expect(sessionFactory.createResolvedAgentSession).toHaveBeenCalledTimes(2);
    expect(second.id).not.toBe(first.id);
    expect(dedupAuditRows(taskStore)).toHaveLength(0);
  });

  it("keeps the dedup decision orthogonal from the disposal barrier", async () => {
    const { prompt, release } = gatedPrompt();
    armSession(prompt);
    // A teardown that never settles: a wake that reached the barrier would wait forever, so a
    // deduped wake returning proves the guard decided before (and without) any barrier wait.
    registerTaskDisposal("FN-1", new Promise<void>(() => {}));
    const liveRun = {
      id: "run-live",
      agentId: "agent-a",
      status: "active",
      endedAt: null,
      contextSnapshot: { taskId: "FN-1" },
    } as unknown as AgentHeartbeatRun;
    (store.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue(liveRun);
    (store.getRunDetail as ReturnType<typeof vi.fn>).mockResolvedValue(liveRun);

    const wake = monitor.executeHeartbeat({
      agentId: "agent-a",
      source: "assignment",
      triggerDetail: "task-assigned",
      taskId: "FN-1",
    });
    const raced = await Promise.race([
      wake.then((r) => r as AgentHeartbeatRun | undefined),
      settle(6).then(() => undefined as undefined),
    ]);
    release();

    expect(raced?.id).toBe("run-live");
    expect(hasTaskDisposalBarrier("FN-1")).toBe(true);
    expect(acquireSpy).not.toHaveBeenCalled();
  });
});
