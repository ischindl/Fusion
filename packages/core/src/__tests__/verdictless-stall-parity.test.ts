import { describe, expect, it } from "vitest";
import { getInReviewStallReason } from "../tasks/in-review-stall.js";
import {
  getTaskMergeBlocker,
  buildPreMergeGateApprovalBlocker,
  PRE_MERGE_STEPS_FAILED_BLOCKER,
  PRE_MERGE_STEPS_NOT_RUN_BLOCKER,
} from "../merge/task-merge.js";
import type { Task, WorkflowStepResult } from "../types.js";

/*
FNXC:VerdictlessFailedGate 2026-09-14-13:32 (RUFU-217, AC4 — blocker-input parity):
RUFU-204's deadlock park was built on a `merge-blocker` stall reason the merge door would never
have written: the stall classifier called `getTaskMergeBlocker` with gate ids withheld while the
door, the queue, and the chip all forwarded them. These pins make that split structurally
impossible for the two shapes the verdict-less fix depends on:
1. under the SAME gate ids, the classifier's reason is byte-identical to the door's refusal;
2. ids-less callers keep the exact pre-RUFU-217 bytes (the generic sentence), so every existing
   consumer that string-matches the stall reason is unaffected;
3. the not-run deferral never becomes a stall signal even with ids forwarded (hazard 1) — a gate
   that has not run yet is waiting on scheduled work, and the merge-retry-conserving
   `PreMergeStepsNotRunError` / FN-9243 reseed lanes own it.
*/

const FAILED_GATE_ROW = {
  workflowStepId: "code-review",
  workflowStepName: "Code Review",
  status: "failed",
  verdict: null,
  verdictRequired: true,
  finishedAt: "2026-09-14T00:00:00.000Z",
} as unknown as WorkflowStepResult;

const AUTHORED_REVISE_ROW: WorkflowStepResult = {
  ...FAILED_GATE_ROW,
  verdict: "REVISE",
} as WorkflowStepResult;

const task = (workflowStepResults: WorkflowStepResult[] | undefined): Task => ({
  id: "RUFU-217",
  column: "in-review",
  paused: false,
  status: undefined,
  error: undefined,
  steps: [{ name: "Step 1", status: "done" }],
  workflowStepResults,
  worktree: "/tmp/rufu-217",
  mergeDetails: {},
  mergeRetries: 0,
} as unknown as Task);

const GATE_IDS = new Set(["code-review"]);

describe("stall classifier ⇄ merge door blocker parity (RUFU-217 AC4)", () => {
  it("verdict-less failed gate: classifier reason is byte-identical to the door's gate-named refusal", () => {
    const t = task([FAILED_GATE_ROW]);
    const door = getTaskMergeBlocker(t, { requiredPreMergeStepIds: GATE_IDS });
    expect(door).toBe(buildPreMergeGateApprovalBlocker("code-review"));
    const signal = getInReviewStallReason(t, { requiredPreMergeStepIds: GATE_IDS });
    expect(signal).toBeDefined();
    expect(signal!.code).toBe("merge-blocker");
    expect(signal!.reason).toBe(door);
  });

  it("authored REVISE gate: parity holds too — authored cards keep their deadlock path with the DOOR's sentence", () => {
    const t = task([AUTHORED_REVISE_ROW]);
    const door = getTaskMergeBlocker(t, { requiredPreMergeStepIds: GATE_IDS });
    expect(door).toBe(buildPreMergeGateApprovalBlocker("code-review"));
    const signal = getInReviewStallReason(t, { requiredPreMergeStepIds: GATE_IDS });
    expect(signal?.reason).toBe(door);
  });

  it("ids-less callers stay byte-identical to the pre-RUFU-217 generic sentence on both sides", () => {
    const t = task([FAILED_GATE_ROW]);
    const door = getTaskMergeBlocker(t, {});
    expect(door).toBe(PRE_MERGE_STEPS_FAILED_BLOCKER);
    const signal = getInReviewStallReason(t, {});
    expect(signal?.code).toBe("merge-blocker");
    expect(signal?.reason).toBe(door);
    expect(signal?.reason).not.toContain("gate '");
  });

  it("hazard 1: a missing (not-yet-run) gate defers, never parks — door writes not-run, classifier emits no signal", () => {
    const t = task([]);
    const door = getTaskMergeBlocker(t, { requiredPreMergeStepIds: GATE_IDS });
    expect(door).toBe(PRE_MERGE_STEPS_NOT_RUN_BLOCKER);
    // Without this suppression, forwarding ids would have made every card between "entered
    // review" and "first gate ran" count stall repetitions toward the deadlock park.
    expect(getInReviewStallReason(t, { requiredPreMergeStepIds: GATE_IDS })).toBeUndefined();
  });

  it("mixed missing + failed gate: both sides name the blocked gate — parity holds, and the door's later-gate not-run deferral is the reseed lane's discovery problem", () => {
    const t = task([FAILED_GATE_ROW]);
    const ids = new Set(["code-review", "verification"]);
    const door = getTaskMergeBlocker(t, { requiredPreMergeStepIds: ids });
    // The door answers the FIRST non-approved required gate (order wins over the later missing
    // gate's not-run state); the classifier must say exactly the same thing, and Step 6's reseed
    // admission routes this verdict-less answer back to the gate instead of the deadlock park.
    expect(door).toBe(buildPreMergeGateApprovalBlocker("code-review"));
    const signal = getInReviewStallReason(t, { requiredPreMergeStepIds: ids });
    expect(signal?.reason).toBe(door);
  });
});
