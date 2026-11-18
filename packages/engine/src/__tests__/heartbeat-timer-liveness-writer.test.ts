/*
FNXC:ReportsHealth 2026-11-18-14:27 (RUFU-716):
Writer pins for `metadata.heartbeatTimerLiveness` — the durable record that a lane's heartbeat timer
physically fired while the engine deliberately withheld the delivery.

Why a separate file, when `heartbeat-scheduler.test.ts` already drives these same gates: that file's
subject is DISPATCH (did the callback fire, was the lane skipped). This file's subject is the EVIDENCE
left behind, and both directions matter:
- The three fire-and-skip paths must leave the record, or `lastHeartbeatAt` stays frozen and every
  health surface calls a live timer dead forever (the production shape: `timer-heartbeat-suppressed
  agentId=agent-3ac88b82 reason=no-fresher-signal` printed one line before `[reports-health] stale
  report … heartbeatAgeMs=29530259`).
- The pause / active-run / ineligible / delivered paths must NOT leave it. Relief for a lane nobody
  scheduled, or for a lane stuck inside a live run, would hide a genuinely lost trigger — the exact
  over-relief this task is required not to introduce.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentStore, TaskStore } from "@fusion/core";
import {
  HEARTBEAT_TIMER_LIVENESS_METADATA_KEY,
  describeHeartbeatDeliverySkip,
  heartbeatTimerFireAgeMs,
  readHeartbeatTimerLiveness,
} from "@fusion/core";
import { HeartbeatTriggerScheduler, type TriggerCallback } from "../agent-heartbeat.js";
import { createBudgetStatus } from "./heartbeat-test-helpers.js";

vi.mock("../logger.js", async () => {
  const { createMockLogger, formatMockError } = await import("./heartbeat-test-helpers.js");
  const logger = createMockLogger();
  return { createLogger: vi.fn(() => logger), heartbeatLog: logger, formatError: formatMockError };
});
import { heartbeatLog } from "../logger.js";

/** Fixed clock: `firedAt` assertions are absolute, never a race against the host clock. */
const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const INTERVAL_MS = 3_600_000;

function makeAgent(patch: Record<string, unknown> = {}): Agent {
  return {
    id: "agent-liveness",
    name: "Audit Executor",
    role: "executor",
    state: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    metadata: {},
    // A lane whose last delivery landed a day ago: every assertion below is about the FIRE, not the delivery.
    lastHeartbeatAt: new Date(NOW - 24 * 3_600_000).toISOString(),
    ...patch,
  } as unknown as Agent;
}

function makeStore(agent: Agent, updateAgent?: (id: string, updates: { metadata: Record<string, unknown> }) => Promise<unknown>) {
  /*
  A live agent row, not a constant. The writer's dedupe reads the row it is about to replace, so a mock
  whose `getAgent` kept returning the pre-write snapshot would report a second write on every tick and
  prove nothing about the bound it is meant to pin.
  */
  const row = { ...(agent ?? {}) } as Agent;
  const store = {
    getAgent: vi.fn().mockImplementation(async () => (agent ? row : null)),
    getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
    getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
    // The registration audit is not this file's subject; with an empty roster it stays silent, so the
    // only metadata writes left are the ones under test.
    listAgents: vi.fn().mockResolvedValue([]),
    getRunDetail: vi.fn().mockResolvedValue(null),
    saveRun: vi.fn().mockResolvedValue(undefined),
    endHeartbeatRun: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    updateAgent: vi.fn(updateAgent ?? (async (_id: string, updates: { metadata: Record<string, unknown> }) => {
      row.metadata = updates.metadata;
      return row;
    })),
  } as unknown as AgentStore;
  return store;
}

function makeTaskStore(settings: Record<string, unknown> = {}): TaskStore {
  return { getSettings: vi.fn().mockResolvedValue(settings) } as unknown as TaskStore;
}

/** Drive one physical tick the way the armed interval would. */
async function tick(
  scheduler: HeartbeatTriggerScheduler,
  intervalMs: number = INTERVAL_MS,
): Promise<void> {
  await (scheduler as unknown as { onTimerTick: (id: string, ms: number) => Promise<void> })
    .onTimerTick("agent-liveness", intervalMs);
}

/*
Every assertion names the liveness key explicitly rather than counting store calls: the subject is what
evidence a path leaves, not how many unrelated writes a tick also performs.
*/
function livenessWrites(store: AgentStore): Array<Record<string, unknown>> {
  return (store.updateAgent as ReturnType<typeof vi.fn>).mock.calls
    .map((call) => ((call[1] as { metadata?: Record<string, unknown> } | undefined)?.metadata?.[HEARTBEAT_TIMER_LIVENESS_METADATA_KEY]) as Record<string, unknown> | undefined)
    .filter((row): row is Record<string, unknown> => row !== undefined);
}

/** The full metadata patch of the write that carried the liveness row, so sibling keys can be inspected. */
function livenessMetadataPatch(store: AgentStore): Record<string, unknown> | undefined {
  const calls = (store.updateAgent as ReturnType<typeof vi.fn>).mock.calls;
  const hit = calls.find((call) => {
    const metadata = (call[1] as { metadata?: Record<string, unknown> } | undefined)?.metadata;
    return metadata?.[HEARTBEAT_TIMER_LIVENESS_METADATA_KEY] !== undefined;
  });
  return (hit?.[1] as { metadata?: Record<string, unknown> } | undefined)?.metadata;
}

/** The MOST RECENT metadata patch that carried a liveness row — what the surfaces would read now. */
function lastLivenessMetadata(store: AgentStore): Record<string, unknown> | undefined {
  const calls = (store.updateAgent as ReturnType<typeof vi.fn>).mock.calls;
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const metadata = (calls[i]?.[1] as { metadata?: Record<string, unknown> } | undefined)?.metadata;
    if (metadata?.[HEARTBEAT_TIMER_LIVENESS_METADATA_KEY] !== undefined) return metadata;
  }
  return undefined;
}

describe("heartbeat timer-liveness writer (RUFU-716)", () => {
  let callback: ReturnType<typeof vi.fn<TriggerCallback>>;
  let scheduler: HeartbeatTriggerScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    callback = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    scheduler?.stop();
    vi.useRealTimers();
  });

  describe("the three fire-and-skip paths record the withheld delivery", () => {
    it("skipHeartbeatWhenIdle with no task writes reason=idle-skip", async () => {
      const agent = makeAgent({ runtimeConfig: { enabled: true, heartbeatIntervalMs: INTERVAL_MS, skipHeartbeatWhenIdle: true } });
      const store = makeStore(agent);
      scheduler = new HeartbeatTriggerScheduler(store, callback, makeTaskStore());
      scheduler.start();

      await tick(scheduler);

      expect(callback).not.toHaveBeenCalled();
      expect(livenessWrites(store)).toHaveLength(1);
      expect(livenessWrites(store)[0]).toMatchObject({ reason: "idle-skip", intervalMs: INTERVAL_MS });
      // Read back through the SAME reader every health surface uses.
      const written = { metadata: livenessMetadataPatch(store) };
      expect(readHeartbeatTimerLiveness(written).reliefEligible).toBe(true);
      expect(describeHeartbeatDeliverySkip(written, { nowMs: NOW, withinMs: 5_400_000 })).toMatchObject({
        kind: "delivery-skip",
        reason: "idle-skip",
      });
    });

    it("allowParallelExecution=false with a bound session executing writes reason=parallel-execution", async () => {
      const agent = makeAgent({
        taskId: "FN-LIVE-1",
        runtimeConfig: { enabled: true, heartbeatIntervalMs: INTERVAL_MS, allowParallelExecution: false },
      });
      const store = makeStore(agent);
      const isTaskExecuting = vi.fn().mockReturnValue(true);
      scheduler = new HeartbeatTriggerScheduler(store, callback, makeTaskStore(), { isTaskExecuting });
      scheduler.start();

      await tick(scheduler);

      expect(callback).not.toHaveBeenCalled();
      expect(livenessWrites(store)).toHaveLength(1);
      expect(livenessWrites(store)[0]).toMatchObject({ reason: "parallel-execution" });
    });

    it("the wake-discipline gate writes reason=wake-suppressed and still logs its own suppression line", async () => {
      const agent = makeAgent({ runtimeConfig: { enabled: true, heartbeatIntervalMs: INTERVAL_MS } });
      const store = makeStore(agent);
      scheduler = new HeartbeatTriggerScheduler(store, callback, makeTaskStore(), {
        shouldSuppressTimerWake: async () => ({ suppress: true, reason: "no-fresher-signal" }),
      });
      scheduler.start();

      await tick(scheduler);

      expect(callback).not.toHaveBeenCalled();
      expect(livenessWrites(store)).toHaveLength(1);
      expect(livenessWrites(store)[0]).toMatchObject({ reason: "wake-suppressed" });
      // The pre-existing needle is untouched: operators grep for it and the symptom test asserts it.
      expect((heartbeatLog.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n"))
        .toContain("timer-heartbeat-suppressed agentId=agent-liveness reason=no-fresher-signal");
    });

    it("the idle-backoff deferral records the same reason code, because the engine withheld either way", async () => {
      const agent = makeAgent({ runtimeConfig: { enabled: true, heartbeatIntervalMs: INTERVAL_MS } });
      const store = makeStore(agent);
      scheduler = new HeartbeatTriggerScheduler(store, callback, makeTaskStore(), {
        shouldSuppressTimerWake: async () => ({ suppress: true, reason: "idle-backoff:600000" }),
      });
      scheduler.start();

      await tick(scheduler);

      expect(livenessWrites(store)).toHaveLength(1);
      expect(livenessWrites(store)[0]).toMatchObject({ reason: "wake-suppressed" });
    });
  });

  describe("paths that must leave no evidence of a live trigger", () => {
    /*
    FNXC:ReportsHealth 2026-11-18-14:27 (RUFU-716 AC2):
    Relief exists to excuse a lane the ENGINE chose to keep quiet. A pause is an operator or
    exhaustion decision, an active run can be a real wedge, and an ineligible state means nothing is
    scheduled at all — writing the row on any of these would launder a dead trigger into "Healthy".
    */
    const nonWritingCases: Array<[string, () => { agent: Agent; opts?: ConstructorParameters<typeof HeartbeatTriggerScheduler>[3]; settings?: Record<string, unknown>; activeRun?: unknown }]> = [
      ["global pause", () => ({
        agent: makeAgent({ runtimeConfig: { enabled: true, heartbeatIntervalMs: INTERVAL_MS } }),
        settings: { globalPause: true },
      })],
      ["engine pause", () => ({
        agent: makeAgent({ runtimeConfig: { enabled: true, heartbeatIntervalMs: INTERVAL_MS } }),
        settings: { enginePaused: true },
      })],
      ["existing active run", () => ({
        agent: makeAgent({ runtimeConfig: { enabled: true, heartbeatIntervalMs: INTERVAL_MS } }),
        activeRun: { id: "run-live", agentId: "agent-liveness", startedAt: new Date(NOW).toISOString(), status: "active" },
      })],
      ["ineligible state (unregisters)", () => ({
        agent: makeAgent({ state: "stopped", runtimeConfig: { enabled: true, heartbeatIntervalMs: INTERVAL_MS } }),
      })],
      ["missing agent (unregisters)", () => ({ agent: null as unknown as Agent })],
    ];

    it.each(nonWritingCases)("writes nothing on %s", async (_label, build) => {
      const { agent, settings, activeRun } = build();
      const store = makeStore(agent);
      if (activeRun) {
        (store.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue(activeRun);
      }
      scheduler = new HeartbeatTriggerScheduler(store, callback, makeTaskStore(settings ?? {}));
      scheduler.start();

      await tick(scheduler);

      expect(livenessWrites(store)).toHaveLength(0);
    });

    it("writes nothing on a delivered dispatch, so the row never competes with a real heartbeat", async () => {
      const agent = makeAgent({ runtimeConfig: { enabled: true, heartbeatIntervalMs: INTERVAL_MS } });
      const store = makeStore(agent);
      scheduler = new HeartbeatTriggerScheduler(store, callback, makeTaskStore());
      scheduler.start();

      await tick(scheduler);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(livenessWrites(store)).toHaveLength(0);
    });
  });

  describe("the write itself is bounded, preserving, and cannot break dispatch", () => {
    it("preserves sibling metadata keys, including the repair and error-recovery rows", async () => {
      const agent = makeAgent({
        runtimeConfig: { enabled: true, heartbeatIntervalMs: INTERVAL_MS, skipHeartbeatWhenIdle: true },
        metadata: {
          custom: "keep me",
          heartbeatTimerRepair: { repairedAt: "2026-11-17T00:00:00.000Z", staleAtRepair: true },
          heartbeatErrorRecovery: { consecutiveAttempts: 2, throttleStreak: 1 },
        },
      });
      const store = makeStore(agent);
      scheduler = new HeartbeatTriggerScheduler(store, callback, makeTaskStore());
      scheduler.start();

      await tick(scheduler);

      const metadata = livenessMetadataPatch(store);
      expect(metadata?.custom).toBe("keep me");
      expect(metadata?.heartbeatTimerRepair).toEqual({ repairedAt: "2026-11-17T00:00:00.000Z", staleAtRepair: true });
      expect(metadata?.heartbeatErrorRecovery).toEqual({ consecutiveAttempts: 2, throttleStreak: 1 });
      expect(metadata?.[HEARTBEAT_TIMER_LIVENESS_METADATA_KEY]).toBeDefined();
    });

    it("collapses repeat skips inside the refresh bound, and refreshes again one interval later", async () => {
      /*
      FNXC:ReportsHealth 2026-11-18-17:15 (RUFU-716 remediation):
      The bound that decides this is HALF an effective interval, not a whole one. The first
      on-cadence fire after a write arrives with the row exactly one interval old, and a gate that
      demanded a full interval of age refused exactly that edge (age === interval is not > interval),
      so a lane that keeps firing on cadence wrote once and then aged the row into the 1.5 x interval
      … 2 x interval band where reports-health goes back to `**stale**` and the "create a follow-up
      task to investigate" line returns. The floor is what the relief depends on; the cap is not.
      */
      const agent = makeAgent({ runtimeConfig: { enabled: true, heartbeatIntervalMs: INTERVAL_MS, skipHeartbeatWhenIdle: true } });
      const store = makeStore(agent);
      scheduler = new HeartbeatTriggerScheduler(store, callback, makeTaskStore());
      scheduler.start();

      await tick(scheduler);
      expect(livenessWrites(store)).toHaveLength(1);

      // A repeat skip well inside the refresh bound: the truth is already recorded for this window.
      await vi.advanceTimersByTimeAsync(60_000);
      await tick(scheduler);
      expect(livenessWrites(store)).toHaveLength(1);

      // Now land a fire at EXACTLY one interval after the recorded one — the steady cadence, with
      // zero callback lateness. This must be a new record, not another refusal.
      await vi.advanceTimersByTimeAsync(INTERVAL_MS - 60_000);
      await tick(scheduler);
      expect(livenessWrites(store)).toHaveLength(2);
    });

    it("stamps the physical fire instant, not the instant the store write happened to compose", async () => {
      /*
      FNXC:ReportsHealth 2026-11-18-17:15 (RUFU-716 remediation):
      The leaf promises "ISO instant the timer physically fired (the same instant lastTimerFireAtMs was
      stamped)", and the instant has to be that one: a stamp taken after the tick's awaited gates
      carries the store round-trip inside the interval the row claims rang, so consecutive stamps drift
      slower than the fires that produce them and the refresh gate — and therefore the relief — is
      missed. A deliberately slow `getAgent` makes the two instants distinguishable.
      */
      const agent = makeAgent({ runtimeConfig: { enabled: true, heartbeatIntervalMs: INTERVAL_MS, skipHeartbeatWhenIdle: true } });
      const store = makeStore(agent);
      const liveRow = await store.getAgent(agent.id);
      (store.getAgent as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await vi.advanceTimersByTimeAsync(250);
        return liveRow;
      });
      scheduler = new HeartbeatTriggerScheduler(store, callback, makeTaskStore());
      scheduler.start();

      const fireInstant = Date.now();
      await tick(scheduler);

      // The write really did compose a quarter-second after the tick, and the row must not say so.
      expect(Date.now()).toBe(fireInstant + 250);
      const row = lastLivenessMetadata(store)?.[HEARTBEAT_TIMER_LIVENESS_METADATA_KEY] as { firedAt?: string } | undefined;
      expect(row?.firedAt).toBe(new Date(fireInstant).toISOString());
    });

    it("keeps the row inside every consumer's relief window across a sustained on-period cadence", async () => {
      /*
      FNXC:ReportsHealth 2026-11-18-17:15 (RUFU-716 AC1):
      AC1 is unconditional: a suppressed-but-firing lane never renders `**stale**`. The first-write,
      dedupe and beyond-window tests each cover one moment, so none of them could see the lapse the
      review measured — a refresh bound equal to the fire cadence leaves the row unrefreshed and ages
      it to ~2 x interval, past the reports-health window (interval x 1.5, `MIN_HEARTBEAT_STALENESS_MS`
      floor). This drives the production shape (a 1h lane, twelve consecutive fires at EXACTLY the
      period, zero callback lateness) and asserts at every fire both the raw age and what the shared
      reader answers at the WORST moment before the next fire — the instant a health surface is most
      likely to sample. Against the old full-interval bound this run wrote once, then went dark.
      */
      const REPORTS_WINDOW_MS = INTERVAL_MS * 1.5; // REPORTS_STALE_INTERVAL_MULTIPLIER, unchanged by this task
      const agent = makeAgent({ runtimeConfig: { enabled: true, heartbeatIntervalMs: INTERVAL_MS, skipHeartbeatWhenIdle: true } });
      const store = makeStore(agent);
      scheduler = new HeartbeatTriggerScheduler(store, callback, makeTaskStore());
      scheduler.start();

      let clock = NOW;
      for (let fire = 1; fire <= 12; fire += 1) {
        await vi.advanceTimersByTimeAsync(INTERVAL_MS);
        clock += INTERVAL_MS;
        await tick(scheduler);

        const metadata = lastLivenessMetadata(store);
        expect(metadata, `fire ${fire} recorded no liveness row`).toBeDefined();
        const row = { metadata };
        expect(heartbeatTimerFireAgeMs(row, clock)).toBeLessThanOrEqual(REPORTS_WINDOW_MS);
        // The worst sample a surface can take: one ms before the next fire would refresh the row.
        expect(describeHeartbeatDeliverySkip(row, { nowMs: clock + INTERVAL_MS - 1, withinMs: REPORTS_WINDOW_MS }))
          .toMatchObject({ kind: "delivery-skip", reason: "idle-skip" });
      }

      // One write per suppressed interval: the cap the writer promises, now also the floor it needs.
      expect(livenessWrites(store)).toHaveLength(12);
    });

    it("a throwing updateAgent neither rejects the tick nor drops the skip log line", async () => {
      const agent = makeAgent({ runtimeConfig: { enabled: true, heartbeatIntervalMs: INTERVAL_MS, skipHeartbeatWhenIdle: true } });
      const store = makeStore(agent, vi.fn().mockRejectedValue(new Error("store down")));
      scheduler = new HeartbeatTriggerScheduler(store, callback, makeTaskStore());
      scheduler.start();

      await expect(tick(scheduler)).resolves.toBeUndefined();

      expect(livenessWrites(store)).toHaveLength(1);
      // Observability failure must not displace the operator-visible skip decision.
      const logged = [...(heartbeatLog.debug as ReturnType<typeof vi.fn>).mock.calls.flat(),
        ...(heartbeatLog.log as ReturnType<typeof vi.fn>).mock.calls.flat(),
        ...(heartbeatLog.error as ReturnType<typeof vi.fn>).mock.calls.flat()].join("\n");
      expect(logged).toContain("Timer tick skipped for agent-liveness (skipHeartbeatWhenIdle, no task assigned)");
      expect(logged).not.toContain("Timer tick error");
    });

    it("a store without updateAgent is tolerated (duck-typed guard, same shape as markRepairMetadata)", async () => {
      const agent = makeAgent({ runtimeConfig: { enabled: true, heartbeatIntervalMs: INTERVAL_MS, skipHeartbeatWhenIdle: true } });
      const store = makeStore(agent) as unknown as Record<string, unknown>;
      delete store.updateAgent;
      scheduler = new HeartbeatTriggerScheduler(store as unknown as AgentStore, callback, makeTaskStore());
      scheduler.start();

      await expect(tick(scheduler)).resolves.toBeUndefined();
    });
  });
});
