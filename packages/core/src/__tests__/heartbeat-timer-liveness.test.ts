/*
FNXC:ReportsHealth 2026-11-18-14:27 (RUFU-716):
Unit pins for the ONE browser-safe reader of `metadata.heartbeatTimerLiveness` — the record that a
durable lane's heartbeat timer physically fired while the engine deliberately withheld the delivery.

These pins are the safety property of the whole fix. The relief is only honest while it is BOUNDED:
a marker can never relieve beyond the caller's own staleness window, so a timer that died during a
suppressed episode stops being excused as soon as it ages past the window that would have called it
stale anyway. Every hostile shape (absent row, non-object row, unparseable/future `firedAt`, unknown
`reason`) therefore has to resolve to "no relief", never to a thrown error and never to relief — the
dashboard calls this on every render for every agent, and a shape it cannot read must leave the
`Unresponsive` verdict standing.
*/
import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_TIMER_LIVENESS_METADATA_KEY,
  HEARTBEAT_TIMER_LIVENESS_RELIEF_REASONS,
  describeHeartbeatDeliverySkip,
  heartbeatTimerFireAgeMs,
  readHeartbeatTimerLiveness,
} from "../agents/heartbeat-timer-liveness.js";

/** Fixed clock: every age assertion is absolute, never a race against the host clock. */
const NOW = Date.parse("2026-11-18T12:00:00.000Z");

function agentWithRow(row: unknown) {
  return { metadata: { [HEARTBEAT_TIMER_LIVENESS_METADATA_KEY]: row } };
}

function reliefRow(overrides: Record<string, unknown> = {}) {
  return {
    firedAt: new Date(NOW - 60_000).toISOString(),
    reason: "wake-suppressed",
    ...overrides,
  };
}

describe("readHeartbeatTimerLiveness", () => {
  it("reads a well-formed row", () => {
    const firedAt = reliefRow().firedAt;
    expect(readHeartbeatTimerLiveness(agentWithRow(reliefRow()))).toEqual({
      firedAt,
      reason: "wake-suppressed",
      intervalMs: null,
      reliefEligible: true,
    });
  });

  it("keeps a diagnostic interval only when it is a positive finite number", () => {
    expect(readHeartbeatTimerLiveness(agentWithRow(reliefRow({ intervalMs: 3_600_000 }))).intervalMs).toBe(3_600_000);
    for (const bad of [0, -1, Number.NaN, "3600000", null]) {
      expect(readHeartbeatTimerLiveness(agentWithRow(reliefRow({ intervalMs: bad }))).intervalMs).toBeNull();
    }
  });

  it("refuses an absent row (every agent that predates the change)", () => {
    for (const agent of [undefined, null, {}, { metadata: null }, { metadata: {} }]) {
      expect(readHeartbeatTimerLiveness(agent)).toEqual({
        firedAt: null,
        reason: null,
        intervalMs: null,
        reliefEligible: false,
      });
    }
  });

  it("refuses a non-object row instead of throwing", () => {
    for (const hostile of ["yes", 42, true, [], null]) {
      expect(() => readHeartbeatTimerLiveness(agentWithRow(hostile))).not.toThrow();
      expect(readHeartbeatTimerLiveness(agentWithRow(hostile)).reliefEligible).toBe(false);
    }
  });

  it("refuses an unparseable or blank firedAt", () => {
    for (const firedAt of ["not-a-date", "", "   ", 12345, null]) {
      expect(readHeartbeatTimerLiveness(agentWithRow(reliefRow({ firedAt }))).reliefEligible).toBe(false);
    }
  });

  /*
  FNXC:ReportsHealth 2026-11-18-14:27 (RUFU-716 AC2):
  A hand-written or future reason string is the shape that would otherwise launder a dead lane into
  a healthy one, so relief eligibility is an explicit allowlist, never "any non-empty string".
  */
  it("refuses an unknown reason", () => {
    for (const reason of ["global-pause", "enginePaused", "active-run", "", "WAKE-SUPPRESSED", null, 7]) {
      expect(readHeartbeatTimerLiveness(agentWithRow(reliefRow({ reason }))).reliefEligible).toBe(false);
    }
  });

  it.each(["wake-suppressed", "idle-skip", "parallel-execution"])(
    "accepts the relief-eligible reason %s",
    (reason) => {
      expect(readHeartbeatTimerLiveness(agentWithRow(reliefRow({ reason }))).reliefEligible).toBe(true);
    },
  );

  it("exports the relief allowlist it actually applies, so a writer cannot drift from it", () => {
    expect([...HEARTBEAT_TIMER_LIVENESS_RELIEF_REASONS].sort()).toEqual([
      "idle-skip",
      "parallel-execution",
      "wake-suppressed",
    ]);
  });
});

describe("heartbeatTimerFireAgeMs", () => {
  it("measures age against the caller's reference clock, not wall-clock now", () => {
    const agent = agentWithRow(reliefRow({ firedAt: new Date(NOW - 5_000).toISOString() }));
    // Same row, five seconds later in the caller's frame: the age follows the reference.
    expect(heartbeatTimerFireAgeMs(agent, NOW)).toBe(5_000);
    expect(heartbeatTimerFireAgeMs(agent, NOW + 5_000)).toBe(10_000);
    expect(heartbeatTimerFireAgeMs(agent, new Date(NOW + 5_000))).toBe(10_000);
  });

  it("clamps a future firedAt (clock skew) to zero rather than a negative age", () => {
    const agent = agentWithRow(reliefRow({ firedAt: new Date(NOW + 90_000).toISOString() }));
    expect(heartbeatTimerFireAgeMs(agent, NOW)).toBe(0);
  });

  it("answers Infinity for an absent or unreadable fire, so absence never relieves", () => {
    expect(heartbeatTimerFireAgeMs(undefined, NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(heartbeatTimerFireAgeMs({}, NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(heartbeatTimerFireAgeMs(agentWithRow(reliefRow({ firedAt: "nope" })), NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(heartbeatTimerFireAgeMs(agentWithRow(reliefRow({ firedAt: null })), NOW)).toBe(Number.POSITIVE_INFINITY);
    // A non-finite reference clock is an unusable measurement, not a zero-age one.
    expect(heartbeatTimerFireAgeMs(agentWithRow(reliefRow()), Number.NaN)).toBe(Number.POSITIVE_INFINITY);
  });

  it("reads the fire timestamp regardless of reason — eligibility is the display verdict's call", () => {
    // Split of responsibility: the age is a measurement, relief is a decision. An unknown reason
    // still says when the timer fired; `describeHeartbeatDeliverySkip` is what refuses to act on it.
    expect(heartbeatTimerFireAgeMs(agentWithRow(reliefRow({ reason: "made-up" })), NOW)).toBe(60_000);
    expect(describeHeartbeatDeliverySkip(agentWithRow(reliefRow({ reason: "made-up" })), { nowMs: NOW, withinMs: 60_000 })).toBeNull();
  });
});

describe("describeHeartbeatDeliverySkip", () => {
  it("describes a fresh, relief-eligible skip within the caller's window", () => {
    const firedAt = new Date(NOW - 5_000).toISOString();
    expect(describeHeartbeatDeliverySkip(agentWithRow(reliefRow({ firedAt })), { nowMs: NOW, withinMs: 60_000 }))
      .toEqual({
        kind: "delivery-skip",
        reason: "wake-suppressed",
        firedAt,
        fireAgeMs: 5_000,
        withinMs: 60_000,
      });
  });

  /*
  FNXC:ReportsHealth 2026-11-18-14:27 (RUFU-716 AC2):
  The boundary is inclusive because it is the exact complement of every caller's `age > threshold`
  test. Off-by-one here would either re-create the false alarm (relief one ms too early) or hide a
  genuinely dead trigger (relief one ms too late).
  */
  it("relieves at exactly the window and refuses one millisecond past it", () => {
    const atBoundary = agentWithRow(reliefRow({ firedAt: new Date(NOW - 60_000).toISOString() }));
    const pastBoundary = agentWithRow(reliefRow({ firedAt: new Date(NOW - 60_001).toISOString() }));

    expect(describeHeartbeatDeliverySkip(atBoundary, { nowMs: NOW, withinMs: 60_000 })).not.toBeNull();
    expect(describeHeartbeatDeliverySkip(pastBoundary, { nowMs: NOW, withinMs: 60_000 })).toBeNull();
  });

  it("refuses relief for an ineligible reason even when freshly written", () => {
    expect(describeHeartbeatDeliverySkip(
      agentWithRow(reliefRow({ reason: "engine-paused" })),
      { nowMs: NOW, withinMs: 60_000 },
    )).toBeNull();
  });

  it("refuses relief when the row is absent or unreadable", () => {
    for (const agent of [undefined, null, {}, agentWithRow(reliefRow({ firedAt: "garbage" }))]) {
      expect(describeHeartbeatDeliverySkip(agent, { nowMs: NOW, withinMs: 60_000 })).toBeNull();
    }
  });

  /*
  FNXC:ReportsHealth 2026-11-18-14:27 (RUFU-716):
  A surface that cannot name its own staleness window must not be handed an open-ended exemption:
  `withinMs` is what keeps this relief bounded, so a nonsense window refuses rather than relieving.
  */
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number])(
    "refuses relief for a nonsense window %p",
    (withinMs) => {
      expect(describeHeartbeatDeliverySkip(agentWithRow(reliefRow()), { nowMs: NOW, withinMs })).toBeNull();
    },
  );

  it("does not read state or pauseReason — those outrank relief at each surface, not here", () => {
    // Non-vacuity: the leaf's structural input is metadata only, so a paused agent's row still parses.
    // Every surface keeps its own precedence ladder above this verdict.
    const withForeignFields = { metadata: { [HEARTBEAT_TIMER_LIVENESS_METADATA_KEY]: reliefRow() }, state: "paused", pauseReason: "user-requested" };
    expect(describeHeartbeatDeliverySkip(withForeignFields, { nowMs: NOW, withinMs: 60_000 })).not.toBeNull();
  });
});
