/*
FNXC:ProviderThrottleIsTransient 2026-09-30-14:05 (RUFU-286):
Self-healing half of the provider-throttle contract. RUFU-286's coordinator was parked
`paused` / `pauseReason:"error-unrecoverable"` by a provider 429 that had already cleared, and FN-7884
startup recovery deliberately preserves that park, so the only path back was a human. These tests pin
the two self-healing obligations that close that hole: startup must treat a throttle-shaped `lastError`
under that park as a mis-park and clear it, while the maintenance sweep must stand down mid-cooldown so
it never races (or spends budget against) the heartbeat timer that owns the re-probe. Assertions stay on
state, metadata fields, and audit rows — never log prose.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Agent, AgentStore, Settings, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import {
  HEARTBEAT_ERROR_RECOVERY_METADATA_KEY,
  HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON,
  HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON,
  armHeartbeatThrottleCooldown,
  isHeartbeatThrottleCooldownActive,
  readHeartbeatErrorRetryCount,
} from "../agent-heartbeat.js";
import { readHeartbeatRecoveryState } from "@fusion/core";

vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => ({
    log: vi.fn(), debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  schedulerLog: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Verbatim RUFU-286 incident envelope (model-fallback wrapper around a live 429 rate_limit_error). */
const THROTTLE_ENVELOPE = 'Unable to select a usable model after 1 attempt (primary unknown model, no fallback configured, trigger: prompt-time): 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011Cf3ZXBTF3bymyoFWRQy3t"}';

/** Operator-actionable durable class the incident card was mistaken for: hard quota exhaustion. */
const QUOTA_ENVELOPE = 'Unable to select a usable model after 1 attempt (primary unknown model, no fallback configured, trigger: session-creation): 429 {"type":"error","error":{"type":"insufficient_quota","message":"Your account\'s budget has been exhausted. Please purchase more."},"request_id":"req_011Cf3Zq2k9PjUu2kH8s"}';

/** A genuine missing-credential park, the class FN-7884 must keep preserving across restarts. */
const MISSING_KEY_ERROR = 'No API key for provider: anthropic. Configure credentials for provider "anthropic" in settings, then resume the agent.';

function createStatefulMockAgentStore(agents: Agent[]): AgentStore & { getAgent(id: string): Agent | undefined } {
  const agentMap = new Map<string, Agent>(
    agents.map((agent) => [agent.id, { ...agent, metadata: agent.metadata ? { ...agent.metadata } : agent.metadata }]),
  );
  return {
    getAgent: (id: string) => agentMap.get(id),
    listAgents: vi.fn().mockImplementation(async () => Array.from(agentMap.values())),
    updateAgentState: vi.fn().mockImplementation(async (id: string, state: Agent["state"]) => {
      const agent = agentMap.get(id);
      if (agent) agentMap.set(id, { ...agent, state });
    }),
    updateAgent: vi.fn().mockImplementation(async (id: string, patch: Partial<Agent>) => {
      const agent = agentMap.get(id);
      if (agent) agentMap.set(id, { ...agent, ...patch });
    }),
  } as unknown as AgentStore & { getAgent(id: string): Agent | undefined };
}

function armedMetadata(agentSeed: Agent, armedAt: number) {
  return armHeartbeatThrottleCooldown({ metadata: agentSeed.metadata ?? {} }, armedAt).metadata;
}

describe("SelfHealingManager provider-throttle mis-park recovery", () => {
  let store: TaskStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = {
      getSettings: vi.fn().mockResolvedValue({
        globalPause: false,
        enginePaused: false,
        taskStuckTimeoutMs: 60_000,
      } as unknown as Settings),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
      listTasks: vi.fn().mockResolvedValue([]),
    } as unknown as TaskStore;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("startup recovery of the mis-park class (FN-7884 extension)", () => {
    it("clears a paused/error-unrecoverable park whose lastError is a provider throttle envelope", async () => {
      const now = Date.now();
      const misParked = {
        id: "mis-parked-coordinator",
        state: "paused",
        pauseReason: HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON,
        lastError: THROTTLE_ENVELOPE,
        runtimeConfig: { enabled: true },
        metadata: { [HEARTBEAT_ERROR_RECOVERY_METADATA_KEY]: { consecutiveAttempts: 5 } },
        updatedAt: new Date(now).toISOString(),
      } as unknown as Agent;
      const agentStore = createStatefulMockAgentStore([misParked]);
      const restartDurableAgentHeartbeat = vi.fn().mockResolvedValue(true);
      const manager = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        agentStore,
        restartDurableAgentHeartbeat,
      });

      const resetCount = await manager.resetDurableAgentErrorStateOnStartup();

      expect(resetCount).toBe(1);
      const agent = agentStore.getAgent("mis-parked-coordinator")!;
      expect(agent.state).toBe("active");
      expect(agent.pauseReason).toBeUndefined();
      expect(agent.lastError).toBeUndefined();
      // A restart is an operator retry: the burned budget that produced the mis-park is reset.
      expect(readHeartbeatErrorRetryCount(agent)).toBe(0);
      expect(isHeartbeatThrottleCooldownActive(agent)).toBe(false);
      expect(restartDurableAgentHeartbeat).toHaveBeenCalledWith("mis-parked-coordinator", {
        reason: "startup-error-reset",
        attempt: 1,
      });
      expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "agent:reset-error-state-on-startup",
        target: "mis-parked-coordinator",
        metadata: expect.objectContaining({
          agentId: "mis-parked-coordinator",
          priorState: "paused",
          priorPauseReason: HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON,
          source: "self-healing",
        }),
      }));
      manager.stop();
    });

    it("preserves genuine operator-actionable parks under the same pause reason", async () => {
      const now = Date.now();
      const agentStore = createStatefulMockAgentStore([
        {
          id: "hard-quota-park",
          state: "paused",
          pauseReason: HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON,
          lastError: QUOTA_ENVELOPE,
          runtimeConfig: { enabled: true },
          updatedAt: new Date(now).toISOString(),
        } as unknown as Agent,
        {
          id: "missing-key-park",
          state: "paused",
          pauseReason: HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON,
          lastError: MISSING_KEY_ERROR,
          runtimeConfig: { enabled: true },
          updatedAt: new Date(now).toISOString(),
        } as unknown as Agent,
      ]);
      const restartDurableAgentHeartbeat = vi.fn().mockResolvedValue(true);
      const manager = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        agentStore,
        restartDurableAgentHeartbeat,
      });

      const resetCount = await manager.resetDurableAgentErrorStateOnStartup();

      expect(resetCount).toBe(0);
      for (const agentId of ["hard-quota-park", "missing-key-park"]) {
        const agent = agentStore.getAgent(agentId)!;
        expect(agent.state).toBe("paused");
        expect(agent.pauseReason).toBe(HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON);
        expect(agentStore.updateAgentState).not.toHaveBeenCalledWith(agentId, expect.anything());
      }
      expect(restartDurableAgentHeartbeat).not.toHaveBeenCalled();
      expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
      manager.stop();
    });
  });

  describe("maintenance sweep defers to the cooldown timer", () => {
    it("leaves a stale error-state agent untouched while its throttle cooldown is live", async () => {
      const now = Date.now();
      const cooled = {
        id: "mid-cooldown",
        state: "error",
        lastError: THROTTLE_ENVELOPE,
        runtimeConfig: { enabled: true },
        metadata: {},
        // Stale enough to be a sweep candidate: only the live cooldown may veto it.
        updatedAt: new Date(now - 120_000).toISOString(),
      } as unknown as Agent;
      const expired = {
        id: "cooldown-expired",
        state: "error",
        lastError: THROTTLE_ENVELOPE,
        runtimeConfig: { enabled: true },
        metadata: {},
        updatedAt: new Date(now - 120_000).toISOString(),
      } as unknown as Agent;
      cooled.metadata = armedMetadata(cooled, now) as Record<string, unknown>;
      expired.metadata = armedMetadata(expired, now - 3_600_000) as Record<string, unknown>;
      expect(isHeartbeatThrottleCooldownActive(cooled)).toBe(true);
      expect(isHeartbeatThrottleCooldownActive(expired)).toBe(false);

      const agentStore = createStatefulMockAgentStore([cooled, expired]);
      const restartDurableAgentHeartbeat = vi.fn().mockResolvedValue(true);
      const manager = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        agentStore,
        restartDurableAgentHeartbeat,
      });

      const recovered = await manager.recoverOrphanedAgents();

      // Non-vacuity control: the expired-cooldown sibling is still auto-recovered, so the
      // mid-cooldown skip is the cooldown gate and not a blanket failure to consider candidates.
      expect(recovered).toBe(1);
      const midCooldown = agentStore.getAgent("mid-cooldown")!;
      expect(midCooldown.state).toBe("error");
      expect(isHeartbeatThrottleCooldownActive(midCooldown)).toBe(true);
      // Deferral is not an attempt: no budget unit is written against a live cooldown.
      expect(readHeartbeatErrorRetryCount(midCooldown)).toBe(0);
      expect(agentStore.updateAgentState).not.toHaveBeenCalledWith("mid-cooldown", expect.anything());
      expect(restartDurableAgentHeartbeat).not.toHaveBeenCalledWith("mid-cooldown", expect.anything());
      expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ target: "mid-cooldown" }));

      const reProbed = agentStore.getAgent("cooldown-expired")!;
      expect(reProbed.state).toBe("active");
      expect(reProbed.lastError).toBeUndefined();
      manager.stop();
    });

    /*
    FNXC:ProviderThrottleIsTransient 2026-09-30-17:12 (RUFU-286 code review P1):
    The sweep's re-probe eligibility write is the SECOND writer that runs against a throttle episode
    from outside the heartbeat (the first is the heartbeat's own run-entry recovery gate). Both burn
    a shared budget unit, and both used to rebuild `heartbeatErrorRecovery` from scratch — which
    silently ended the episode, so the next real probe restarted the backoff at the 60 s floor. The
    P0 was reproduced with the heartbeat's interval in production and could only be observed on the
    METADATA, so the sweep must preserve the streak for the same reason the heartbeat does.
    */
    it("carries the throttle streak across the sweep's own recovery-metadata write", async () => {
      const now = Date.now();
      const expiredEpisode = {
        id: "expired-episode",
        state: "error",
        lastError: THROTTLE_ENVELOPE,
        runtimeConfig: { enabled: true },
        metadata: {
          [HEARTBEAT_ERROR_RECOVERY_METADATA_KEY]: {
            consecutiveAttempts: 1,
            throttleStreak: 2,
            cooldownUntilAt: new Date(now - 60_000).toISOString(),
            updatedAt: new Date(now - 120_000).toISOString(),
          },
        },
        updatedAt: new Date(now - 120_000).toISOString(),
      } as unknown as Agent;
      expect(isHeartbeatThrottleCooldownActive(expiredEpisode)).toBe(false);

      const agentStore = createStatefulMockAgentStore([expiredEpisode]);
      const manager = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        agentStore,
        restartDurableAgentHeartbeat: vi.fn().mockResolvedValue(true),
      });

      expect(await manager.recoverOrphanedAgents()).toBe(1);

      const agent = agentStore.getAgent("expired-episode")!;
      expect(agent.state).toBe("active");
      expect(agent.lastError).toBeUndefined();
      // The sweep is an attempt: the budget moved, so a recovery-metadata write definitely happened.
      const state = readHeartbeatRecoveryState(agent);
      expect(state.consecutiveAttempts).toBe(2);
      // ...and that write is the throttle-preserving one: only the expired horizon is withdrawn.
      expect(state.throttleStreak).toBe(2);
      expect(state.cooldownUntilAt).toBeNull();
      expect(isHeartbeatThrottleCooldownActive(agent)).toBe(false);
      manager.stop();
    });

    it("never re-parks an exhausted throttle episode in a loop", async () => {
      const now = Date.now();
      const exhaustedAgent = {
        id: "exhausted-throttle",
        state: "paused",
        pauseReason: HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON,
        lastError: THROTTLE_ENVELOPE,
        runtimeConfig: { enabled: true },
        metadata: { [HEARTBEAT_ERROR_RECOVERY_METADATA_KEY]: { consecutiveAttempts: 5 } },
        updatedAt: new Date(now - 120_000).toISOString(),
      } as unknown as Agent;
      const agentStore = createStatefulMockAgentStore([exhaustedAgent]);
      const manager = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        agentStore,
        restartDurableAgentHeartbeat: vi.fn().mockResolvedValue(true),
      });

      // Two passes: a re-admission loop would show up as repeated state writes/audits here.
      expect(await manager.recoverOrphanedAgents()).toBe(0);
      expect(await manager.recoverOrphanedAgents()).toBe(0);

      const agent = agentStore.getAgent("exhausted-throttle")!;
      expect(agent.state).toBe("paused");
      expect(agent.pauseReason).toBe(HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON);
      expect(agentStore.updateAgentState).not.toHaveBeenCalledWith("exhausted-throttle", expect.anything());
      expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
      manager.stop();
    });
  });
});
