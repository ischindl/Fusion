import { describe, expect, it } from "vitest";
import {
  LANE_CAPABILITY_DECLINE_CODE,
  LANE_CAPABILITY_DECLINE_REMEDY,
  buildLaneCapabilityFreezePatch,
  formatLaneCapabilityDeclineReason,
  hasLaneCapabilityFreeze,
  isLaneCapabilityDecline,
  laneCapabilityDeclinePolicy,
} from "../index.js";

/*
FNXC:LaneCapabilityDecline 2026-09-26-19:40 (RUFU-272 Step 3):
The named decline is the operator contract of the lane-capability fix: the refusal must name the
lane, the policy/roles that produced it, the card, and the remedy — on the task row, not only in an
agent log. These pins guard the sentence shape, the classifier round-trip against the EXACT
persisted builder output, and the freeze's resume preservation (rename-aware by construction).
*/

const auditLane = { id: "agent-audit", role: "reviewer" as never, roles: ["reviewer"] as never, runtimeConfig: { assignmentPolicy: "none" } };
const card = { id: "FN-1", column: "todo", currentStep: 0 };

describe("formatLaneCapabilityDeclineReason", () => {
  it("names the lane id, the policy, the card, and the remedy", () => {
    const reason = formatLaneCapabilityDeclineReason(auditLane, card);
    expect(reason).toContain("agent-audit");
    expect(reason).toContain('assignmentPolicy "none"');
    expect(reason).toContain("FN-1");
    expect(reason).toContain(LANE_CAPABILITY_DECLINE_REMEDY);
    // The remedy names the knobs an operator can actually turn.
    expect(reason).toMatch(/reassign|role tags|assignment policy/i);
  });

  it("policy line carries roles for a policy-auto role refusal", () => {
    const lane = { id: "agent-x", role: "reviewer" as never, roles: ["reviewer", "triage"] as never };
    expect(laneCapabilityDeclinePolicy(lane)).toBe("auto/[reviewer,triage]");
    expect(formatLaneCapabilityDeclineReason(lane, card)).toContain('roles "reviewer, triage"');
  });
});

describe("buildLaneCapabilityFreezePatch + classifier round-trip", () => {
  const stranded = {
    id: "RUFU-257",
    column: "building", // renamed work lane — the resume point must be THIS lane, never hardcoded todo
    currentStep: 2,
    worktree: "/tmp/wt/rufu-257",
    branch: "fusion/rufu-257",
  };

  it("preserves the resume column / step / worktree / branch of a renamed-lane card", () => {
    const patch = buildLaneCapabilityFreezePatch(stranded as never, auditLane as never);
    expect(patch.externalBlock?.resume).toEqual({
      column: "building",
      currentStep: 2,
      worktree: "/tmp/wt/rufu-257",
      branch: "fusion/rufu-257",
    });
    // The freeze performs NO column move: whatever resume-adjacent move happens, the lane is the card's own.
    expect(patch.column).toBeUndefined();
  });

  it("classifier round-trips on the EXACT persisted builder shapes and refuses unrelated blocks", () => {
    const patch = buildLaneCapabilityFreezePatch(stranded as never, auditLane as never);
    expect(isLaneCapabilityDecline({ error: patch.error, externalBlock: patch.externalBlock })).toBe(true);
    expect(hasLaneCapabilityFreeze({ ...stranded, ...patch } as never)).toBe(true);

    expect(isLaneCapabilityDecline({
      error: "BLOCKED: project-configuration/overlap-delivery-unavailable: other",
      externalBlock: { origin: "project-configuration", code: "overlap-delivery-unavailable", message: "x", source: "dependency-readiness", blockedAt: new Date().toISOString(), resume: { column: "building", currentStep: 0 } },
    })).toBe(false);
    expect(isLaneCapabilityDecline({ error: "BLOCKED: host-environment/HOST-X: disk", externalBlock: undefined })).toBe(false);
    expect(isLaneCapabilityDecline({ error: undefined, externalBlock: undefined })).toBe(false);
  });

  it("freeze is operator-recoverable state: external-block pause, NEVER pausedByAgentId", () => {
    const patch = buildLaneCapabilityFreezePatch(stranded as never, auditLane as never);
    expect(patch.status).toBe("blocked");
    expect(patch.paused).toBe(true);
    expect(patch.pausedReason).toBe("external-block");
    /* Design Lock 8 hazard: a card paused BY ITS OWN ASSIGNEE is auto-unpaused by the assignment
    seam. The decline freeze must never carry an agent pause attribution for exactly that reason. */
    expect(patch.pausedByAgentId).toBeNull();
    expect(patch.error).toContain(LANE_CAPABILITY_DECLINE_CODE);
    expect(patch.externalBlock?.origin).toBe("project-configuration");
  });
});
