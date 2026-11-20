/*
FNXC:HeartbeatTerminalBoundary 2026-11-20-01:10 (RUFU-783):

ONE MEASURED DEFECT, TWO SURFACES THAT LIE ABOUT IT.

A heartbeat run that finished its work and recorded its closing `fn_heartbeat_done` line stayed
`status: "active"` in the run registry, and its agent stayed `state: "running"`, for the rest of the
lane's cadence. The only reclaim that closed such a run — `maybeReapStaleActiveRun`
(`reason=orphaned-run-reaped`) and `reconcileOrphanedRunningAgents` — is evaluated on the cadence and
poll paths, so the reclaim arrived once per hour for a lane whose work had ended 2.5 minutes in.

Measured first-hand on `agent-3ac88b82` (Audit Executor, declared cadence 3 600 000 ms) on
2026-10-24: run log `run-5ab79792` holds 54 lines, the last one being `type=tool text=fn_heartbeat_done`
(work complete), while the daemon logged `reason=orphaned-run-reaped ... elapsedMs=1502675` and again at
`elapsedMs=3600565` against `thresholdMs=120000 source=timer`, followed by
`Reconciled orphaned running agent agent-3ac88b82 → active (no active run)` — the settle the engine
already knows how to do, performed once per cadence. Meanwhile the Reports Health table rendered
`| Audit Executor | running | — | 3m ago | **stuck** |` and told the manager agent to open an
investigation task for a lane that was healthy and idle.

Root cause is a lifecycle boundary in the wrong place, not a threshold: `completeRun` is reached only
after the awaited provider prompt settles, and after `stopHeartbeatSession()` aborts a session that
never settles, everything downstream of that await — the acknowledgement, the terminal `saveRun`,
`clearRunState`, and the `running → active` transition — is unreachable. This suite pins the boundary
where it belongs: an ACCEPTED `fn_heartbeat_done` closes the run and settles the agent immediately, and
the cadence sweeps are demoted to a crash backstop.

Deliberately excluded from this card's shape (sibling defects with their own cards): RUFU-524's
undisposed session calling `fn_heartbeat_done` twice under one runId (exercised here only for the
one-closure guarantee), RUFU-716's suppressed-delivery frozen `lastHeartbeatAt` (false `stale`),
RUFU-416's runs never being created, and RUFU-616's `workflow_work_items` running rows.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_VALID_TRANSITIONS } from "@fusion/core";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import { createBudgetStatus } from "./heartbeat-test-helpers.js";
import type { Agent, AgentHeartbeatRun, AgentStore, MessageStore, TaskStore } from "@fusion/core";

vi.mock("../logger.js", async () => {
  const { formatMockError } = await import("./heartbeat-test-helpers.js");
  const quietLogger = () => ({
    log: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
  return {
    createLogger: vi.fn(() => quietLogger()),
    heartbeatLog: quietLogger(),
    formatError: formatMockError,
  };
});
vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session: any, prompt: string) => {
    await session.prompt(prompt);
  }),
}));
vi.mock("../worktree/worktree-acquisition.js", () => ({ acquireTaskWorktree: vi.fn() }));

import { createFnAgent } from "../pi.js";
import { acquireTaskWorktree } from "../worktree/worktree-acquisition.js";

const mockedCreateFnAgent = vi.mocked(createFnAgent);
const mockedAcquireTaskWorktree = vi.mocked(acquireTaskWorktree);

const AGENT_ID = "agent-done-boundary-1";
/** The reported lane's declared cadence: reclaim decisions must not be able to lean on this. */
const CADENCE_MS = 3_600_000;
/** The monitor default (`heartbeatTimeoutMs ?? 60000`), used explicitly so the arithmetic is visible. */
const TIMEOUT_MS = 60_000;

/**
 * The reported lane: an identity-bearing, unassigned durable agent on a one-hour cadence. `taskId` is
 * absent on purpose — the shape that produced the false `**stuck**` badge is the no-task identity lane,
 * which has no parked-assignment path to hide behind.
 */
function noTaskAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    name: "Audit Executor",
    role: "custom",
    state: "active",
    taskId: undefined,
    soul: "Watch the board and report what changed.",
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
    metadata: {},
    runtimeConfig: { heartbeatIntervalMs: CADENCE_MS, heartbeatTimeoutMs: TIMEOUT_MS },
    ...overrides,
  } as unknown as Agent;
}

function mockSession() {
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(),
    model: { provider: "mock", id: "mock-model" },
  };
}

interface Harness {
  agent: Agent;
  store: AgentStore;
  monitor: HeartbeatMonitor;
  session: ReturnType<typeof mockSession>;
  /** Every persisted run row, newest write last, exactly as `saveRun` saw it. */
  savedRuns: AgentHeartbeatRun[];
  /** Heartbeat events recorded by the store fake, in order. */
  heartbeatEvents: Array<{ status: string; runId: string }>;
  /** Agent-state writes, in order — the surface the false `running` badge lives on. */
  stateTransitions: Array<{ from: string | undefined; to: string }>;
  /** The one run this harness started, by id. */
  runId: () => string;
  /** The single active run the registry would hand `getActiveHeartbeatRun`, or null. */
  activeRun: () => AgentHeartbeatRun | null;
  /** How many writes moved THIS run from non-terminal to terminal. */
  terminalWritesFor: (runId: string) => number;
  runOf: (runId: string) => AgentHeartbeatRun | undefined;
  /** Simulates the session calling an engine-offered tool mid-run, as pi really does. */
  invokeTool: (name: string, params?: Record<string, unknown>) => Promise<unknown>;
  /** Starts a run and does NOT await it: the reported session never settles after the abort. */
  startHangingRun: () => void;
}

/**
 * A store fake that behaves like the real `AgentStore` on exactly the three facts this card turns on:
 * a run row has a status that only moves to terminal through a write; `getActiveHeartbeatRun` reports
 * that row and nothing else; and a state write must be a transition the real table permits, so a fix
 * that "settles" the agent by an illegal route fails here instead of shipping.
 */
function createHarness(options: {
  /** True (default): the scripted session hangs after the done tool, the reported production shape. */
  hangAfterDone?: boolean;
  /** How many times the scripted session calls `fn_heartbeat_done` (RUFU-524 shape = 2). */
  doneCalls?: number;
  agent?: Agent;
} = {}): Harness {
  const hangAfterDone = options.hangAfterDone !== false;
  const doneCalls = options.doneCalls ?? 1;
  const agent = options.agent ?? noTaskAgent();

  const runs: AgentHeartbeatRun[] = [];
  const savedRuns: AgentHeartbeatRun[] = [];
  const heartbeatEvents: Array<{ status: string; runId: string }> = [];
  const stateTransitions: Array<{ from: string | undefined; to: string }> = [];
  let currentRunId = "";
  const offeredTools = new Map<string, { execute?: (id: string, params: never) => Promise<unknown> }>();

  const runOf = (runId: string) => [...runs].reverse().find((run) => run.id === runId);
  /*
  A closure is a write that moves the row from non-terminal to terminal. A later terminal -> terminal
  write is an enrichment (Step 3 makes `completeRun` enrich-only), so it must NOT count as a second
  closure — that is exactly the double-close the duplicate-done and enrich-only cases are about.
  */
  const isTerminal = (status: AgentHeartbeatRun["status"]) => status !== "active";
  const terminalWritesFor = (runId: string): number => {
    let closures = 0;
    let priorTerminal = false;
    for (const row of savedRuns.filter((run) => run.id === runId)) {
      if (isTerminal(row.status) && !priorTerminal) closures++;
      priorTerminal = isTerminal(row.status);
    }
    return closures;
  };

  mockedCreateFnAgent.mockImplementation(async (opts: {
    customTools?: Array<{ name: string; execute?: (id: string, params: never) => Promise<unknown> }>;
  }) => {
    offeredTools.clear();
    for (const tool of opts.customTools ?? []) offeredTools.set(tool.name, tool);
    return { session: session as never } as never;
  });

  const invokeTool = async (name: string, params: Record<string, unknown> = {}) => {
    const tool = offeredTools.get(name);
    if (!tool?.execute) throw new Error(`harness: the session was never offered ${name}`);
    return tool.execute(`tool-call-${name}`, params as never);
  };

  const session = mockSession();
  session.prompt.mockImplementation(async () => {
    for (let call = 0; call < doneCalls; call++) {
      await invokeTool("fn_heartbeat_done", { summary: `Round ${call + 1} complete.` });
    }
    if (!hangAfterDone) return undefined;
    /*
    The measured production shape: the run log's last line is the done row and nothing after it ever
    arrives. `stopHeartbeatSession()` aborts the session, and the awaited transport never settles, so
    every downstream write in `executeHeartbeat` is unreachable. This promise stands in for that.
    */
    return new Promise<void>(() => {});
  });

  const store = {
    getAgent: vi.fn(async () => agent),
    getCachedAgent: vi.fn().mockReturnValue(null),
    /*
    The orphan reconcile enumerates by state (`listAgents({ state: "running" })`), so the fake answers the
    same shape rather than the whole roster: a harness whose agent is not `running` has nothing to reconcile.
    */
    listAgents: vi.fn(async (filter?: { state?: string }) =>
      !filter?.state || filter.state === agent.state ? [agent] : []),
    assignTask: vi.fn(async () => agent),
    claimTaskForAgent: vi.fn(async () => ({ ok: false, reason: "task_not_found" })),
    handoffTaskToWorkflowExecutor: vi.fn(async () => ({ ok: true, task: { id: "RUFU-783" } })),
    startHeartbeatRun: vi.fn(async (_agentId: string, initialMetadata: Record<string, unknown> = {}) => {
      currentRunId = `run-${runs.length + 1}`;
      const run: AgentHeartbeatRun = {
        id: currentRunId,
        agentId: AGENT_ID,
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "active",
        processPid: process.pid,
        ...initialMetadata,
      } as AgentHeartbeatRun;
      runs.push(run);
      savedRuns.push({ ...run });
      heartbeatEvents.push({ status: "ok", runId: run.id });
      return { ...run };
    }),
    saveRun: vi.fn(async (run: AgentHeartbeatRun) => {
      runs.push({ ...run });
      savedRuns.push({ ...run });
    }),
    getRunDetail: vi.fn(async (_agentId: string, runId: string) => runOf(runId) ?? null),
    getActiveHeartbeatRun: vi.fn(async (_agentId: string) => runOf(currentRunId ?? "")?.status === "active"
      ? runOf(currentRunId ?? "") ?? null
      : null),
    getRecentRuns: vi.fn(async () => runs.filter((run) => run.id === currentRunId)),
    getCompletedHeartbeatRuns: vi.fn(async () => runs.filter((run) => run.status !== "active")),
    listActiveHeartbeatRuns: vi.fn(async () => runs.filter((run) => run.status === "active")),
    endHeartbeatRun: vi.fn(async (runId: string, status: "completed" | "terminated") => {
      const prior = runOf(runId);
      if (!prior) return;
      const next: AgentHeartbeatRun = { ...prior, status, endedAt: new Date().toISOString() };
      runs.push(next);
      savedRuns.push({ ...next });
      heartbeatEvents.push({ status: status === "terminated" ? "missed" : "ok", runId });
    }),
    recordHeartbeat: vi.fn(async (_agentId: string, status: string, runId?: string) => {
      heartbeatEvents.push({ status, runId: runId ?? currentRunId ?? "unknown" });
      if (status === "ok") agent.lastHeartbeatAt = new Date().toISOString();
      return { timestamp: new Date().toISOString(), status, runId: runId ?? "unknown" };
    }),
    updateAgentState: vi.fn(async (_agentId: string, next: string) => {
      const from = agent.state;
      /*
      Mirrors the real store: a same-state write is a no-op, not a transition. Without this the fake throws
      on `active -> active`, which the real store answers silently — and several honest fix designs settle a
      badge that is already correct.
      */
      if (from === next) return agent;
      const allowed = (AGENT_VALID_TRANSITIONS as Record<string, string[]>)[from];
      if (allowed && !allowed.includes(next)) {
        throw new Error(`Invalid state transition: ${from} -> ${next}. Valid transitions: ${allowed.join(", ")}`);
      }
      stateTransitions.push({ from, to: next });
      agent.state = next as Agent["state"];
      return agent;
    }),
    updateAgent: vi.fn(async (_agentId: string, updates: Record<string, unknown>) => {
      Object.assign(agent, updates);
      return agent;
    }),
    syncExecutionTaskLink: vi.fn(async () => agent),
    getBudgetStatus: vi.fn(async () => createBudgetStatus()),
    getLastBlockedState: vi.fn(async () => null),
    setLastBlockedState: vi.fn(async () => undefined),
    clearLastBlockedState: vi.fn(async () => undefined),
    getRatingSummary: vi.fn(async () => undefined),
    appendRunLog: vi.fn(async () => undefined),
    getAgentsByReportsTo: vi.fn(async () => []),
    listAgents: vi.fn(async () => [agent]),
  } as unknown as AgentStore;

  const messageStore = {
    setMessageToAgentHook: vi.fn(),
    getInbox: vi.fn(async () => []),
    getMailbox: vi.fn(async () => ({ unreadCount: 0, messages: [] })),
    markInboxAsRead: vi.fn(async () => []),
  } as unknown as MessageStore;

  const taskStore = {
    getTask: vi.fn(async () => null),
    getSettings: vi.fn(async () => ({})),
    listTasks: vi.fn(async () => []),
    getTasksByAssignedAgent: vi.fn(async () => []),
    selectNextTaskForAgent: vi.fn(async () => null),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    addComment: vi.fn(async () => ({})),
    getMissionStore: vi.fn().mockReturnValue(null),
    findRecentTasksBySourceParentTaskId: vi.fn(async () => []),
    createTask: vi.fn(async () => ({ id: "RUFU-784", description: "x", dependencies: [], column: "triage" })),
    upsertTaskDocument: vi.fn(async () => ({})),
    getTaskDocument: vi.fn(async () => null),
    listTaskDocuments: vi.fn(async () => []),
  } as unknown as TaskStore;

  const monitor = new HeartbeatMonitor({
    store,
    messageStore,
    taskStore,
    rootDir: "/tmp",
    heartbeatTimeoutMs: TIMEOUT_MS,
  });

  const startHangingRun = (): void => {
    // The reported session never settles after the abort, so the caller must NOT await the run to
    // observe what the accepted done boundary owed the registry. Awaiting here would hang the suite.
    void monitor.executeHeartbeat({ agentId: AGENT_ID, source: "timer" }).catch(() => undefined);
  };

  return {
    agent,
    store,
    monitor,
    session,
    savedRuns,
    heartbeatEvents,
    stateTransitions,
    runId: () => currentRunId,
    activeRun: () => (runOf(currentRunId)?.status === "active" ? runOf(currentRunId) ?? null : null),
    terminalWritesFor,
    runOf,
    invokeTool,
    startHangingRun,
  };
}

/**
 * Drains the boundary's persistence chain under fake timers.
 *
 * Polling for the observable outcome, not a fixed number of microtask hops: the chain length differs
 * between a single-test run and a whole-file run (lazy module loads inside `executeHeartbeat` add hops),
 * and a test that encodes a hop count is a flake that has not happened yet. Fake timers only — no real
 * waiting, and the bound is what fails the test rather than hanging it.
 */
async function flushUntil(predicate: () => boolean, maxRounds = 60): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    if (predicate()) return;
    await vi.advanceTimersByTimeAsync(10);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T01:56:08.923Z"));
  mockedCreateFnAgent.mockResolvedValue({ session: mockSession() as never } as never);
  mockedAcquireTaskWorktree.mockResolvedValue({
    worktreePath: "/tmp/wt",
    branch: "fusion/rufu-783",
    source: "existing",
    hydrated: false,
    isResume: true,
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("an accepted fn_heartbeat_done closes the run immediately", () => {
  it("AC1: leaves no active registry row, with the run closed completed and the ack persisted", async () => {
    const h = createHarness();
    h.startHangingRun();
    await flushUntil(() => h.savedRuns.some((row) => row.status !== "active"));

    const runId = h.runId();
    expect(runId).not.toBe("");
    const run = h.runOf(runId)!;

    // (a) the registry no longer claims a run is in flight, and the row reached a terminal COMPLETED.
    await expect(h.store.getActiveHeartbeatRun(AGENT_ID)).resolves.toBeNull();
    expect(run.status).toBe("completed");
    expect(run.endedAt).not.toBeNull();
    // The ack is on the row now, not only after a prompt that may never settle.
    expect(run.resultJson).toMatchObject({ heartbeatDoneAccepted: true });
  });

  it("AC2: settles the agent out of running and records no missed heartbeat for the run", async () => {
    const h = createHarness();
    h.startHangingRun();
    await flushUntil(() => h.savedRuns.some((row) => row.status !== "active"));

    // (b) the persisted agent state is no longer `running`...
    expect(h.agent.state).not.toBe("running");
    // ...and the closure is an OK heartbeat, not the `missed` a `terminated` close would write.
    const runId = h.runId();
    expect(h.heartbeatEvents.filter((event) => event.runId === runId && event.status === "missed")).toEqual([]);
    expect(h.heartbeatEvents.filter((event) => event.runId === runId && event.status === "ok").length)
      .toBeGreaterThanOrEqual(1);
    expect(h.terminalWritesFor(runId)).toBe(1);
  });

  it("closes exactly once when the session calls fn_heartbeat_done twice under one runId (RUFU-524 shape)", async () => {
    const h = createHarness({ doneCalls: 2 });
    h.startHangingRun();
    await flushUntil(() => h.savedRuns.some((row) => row.status !== "active"));

    const runId = h.runId();
    expect(h.terminalWritesFor(runId)).toBe(1);
    expect(h.runOf(runId)!.status).toBe("completed");
    expect(h.heartbeatEvents.filter((event) => event.runId === runId && event.status === "missed")).toEqual([]);
  });

  it("records the acknowledgement first, additively, while the row it describes is still active", async () => {
    const h = createHarness();
    h.startHangingRun();
    await flushUntil(() => h.savedRuns.some((row) => row.status !== "active"));

    const runId = h.runId();
    /*
    Ordering is the contract, not a detail: the reclaim and the health classifier both read the accepted
    done as their positive evidence, so the ack has to be on the row BEFORE anything makes it terminal.
    The first persisted row carrying the ack is therefore still `active` even after the close landed.
    */
    const firstAcked = h.savedRuns.find((row) => row.id === runId
      && (row.resultJson as Record<string, unknown> | undefined)?.heartbeatDoneAccepted === true);
    expect(firstAcked?.status).toBe("active");

    const final = h.runOf(runId)!;
    expect(final.resultJson).toMatchObject({
      heartbeatDoneAccepted: true,
      heartbeatDoneAt: expect.any(String),
      summary: "Round 1 complete.",
    });
  });

  it("settles the same run for a session that does settle, without double-closing it", async () => {
    const h = createHarness({ hangAfterDone: false });

    const run = await h.monitor.executeHeartbeat({ agentId: AGENT_ID, source: "timer" });

    expect(run.status).toBe("completed");
    expect(h.terminalWritesFor(run.id)).toBe(1);
    expect(h.agent.state).not.toBe("running");
    expect(h.heartbeatEvents.filter((event) => event.runId === run.id && event.status === "missed")).toEqual([]);
  });

  /*
  FNXC:HeartbeatTerminalBoundary 2026-11-20-02:05 (RUFU-783):
  The second reclaim, and the one the report actually came through: the sweep that settles persisted
  `running` rows. Its untracked-run branch charged a work budget (`heartbeatTimeoutMs x 3`) before touching
  the row, so an accepted done still had to age out; and when it did act, it closed the run `terminated`,
  which records a `missed` heartbeat — trading the false `running` badge for a false missed beat. Below the
  180s budget here, the only thing that may close this row is the evidence on it.
  */
  it("reconciles a done-claimed running lane as completed, below any work budget, with no missed beat", async () => {
    const agent = noTaskAgent({ state: "running", lastHeartbeatAt: new Date().toISOString() });
    const h = createHarness({ agent });

    await h.store.startHeartbeatRun(AGENT_ID, {});
    const runId = h.runId();
    await h.store.saveRun({ ...h.runOf(runId)!, resultJson: {
      heartbeatDoneAccepted: true,
      heartbeatDoneAt: new Date().toISOString(),
      summary: "Round 1 complete.",
    } } as AgentHeartbeatRun);

    await (h.monitor as unknown as { reconcileOrphanedRunningAgents: () => Promise<void> })
      .reconcileOrphanedRunningAgents();

    expect(h.store.endHeartbeatRun).toHaveBeenCalledWith(runId, "completed");
    expect(h.store.endHeartbeatRun).not.toHaveBeenCalledWith(runId, "terminated");
    expect(h.agent.state).toBe("active");
    expect(h.heartbeatEvents.filter((event) => event.runId === runId && event.status === "missed")).toEqual([]);
  });
});
