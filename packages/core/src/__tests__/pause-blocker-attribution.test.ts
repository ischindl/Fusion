/*
FNXC:PauseBlockerAttribution 2026-10-02-18:05 (RUFU-504):
Saneca's review lane held 15 cards whose ONLY blocker sentence was `task is paused`, written by the
engine's own stall park. The sentence named the symptom, so an operator reading the card could not
distinguish "a hand is holding this" from "the code-review gate refused it", and the real cause — a
`code-review` row left `failed` with no authored verdict — was visible only by fetching the whole card.
These tests pin both halves of the fix: the cause appears when the engine authored the park, and the
verbatim `task is paused` survives for every other pause, because that string is what a hand-held card
must keep saying.
*/
import { describe, expect, it } from "vitest";
import { describeEngineStallParkBlocker, getTaskHardMergeBlocker, getTaskMergeBlocker } from "../merge/task-merge.js";
import { IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON } from "../tasks/manual-retry-reset.js";

type Row = {
  phase: string;
  workflowStepId: string;
  status: string;
  verdict?: string;
  bypassedBy?: string;
};

const base = {
  column: "in-review" as const,
  status: undefined as string | undefined,
  error: undefined as string | undefined,
  steps: [] as Array<{ name: string; status: string }>,
  repositoryScope: undefined,
  mergeDetails: undefined,
};

const parked = (rows: Row[]) => ({
  ...base,
  paused: true,
  pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
  workflowStepResults: rows as never,
});

const gateIds = new Set(["code-review"]);

describe("pause blocker attribution (RUFU-504)", () => {
  it("names the gate that caused an engine-authored review-stall park", () => {
    const blocker = getTaskMergeBlocker(parked([
      { phase: "pre-merge", workflowStepId: "plan-review", status: "passed", verdict: "APPROVE" },
      { phase: "pre-merge", workflowStepId: "code-review", status: "failed" },
    ]) as never, { requiredPreMergeStepIds: gateIds });

    expect(blocker).toBeTruthy();
    // The claim is readability: the sentence must carry the gate, its status, and the missing verdict.
    expect(blocker).toContain("code-review");
    expect(blocker).toContain("'failed'");
    expect(blocker).toContain("no authored verdict");
    expect(blocker).toContain(IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON);
  });

  it("still reports a blocker — attributing a cause is not waiving the refusal", () => {
    const task = parked([
      { phase: "pre-merge", workflowStepId: "plan-review", status: "passed", verdict: "APPROVE" },
      { phase: "pre-merge", workflowStepId: "code-review", status: "failed" },
    ]);
    expect(typeof getTaskMergeBlocker(task as never, { requiredPreMergeStepIds: gateIds })).toBe("string");
    expect(getTaskMergeBlocker(task as never, { requiredPreMergeStepIds: gateIds })).toBeDefined();
    // A failed pre-merge gate blocks even with the pause taken out of the picture, which is what the
    // hard variant does: enrichment cannot be a laundering path.
    expect(getTaskHardMergeBlocker(task as never, { requiredPreMergeStepIds: gateIds })).toBeDefined();
  });

  it("answers a hand-held card verbatim as it always has", () => {
    const blocker = getTaskMergeBlocker({ ...base, paused: true } as never, { requiredPreMergeStepIds: gateIds });
    expect(blocker).toBe("task is paused");
  });

  it("keys on the engine park reason and not on pause alone", () => {
    // A shipped operator hold keeps the verbatim sentence: this also pins that the reason key is the
    // real constant and not a literal that drifted away from it.
    const held = { ...base, paused: true, pausedReason: "manual-hold", workflowStepResults: [
      { phase: "pre-merge", workflowStepId: "code-review", status: "failed" },
    ] as never };
    expect(getTaskMergeBlocker(held as never, { requiredPreMergeStepIds: gateIds })).toBe("task is paused");
    expect(describeEngineStallParkBlocker(held as never, gateIds)).toBeNull();
    // The same rows under the engine's own reason DO attribute the gate.
    expect(describeEngineStallParkBlocker(parked([
      { phase: "pre-merge", workflowStepId: "code-review", status: "failed" },
    ]) as never, gateIds)).toContain("code-review");
  });

  it("invents no cause when the park has nothing gate-shaped behind it", () => {
    const approved = parked([{ phase: "pre-merge", workflowStepId: "plan-review", status: "passed", verdict: "APPROVE" }]);
    expect(describeEngineStallParkBlocker(approved as never, gateIds)).toBeNull();
    expect(getTaskMergeBlocker(approved as never, { requiredPreMergeStepIds: gateIds })).toBe("task is paused");

    const noRows = parked([]);
    expect(getTaskMergeBlocker(noRows as never, { requiredPreMergeStepIds: gateIds })).toBe("task is paused");
  });

  it("judges a gate by its latest row, so a remediated gate is not blamed for its old failure", () => {
    const remediated = parked([
      { phase: "pre-merge", workflowStepId: "code-review", status: "failed" },
      { phase: "pre-merge", workflowStepId: "code-review", status: "passed", verdict: "APPROVE" },
    ]);
    expect(describeEngineStallParkBlocker(remediated as never, gateIds)).toBeNull();
  });

  it("looks only at the required gates it was given", () => {
    const otherGateFailed = parked([
      { phase: "pre-merge", workflowStepId: "browser-review", status: "failed" },
    ]);
    expect(describeEngineStallParkBlocker(otherGateFailed as never, gateIds)).toBeNull();
    // With no required-gate set the caller has no scope to offer, so any pre-merge failure is reportable.
    expect(describeEngineStallParkBlocker(otherGateFailed as never)).toContain("browser-review");
  });

  it("names a bypassed gate instead of going silent on the card that was just waived", () => {
    // RUFU-504's canary shape: the zero-diff `failed` row was bypassed under an audited waiver, so the
    // latest row is `skipped`. Reporting nothing here is how the tautology came back on SANE-463.
    const waived = parked([
      { phase: "pre-merge", workflowStepId: "plan-review", status: "passed", verdict: "APPROVE" },
      { phase: "pre-merge", workflowStepId: "code-review", status: "skipped", bypassedBy: "dashboard-operator" },
    ]);

    const blocker = getTaskMergeBlocker(waived as never, { requiredPreMergeStepIds: gateIds });
    expect(blocker).toContain("code-review");
    expect(blocker).toContain("was bypassed and no merge owner has run");
    expect(blocker).not.toContain("no authored verdict");
    // Still a refusal, not a waiver written into the door.
    expect(blocker).toBeTruthy();
  });

  it("does not call an ordinary workflow skip a bypass", () => {
    const plainSkip = parked([{ phase: "pre-merge", workflowStepId: "code-review", status: "skipped" }]);
    expect(describeEngineStallParkBlocker(plainSkip as never, gateIds)).toBeNull();
    expect(getTaskMergeBlocker(plainSkip as never, { requiredPreMergeStepIds: gateIds })).toBe("task is paused");
  });

  it("prefers a live refusal over an older waiver", () => {
    const both = parked([
      { phase: "pre-merge", workflowStepId: "code-review", status: "skipped", bypassedBy: "dashboard-operator" },
      { phase: "pre-merge", workflowStepId: "browser-review", status: "failed" },
    ]);
    // browser-review is outside the required scope, so the required gate reads as the waived row; widened,
    // the live `failed` refusal is what gets named.
    expect(describeEngineStallParkBlocker(both as never, gateIds)).toContain("was bypassed");
    expect(describeEngineStallParkBlocker(both as never, new Set(["code-review", "browser-review"])))
      .toContain("'failed'");
  });
});
