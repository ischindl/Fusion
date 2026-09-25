/*
FNXC:UnrunPostMergeGateRecovery 2026-09-25-15:35 (RUFU-306):
One blocker sentence covered two states with opposite remedies, and the engine could not tell them
apart. `has not reported` means the node never ran — recoverable by seeding a real run.
`is not approved` means a verdict exists and said no — re-running it would be a machine overruling a
gate. Production 2026-09-25 had cards of the first kind parked forever (DGXS-313, ROZV-290,
RUFU-220, ROZV-286), so the distinction is now expressed in code, and the blocker TEXT is pinned to
stay byte-stable because operators and existing consumers match on it.
*/
import { describe, expect, it } from "vitest";
import {
  getPostMergeEvidenceGateStatuses,
  getRequiredPostMergeEvidenceBlocker,
  resolveRequiredPostMergeGateIds,
} from "../merge/confirmed-merge-reconciliation.js";
import type { Task, WorkflowIr } from "../types.js";

const GATE_ID = "post-merge-verification";

function irWithPostMergeGate(defaultOn: boolean): WorkflowIr {
  return {
    version: "v2",
    id: "builtin:coding",
    name: "Coding",
    nodes: [
      { id: "merge-attempt", kind: "action", column: "in-review" },
      {
        id: GATE_ID,
        kind: "optional-group",
        column: "in-review",
        config: {
          phase: "post-merge",
          defaultOn,
          template: { nodes: [{ id: "post-merge-check", kind: "prompt", config: { gateMode: "gate" } }] },
        },
      },
    ],
    edges: [],
    columns: [{ id: "in-review", label: "In review", traits: [] }],
  } as unknown as WorkflowIr;
}

function taskWith(enabledWorkflowSteps?: string[]): Pick<Task, "id" | "enabledWorkflowSteps" | "workflowStepResults"> {
  return { id: "RUFU-306", enabledWorkflowSteps, workflowStepResults: [] };
}

function storeFor(ir: WorkflowIr) {
  return {
    getTaskWorkflowSelection: () => ({ workflowId: "builtin:coding", stepIds: [] }),
    getWorkflowDefinition: async () => ({ ir }),
  };
}

describe("post-merge evidence gate states", () => {
  it("names an enabled gate-mode post-merge group as required", () => {
    expect(resolveRequiredPostMergeGateIds(taskWith(), irWithPostMergeGate(true))).toEqual([GATE_ID]);
    expect(resolveRequiredPostMergeGateIds(taskWith(), irWithPostMergeGate(false))).toEqual([]);
  });

  it("leaves an explicitly disabled group non-blocking", () => {
    const ir = irWithPostMergeGate(true);
    // An explicit selection array that omits the group is the operator switching it off; `undefined`
    // is the "never chosen" case that falls back to config.defaultOn.
    expect(resolveRequiredPostMergeGateIds({ enabledWorkflowSteps: [] }, ir)).toEqual([]);
    expect(resolveRequiredPostMergeGateIds({ enabledWorkflowSteps: [GATE_ID] }, ir)).toEqual([GATE_ID]);
  });

  it("reports a gate with no result row as missing, not as unapproved", async () => {
    const ir = irWithPostMergeGate(true);
    const task = taskWith([GATE_ID]);

    expect(getPostMergeEvidenceGateStatuses(task, ir)).toEqual([{ gateId: GATE_ID, state: "missing" }]);
    expect(await getRequiredPostMergeEvidenceBlocker(storeFor(ir) as never, task))
      .toBe(`required post-merge evidence gate '${GATE_ID}' has not reported`);
  });

  it("reports a gate whose row did not approve as not-approved", () => {
    const ir = irWithPostMergeGate(true);
    const task = {
      ...taskWith([GATE_ID]),
      workflowStepResults: [{ workflowStepId: GATE_ID, status: "passed", verdict: "REVISE" }],
    } as never;

    expect(getPostMergeEvidenceGateStatuses(task, ir)).toEqual([{ gateId: GATE_ID, state: "not-approved" }]);
  });

  it("clears once the gate reports an approving verdict", async () => {
    const ir = irWithPostMergeGate(true);
    const task = {
      ...taskWith([GATE_ID]),
      workflowStepResults: [{ workflowStepId: GATE_ID, status: "passed", verdict: "APPROVE" }],
    } as never;

    expect(getPostMergeEvidenceGateStatuses(task, ir)).toEqual([]);
    expect(await getRequiredPostMergeEvidenceBlocker(storeFor(ir) as never, task)).toBeUndefined();
  });
});
