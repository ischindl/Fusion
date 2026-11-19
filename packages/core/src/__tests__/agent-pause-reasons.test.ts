import { describe, expect, it } from "vitest";

import {
  PAUSE_REASON_LABELS as PauseReasonLabelsSource,
  agentPauseReasonLabel as agentPauseReasonLabelSource,
  classifyAgentStall as classifyAgentStallSource,
} from "../agents/agent-pause-reasons.js";
import {
  PAUSE_REASON_LABELS,
  AGENT_STALL_REASON_UNKNOWN,
  agentPauseReasonLabel,
  classifyAgentStall,
  isAgentStateStopped,
} from "../index.js";
import {
  PAUSE_REASON_LABELS as PAUSE_REASON_LABELS_GATE,
  AGENT_STALL_REASON_UNKNOWN as AGENT_STALL_REASON_UNKNOWN_GATE,
  agentPauseReasonLabel as agentPauseReasonLabelGate,
  classifyAgentStall as classifyAgentStallGate,
} from "../index.gate.js";

/*
FNXC:AgentStallDiagnostics 2026-11-19-06:23 (RUFU-247):
Both-barrels pin, same shape `agent-log-read-guard.test.ts` establishes after RUFU-204: the
`engine-core` merge-gate vitest project aliases `@fusion/core` to the gate bundle, and the engine's
agent tools reach the projection through that namespace import. A gate-barrel omission therefore
resolves these symbols as `undefined` in the merge-gate lane while every ordinary run stays green —
the failure mode that invisible-class bug made load-bearing, not cosmetic.

Identity (`.toBe`), not just "both exist": the barrels re-export the SAME module instance, so the
dashboard's stall resolver, `fn agent show`, and the engine tool cannot hold two copies of the
pause-reason table and drift apart in wording.
*/

describe("pause-reason vocabulary is exposed from BOTH core barrels", () => {
  it("index.ts and index.gate.ts resolve to the same function objects", () => {
    expect(typeof classifyAgentStall).toBe("function");
    expect(classifyAgentStallGate).toBe(classifyAgentStall);
    expect(classifyAgentStall).toBe(classifyAgentStallSource);
    expect(agentPauseReasonLabelGate).toBe(agentPauseReasonLabel);
    expect(agentPauseReasonLabel).toBe(agentPauseReasonLabelSource);
    expect(isAgentStateStopped("paused")).toBe(true);
  });

  it("exposes the same frozen table and the same sentinel from both barrels", () => {
    expect(PAUSE_REASON_LABELS_GATE).toBe(PAUSE_REASON_LABELS);
    expect(PAUSE_REASON_LABELS).toBe(PauseReasonLabelsSource);
    expect(AGENT_STALL_REASON_UNKNOWN_GATE).toBe(AGENT_STALL_REASON_UNKNOWN);
    expect(PAUSE_REASON_LABELS["error-unrecoverable"]).toBeTruthy();
  });

  it("behaves identically through the gate barrel", () => {
    expect(classifyAgentStallGate({ state: "paused", pauseReason: null }))
      .toBe(AGENT_STALL_REASON_UNKNOWN);
    expect(classifyAgentStallGate({ state: "paused", pauseReason: "error-retry-exhausted" }))
      .toBe("error-retry-exhausted");
    expect(classifyAgentStallGate({ state: "active", pauseReason: null })).toBeNull();
    expect(agentPauseReasonLabelGate("error-retry-exhausted"))
      .toBe("Automatic retries exhausted");
  });
});
