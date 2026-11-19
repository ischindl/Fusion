import { describe, expect, it } from "vitest";

import {
  AGENT_STALL_REASON_UNKNOWN,
  AGENT_STALL_REASON_UNKNOWN_LABEL,
  PAUSE_REASON_LABELS,
  agentPauseReasonLabel,
  classifyAgentStall,
  isAgentStateStopped,
  isOperatorActionablePauseReason,
} from "../agent-pause-reasons.js";

/*
FNXC:AgentStallDiagnostics 2026-11-19-06:23 (RUFU-247):
These assert the three honest stall cases the operator must be able to tell apart, because each one
needs a different action. Measured 2026-09-15: one `paused` owner agent carrying NO pauseReason at all
idled five assigned cards holding 519,682,059 tokens for a day, and the old truthiness-guarded render
printed nothing for it — "the lane recorded no reason" and "nothing happened" looked identical. The
`unknown` cases below are the regression cover for exactly that blank.
*/

describe("classifyAgentStall — the three honest stall cases", () => {
  it("a recorded operator-actionable park classifies with its own code", () => {
    expect(classifyAgentStall({ state: "paused", pauseReason: "error-unrecoverable" }))
      .toBe("error-unrecoverable");
  });

  it("a recorded budget exhaustion classifies with its own code", () => {
    expect(classifyAgentStall({ state: "paused", pauseReason: "error-retry-exhausted" }))
      .toBe("error-retry-exhausted");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["a whitespace-only string", "   "],
  ])("a paused agent with %s pause reason classifies as unknown, never blank", (_label, pauseReason) => {
    expect(classifyAgentStall({ state: "paused", pauseReason })).toBe(AGENT_STALL_REASON_UNKNOWN);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
  ])("an errored agent with %s pause reason classifies as unknown too", (_label, pauseReason) => {
    // `error` is a stopped state: a lane that died before writing a reason idles cards just as hard.
    expect(classifyAgentStall({ state: "error", pauseReason })).toBe(AGENT_STALL_REASON_UNKNOWN);
  });

  it("a healthy agent with no recorded reason classifies as nothing to show", () => {
    expect(classifyAgentStall({ state: "active" })).toBeNull();
    expect(classifyAgentStall({ state: "running", pauseReason: null })).toBeNull();
    expect(classifyAgentStall({ state: "idle" })).toBeNull();
  });

  it("keeps a reason a lane recorded even on a non-stopped state — the fact is not state-dependent", () => {
    // A running agent still carrying a stale reason shows it: dropping it would hide a real field
    // the dashboard resolver already treats as authoritative.
    expect(classifyAgentStall({ state: "active", pauseReason: "manual" })).toBe("manual");
  });

  it("treats a missing record as nothing to show rather than throwing", () => {
    expect(classifyAgentStall(null)).toBeNull();
    expect(classifyAgentStall(undefined)).toBeNull();
    expect(classifyAgentStall({})).toBeNull();
  });
});

describe("isAgentStateStopped", () => {
  it("names paused and error as stopped and everything else as not", () => {
    expect(isAgentStateStopped("paused")).toBe(true);
    expect(isAgentStateStopped("error")).toBe(true);
    expect(isAgentStateStopped("active")).toBe(false);
    expect(isAgentStateStopped("running")).toBe(false);
    expect(isAgentStateStopped("idle")).toBe(false);
    expect(isAgentStateStopped(undefined)).toBe(false);
    expect(isAgentStateStopped(null)).toBe(false);
  });
});

describe("PAUSE_REASON_LABELS — the relocated table", () => {
  /*
  FNXC:StallReason 2026-09-01-17:48 (RUFU-175): the table moved out of the dashboard verbatim. The
  value assertions are the byte-identity pin: `stall.pausedReason.<code>.*` English defaults and the
  agent-health pill both read these exact strings, so a reword here changes shipped copy.
  */
  it("carries every documented code with its exact words", () => {
    expect(PAUSE_REASON_LABELS).toMatchObject({
      "error-unrecoverable": "Paused with an unrecoverable error",
      "error-retry-exhausted": "Automatic retries exhausted",
      "awaiting-approval": "Awaiting approval",
      "heartbeat-model-unavailable": "Heartbeat model unavailable",
      "heartbeat-unresponsive": "Heartbeat unresponsive",
      "budget-exhausted": "Output budget exhausted",
      "migrated-from-terminated": "Recovered from a terminated runtime",
      manual: "Paused by an operator",
      "user-requested": "Paused at your request",
      testing: "Paused for testing",
      "duplicate-decision-required": "Awaiting a duplicate decision",
    });
  });

  it("covers the full eleven-code inventory the dashboard resolver enumerates", () => {
    expect(Object.keys(PAUSE_REASON_LABELS)).toHaveLength(11);
  });

  it("is frozen so no surface can mutate the shared vocabulary", () => {
    expect(Object.isFrozen(PAUSE_REASON_LABELS)).toBe(true);
  });
});

describe("agentPauseReasonLabel", () => {
  it("renders the table words for a known code", () => {
    expect(agentPauseReasonLabel("error-unrecoverable")).toBe("Paused with an unrecoverable error");
    expect(agentPauseReasonLabel("error-retry-exhausted")).toBe("Automatic retries exhausted");
  });

  it("renders the explicit no-reason sentence for the unknown sentinel", () => {
    expect(agentPauseReasonLabel(AGENT_STALL_REASON_UNKNOWN)).toBe(AGENT_STALL_REASON_UNKNOWN_LABEL);
    expect(agentPauseReasonLabel(AGENT_STALL_REASON_UNKNOWN)).not.toBe(AGENT_STALL_REASON_UNKNOWN);
  });

  it("falls back to the raw code for a code the table has never heard of", () => {
    // Same honest fallback the dashboard resolver promises: a sibling card's new code names itself
    // rather than rendering blank.
    expect(agentPauseReasonLabel("throttle-cooldown-park")).toBe("throttle-cooldown-park");
  });
});

describe("isOperatorActionablePauseReason", () => {
  it("marks only the credential/billing park as needing a human repair", () => {
    expect(isOperatorActionablePauseReason("error-unrecoverable")).toBe(true);
    expect(isOperatorActionablePauseReason("error-retry-exhausted")).toBe(false);
    expect(isOperatorActionablePauseReason(AGENT_STALL_REASON_UNKNOWN)).toBe(false);
    expect(isOperatorActionablePauseReason(null)).toBe(false);
  });
});
