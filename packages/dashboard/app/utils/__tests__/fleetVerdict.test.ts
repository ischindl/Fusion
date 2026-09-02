import { describe, it, expect } from "vitest";
import {
  AGENT_TASK_HUMAN_HOLD_COLUMNS,
  FLEET_STALL_CODES,
  classifyFleetVerdict,
  resolveFleetStallReason,
  resolveFleetVerdictBucket,
  type FleetRosterAgent,
} from "../fleetVerdict";

/*
FNXC:FleetVerdict 2026-09-02-05:28 (RUFU-176):
Fixtures age heartbeats against an injected `dataAsOfMs` (never `Date.now()`) so the classifier's honesty
invariant is testable without a clock. `MIN_STALE` is 30 min before `NOW`, past the 20-minute threshold that a
5-minute interval × 4× grace resolves to, so it reliably yields the "Unresponsive" label.
*/
const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const MINUTE = 60_000;
const FRESH = new Date(NOW - 10_000).toISOString();
const OVERDUE = new Date(NOW - 30 * MINUTE).toISOString();

function makeAgent(overrides: Partial<FleetRosterAgent> & Pick<FleetRosterAgent, "state"> = { state: "idle" }): FleetRosterAgent {
  return {
    lastHeartbeatAt: FRESH,
    runtimeConfig: { heartbeatIntervalMs: 300_000 },
    ...overrides,
  } as FleetRosterAgent;
}

const CONTEXT = { dataAsOfMs: NOW, heartbeatMultiplier: 1 };

describe("classifyFleetVerdict — honesty invariant", () => {
  it("returns all zeros for an empty roster", () => {
    expect(classifyFleetVerdict([], CONTEXT)).toEqual({
      active: 0,
      waitingHuman: 0,
      noHeartbeat: 0,
      stalled: 0,
    });
  });

  it("never counts an agent in more than one bucket", () => {
    const roster: FleetRosterAgent[] = [
      makeAgent({ state: "running", pendingApprovalCount: 2, taskColumn: "awaiting-approval" }),
      makeAgent({ state: "paused", pauseReason: "awaiting-approval" }),
      makeAgent({ state: "idle", lastHeartbeatAt: OVERDUE }),
      makeAgent({ state: "error", lastError: "boom" }),
      makeAgent({ state: "idle" }),
    ];
    const verdict = classifyFleetVerdict(roster, CONTEXT);
    const sum = verdict.active + verdict.waitingHuman + verdict.noHeartbeat + verdict.stalled;
    expect(sum).toBeLessThanOrEqual(roster.length);
    expect(sum).toBe(4); // the healthy-idle agent belongs to none of the four
  });

  it("classifies a 30-agent mixed roster into the exact expected tuple", () => {
    const roster: FleetRosterAgent[] = [
      ...Array.from({ length: 5 }, () => makeAgent({ state: "active" })),
      ...Array.from({ length: 5 }, () => makeAgent({ state: "running" })),
      ...Array.from({ length: 3 }, () => makeAgent({ state: "idle", pendingApprovalCount: 1 })),
      ...Array.from({ length: 2 }, () => makeAgent({ state: "paused", pauseReason: "awaiting-approval" })),
      ...Array.from({ length: 2 }, () => makeAgent({ state: "idle", taskColumn: "awaiting-user-input" })),
      ...Array.from({ length: 3 }, () => makeAgent({ state: "idle", lastHeartbeatAt: OVERDUE })),
      ...Array.from({ length: 2 }, () => makeAgent({ state: "idle", runtimeConfig: { enabled: false }, lastHeartbeatAt: OVERDUE })),
      ...Array.from({ length: 2 }, () => makeAgent({ state: "paused", pauseReason: "budget-exhausted" })),
      ...Array.from({ length: 2 }, () => makeAgent({ state: "error", lastError: "crash" })),
      ...Array.from({ length: 4 }, () => makeAgent({ state: "idle" })),
    ];
    expect(roster).toHaveLength(30);
    expect(classifyFleetVerdict(roster, CONTEXT)).toEqual({
      active: 10,
      waitingHuman: 7,
      noHeartbeat: 5,
      stalled: 4,
    });
  });
});

describe("classifyFleetVerdict — bucket 1: active", () => {
  it.each(["active", "running"] as const)("counts state %s as active", (state) => {
    expect(resolveFleetVerdictBucket(makeAgent({ state }), CONTEXT)).toBe("active");
  });

  it("counts a running agent that is also awaiting approval as active only", () => {
    const agent = makeAgent({ state: "running", pendingApprovalCount: 3, pauseReason: "awaiting-approval", taskColumn: "awaiting-approval" });
    expect(resolveFleetVerdictBucket(agent, CONTEXT)).toBe("active");
  });
});

describe("classifyFleetVerdict — bucket 2: waitingHuman", () => {
  it("counts pendingApprovalCount > 0", () => {
    expect(resolveFleetVerdictBucket(makeAgent({ state: "idle", pendingApprovalCount: 1 }), CONTEXT)).toBe("waitingHuman");
  });

  it("does NOT count pendingApprovalCount === 0 as waiting", () => {
    expect(resolveFleetVerdictBucket(makeAgent({ state: "idle", pendingApprovalCount: 0 }), CONTEXT)).toBeUndefined();
  });

  it("counts pauseReason awaiting-approval ahead of stalled", () => {
    expect(resolveFleetVerdictBucket(makeAgent({ state: "paused", pauseReason: "awaiting-approval" }), CONTEXT)).toBe("waitingHuman");
  });

  it.each(AGENT_TASK_HUMAN_HOLD_COLUMNS)("counts linked taskColumn %s", (taskColumn) => {
    expect(resolveFleetVerdictBucket(makeAgent({ state: "idle", taskColumn }), CONTEXT)).toBe("waitingHuman");
  });

  it("never counts the unresolved sentinel or an undefined taskColumn as waiting", () => {
    expect(resolveFleetVerdictBucket(makeAgent({ state: "idle", taskColumn: "unresolved" }), CONTEXT)).toBeUndefined();
    expect(resolveFleetVerdictBucket(makeAgent({ state: "idle", taskColumn: undefined }), CONTEXT)).toBeUndefined();
  });

  it("promotes a linked-task holder via the RUFU-174 held-human-review seam", () => {
    const agent = makeAgent({ state: "idle", taskId: "RUFU-100" });
    const linked = new Map([["RUFU-100", ["held-human-review"]]]);
    expect(resolveFleetVerdictBucket(agent, { ...CONTEXT, linkedTaskStallCodes: linked })).toBe("waitingHuman");
  });

  it("does NOT let a non-human-hold linked stall code promote", () => {
    const agent = makeAgent({ state: "idle", taskId: "RUFU-100" });
    const linked = new Map([["RUFU-100", ["merge-blocker", "dependency-blocker"]]]);
    expect(resolveFleetVerdictBucket(agent, { ...CONTEXT, linkedTaskStallCodes: linked })).toBeUndefined();
  });

  it("keeps the classifier working when the seam is unwired (empty default)", () => {
    const agent = makeAgent({ state: "idle", taskId: "RUFU-100", taskColumn: "todo" });
    expect(resolveFleetVerdictBucket(agent, CONTEXT)).toBeUndefined();
  });
});

describe("classifyFleetVerdict — bucket 3: noHeartbeat", () => {
  it("counts an explicitly heartbeat-disabled agent", () => {
    const agent = makeAgent({ state: "idle", runtimeConfig: { enabled: false }, lastHeartbeatAt: FRESH });
    expect(resolveFleetVerdictBucket(agent, CONTEXT)).toBe("noHeartbeat");
  });

  it("counts a never-beat agent (no lastHeartbeatAt at all)", () => {
    const agent = makeAgent({ state: "idle", lastHeartbeatAt: undefined });
    expect(resolveFleetVerdictBucket(agent, CONTEXT)).toBe("noHeartbeat");
  });

  it("counts an overdue heartbeat (the Unresponsive label) as noHeartbeat", () => {
    expect(resolveFleetVerdictBucket(makeAgent({ state: "idle", lastHeartbeatAt: OVERDUE }), CONTEXT)).toBe("noHeartbeat");
  });

  it("does NOT steal a paused agent that merely has no beat — it is stalled, not heartbeatless", () => {
    const agent = makeAgent({ state: "paused", pauseReason: "budget-exhausted", lastHeartbeatAt: undefined });
    expect(resolveFleetVerdictBucket(agent, CONTEXT)).toBe("stalled");
  });

  it("honors the injected heartbeat multiplier when judging staleness", () => {
    // 30 min overdue is stale at ×1 but inside the threshold at ×10 (interval 5m ×10 ×4 grace = 200m).
    const agent = makeAgent({ state: "idle", lastHeartbeatAt: OVERDUE });
    expect(resolveFleetVerdictBucket(agent, CONTEXT)).toBe("noHeartbeat");
    expect(resolveFleetVerdictBucket(agent, { dataAsOfMs: NOW, heartbeatMultiplier: 10 })).toBeUndefined();
  });
});

describe("classifyFleetVerdict — bucket 4: stalled", () => {
  it("counts a paused agent with a known runtime pause reason", () => {
    expect(resolveFleetVerdictBucket(makeAgent({ state: "paused", pauseReason: "budget-exhausted" }), CONTEXT)).toBe("stalled");
  });

  it("counts a paused agent with an UNKNOWN pause reason (generic fallback)", () => {
    expect(resolveFleetVerdictBucket(makeAgent({ state: "paused", pauseReason: "totally-unknown-reason" }), CONTEXT)).toBe("stalled");
  });

  it("counts an errored agent", () => {
    expect(resolveFleetVerdictBucket(makeAgent({ state: "error", lastError: "heartbeat died" }), CONTEXT)).toBe("stalled");
  });

  it("counts an errored agent with no lastError", () => {
    expect(resolveFleetVerdictBucket(makeAgent({ state: "error", lastError: undefined }), CONTEXT)).toBe("stalled");
  });
});

describe("classifyFleetVerdict — honest non-membership", () => {
  it("leaves a healthy idle agent in none of the four buckets", () => {
    expect(resolveFleetVerdictBucket(makeAgent({ state: "idle", lastHeartbeatAt: FRESH }), CONTEXT)).toBeUndefined();
  });

  it("sums strictly below the roster size when healthy idle agents are present", () => {
    const roster: FleetRosterAgent[] = [
      makeAgent({ state: "active" }),
      makeAgent({ state: "idle" }),
      makeAgent({ state: "idle" }),
    ];
    const v = classifyFleetVerdict(roster, CONTEXT);
    expect(v.active).toBe(1);
    expect(v.active + v.waitingHuman + v.noHeartbeat + v.stalled).toBe(1);
  });
});

/*
FNXC:FleetVerdict 2026-09-02-07:05 (RUFU-176):
`resolveFleetStallReason` is the per-node answer to "why is this one parked", so its contract is two-sided: an agent the
classifier counts must get a reason, and an agent it does not count must get none (a node that invented a reason for a
moving agent would contradict the strip). Codes are asserted as raw engine `pauseReason` passthrough or the
fleet-synthesized set — never as English, which is the caller's translation layer's job.
*/
describe("resolveFleetStallReason", () => {
  it("prefers an approvable item over the engine's own awaiting-approval pause", () => {
    expect(resolveFleetStallReason(makeAgent({ state: "paused", pauseReason: "manual", pendingApprovalCount: 2 }), CONTEXT)).toEqual({
      bucket: "waitingHuman",
      code: FLEET_STALL_CODES.awaitingApproval,
    });
  });

  it("passes an engine pause reason through unchanged", () => {
    expect(resolveFleetStallReason(makeAgent({ state: "paused", pauseReason: "budget-exhausted" }), CONTEXT)).toEqual({
      bucket: "stalled",
      code: "budget-exhausted",
    });
  });

  it("labels a paused agent with no pause reason", () => {
    expect(resolveFleetStallReason(makeAgent({ state: "paused", pauseReason: undefined }), CONTEXT)).toEqual({
      bucket: "stalled",
      code: FLEET_STALL_CODES.paused,
    });
  });

  it("carries the failure evidence for an errored agent", () => {
    expect(resolveFleetStallReason(makeAgent({ state: "error", lastError: "model unavailable" }), CONTEXT)).toEqual({
      bucket: "stalled",
      code: FLEET_STALL_CODES.stateError,
      detail: "model unavailable",
    });
  });

  it("converges a card sitting on a human-hold column onto the person-hold code", () => {
    expect(resolveFleetStallReason(makeAgent({ state: "idle", taskId: "FN-042", taskColumn: "awaiting-user-review" }), CONTEXT)).toEqual({
      bucket: "waitingHuman",
      code: FLEET_STALL_CODES.heldByPerson,
      taskId: "FN-042",
      taskColumn: "awaiting-user-review",
    });
  });

  it("uses the RUFU-174 seam when a linked task is held by a person", () => {
    // Not `active`/`running`: a busy agent is excluded from the human-hold bucket, so the seam only speaks for one.
    const agent = makeAgent({ state: "idle", taskId: "FN-043" });
    const context = { ...CONTEXT, linkedTaskStallCodes: new Map([["FN-043", ["held-human-review"]]]) };
    expect(resolveFleetStallReason(agent, context)).toEqual({
      bucket: "waitingHuman",
      code: FLEET_STALL_CODES.heldByPerson,
      taskId: "FN-043",
    });
  });

  it("distinguishes a heartbeat that is switched off from one that never fired", () => {
    const disabled = makeAgent({ state: "idle", runtimeConfig: { enabled: false }, lastHeartbeatAt: FRESH });
    const never = makeAgent({ state: "idle", lastHeartbeatAt: undefined });
    expect(resolveFleetStallReason(disabled, CONTEXT)).toMatchObject({ code: FLEET_STALL_CODES.heartbeatDisabled });
    expect(resolveFleetStallReason(never, CONTEXT)).toMatchObject({ code: FLEET_STALL_CODES.neverBeat });
  });

  it("names an overdue heartbeat using the engine's own unresponsive reason code", () => {
    expect(resolveFleetStallReason(makeAgent({ state: "idle", lastHeartbeatAt: OVERDUE }), CONTEXT)).toMatchObject({
      bucket: "noHeartbeat",
      code: "heartbeat-unresponsive",
    });
  });

  it("stays silent for an agent that is moving", () => {
    expect(resolveFleetStallReason(makeAgent({ state: "idle" }), CONTEXT)).toBeUndefined();
    expect(resolveFleetStallReason(makeAgent({ state: "active" }), CONTEXT)).toBeUndefined();
    expect(resolveFleetStallReason(makeAgent({ state: "running" }), CONTEXT)).toBeUndefined();
  });

  it("does not explain a busy agent whose linked card happens to sit on a person", () => {
    const agent = makeAgent({ state: "active", taskId: "FN-044", taskColumn: "awaiting-user-review" });
    expect(resolveFleetStallReason(agent, CONTEXT)).toBeUndefined();
  });

  it("gives every bucketed agent a reason and every unbucketed agent none", () => {
    const roster: FleetRosterAgent[] = [
      makeAgent({ state: "active" }),
      makeAgent({ state: "idle" }),
      makeAgent({ state: "paused", pauseReason: "awaiting-approval" }),
      makeAgent({ state: "idle", taskId: "FN-001", taskColumn: "awaiting-user-review" }),
      makeAgent({ state: "idle", runtimeConfig: { enabled: false }, lastHeartbeatAt: FRESH }),
      makeAgent({ state: "idle", lastHeartbeatAt: OVERDUE }),
      makeAgent({ state: "paused", pauseReason: "manual" }),
      makeAgent({ state: "error", lastError: "boom" }),
    ];

    for (const agent of roster) {
      const bucket = resolveFleetVerdictBucket(agent, CONTEXT);
      const reason = resolveFleetStallReason(agent, CONTEXT);
      if (bucket && bucket !== "active") {
        expect(reason, `agent in ${bucket} must name a reason`).toBeTruthy();
        expect(reason?.bucket).toBe(bucket);
      } else {
        expect(reason, "an unbucketed agent must not grow a stall line").toBeUndefined();
      }
    }
  });

  it("exposes every human-hold column it can name a reason for", () => {
    expect(AGENT_TASK_HUMAN_HOLD_COLUMNS.length).toBeGreaterThan(0);
    for (const column of AGENT_TASK_HUMAN_HOLD_COLUMNS) {
      expect(resolveFleetStallReason(makeAgent({ state: "idle", taskId: "FN-050", taskColumn: column }), CONTEXT)?.code)
        .toBe(FLEET_STALL_CODES.heldByPerson);
    }
  });
});
