import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Agent, AgentHeartbeatRun, AgentStore, TaskStore } from "@fusion/core";
import {
  describeHeartbeatThrottle,
  isHeartbeatThrottleCooldownActive,
  readHeartbeatRecoveryState,
  THROTTLE_BACKOFF_CAP_MS,
  THROTTLE_BACKOFF_FLOOR_MS,
} from "@fusion/core";
import { createBudgetStatus } from "./heartbeat-test-helpers.js";

vi.mock("../logger.js", async () => {
  const { createMockLogger, formatMockError } = await import("./heartbeat-test-helpers.js");
  return {
    createLogger: vi.fn(() => createMockLogger()),
    heartbeatLog: createMockLogger(),
    formatError: formatMockError,
  };
});

vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session: { prompt: (prompt: string) => Promise<void> }, prompt: string) => {
    await session.prompt(prompt);
  }),
}));

vi.mock("../agents/agent-session-helpers.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/agent-session-helpers.js")>("../agents/agent-session-helpers.js");
  const pi = await import("../pi.js");
  return {
    ...actual,
    createResolvedAgentSession: vi.fn(async () => ({
      session: await pi.createFnAgent(),
      sessionFile: undefined,
      runtimeId: "mock",
      wasConfigured: true,
    })),
  };
});

import { createFnAgent } from "../pi.js";
import {
  HEARTBEAT_ERROR_RECOVERY_METADATA_KEY,
  HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON,
  HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON,
  HeartbeatMonitor,
  armHeartbeatThrottleCooldown,
  buildHeartbeatErrorRecoveryMetadata,
  isErrorRecoveryEligible,
  isHeartbeatErrorRecoverable,
  readHeartbeatErrorRetryCount,
} from "../agent-heartbeat.js";

const mockedCreateFnAgent = vi.mocked(createFnAgent);

/*
 * RUFU-286 lifecycle fixtures. `THROTTLE_ENVELOPE` is verbatim from the incident card's log
 * (coordinator parked `paused` / `error-unrecoverable` after a 429 `rate_limit_error`); the quota
 * fixtures are the operator-actionable classes that share the `429` status code and MUST keep their
 * durable park. Fixtures are shared with the classifier tests in
 * `transient-error-detector.test.ts` — do not paraphrase them, the whole point is the exact envelope.
 */
const THROTTLE_ENVELOPE =
  'Unable to select a usable model after 1 attempt (primary unknown model, no fallback configured, trigger: prompt-time): 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}';

const ANTHROPIC_QUOTA_ENVELOPE =
  'Unable to select a usable model after 1 attempt (primary unknown model, no fallback configured, trigger: session-creation): 429 {"type":"error","error":{"type":"insufficient_quota","message":"Your account\'s budget has been exhausted. Please purchase more."},"request_id":"req_011Cf3Zq2k9PjUu2kH8s"}';

const OPENAI_QUOTA_ENVELOPE =
  '{"error":{"code":"insufficient_quota","type":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}';

/** Fixed clock for the pure-fixture helpers (`armHeartbeatThrottleCooldown(agent, NOW)`). */
const NOW = Date.parse("2026-09-30T12:00:00.000Z");

/*
FNXC:ProviderThrottleIsTransient 2026-09-30-17:05 (RUFU-286 code review P1):
Every lifecycle symptom in this file drives `monitor.executeHeartbeat`, never `startRun` +
`completeRun` by hand. The P0 lived ONLY on the production path: the recovery-gate budget write at
run entry is the one `heartbeatErrorRecovery` write that happens BETWEEN two probes, and a
hand-completed run skips it, so the suite stayed green while production pinned the wait at the 60 s
floor and burned the 5-unit budget in ~5 minutes of sustained throttling.

A throttle envelope is also `isUsageLimitError`, so the heartbeat's own `withRateLimitRetry` wrapper
sleeps 30 s / 60 s / 120 s and re-prompts three times before the failure reaches the classifier.
Waiting for the first mocked prompt guarantees that retry timer exists before the one deterministic
drain (the FN-8271 pattern in `heartbeat-error-recovery.test.ts`), and the drain is what lets the
probe finish instead of hanging on a sleep fake time would never fire. The drain advances the fake
clock by ~3.5 minutes per probe, so every horizon assertion below is RELATIVE to `Date.now()` at arm
time — an absolute ISO constant would assert the drain's jitter, not the backoff rung.
*/

/**
 * A session whose prompt always fails with `envelope`, plus a per-call synchronization signal.
 * `nextPrompt()` must be registered BEFORE the tick starts, so each `executeHeartbeat` waits on its
 * own first prompt rather than one already-resolved promise from an earlier tick.
 */
function envelopedSession(envelope: string) {
  const waiters: Array<() => void> = [];
  const session = createSession(async () => {
    waiters.shift()?.();
    throw new Error(envelope);
  });
  return {
    session,
    nextPrompt: (): Promise<void> => new Promise<void>((resolve) => { waiters.push(resolve); }),
  };
}

/** One full production heartbeat tick whose prompt fails: dispatch, in-run retries, failure path. */
async function failingHeartbeatTick(monitor: HeartbeatMonitor, agentId: string, nextPrompt: () => Promise<void>) {
  const firstPrompt = nextPrompt();
  const heartbeat = monitor.executeHeartbeat({ agentId, source: "timer" });
  await firstPrompt;
  await vi.runAllTimersAsync();
  return heartbeat;
}

const baseAgent = (patch: Partial<Agent> = {}): Agent => ({
  id: "agent-throttle",
  name: "Coordinator",
  role: "executor",
  state: "error",
  soul: "Keeps the fleet moving",
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
  metadata: {},
  runtimeConfig: { enabled: true },
  ...patch,
}) as Agent;

/** Task store fake that also captures every run-audit row verbatim for payload-shape assertions. */
function createNoTaskStore(settings: Record<string, unknown> = {}): TaskStore & { auditEvents: Array<Record<string, unknown>> } {
  const auditEvents: Array<Record<string, unknown>> = [];
  return {
    auditEvents,
    getSettings: vi.fn().mockResolvedValue(settings),
    selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
    listTasks: vi.fn().mockResolvedValue([]),
    getTaskDocuments: vi.fn().mockResolvedValue([]),
    recordRunAuditEvent: vi.fn(async (input: unknown) => {
      auditEvents.push(input as Record<string, unknown>);
    }),
  } as unknown as TaskStore & { auditEvents: Array<Record<string, unknown>> };
}

function createAgentStore(agent: Agent): AgentStore & { agent: Agent; runs: Map<string, AgentHeartbeatRun> } {
  let runSeq = 0;
  const runs = new Map<string, AgentHeartbeatRun>();
  const store = {
    agent,
    runs,
    recordHeartbeat: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn(async () => store.agent),
    getCachedAgent: vi.fn(() => store.agent),
    listAgents: vi.fn(async () => [store.agent]),
    on: vi.fn(),
    off: vi.fn(),
    updateAgentState: vi.fn(async (_agentId: string, state: Agent["state"]) => {
      store.agent = { ...store.agent, state };
      return store.agent;
    }),
    updateAgent: vi.fn(async (_agentId: string, updates: Partial<Agent>) => {
      store.agent = { ...store.agent, ...updates };
      return store.agent;
    }),
    getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
    startHeartbeatRun: vi.fn(async () => {
      runSeq += 1;
      const run = {
        id: `run-${runSeq}`,
        agentId: store.agent.id,
        source: "timer",
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "active",
      } as AgentHeartbeatRun;
      runs.set(run.id, run);
      return run;
    }),
    saveRun: vi.fn(async (run: AgentHeartbeatRun) => {
      runs.set(run.id, run);
    }),
    getRunDetail: vi.fn(async (_agentId: string, runId: string) => runs.get(runId) ?? null),
    endHeartbeatRun: vi.fn(async (_runId: string) => undefined),
    appendRunLog: vi.fn().mockResolvedValue(undefined),
    getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
    getRecentRuns: vi.fn().mockResolvedValue([]),
    getRatingSummary: vi.fn().mockResolvedValue(undefined),
    claimTaskForAgent: vi.fn().mockResolvedValue({ ok: false, reason: "task_not_found" }),
    assignTask: vi.fn().mockResolvedValue(agent),
    syncExecutionTaskLink: vi.fn().mockResolvedValue(undefined),
    getAgentsByReportsTo: vi.fn().mockResolvedValue([]),
    getLastBlockedState: vi.fn().mockResolvedValue(null),
    setLastBlockedState: vi.fn().mockResolvedValue(undefined),
    clearLastBlockedState: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentStore & { agent: Agent; runs: Map<string, AgentHeartbeatRun> };
  return store;
}

function createSession(promptImpl: () => Promise<void>) {
  return {
    prompt: vi.fn(promptImpl),
    dispose: vi.fn(),
    subscribe: vi.fn(),
    model: { provider: "mock", id: "mock-model" },
  };
}

function monitorFor(store: AgentStore, taskStore: TaskStore): HeartbeatMonitor {
  return new HeartbeatMonitor({ store, taskStore, rootDir: process.cwd() });
}

describe("heartbeat provider throttle cooldown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedCreateFnAgent.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /*
   * Symptom 1 (RUFU-286): the incident envelope must land in recoverable `error` with a bounded
   * re-probe armed, never in `paused` / `error-unrecoverable` demanding an operator action that the
   * provider window would have answered for free.
   */
  it("arms a bounded re-probe on the failing run instead of parking the agent for an operator", async () => {
    const store = createAgentStore(baseAgent({ state: "active", lastError: undefined }));
    const taskStore = createNoTaskStore();
    const monitor = monitorFor(store, taskStore);
    const { session, nextPrompt } = envelopedSession(THROTTLE_ENVELOPE);
    mockedCreateFnAgent.mockResolvedValue(session as never);

    const run = await failingHeartbeatTick(monitor, store.agent.id, nextPrompt);

    expect(session.prompt).toHaveBeenCalled();
    expect(run.status).toBe("failed");
    expect(store.agent.state).toBe("error");
    expect(store.agent.pauseReason).toBeUndefined();
    expect(isHeartbeatErrorRecoverable({ lastError: store.agent.lastError })).toBe(true);

    const state = readHeartbeatRecoveryState(store.agent);
    expect(state.throttleStreak).toBe(1);
    expect(Date.parse(state.cooldownUntilAt!) - Date.now()).toBe(THROTTLE_BACKOFF_FLOOR_MS);
    expect(isHeartbeatThrottleCooldownActive(store.agent)).toBe(true);
    // Arming schedules a re-probe; it is not itself an attempt, so the shared budget stays untouched.
    expect(readHeartbeatErrorRetryCount(store.agent)).toBe(0);

    expect(taskStore.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: store.agent.id,
      mutationType: "agent:throttle-cooldown-armed",
      target: store.agent.id,
      metadata: {
        agentId: store.agent.id,
        attempt: 0,
        limit: 5,
        backoffMs: THROTTLE_BACKOFF_FLOOR_MS,
        source: "run-failure",
      },
    }));
    expect(taskStore.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "agent:error-parked-unrecoverable",
    }));
  });

  /*
   * Symptom 2 (RUFU-286): while a cooldown is live, run entry defers — a skipped run shaped like the
   * pause/budget skips, no session, no budget unit, no duplicated auto-recover audit row, and the
   * `error` state the tick arrived in survives the skip so the NEXT tick still sees the wait.
   */
  it("defers heartbeat run entry while the cooldown is active, burning nothing", async () => {
    const armed = armHeartbeatThrottleCooldown(baseAgent(), NOW);
    const store = createAgentStore(baseAgent({
      state: "error",
      lastError: THROTTLE_ENVELOPE,
      metadata: armed.metadata,
    }));
    const taskStore = createNoTaskStore();
    const monitor = monitorFor(store, taskStore);

    const run = await monitor.executeHeartbeat({ agentId: store.agent.id, source: "timer" });

    expect(run.status).toBe("completed");
    expect(run.resultJson).toMatchObject({
      reason: "throttle-cooldown",
      source: "timer",
      cooldownUntilAt: armed.cooldownUntilAt,
      throttleStreak: 1,
    });
    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(store.agent.state).toBe("error");
    expect(readHeartbeatErrorRetryCount(store.agent)).toBe(0);
    expect(readHeartbeatRecoveryState(store.agent)).toMatchObject({
      throttleStreak: 1,
      cooldownUntilAt: armed.cooldownUntilAt,
    });
    expect(taskStore.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "agent:auto-recover-error-state",
    }));

    // A second tick inside the same window behaves identically: deferral never decays into an attempt.
    const second = await monitor.executeHeartbeat({ agentId: store.agent.id, source: "timer" });
    expect(second.resultJson).toMatchObject({ reason: "throttle-cooldown" });
    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(readHeartbeatErrorRetryCount(store.agent)).toBe(0);
    expect(store.agent.state).toBe("error");
  });

  /*
   * Symptom 3 (RUFU-286): once the horizon passes, the ordinary recovery ladder owns the tick — one
   * shared-budget attempt consumed and the pre-existing `agent:auto-recover-error-state` row written.
   */
  it("probes through the existing recovery ladder once the cooldown horizon passes", async () => {
    const armed = armHeartbeatThrottleCooldown(baseAgent(), NOW);
    const store = createAgentStore(baseAgent({
      state: "error",
      lastError: THROTTLE_ENVELOPE,
      metadata: armed.metadata,
    }));
    const taskStore = createNoTaskStore();
    const monitor = monitorFor(store, taskStore);
    // The probe itself fails with an ordinary transient error: the run-entry increment is what this
    // test measures, and a successful run would reset the shared budget and erase the evidence.
    const session = createSession(async () => { throw new Error("socket hang up"); });
    mockedCreateFnAgent.mockResolvedValueOnce(session as never);

    vi.setSystemTime(NOW + THROTTLE_BACKOFF_FLOOR_MS + 1_000);
    const run = await monitor.executeHeartbeat({ agentId: store.agent.id, source: "timer" });

    expect(run.resultJson).not.toMatchObject({ reason: "throttle-cooldown" });
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(readHeartbeatErrorRetryCount(store.agent)).toBe(1);
    expect(store.agent.state).toBe("error");
    // The expired wait is gone, and a socket hang-up is not a throttle: a different problem taking
    // over is what ENDS the episode, so the streak is cleared here and only here.
    expect(isHeartbeatThrottleCooldownActive(store.agent)).toBe(false);
    expect(readHeartbeatRecoveryState(store.agent).throttleStreak).toBe(0);
    expect(taskStore.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "agent:auto-recover-error-state",
      target: store.agent.id,
      metadata: expect.objectContaining({ attempt: 1, limit: 5 }),
    }));
  });

  /*
   * Symptom 4 (RUFU-286, code review P0+P1): repeated throttle failures raise the streak and
   * strictly grow the PERSISTED horizon (floor -> doubling -> cap) without ever turning the card
   * into a durable park.
   *
   * This is the test that was false-positive green before the P0 fix. It walks three complete
   * `executeHeartbeat` ticks, so the run-entry recovery gate — the only writer that runs between
   * two probes — is inside the sequence. Each tick asserts the horizon the NEXT tick will read,
   * measured from the arm instant, because the in-run retry drain moves the fake clock.
   */
  it("escalates the persisted horizon through the ladder across real heartbeat ticks", async () => {
    const store = createAgentStore(baseAgent({ state: "active", lastError: undefined }));
    const taskStore = createNoTaskStore();
    const monitor = monitorFor(store, taskStore);
    const { session, nextPrompt } = envelopedSession(THROTTLE_ENVELOPE);
    mockedCreateFnAgent.mockResolvedValue(session as never);

    /*
     * The wait is measured from `Date.now()` AFTER the tick, not before it: the arm happens at the
     * end of the failure path, i.e. once the in-run retry drain (~210 s of fake sleep) is already
     * spent, so a pre-tick instant would fold the drain into the measured backoff.
     */
    const probe = async () => {
      await failingHeartbeatTick(monitor, store.agent.id, nextPrompt);
      const state = readHeartbeatRecoveryState(store.agent);
      return { state, waitedMs: Date.parse(state.cooldownUntilAt!) - Date.now() };
    };

    // Tick 1: no episode yet, so this is an ordinary run that fails on a throttle and arms rung 1.
    const first = await probe();
    expect(first.state.throttleStreak).toBe(1);
    expect(first.waitedMs).toBe(THROTTLE_BACKOFF_FLOOR_MS);
    // Arming spends no budget unit; the re-probe at the horizon does.
    expect(readHeartbeatErrorRetryCount(store.agent)).toBe(0);

    /*
     * Tick 2: the horizon has passed, so run entry takes the recovery gate and burns one shared
     * budget unit. THAT write used to drop `throttleStreak` with the expired horizon, which is what
     * pinned `waitedMs` at the floor for every later rung while the budget burned ~5x too fast.
     */
    vi.setSystemTime(Date.parse(first.state.cooldownUntilAt!) + 1_000);
    const second = await probe();
    expect(second.state.throttleStreak).toBe(2);
    expect(second.waitedMs).toBe(THROTTLE_BACKOFF_FLOOR_MS * 2);
    expect(readHeartbeatErrorRetryCount(store.agent)).toBe(1);

    // Tick 3: the doubling continues, and the card is still a recoverable `error` at every rung.
    vi.setSystemTime(Date.parse(second.state.cooldownUntilAt!) + 1_000);
    const third = await probe();
    expect(third.state.throttleStreak).toBe(3);
    expect(third.waitedMs).toBe(THROTTLE_BACKOFF_FLOOR_MS * 4);
    expect(readHeartbeatErrorRetryCount(store.agent)).toBe(2);

    // Control for "the escalation came from the ladder, not from extra budget burns": every probe
    // after the first consumed exactly one attempt, and no run entered a durable park.
    expect(store.agent.state).toBe("error");
    expect(store.agent.pauseReason).toBeUndefined();
    expect(taskStore.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "agent:auto-recover-error-state",
    }));
    expect(taskStore.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "agent:error-retry-exhausted",
    }));
    expect(taskStore.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "agent:error-parked-unrecoverable",
    }));
    // Three ticks, three distinct horizons, strictly increasing.
    const horizons = [first, second, third].map((rung) => Date.parse(rung.state.cooldownUntilAt!));
    expect(new Set(horizons).size).toBe(3);
    expect(session.prompt).toHaveBeenCalled();
  });

  it("bounds the doubling sequence at the shared cap", () => {
    expect(THROTTLE_BACKOFF_CAP_MS).toBeGreaterThan(THROTTLE_BACKOFF_FLOOR_MS);
    // One long-lived episode: the horizon stays finite and never exceeds the cap.
    let agent = baseAgent();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      agent = { ...agent, metadata: armHeartbeatThrottleCooldown(agent, NOW).metadata };
    }
    const state = readHeartbeatRecoveryState(agent);
    expect(state.throttleStreak).toBe(8);
    const waitMs = Date.parse(state.cooldownUntilAt!) - NOW;
    expect(waitMs).toBeGreaterThan(0);
    expect(waitMs).toBeLessThanOrEqual(THROTTLE_BACKOFF_CAP_MS);
  });

  /*
   * Symptom 5 (RUFU-286): the durable/operator-actionable classes share the `429` status code and
   * must be untouched — same park, same reason, and no cooldown armed to hide them behind a wait.
   */
  it.each([
    ["Anthropic quota wrapper", ANTHROPIC_QUOTA_ENVELOPE],
    ["OpenAI quota/billing envelope", OPENAI_QUOTA_ENVELOPE],
  ])("keeps the durable operator park for %s", async (_label, envelope) => {
    const store = createAgentStore(baseAgent({ state: "active", lastError: undefined }));
    const taskStore = createNoTaskStore();
    const monitor = monitorFor(store, taskStore);
    const { session, nextPrompt } = envelopedSession(envelope);
    mockedCreateFnAgent.mockResolvedValue(session as never);

    await failingHeartbeatTick(monitor, store.agent.id, nextPrompt);

    expect(isHeartbeatErrorRecoverable({ lastError: envelope })).toBe(false);
    expect(store.agent.state).toBe("paused");
    expect(store.agent.pauseReason).toBe(HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON);
    expect(isHeartbeatThrottleCooldownActive(store.agent)).toBe(false);
    expect(readHeartbeatRecoveryState(store.agent).throttleStreak).toBe(0);
    expect(taskStore.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "agent:throttle-cooldown-armed",
    }));
    expect(taskStore.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "agent:error-parked-unrecoverable",
    }));
  });

  /*
   * Symptom 6a (RUFU-286, code review P0): the exhaustion park every recoverable class gets is
   * `error-retry-exhausted` — which restart and `fn_agent_start` clear — never
   * `error-unrecoverable`, and the parked card stops advertising a re-probe nothing owns.
   *
   * The PARKED CARD MUST STILL SAY WHAT CONSUMED THE BUDGET. `throttleStreak` is the only record of
   * that, and the shared reader's `throttle-exhausted` classification needs it (paused +
   * `error-retry-exhausted` + streak > 0); clearing the streak would put an operator-agent reading
   * the card back to guessing credentials. This is the run-entry route: the budget was already
   * burned, so the gate parks at entry and writes no recovery metadata at all.
   */
  it("parks an exhausted budget at run entry as error-retry-exhausted while keeping the throttle attribution", async () => {
    const burned = buildHeartbeatErrorRecoveryMetadata(baseAgent(), 5);
    const armed = armHeartbeatThrottleCooldown({ ...baseAgent(), metadata: burned }, NOW);
    expect(armed.metadata[HEARTBEAT_ERROR_RECOVERY_METADATA_KEY]).toBeDefined();
    const store = createAgentStore(baseAgent({
      state: "error",
      lastError: THROTTLE_ENVELOPE,
      metadata: armed.metadata,
    }));
    const taskStore = createNoTaskStore();
    const monitor = monitorFor(store, taskStore);

    // Horizon crossed, so the gate is the exhausted branch rather than a cooldown deferral.
    vi.setSystemTime(NOW + THROTTLE_BACKOFF_FLOOR_MS + 1_000);
    const run = await monitor.executeHeartbeat({ agentId: store.agent.id, source: "timer" });

    expect(run.resultJson).toMatchObject({
      reason: HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON,
      attempts: 5,
      limit: 5,
    });
    // Nothing was probed: the exhaustion decision happens before any session is created.
    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(store.agent.state).toBe("paused");
    expect(store.agent.pauseReason).toBe(HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON);
    expect(readHeartbeatRecoveryState(store.agent)).toMatchObject({
      throttleStreak: 1,
      cooldownUntilAt: armed.cooldownUntilAt,
    });
    expect(describeHeartbeatThrottle({ ...store.agent, metadata: store.agent.metadata })).toMatchObject({
      kind: "throttle-exhausted",
      throttleStreak: 1,
    });
  });

  /*
   * Symptom 6b (RUFU-286): the mid-run route reaches the same park, and the exhaustion write keeps
   * the streak while withdrawing the re-probe promise — the two throttle facts point opposite ways
   * on a parked card.
   */
  it("parks mid-run exhaustion as error-retry-exhausted and clears only the live cooldown", async () => {
    const burned = buildHeartbeatErrorRecoveryMetadata(baseAgent(), 4);
    const armed = armHeartbeatThrottleCooldown({ ...baseAgent(), metadata: burned }, NOW);
    const store = createAgentStore(baseAgent({
      state: "error",
      lastError: THROTTLE_ENVELOPE,
      metadata: armed.metadata,
    }));
    const taskStore = createNoTaskStore();
    const monitor = monitorFor(store, taskStore);
    const { session, nextPrompt } = envelopedSession(THROTTLE_ENVELOPE);
    mockedCreateFnAgent.mockResolvedValue(session as never);

    // Burn the 5th unit at the run-entry gate, then have the provider throttle the probe itself.
    vi.setSystemTime(NOW + THROTTLE_BACKOFF_FLOOR_MS + 1_000);
    await failingHeartbeatTick(monitor, store.agent.id, nextPrompt);

    expect(store.agent.state).toBe("paused");
    expect(store.agent.pauseReason).toBe(HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON);
    expect(store.agent.pauseReason).not.toBe(HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON);
    // The shared attempt budget is what holds the card, and it survives the cooldown clear.
    expect(readHeartbeatErrorRetryCount(store.agent)).toBe(5);
    expect(isHeartbeatThrottleCooldownActive(store.agent)).toBe(false);
    const parked = readHeartbeatRecoveryState(store.agent);
    expect(parked.cooldownUntilAt).toBeNull();
    expect(parked.throttleStreak).toBe(1);
    expect(taskStore.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "agent:error-retry-exhausted",
    }));
    expect(taskStore.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "agent:error-parked-unrecoverable",
    }));
  });

  /*
   * Timer-eligibility regression (RUFU-286): `isTimerEligibleAgent` composes `isErrorRecoveryEligible`
   * for error-state agents and stays unchanged, so the Step 1 classification alone keeps a throttled
   * error card dispatchable while a genuine durable park stays silent.
   */
  it("keeps an error-state throttle agent recovery-eligible and a durable park ineligible", () => {
    const armed = armHeartbeatThrottleCooldown(baseAgent(), NOW);
    const throttled = baseAgent({
      state: "error",
      lastError: THROTTLE_ENVELOPE,
      metadata: armed.metadata,
    });
    expect(isHeartbeatErrorRecoverable(throttled)).toBe(true);
    expect(isErrorRecoveryEligible(throttled, 5)).toBe(true);

    const durableParked = baseAgent({
      state: "paused",
      pauseReason: HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON,
      lastError: ANTHROPIC_QUOTA_ENVELOPE,
    });
    expect(isHeartbeatErrorRecoverable(durableParked)).toBe(false);
    expect(isErrorRecoveryEligible(durableParked, 5)).toBe(false);
  });

  /*
   * Provider envelopes carry account text. The audit row is ids/counts/outcomes-only, so nothing on
   * the telemetry side may echo the message back (RUFU-286 run-audit contract).
   */
  it("never writes the provider envelope into run-audit metadata", async () => {
    const store = createAgentStore(baseAgent({ state: "active", lastError: undefined }));
    const taskStore = createNoTaskStore();
    const monitor = monitorFor(store, taskStore);
    const { session, nextPrompt } = envelopedSession(THROTTLE_ENVELOPE);
    mockedCreateFnAgent.mockResolvedValue(session as never);

    await failingHeartbeatTick(monitor, store.agent.id, nextPrompt);

    expect(taskStore.auditEvents.length).toBeGreaterThan(0);
    const armedRows = taskStore.auditEvents.filter((event) => event.mutationType === "agent:throttle-cooldown-armed");
    expect(armedRows).toHaveLength(1);
    for (const event of taskStore.auditEvents) {
      const serialized = JSON.stringify(event.metadata ?? {});
      expect(serialized).not.toContain("rate_limit_error");
      expect(serialized).not.toContain("This request would exceed");
    }
  });
});
