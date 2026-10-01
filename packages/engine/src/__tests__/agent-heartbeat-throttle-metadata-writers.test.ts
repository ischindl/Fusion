/*
FNXC:ProviderThrottleIsTransient 2026-09-30-16:55 (RUFU-286 code review P0):
Unit-level pins for the ONE writer set that owns the `heartbeatErrorRecovery` row shape.

The P0 defect these pin is invisible from any single call site: `cooldownUntilAt` (a promise of a
re-probe at an instant) and `throttleStreak` (how many consecutive throttles this episode has seen,
i.e. the backoff exponent) are two facts and only the first one expires. The preserving budget
builder used to drop BOTH as soon as the horizon was unreadable, and the horizon is crossed at
exactly one instant — the run-entry recovery-gate increment — so every re-probe recomputed streak 1
and the wait was pinned at the 60 s floor forever (never 120 → 240 → 480 → 900) while the 5-unit
budget burned in ~5 min of sustained throttling.

Why a metadata-level file at all, when `agent-heartbeat-throttle-cooldown.test.ts` already drives the
lifecycle: the two facts are the row's contract, and only this seam can compare an arm against the
metadata the *previous* increment wrote without moving a clock. The lifecycle file proves production
ordering; this file proves the writers, including the hostile/legacy row shapes a lifecycle test
cannot reach.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@fusion/core";
import {
  HEARTBEAT_ERROR_RECOVERY_METADATA_KEY,
  THROTTLE_BACKOFF_CAP_MS,
  THROTTLE_BACKOFF_FLOOR_MS,
  describeHeartbeatThrottle,
  isHeartbeatThrottleCooldownActive,
  readHeartbeatRecoveryState,
  throttleBackoffMs,
} from "@fusion/core";
import {
  armHeartbeatThrottleCooldown,
  buildHeartbeatErrorRecoveryMetadata,
  buildHeartbeatErrorRecoveryMetadataPreservingThrottle,
  buildHeartbeatThrottleExhaustionMetadata,
  incrementHeartbeatErrorRecoveryMetadata,
  readHeartbeatErrorRetryCount,
  resetHeartbeatErrorRecoveryMetadata,
} from "../agent-heartbeat.js";

/** Fixed clock: every horizon assertion is absolute, never a race against the host clock. */
const NOW = Date.parse("2026-09-30T12:00:00.000Z");

/** A durable coordinator mid-episode: the row shape a re-probe actually finds on the store. */
function agentWithRow(
  row: Record<string, unknown>,
  patch: Partial<Agent> = {},
): Agent {
  return {
    id: "agent-writers",
    name: "Coordinator",
    role: "executor",
    state: "error",
    metadata: { [HEARTBEAT_ERROR_RECOVERY_METADATA_KEY]: row },
    ...patch,
  } as unknown as Agent;
}

/** The row after a writer's patch, read through the SAME reader every operator surface uses. */
function rowOf(metadata: Record<string, unknown>) {
  return (metadata[HEARTBEAT_ERROR_RECOVERY_METADATA_KEY] ?? {}) as Record<string, unknown>;
}

describe("heartbeat recovery metadata writers (RUFU-286 P0)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("budget increment at the cooldown horizon", () => {
    it("keeps throttleStreak and drops only the expired cooldownUntilAt", () => {
      const armedAt = NOW;
      const agent = agentWithRow({
        consecutiveAttempts: 0,
        throttleStreak: 1,
        cooldownUntilAt: new Date(armedAt + THROTTLE_BACKOFF_FLOOR_MS).toISOString(),
      });

      // The production call: the run-entry recovery gate burns one budget unit at the horizon.
      const written = incrementHeartbeatErrorRecoveryMetadata(agent, armedAt + THROTTLE_BACKOFF_FLOOR_MS);
      const row = rowOf(written);

      // THE regression: the exponent survives the instant the wait is crossed.
      expect(row.throttleStreak).toBe(1);
      // ...and the row's agent, read back through the shared reader, still carries the episode.
      expect(readHeartbeatRecoveryState({ metadata: written }).throttleStreak).toBe(1);
      // The crossed promise itself is withdrawn — nothing owns a re-probe at a past instant.
      expect(row.cooldownUntilAt).toBeUndefined();
      expect(isHeartbeatThrottleCooldownActive({ metadata: written })).toBe(false);
      // The budget unit is still burned, unchanged in shape.
      expect(row.consecutiveAttempts).toBe(1);
      expect(readHeartbeatErrorRetryCount({ metadata: written })).toBe(1);
    });

    it("escalates the very next arm to the second rung instead of restarting at the floor", () => {
      const agent = agentWithRow({
        consecutiveAttempts: 0,
        throttleStreak: 1,
        cooldownUntilAt: new Date(NOW + THROTTLE_BACKOFF_FLOOR_MS).toISOString(),
      });
      const afterProbe = incrementHeartbeatErrorRecoveryMetadata(agent, NOW + THROTTLE_BACKOFF_FLOOR_MS);

      // The provider throttles again at the end of that probe: the arm must read the preserved streak.
      const armed = armHeartbeatThrottleCooldown({ metadata: afterProbe }, NOW + THROTTLE_BACKOFF_FLOOR_MS);

      expect(armed.throttleStreak).toBe(2);
      expect(armed.backoffMs).toBe(THROTTLE_BACKOFF_FLOOR_MS * 2);
      expect(Date.parse(armed.cooldownUntilAt)).toBe(NOW + THROTTLE_BACKOFF_FLOOR_MS + THROTTLE_BACKOFF_FLOOR_MS * 2);
    });

    it("walks the whole ladder when a budget increment interleaves every arm", () => {
      // The production order: arm → horizon crossed → budget increment → throttled again → arm.
      let metadata: Record<string, unknown> = {};
      const waits: number[] = [];
      let clock = NOW;
      for (let probe = 0; probe < 6; probe += 1) {
        const armed = armHeartbeatThrottleCooldown({ metadata }, clock);
        waits.push(armed.backoffMs);
        metadata = armed.metadata;
        clock = Date.parse(armed.cooldownUntilAt);
        metadata = incrementHeartbeatErrorRecoveryMetadata({ metadata }, clock);
      }

      expect(waits).toEqual([
        60_000,
        120_000,
        240_000,
        480_000,
        THROTTLE_BACKOFF_CAP_MS,
        THROTTLE_BACKOFF_CAP_MS,
      ]);
      // Six throttles burned exactly six budget units — the ladder does not spend extra attempts.
      expect(readHeartbeatErrorRetryCount({ metadata })).toBe(6);
      expect(readHeartbeatRecoveryState({ metadata }).throttleStreak).toBe(6);
    });

    it("keeps an unexpired horizon so a restart does not lose the scheduled re-probe", () => {
      const cooldownUntilAt = new Date(NOW + THROTTLE_BACKOFF_FLOOR_MS).toISOString();
      const agent = agentWithRow({ consecutiveAttempts: 1, throttleStreak: 3, cooldownUntilAt });

      // Mid-cooldown budget write (self-healing backstop / any foreign increment).
      const written = buildHeartbeatErrorRecoveryMetadataPreservingThrottle(agent, 2, NOW);

      expect(rowOf(written)).toMatchObject({ consecutiveAttempts: 2, throttleStreak: 3, cooldownUntilAt });
      expect(isHeartbeatThrottleCooldownActive({ metadata: written })).toBe(true);
    });

    it("keeps the streak when the horizon is corrupt or missing, because only that field is unreadable", () => {
      const hostile = agentWithRow({ consecutiveAttempts: 2, throttleStreak: 4, cooldownUntilAt: "not-a-date" });
      const missing = agentWithRow({ consecutiveAttempts: 2, throttleStreak: 4 });

      for (const agent of [hostile, missing]) {
        const written = buildHeartbeatErrorRecoveryMetadataPreservingThrottle(agent, 3, NOW);
        const row = rowOf(written);
        expect(row.throttleStreak).toBe(4);
        expect(row.cooldownUntilAt).toBeUndefined();
        expect(row.consecutiveAttempts).toBe(3);
      }
    });

    it("writes the legacy two-field row when no episode exists, so ordinary failures gain no noise", () => {
      const legacy = agentWithRow({ consecutiveAttempts: 2, updatedAt: new Date(NOW).toISOString() });

      const written = incrementHeartbeatErrorRecoveryMetadata(legacy, NOW);

      expect(Object.keys(rowOf(written)).sort()).toEqual(["consecutiveAttempts", "updatedAt"]);
      // Non-vacuity control: the same writer on an episode-bearing row DOES carry the third field.
      const episode = agentWithRow({ consecutiveAttempts: 2, throttleStreak: 1 });
      expect(rowOf(incrementHeartbeatErrorRecoveryMetadata(episode, NOW)).throttleStreak).toBe(1);
    });
  });

  describe("who is allowed to END an episode", () => {
    it("clears both throttle fields on a success reset", () => {
      const agent = agentWithRow({
        consecutiveAttempts: 3,
        throttleStreak: 4,
        cooldownUntilAt: new Date(NOW + THROTTLE_BACKOFF_FLOOR_MS).toISOString(),
      });

      const reset = resetHeartbeatErrorRecoveryMetadata(agent);

      expect(readHeartbeatRecoveryState({ metadata: reset })).toMatchObject({
        consecutiveAttempts: 0,
        throttleStreak: 0,
        cooldownUntilAt: null,
      });
    });

    it("clears both throttle fields on the clearing budget write (a non-throttle failure took over)", () => {
      const agent = agentWithRow({
        consecutiveAttempts: 2,
        throttleStreak: 2,
        cooldownUntilAt: new Date(NOW + THROTTLE_BACKOFF_FLOOR_MS).toISOString(),
      });

      const written = buildHeartbeatErrorRecoveryMetadata(agent, 3);

      expect(rowOf(written).throttleStreak).toBeUndefined();
      expect(rowOf(written).cooldownUntilAt).toBeUndefined();
      expect(rowOf(written).consecutiveAttempts).toBe(3);
    });

    it("keeps the streak but withdraws the re-probe promise on the exhaustion park", () => {
      const agent = agentWithRow({
        consecutiveAttempts: 5,
        throttleStreak: 3,
        cooldownUntilAt: new Date(NOW + THROTTLE_BACKOFF_FLOOR_MS).toISOString(),
      });

      const parked = buildHeartbeatThrottleExhaustionMetadata(agent, 5);
      const state = readHeartbeatRecoveryState({ metadata: parked });

      // A paused card advertises no re-probe: the timer stops dispatching paused agents.
      expect(state.cooldownUntilAt).toBeNull();
      expect(isHeartbeatThrottleCooldownActive({ metadata: parked })).toBe(false);
      // ...but the episode stays attributable: this is the only record of WHAT ate the budget.
      expect(state.throttleStreak).toBe(3);
      expect(describeHeartbeatThrottle({
        state: "paused",
        pauseReason: "error-retry-exhausted",
        metadata: parked,
      })).toMatchObject({ kind: "throttle-exhausted", throttleStreak: 3, consecutiveAttempts: 5 });
    });

    it("preserves unrelated metadata keys through every writer", () => {
      const agent = {
        id: "agent-writers",
        metadata: {
          custom: "keep me",
          durableErrorRecovery: { attempts: 2 },
          [HEARTBEAT_ERROR_RECOVERY_METADATA_KEY]: { consecutiveAttempts: 1, throttleStreak: 2 },
        },
      } as unknown as Agent;

      for (const written of [
        incrementHeartbeatErrorRecoveryMetadata(agent, NOW),
        buildHeartbeatErrorRecoveryMetadata(agent, 2),
        buildHeartbeatThrottleExhaustionMetadata(agent, 2),
      ]) {
        expect(written.custom).toBe("keep me");
        expect(written.durableErrorRecovery).toEqual({ attempts: 2 });
      }
      // The success reset is the one writer that drops the legacy duplicate budget.
      expect(resetHeartbeatErrorRecoveryMetadata(agent).durableErrorRecovery).toBeUndefined();
      expect(resetHeartbeatErrorRecoveryMetadata(agent).custom).toBe("keep me");
    });
  });

  describe("shared backoff bounds stay the single source of truth", () => {
    it("derives every armed wait from throttleBackoffMs", () => {
      for (const streak of [1, 2, 5, 9]) {
        const armed = armHeartbeatThrottleCooldown(
          agentWithRow({ consecutiveAttempts: 0, throttleStreak: streak - 1 }),
          NOW,
        );
        expect(armed.backoffMs).toBe(throttleBackoffMs(streak));
      }
    });
  });
});
