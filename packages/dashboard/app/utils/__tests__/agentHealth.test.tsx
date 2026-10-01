import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { JSX } from "react";
import {
  getAgentHealthStatus,
  getAgentHealthColorVar,
  AGENT_HEALTH_LABEL_AWAITING_APPROVAL,
  AGENT_HEALTH_LABEL_RATE_LIMITED,
} from "../agentHealth";
import { PAUSE_REASON_LABELS } from "../stallReason";
import type { Agent } from "../../api";

// Mock Date.now to get deterministic elapsed time calculations
const FIXED_NOW = new Date("2026-04-10T12:00:00.000Z").getTime();

type AgentHealthInput = Pick<
  Agent,
  | "state"
  | "lastHeartbeatAt"
  | "lastError"
  | "pauseReason"
  | "runtimeConfig"
  | "metadata"
  | "name"
  | "role"
  | "taskId"
  // RUFU-177: the approval count is a pill input now (it mirrors the module's own input Pick).
  | "pendingApprovalCount"
>;

function makeAgent(overrides: Partial<AgentHealthInput> = {}): AgentHealthInput {
  return {
    name: "Test Agent",
    role: "executor",
    state: "idle",
    taskId: undefined,
    metadata: {},
    lastHeartbeatAt: undefined,
    lastError: undefined,
    pauseReason: undefined,
    runtimeConfig: undefined,
    pendingApprovalCount: undefined,
    ...overrides,
  };
}

describe("getAgentHealthStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("error state", () => {
    it('returns "Error" for error agents without lastError', () => {
      const agent = makeAgent({ state: "error" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Error");
      expect(status.stateDerived).toBe(true);
      expect(status.color).toBe("var(--state-error-text)");
    });

    it("uses lastError as label when available", () => {
      const agent = makeAgent({ state: "error", lastError: "Agent crashed" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Agent crashed");
      expect(status.stateDerived).toBe(false);
    });

    it("ignores heartbeat data for error agents", () => {
      const agent = makeAgent({
        state: "error",
        lastHeartbeatAt: new Date(FIXED_NOW - 1000).toISOString(),
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Error");
      expect(status.stateDerived).toBe(true);
    });
  });

  /*
  FNXC:ProviderThrottleIsTransient 2026-09-30-14:58 (RUFU-286):
  The reported incident, on the surface that actually misled the operator. The pill printed the raw
  upstream wrapper body, whose tail says `unknown model, no fallback configured` — text that reads as
  "a model name is broken, go fix configuration" — while the real cause was a 429 account rate limit
  the engine was already waiting out. These cases pin the whole distinction: the cooldown outranks the
  body, the body survives as tooltip evidence, and BOTH controls prove the gate is the live cooldown
  rather than `lastError` never being allowed to render at all.
  */
  describe("provider throttle cooldown", () => {
    const THROTTLE_ENVELOPE = 'Unable to select a usable model after 1 attempt (primary unknown model, no fallback configured, trigger: prompt-time): 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011Cf3ZXBTF3bymyoFWRQy3t"}';
    const cooldownMetadata = (untilAt: string) => ({
      heartbeatErrorRecovery: {
        consecutiveAttempts: 1,
        updatedAt: new Date(FIXED_NOW).toISOString(),
        throttleStreak: 2,
        cooldownUntilAt: untilAt,
      },
    });
    const retryingAt = new Date(FIXED_NOW + 120_000).toISOString();

    it('labels a cooled-down throttled agent "Rate limited" instead of printing the provider body', () => {
      const status = getAgentHealthStatus(makeAgent({
        state: "error",
        lastError: THROTTLE_ENVELOPE,
        metadata: cooldownMetadata(retryingAt),
      }));

      expect(status.label).toBe(AGENT_HEALTH_LABEL_RATE_LIMITED);
      // The misdiagnosis text must never reach the headline again.
      expect(status.label).not.toContain("unknown model");
      expect(status.label).not.toContain("429");
      // The raw body is demoted to evidence, not deleted.
      expect(status.reason).toContain("429");
      expect(status.reason).toContain(retryingAt);
    });

    it("keeps printing the provider body once the cooldown has elapsed", () => {
      // Control for the case above: the gate is a LIVE cooldown, not a blanket ban on lastError.
      const elapsed = new Date(FIXED_NOW - 1).toISOString();
      const status = getAgentHealthStatus(makeAgent({
        state: "error",
        lastError: THROTTLE_ENVELOPE,
        metadata: cooldownMetadata(elapsed),
      }));

      expect(status.label).toBe(THROTTLE_ENVELOPE);
    });

    it("does not pre-empt a pending approval the operator can act on", () => {
      // The cooldown keeps running underneath either way; the actionable wait is what gets named.
      const status = getAgentHealthStatus(makeAgent({
        state: "error",
        lastError: THROTTLE_ENVELOPE,
        pendingApprovalCount: 1,
        metadata: cooldownMetadata(retryingAt),
      }));

      expect(status.label).toBe(AGENT_HEALTH_LABEL_AWAITING_APPROVAL);
    });

    it("does not promise a retry to a paused agent whose throttle budget ran out", () => {
      const status = getAgentHealthStatus(makeAgent({
        state: "paused",
        pauseReason: "error-retry-exhausted",
        lastError: THROTTLE_ENVELOPE,
        metadata: cooldownMetadata(retryingAt),
      }));

      expect(status.label).toBe(PAUSE_REASON_LABELS["error-retry-exhausted"]);
      expect(status.reason ?? "").not.toContain(retryingAt);
    });
  });

  describe("paused state", () => {
    it('returns "Paused" for paused agents without pauseReason', () => {
      const agent = makeAgent({ state: "paused" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Paused");
      expect(status.stateDerived).toBe(true);
      expect(status.color).toBe("var(--state-paused-text)");
    });

    it("includes pauseReason in label when available", () => {
      const agent = makeAgent({ state: "paused", pauseReason: "User requested" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Paused: User requested");
      expect(status.stateDerived).toBe(false);
    });

    /*
    FNXC:StallReason 2026-09-01-18:47 (RUFU-175):
    The health pill must speak the same words as every other stall surface for a pause reason the
    shared code table knows, instead of leaking the raw engine code. A code the table does NOT know
    yet keeps the verbatim `Paused: <raw>` fallback so a future reason is never hidden.
    */
    it("maps a known pause reason through the shared code table instead of the raw code", () => {
      const status = getAgentHealthStatus(makeAgent({ state: "paused", pauseReason: "error-retry-exhausted" }));
      expect(status.label).toBe("Automatic retries exhausted");
      expect(status.label).not.toContain("error-retry-exhausted");
    });

    it("keeps an unrecognized pause reason verbatim as the Paused:<code> fallback", () => {
      const status = getAgentHealthStatus(makeAgent({ state: "paused", pauseReason: "future-reason-code" }));
      expect(status.label).toBe("Paused: future-reason-code");
    });

    it("ignores heartbeat data for paused agents", () => {
      const agent = makeAgent({
        state: "paused",
        lastHeartbeatAt: new Date(FIXED_NOW - 1000).toISOString(),
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Paused");
      expect(status.stateDerived).toBe(true);
    });
  });

  /*
  FNXC:AgentHealthPill 2026-09-02-22:39 (RUFU-177):
  Pins the pill's precedence ladder for a pending approval: Error > named non-approval pause >
  AWAITING APPROVAL > heartbeat verdicts > Running/Healthy. The approval state deliberately OUTRANKS the
  heartbeat-unresponsive branches (spec Step 4): an agent parked at the gate stops heartbeating, so a
  stale beat beside a pending approval is the SYMPTOM of the wait, not a competing diagnosis --
  reporting "Unresponsive" there told operators to kill a process that was merely waiting for a click.
  The label is the catalog's `agents.stallReason.awaiting-approval` wording ("Waiting for approval"),
  what the Fleet/Agents stall column already says -- not the stall resolver's chip wording.
  */
  describe("approval-parked agent", () => {
    const freshBeat = () => new Date(FIXED_NOW - 30_000).toISOString();

    it('names the wait for an agent blocked on the gate while still reporting "running"', () => {
      const status = getAgentHealthStatus(makeAgent({ state: "running", pendingApprovalCount: 2 }));
      expect(status.label).toBe("Waiting for approval");
      expect(status.stateDerived).toBe(false);
    });

    it('reads "Waiting for approval" for an engine approval PARK, byte-identically to the count branch', () => {
      // Completion criterion: the parked and the counted paths cannot disagree on the pill.
      const parked = getAgentHealthStatus(
        makeAgent({ state: "paused", pauseReason: "awaiting-approval", pendingApprovalCount: 2 }),
      );
      const counted = getAgentHealthStatus(makeAgent({ state: "running", pendingApprovalCount: 2 }));
      expect(parked.label).toBe("Waiting for approval");
      expect(parked.label).toBe(counted.label);
      expect(parked.color).toBe(counted.color);
    });

    it('names the wait instead of "Healthy" for a live agent that is simply sitting idle', () => {
      const status = getAgentHealthStatus(
        makeAgent({ state: "idle", lastHeartbeatAt: freshBeat(), pendingApprovalCount: 1 }),
      );
      expect(status.label).toBe("Waiting for approval");
    });

    it("outranks the heartbeat-unresponsive verdict -- the spec's core symptom (waiting != dead)", () => {
      // An agent parked at the gate stops heartbeating; this used to read "Unresponsive" and send
      // operators to restart a process that was merely waiting for a click.
      const status = getAgentHealthStatus(
        makeAgent({ state: "idle", lastHeartbeatAt: new Date(FIXED_NOW - 5 * 3_600_000).toISOString(), pendingApprovalCount: 2 }),
      );
      expect(status.label).toBe("Waiting for approval");
    });

    it("outranks heartbeat-disabled and never-beaten labels for the same reason", () => {
      expect(
        getAgentHealthStatus(makeAgent({ state: "active", runtimeConfig: { enabled: false }, pendingApprovalCount: 2 })).label,
      ).toBe("Waiting for approval");
      expect(getAgentHealthStatus(makeAgent({ state: "active", pendingApprovalCount: 2 })).label).toBe("Waiting for approval");
    });

    it('keeps "Running" when there is nothing to approve', () => {
      expect(getAgentHealthStatus(makeAgent({ state: "running", pendingApprovalCount: 0 })).label).toBe("Running");
      expect(getAgentHealthStatus(makeAgent({ state: "running" })).label).toBe("Running");
    });

    it("lets a real failure or a differently-named pause outrank the count", () => {
      expect(
        getAgentHealthStatus(makeAgent({ state: "error", lastError: "Agent crashed", pendingApprovalCount: 3 })).label,
      ).toBe("Agent crashed");
      // The paused branch prints its own pause reason; the count adds no better information than that.
      expect(
        getAgentHealthStatus(
          makeAgent({ state: "paused", pauseReason: "budget-exhausted", pendingApprovalCount: 3 }),
        ).label,
      ).toBe("Output budget exhausted");
    });
  });

  describe("running state", () => {
    it('returns "Running" for running agents', () => {
      const agent = makeAgent({ state: "running" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Running");
      expect(status.stateDerived).toBe(true);
      expect(status.color).toBe("var(--state-active-text)");
    });

    it("ignores heartbeat data for running agents", () => {
      const agent = makeAgent({
        state: "running",
        lastHeartbeatAt: new Date(FIXED_NOW - 100_000).toISOString(), // 100s ago - would be "unresponsive" without this
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Running");
      expect(status.stateDerived).toBe(true);
    });
  });

  // Heartbeat disabled is a real durable-agent state in the UI. Task workers
  // still follow execution-state health because their runtimeConfig.enabled
  // flag only opts them out of scheduler timers.

  describe("task worker health classification", () => {
    it('returns "Running" for metadata-marked task workers with disabled heartbeat', () => {
      const agent = makeAgent({
        name: "executor-FN-1661",
        role: "executor",
        state: "active",
        taskId: "FN-1661",
        metadata: {
          agentKind: "task-worker",
          taskWorker: true,
          managedBy: "task-executor",
        },
        lastHeartbeatAt: new Date(FIXED_NOW - 1_000_000).toISOString(),
        runtimeConfig: { enabled: false, heartbeatTimeoutMs: 60_000 },
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Running");
      expect(status.stateDerived).toBe(true);
      expect(status.color).toBe("var(--state-active-text)");
    });

    it('returns "Running" for legacy executor-* task workers with stale heartbeat', () => {
      const agent = makeAgent({
        name: "executor-FN-1661",
        role: "executor",
        state: "active",
        taskId: "FN-1661",
        lastHeartbeatAt: new Date(FIXED_NOW - 1_000_000).toISOString(),
        runtimeConfig: { heartbeatTimeoutMs: 30_000 },
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Running");
      expect(status.stateDerived).toBe(true);
      expect(status.color).toBe("var(--state-active-text)");
    });

    it('returns "Heartbeat Disabled" for non-task-worker agents with heartbeat disabled', () => {
      const agent = makeAgent({
        name: "Reviewer",
        role: "reviewer",
        state: "active",
        runtimeConfig: { enabled: false },
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Heartbeat Disabled");
      expect(status.stateDerived).toBe(false);
      expect(status.color).toBe("var(--state-paused-text)");
    });

    it('returns "Heartbeat Disabled" even when a disabled durable agent has a recent heartbeat', () => {
      const agent = makeAgent({
        name: "Reviewer",
        role: "reviewer",
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 1_000).toISOString(),
        runtimeConfig: { enabled: false, heartbeatIntervalMs: 60_000 },
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Heartbeat Disabled");
    });
  });

  // ── No heartbeat data ──────────────────────────────────────────────────────

  describe("no heartbeat data", () => {
    it('returns "Starting..." for active agents with no lastHeartbeatAt', () => {
      const agent = makeAgent({ state: "active" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Starting...");
      expect(status.stateDerived).toBe(false);
      expect(status.color).toBe("var(--text-muted)");
    });

    it('returns "Idle" for non-active agents with no lastHeartbeatAt', () => {
      const agent = makeAgent({ state: "idle" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Idle");
      expect(status.stateDerived).toBe(false);
      expect(status.color).toBe("var(--text-muted)");
    });

  });

  // ── Healthy vs Unresponsive ───────────────────────────────────────────────

  describe("heartbeat freshness", () => {
    it('returns "Healthy" when heartbeat is fresh (within timeout) with periodic heartbeat', () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 30_000).toISOString(), // 30s ago, well within 60s timeout
        runtimeConfig: { heartbeatIntervalMs: 30_000 }, // periodic heartbeat configured
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy");
      expect(status.stateDerived).toBe(false);
      expect(status.color).toBe("var(--state-active-text)");
    });

    it('returns "Healthy" when heartbeat is exactly at the timeout boundary with periodic heartbeat', () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 60_000).toISOString(), // exactly 60s ago
        runtimeConfig: { heartbeatIntervalMs: 30_000 }, // periodic heartbeat configured
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy");
      expect(status.stateDerived).toBe(false);
    });

    it('returns "Unresponsive" when heartbeat exceeds the freshness threshold with periodic heartbeat', () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 24 * 60 * 1000 - 1).toISOString(), // just over 24 minutes ago
        runtimeConfig: { heartbeatIntervalMs: 6 * 60 * 1000 }, // 6 minute interval
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Unresponsive");
      expect(status.stateDerived).toBe(false);
      expect(status.color).toBe("var(--state-error-text)");
    });

    it("ignores heartbeatTimeoutMs — that's the per-run work budget, not freshness", () => {
      // 30s interval → staleness threshold = max(60s floor, 60s) = 60s. A
      // 45s-old heartbeat is healthy regardless of what heartbeatTimeoutMs says.
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 45_000).toISOString(),
        runtimeConfig: { heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 30_000 },
      });
      expect(getAgentHealthStatus(agent).label).toBe("Healthy");
    });

    it("FN-8190: applies the project multiplier once before classifying long-cadence agents", () => {
      // Field configuration: raw 3h cadence with a 7.5x project multiplier.
      // At 13h, raw 4x grace would falsely label this agent Unresponsive; the
      // 22h30m effective cadence has a 90h dashboard grace window instead.
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 13 * 3_600_000).toISOString(),
        runtimeConfig: { heartbeatIntervalMs: 3 * 3_600_000 },
      });

      expect(getAgentHealthStatus(agent, 7.5).label).toBe("Healthy");
    });

    it("FN-8190: preserves strict dashboard boundaries for sub-one, default, and field multipliers", () => {
      const rawIntervalMs = 3 * 3_600_000;
      for (const multiplier of [0.5, 1, 7.5]) {
        const thresholdMs = rawIntervalMs * multiplier * 4;
        const agent = (ageMs: number) => makeAgent({
          state: "active",
          lastHeartbeatAt: new Date(FIXED_NOW - ageMs).toISOString(),
          runtimeConfig: { heartbeatIntervalMs: rawIntervalMs },
        });

        expect(getAgentHealthStatus(agent(thresholdMs - 1), multiplier).label).toBe("Healthy");
        expect(getAgentHealthStatus(agent(thresholdMs), multiplier).label).toBe("Healthy");
        expect(getAgentHealthStatus(agent(thresholdMs + 1), multiplier).label).toBe("Unresponsive");
      }
    });
  });

  // ── Agents without explicit heartbeatIntervalMs ───────────────────────────
  //
  // Agents that never had an interval persisted still get the server-side
  // default interval (1h), so they render Healthy within ~4h of the last
  // heartbeat and tip into Unresponsive beyond that.

  describe("agents without explicit heartbeatIntervalMs", () => {
    it('returns "Healthy" within the default-interval grace window', () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 60_000).toISOString(), // 1m ago
        runtimeConfig: {}, // no interval — falls back to 1h default
      });
      expect(getAgentHealthStatus(agent).label).toBe("Healthy");
    });

    it('returns "Unresponsive" once elapsed exceeds 4× the default 1h interval', () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 5 * 3_600_000).toISOString(), // 5h ago
        runtimeConfig: {},
      });
      expect(getAgentHealthStatus(agent).label).toBe("Unresponsive");
    });

    it("reproduces the FN-8018 field ages against the default 4h grace boundary", () => {
      const fieldAgents = [
        { name: "Backend Engineer", ageMs: 6 * 3_600_000 + 32 * 60_000 },
        { name: "Frontend Engineer", ageMs: 5 * 3_600_000 + 59 * 60_000 },
        { name: "Technical Writer", ageMs: 6 * 3_600_000 + 34 * 60_000 },
      ];

      for (const fieldAgent of fieldAgents) {
        expect(getAgentHealthStatus(makeAgent({
          name: fieldAgent.name,
          state: "active",
          lastHeartbeatAt: new Date(FIXED_NOW - fieldAgent.ageMs).toISOString(),
          runtimeConfig: {},
        })).label).toBe("Unresponsive");
      }

      expect(getAgentHealthStatus(makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 4 * 3_600_000).toISOString(),
        runtimeConfig: {},
      })).label).toBe("Healthy");
      expect(getAgentHealthStatus(makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 4 * 3_600_000 - 1).toISOString(),
        runtimeConfig: {},
      })).label).toBe("Unresponsive");
    });

    it("clamps invalid intervals (0/negative) to the dashboard minimum (5m)", () => {
      // 0 clamp to 300000ms (5m minimum) → threshold = max(300000 × 4, 300000) = 1,200,000ms (20 minutes).
      // A heartbeat 21 minutes old is stale.
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 1_260_000).toISOString(), // 21 minutes ago
        runtimeConfig: { heartbeatIntervalMs: 0 },
      });
      expect(getAgentHealthStatus(agent).label).toBe("Unresponsive");
    });
  });

  // ── Staleness floor ───────────────────────────────────────────────────────
  //
  // Short intervals get a 5m floor so the UI doesn't flicker between
  // Healthy and Unresponsive every tick for second-level heartbeats.

  describe("staleness floor", () => {
    it("holds Healthy below the 5m floor even for sub-minute intervals", () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 30_000).toISOString(),
        runtimeConfig: { heartbeatIntervalMs: 10_000 },
      });
      expect(getAgentHealthStatus(agent).label).toBe("Healthy");
    });

    it("tips to Unresponsive past the floor", () => {
      // 6 minute interval → threshold = max(6m × 4, 5m floor) = 24 minutes.
      // A heartbeat 25 minutes old exceeds the threshold.
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 25 * 60 * 1000).toISOString(), // 25 minutes ago
        runtimeConfig: { heartbeatIntervalMs: 6 * 60 * 1000 }, // 6 minute interval
      });
      expect(getAgentHealthStatus(agent).label).toBe("Unresponsive");
    });
  });

  describe("stateDerived semantics", () => {
    it.each([
      {
        name: "paused without reason",
        agent: makeAgent({ state: "paused" }),
        expectedLabel: "Paused",
        expectedStateDerived: true,
      },
      {
        name: "paused with reason",
        agent: makeAgent({ state: "paused", pauseReason: "Backoff" }),
        expectedLabel: "Paused: Backoff",
        expectedStateDerived: false,
      },
      {
        name: "running",
        agent: makeAgent({ state: "running" }),
        expectedLabel: "Running",
        expectedStateDerived: true,
      },
      {
        name: "error without lastError",
        agent: makeAgent({ state: "error" }),
        expectedLabel: "Error",
        expectedStateDerived: true,
      },
      {
        name: "error with lastError",
        agent: makeAgent({ state: "error", lastError: "OOM" }),
        expectedLabel: "OOM",
        expectedStateDerived: false,
      },
      {
        name: "healthy",
        agent: makeAgent({ state: "active", lastHeartbeatAt: new Date(FIXED_NOW - 10_000).toISOString() }),
        expectedLabel: "Healthy",
        expectedStateDerived: false,
      },
      {
        name: "unresponsive",
        agent: makeAgent({
          state: "active",
          lastHeartbeatAt: new Date(FIXED_NOW - 25 * 60 * 1000).toISOString(), // 25 minutes ago
          runtimeConfig: { heartbeatIntervalMs: 6 * 60 * 1000 }, // 6 minute interval
        }),
        expectedLabel: "Unresponsive",
        expectedStateDerived: false,
      },
      {
        name: "idle",
        agent: makeAgent({ state: "idle", lastHeartbeatAt: undefined }),
        expectedLabel: "Idle",
        expectedStateDerived: false,
      },
      {
        name: "starting",
        agent: makeAgent({ state: "active", lastHeartbeatAt: undefined }),
        expectedLabel: "Starting...",
        expectedStateDerived: false,
      },
    ])("sets stateDerived correctly for $name", ({ agent, expectedLabel, expectedStateDerived }) => {
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe(expectedLabel);
      expect(status.stateDerived).toBe(expectedStateDerived);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles null runtimeConfig gracefully", () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 30_000).toISOString(),
        runtimeConfig: null as unknown as undefined,
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy");
      expect(status.stateDerived).toBe(false);
    });

    it("handles empty runtimeConfig object", () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 30_000).toISOString(),
        runtimeConfig: {},
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy");
      expect(status.stateDerived).toBe(false);
    });

    it("treats an unparseable persisted heartbeat as Unresponsive instead of Healthy", () => {
      const status = getAgentHealthStatus(makeAgent({
        state: "active",
        lastHeartbeatAt: "not-a-timestamp",
        runtimeConfig: { heartbeatIntervalMs: 60 * 60_000 },
      }));
      expect(status.label).toBe("Unresponsive");
      expect(status.reason).toBe("Last heartbeat timestamp is invalid");
    });

    it("clamps a future heartbeat timestamp to fresh rather than stale", () => {
      expect(getAgentHealthStatus(makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW + 24 * 60 * 60_000).toISOString(),
        runtimeConfig: { heartbeatIntervalMs: 60 * 60_000 },
      })).label).toBe("Healthy");
    });

    it("100s stale heartbeat with no explicit interval → Healthy (default 1h applies)", () => {
      // 1h default interval → 4h threshold, so 100s is well within range.
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 100_000).toISOString(),
        runtimeConfig: { heartbeatTimeoutMs: 120_000 }, // no heartbeatIntervalMs
      });
      expect(getAgentHealthStatus(agent).label).toBe("Healthy");
    });

    it("uses interval-based staleness for enabled durable agents", () => {
      // 6 minute interval → 24 minute threshold. 25 minutes elapsed is stale
      // regardless of any per-run timeout.
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 25 * 60 * 1000).toISOString(), // 25 minutes ago
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 6 * 60 * 1000, heartbeatTimeoutMs: 120_000 },
      });
      expect(getAgentHealthStatus(agent).label).toBe("Unresponsive");
    });

    it("returns consistent icons for all states", () => {
      const testCases: Array<{ agent: ReturnType<typeof makeAgent>; expectedIconType: string }> = [
        { agent: makeAgent({ state: "error" }), expectedIconType: "Activity" },
        { agent: makeAgent({ state: "paused" }), expectedIconType: "Pause" },
        { agent: makeAgent({ state: "running" }), expectedIconType: "Activity" },
        { agent: makeAgent({ state: "idle" }), expectedIconType: "Bot" },
        { agent: makeAgent({ state: "active", runtimeConfig: { enabled: false } }), expectedIconType: "Pause" },
        {
          agent: makeAgent({
            name: "executor-FN-1661",
            role: "executor",
            state: "active",
            taskId: "FN-1661",
            metadata: { agentKind: "task-worker" },
            runtimeConfig: { enabled: false },
          }),
          expectedIconType: "Activity",
        },
        // Active with recent heartbeat should show "Healthy" (Heart icon)
        { agent: makeAgent({ state: "active", lastHeartbeatAt: new Date(FIXED_NOW - 30_000).toISOString() }), expectedIconType: "Heart" },
      ];

      testCases.forEach(({ agent, expectedIconType }) => {
        const status = getAgentHealthStatus(agent);
        // lucide icons expose their component on the JSX element's `type`
        const iconElement = status.icon as JSX.Element & {
          type?: {
            displayName?: string;
            name?: string;
          };
        };
        const iconType = iconElement.type?.displayName ?? iconElement.type?.name;
        expect(iconType).toBe(expectedIconType);
      });
    });
  });
});

describe("getAgentHealthColorVar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("extracts CSS variable name from health status color", () => {
    const agent = makeAgent({ state: "error" });
    const colorVar = getAgentHealthColorVar(agent);
    expect(colorVar).toBe("--state-error-text");
  });

  it("returns full color for non-variable colors (fallback)", () => {
    // This shouldn't happen in practice, but testing the fallback
    const agent = makeAgent({ state: "error" });
    const status = getAgentHealthStatus(agent);
    // The function should return the variable name in var() format
    expect(getAgentHealthColorVar(agent)).toBe(status.color.replace(/var\((--[^)]+)\)/, "$1"));
  });
});

describe("AgentHealthStatus reason field", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes reason on Unresponsive status", () => {
    const agent = makeAgent({
      state: "active",
      lastHeartbeatAt: new Date(FIXED_NOW - 25 * 60 * 1000).toISOString(), // 25 minutes ago
      runtimeConfig: { heartbeatIntervalMs: 6 * 60 * 1000 }, // 6 minute interval
    });
    const status = getAgentHealthStatus(agent);
    expect(status.label).toBe("Unresponsive");
    expect(status.reason).toBeDefined();
    expect(status.reason).toContain("No heartbeat for");
    expect(status.reason).toContain("threshold:");
  });

  it("surfaces unresponsive status when timer repair metadata marks stale and no newer heartbeat exists", () => {
    const repairTime = new Date(FIXED_NOW - 2 * 60 * 1000).toISOString();
    const agent = makeAgent({
      state: "active",
      lastHeartbeatAt: new Date(FIXED_NOW - 20 * 60 * 1000).toISOString(),
      runtimeConfig: { heartbeatIntervalMs: 60 * 60 * 1000 },
      metadata: {
        heartbeatTimerRepair: {
          repairedAt: repairTime,
          staleAtRepair: true,
          staleRepairReason: "No heartbeat before repair",
        },
      },
    });

    const status = getAgentHealthStatus(agent);
    expect(status.label).toBe("Unresponsive");
    expect(status.reason).toBe("No heartbeat before repair");
  });

  it("formats reason with elapsed time and threshold", () => {
    const agent = makeAgent({
      state: "active",
      lastHeartbeatAt: new Date(FIXED_NOW - 90 * 60 * 1000).toISOString(), // 1h 30m ago
      runtimeConfig: { heartbeatIntervalMs: 15 * 60 * 1000 }, // 15m interval → threshold = 60m
    });
    const status = getAgentHealthStatus(agent);
    expect(status.reason).toBe("No heartbeat for 1h 30m (threshold: 1h)");
  });

  it.each([
    { name: "error", agent: makeAgent({ state: "error" }) },
    { name: "paused", agent: makeAgent({ state: "paused" }) },
    { name: "running", agent: makeAgent({ state: "running" }) },
    { name: "idle", agent: makeAgent({ state: "idle" }) },
    {
      name: "healthy",
      agent: makeAgent({ state: "active", lastHeartbeatAt: new Date(FIXED_NOW - 30_000).toISOString() }),
    },
    {
      name: "starting",
      agent: makeAgent({ state: "active" }),
    },
    {
      name: "heartbeat disabled",
      agent: makeAgent({ state: "active", runtimeConfig: { enabled: false } }),
    },
  ])("has no reason on $name status", ({ agent }) => {
    const status = getAgentHealthStatus(agent);
    expect(status.reason).toBeUndefined();
  });
});
