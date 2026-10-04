import { describe, expect, it } from "vitest";

import { buildPreMergeGateApprovalBlocker } from "@fusion/core";

import { classifyVerdictlessGatePark } from "../self-healing.js";

/*
FNXC:ReviewDispatch 2026-10-04-17:34 (RUFU-343):
This classifier decides whether a terminal in-review park may be lifted and its gate re-seeded. It used to
require the park sentence to NAME a gate. A stall-deadlock sentence never does — it names its stall code and
`signal.reason` — so the whole `completed-review-status-none` class was invisible to every recovery lane
(SANE-406/468/504/531, VLLM-095/098: parked, `code-review -> failed` with verdict null, zero completed reviewer
runs). Discovery is now allowed for that shape only, and the tests below pin both directions of the invariant:
an unambiguous verdict-less failed gate is discoverable, while anything ambiguous, authored, operator-held, or
produced by the other park producer stays operator-owned.

These are pure classifier cases on purpose: the wedge is a decision-table defect, and a store-backed test would
assert the same table while costing a database.
*/

const STALL_PAUSE = "in-review-stall-deadlock";
const STALL_ERROR =
  "In-review stall deadlock: completed-review-status-none repeated 3× without progress. " +
  "Completed review task has no merge owner or status for >= 30 min";

function gateRow(stepId: string, overrides: Record<string, unknown> = {}) {
  return {
    workflowStepId: stepId,
    workflowStepName: stepId,
    status: "failed",
    supersededAt: null,
    ...overrides,
  };
}

function parked(stepResults: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
  return {
    userPaused: false,
    deletedAt: null,
    paused: true,
    pausedReason: STALL_PAUSE,
    error: STALL_ERROR,
    workflowStepResults: stepResults,
    repositoryScope: "singular",
    ...overrides,
  } as never;
}

describe("classifyVerdictlessGatePark discovers the gate a stall-deadlock sentence never names", () => {
  it("lifts a stall-deadlock park whose single verdict-less failed gate is discoverable", () => {
    const park = classifyVerdictlessGatePark(parked([gateRow("code-review")]));
    expect(park).toEqual({ shape: "stall-deadlock", gateId: "code-review" });
  });

  it("stays operator-owned when two gates are verdict-less, because guessing lifts the wrong authority", () => {
    const park = classifyVerdictlessGatePark(
      parked([gateRow("code-review"), gateRow("security-review")]),
    );
    expect(park).toBeUndefined();
  });

  it("stays operator-owned when the failing row carries an authored verdict", () => {
    const park = classifyVerdictlessGatePark(
      parked([gateRow("code-review", { verdict: "REVISE" })]),
    );
    expect(park).toBeUndefined();
  });

  it("keeps the operator's own hold untouched", () => {
    const park = classifyVerdictlessGatePark(
      parked([gateRow("code-review")], { userPaused: true }),
    );
    expect(park).toBeUndefined();
  });

  it("still requires the named gate for the other park producer", () => {
    const park = classifyVerdictlessGatePark(
      parked([gateRow("code-review")], {
        pausedReason: undefined,
        error: "auto-merge-retry-rejected: post-merge evidence held",
      }),
    );
    expect(park).toBeUndefined();
  });

  it("keeps honouring a park sentence that embeds the gate-named refusal (RUFU-217 shape)", () => {
    const named = `Cannot merge SANE-0001: ${buildPreMergeGateApprovalBlocker("code-review")}`;
    const park = classifyVerdictlessGatePark(parked([gateRow("code-review")], { error: named }));
    expect(park?.gateId).toBe("code-review");
  });
});
