import { describe, expect, it } from "vitest";
import { toStallAgent } from "../stallAgent";
import { resolveStallReason, type Translate } from "../stallReason";

/**
 * FNXC:StallReason 2026-09-02-22:35 (RUFU-177):
 * RUFU-177 Step 4. The agent surfaces wire the owning agent into `resolveStallReason` through this one
 * mapper, so the mapper is where the wrong-owner hazard lives: shared-map staleness or a reassignment
 * race must never let agent B's approval wait stall agent A's card.
 */

function makeT() {
  const calls: Array<{ key: string; fallback: string; resolved: string }> = [];
  const t: Translate = (key, fallback, resolved) => {
    calls.push({ key, fallback, resolved });
    return resolved;
  };
  return { t, calls };
}

/**
 * FNXC:ProviderThrottleIsTransient 2026-09-30-14:58 (RUFU-286): shared card under test for the throttle
 * mappings below — the mapper only reads `assignedAgentId` to prove ownership, while `resolveStallReason`
 * needs a real column/updatedAt, so one shape serves both.
 */
const CARD = {
  id: "FN-701",
  title: "Task",
  column: "in-progress" as const,
  status: "in-progress" as const,
  assignedAgentId: "agent-a",
  createdAt: "2026-09-02T12:00:00.000Z",
  updatedAt: "2026-09-02T12:00:00.000Z",
};

describe("toStallAgent", () => {
  it("maps the owning agent's approval and pause fields through verbatim", () => {
    const stall = toStallAgent(
      { assignedAgentId: "agent-a" },
      {
        id: "agent-a",
        state: "paused",
        pauseReason: "awaiting-approval",
        lastError: null,
        pendingApprovalCount: 2,
      },
    );
    expect(stall).toEqual({
      state: "paused",
      pauseReason: "awaiting-approval",
      lastError: undefined,
      pendingApprovalCount: 2,
    });
  });

  it("normalizes null enrichments to undefined", () => {
    const stall = toStallAgent(
      { assignedAgentId: "agent-a" },
      { id: "agent-a", state: "running", pauseReason: null, lastError: null, pendingApprovalCount: null },
    );
    expect(stall).toEqual({ state: "running", pauseReason: undefined, lastError: undefined, pendingApprovalCount: undefined });
  });

  it("maps a record when the task carries no assignment (caller's intent wins)", () => {
    const stall = toStallAgent({}, { id: "agent-a", state: "running", pendingApprovalCount: 1 });
    expect(stall?.pendingApprovalCount).toBe(1);
  });

  it("drops an agent that does not own the card, so a foreign approval wait cannot stall it", () => {
    const stall = toStallAgent({ assignedAgentId: "agent-a" }, { id: "agent-b", state: "idle", pendingApprovalCount: 3 });
    expect(stall).toBeUndefined();
  });

  it("returns undefined for a missing agent", () => {
    expect(toStallAgent({ assignedAgentId: "agent-a" }, undefined)).toBeUndefined();
    expect(toStallAgent({ assignedAgentId: "agent-a" }, null)).toBeUndefined();
  });

  it("feeds the resolver: mapped owner reaches agent-approval, a dropped foreign owner does not", () => {
    const { t } = makeT();
    const ISO = new Date("2026-09-02T12:00:00.000Z").toISOString();
    const base = {
      id: "FN-700",
      title: "Task",
      column: "in-progress" as const,
      status: "in-progress" as const,
      assignedAgentId: "agent-a",
      createdAt: ISO,
      updatedAt: ISO,
    };

    const owned = resolveStallReason(
      { ...base, stallReason: undefined },
      { t, agent: toStallAgent(base, { id: "agent-a", state: "running", pendingApprovalCount: 1 }) },
    );
    expect(owned?.code).toBe("agent-approval");

    const foreign = resolveStallReason(
      { ...base, stallReason: undefined },
      { t, agent: toStallAgent(base, { id: "agent-b", state: "running", pendingApprovalCount: 1 }) },
    );
    expect(foreign?.code).toBeUndefined();
  });

  /*
  FNXC:ProviderThrottleIsTransient 2026-09-30-14:58 (RUFU-286):
  This mapper is the ONLY place a card learns about a provider throttle, so these two assertions carry the
  single-reader guarantee. The fixture writes the canonical `heartbeatErrorRecovery` envelope the engine
  actually persists — a test that invented its own key names would pass while production stayed broken.
  The controls matter as much as the positive case: an elapsed cooldown and an exhausted park must NOT
  forward a retry date, or the card would promise a re-probe that is never coming.
  */
  it("derives throttleRetryAt from the canonical throttle envelope the engine persists", () => {
    const retryingAt = new Date(Date.now() + 120_000).toISOString();
    const mapped = toStallAgent(
      { ...CARD, stallReason: undefined },
      {
        id: "agent-a",
        state: "error",
        lastError: "429 rate_limit_error (unknown model, no fallback configured)",
        metadata: {
          heartbeatErrorRecovery: {
            consecutiveAttempts: 1,
            updatedAt: new Date().toISOString(),
            throttleStreak: 2,
            cooldownUntilAt: retryingAt,
          },
        },
      },
    );

    expect(mapped?.throttleRetryAt).toBe(retryingAt);

    const { t } = makeT();
    expect(resolveStallReason({ ...CARD, stallReason: undefined }, { t, agent: mapped })?.code).toBe("agent-rate-limited");
  });

  it("forwards no retry date for an elapsed cooldown or an exhausted park", () => {
    const elapsed = toStallAgent(
      { ...CARD, stallReason: undefined },
      {
        id: "agent-a",
        state: "error",
        metadata: {
          heartbeatErrorRecovery: {
            consecutiveAttempts: 1,
            updatedAt: new Date(Date.now() - 600_000).toISOString(),
            throttleStreak: 2,
            cooldownUntilAt: new Date(Date.now() - 60_000).toISOString(),
          },
        },
      },
    );
    expect(elapsed?.throttleRetryAt).toBeUndefined();

    const exhausted = toStallAgent(
      { ...CARD, stallReason: undefined },
      {
        id: "agent-a",
        state: "paused",
        pauseReason: "error-retry-exhausted",
        metadata: {
          heartbeatErrorRecovery: {
            consecutiveAttempts: 5,
            updatedAt: new Date().toISOString(),
            throttleStreak: 5,
          },
        },
      },
    );
    expect(exhausted?.throttleRetryAt).toBeUndefined();
  });
});
