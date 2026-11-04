import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_WAKE_SUPPRESSION_WINDOW_MS,
  buildAssignmentWakeSignature,
  isAssignmentWakeSuppressed,
  type AssignmentWakeDelta,
} from "../assignment-wake-signature.js";

/*
FNXC:AssignmentWakeDedup 2026-11-04-21:07 (RUFU-411):
The suppression decision is the one thing standing between an agent and a session that can only say
"nothing to do", so both directions have to be pinned: identical deltas collapse (otherwise the wake storm
survives) and any real change separates (otherwise a legitimate hand-off is stranded). The shipped policy is
one delivery per (agent, goal, delta) per window, and the window itself is part of the contract.
*/

const base: AssignmentWakeDelta = {
  agentId: "agent-a",
  taskId: "RUFU-409",
  agentState: "active",
  boundTaskId: "RUFU-409",
};

const NOW = 1_700_000_000_000;

describe("buildAssignmentWakeSignature", () => {
  it("is stable under duplication and reordering of comment ids", () => {
    const a = buildAssignmentWakeSignature({ ...base, triggeringCommentIds: ["c-2", "c-1", "c-2"], triggeringCommentType: "steering" });
    const b = buildAssignmentWakeSignature({ ...base, triggeringCommentIds: ["c-1", "c-2"], triggeringCommentType: "steering" });

    expect(a).toBe(b);
  });

  it("treats absent and empty comment id lists as the same 'no comments' delta", () => {
    const omitted = buildAssignmentWakeSignature(base);
    const empty = buildAssignmentWakeSignature({ ...base, triggeringCommentIds: [] });
    const emptyWithClass = buildAssignmentWakeSignature({ ...base, triggeringCommentIds: [], triggeringCommentType: "steering" });

    expect(omitted).toBe(empty);
    expect(omitted).toBe(emptyWithClass);
  });

  it("distinguishes every observable input the wake path can see", () => {
    const anchor = buildAssignmentWakeSignature(base);
    const variants: Array<[string, AssignmentWakeDelta]> = [
      ["new steering comment", { ...base, triggeringCommentIds: ["c-new"], triggeringCommentType: "steering" }],
      ["different comment id", { ...base, triggeringCommentIds: ["c-other"], triggeringCommentType: "steering" }],
      ["different comment class", { ...base, triggeringCommentIds: ["c-new"], triggeringCommentType: "pr" }],
      ["different goal", { ...base, taskId: "RUFU-410" }],
      ["different agent", { ...base, agentId: "agent-b" }],
      ["agent state change", { ...base, agentState: "idle" }],
      ["agent rebind", { ...base, boundTaskId: "RUFU-367" }],
    ];

    for (const [label, delta] of variants) {
      expect(buildAssignmentWakeSignature(delta), label).not.toBe(anchor);
    }
  });

  it("is length-bounded and carries no prose regardless of comment volume", () => {
    const many = buildAssignmentWakeSignature({
      ...base,
      triggeringCommentIds: Array.from({ length: 500 }, (_, i) => `comment-${i}`),
      triggeringCommentType: "steering",
    });

    expect(many).toMatch(/^aw1:[0-9a-f]{8}$/);
  });
});

describe("isAssignmentWakeSuppressed", () => {
  const fired = (overrides: Partial<AssignmentWakeDelta> = {}) => ({
    taskId: base.taskId,
    signature: buildAssignmentWakeSignature({ ...base, ...overrides }),
    firedAtMs: NOW - 1_000,
  });

  it("allows the first wake for an agent (cold engine start)", () => {
    expect(isAssignmentWakeSuppressed({ prior: undefined, delta: base, nowMs: NOW })).toBe(false);
    expect(isAssignmentWakeSuppressed({ prior: null, delta: base, nowMs: NOW })).toBe(false);
  });

  it("suppresses the identical delta inside the window", () => {
    expect(isAssignmentWakeSuppressed({ prior: fired(), delta: base, nowMs: NOW })).toBe(true);
  });

  it("allows the identical delta once the window has elapsed, and only then", () => {
    const prior = { taskId: base.taskId, signature: buildAssignmentWakeSignature(base), firedAtMs: NOW - ASSIGNMENT_WAKE_SUPPRESSION_WINDOW_MS };

    expect(isAssignmentWakeSuppressed({ prior, delta: base, nowMs: NOW - 1 })).toBe(true);
    expect(isAssignmentWakeSuppressed({ prior, delta: base, nowMs: NOW })).toBe(false);
  });

  it("allows a changed delta immediately, with no window to wait out", () => {
    const prior = fired();

    expect(isAssignmentWakeSuppressed({
      prior,
      delta: { ...base, triggeringCommentIds: ["c-new"], triggeringCommentType: "steering" },
      nowMs: NOW,
    })).toBe(false);
    expect(isAssignmentWakeSuppressed({ prior, delta: { ...base, agentState: "idle" }, nowMs: NOW })).toBe(false);
    expect(isAssignmentWakeSuppressed({ prior, delta: { ...base, boundTaskId: null }, nowMs: NOW })).toBe(false);
  });

  it("fails open on an unusable clock or a disabled window rather than stranding the wake", () => {
    const prior = { taskId: base.taskId, signature: buildAssignmentWakeSignature(base), firedAtMs: Number.NaN };

    expect(isAssignmentWakeSuppressed({ prior, delta: base, nowMs: NOW })).toBe(false);
    expect(isAssignmentWakeSuppressed({ prior: fired(), delta: base, nowMs: Number.NaN })).toBe(false);
    expect(isAssignmentWakeSuppressed({ prior: fired(), delta: base, nowMs: NOW, windowMs: 0 })).toBe(false);
  });

  it("honours an injected window so the policy bound stays a one-line change", () => {
    const prior = { taskId: base.taskId, signature: buildAssignmentWakeSignature(base), firedAtMs: NOW - 10_000 };

    expect(isAssignmentWakeSuppressed({ prior, delta: base, nowMs: NOW, windowMs: 60_000 })).toBe(true);
    expect(isAssignmentWakeSuppressed({ prior, delta: base, nowMs: NOW, windowMs: 5_000 })).toBe(false);
  });
});
