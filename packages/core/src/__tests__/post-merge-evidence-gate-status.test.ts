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
import { FAST_MODE_BYPASS_ACTOR } from "../workflows/workflow-fast-lane.js";
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
  /*
  FNXC:PostMergeGateDeliveryShape 2026-09-30-13:09 (RUFU-429):
  The requirement is only real when the lane that delivered the card can report the evidence. These cases
  pin BOTH sides of the invariant in one place, so the exemption cannot be widened into a general
  post-merge bypass: the same IR and the same enabled gate must still block a singular-delivery card, and
  must still block a workspace card that carries a real negative verdict.
  */
  it("does not hold a workspace-shaped card out of completion for evidence its lane cannot produce", async () => {
    const ir = irWithPostMergeGate(true);
    const workspaceTask = {
      ...taskWith([GATE_ID]),
      workspaceWorktrees: { app: { path: "/repo/.worktrees/app" } },
    } as never;

    expect(getPostMergeEvidenceGateStatuses(workspaceTask, ir))
      .toEqual([{ gateId: GATE_ID, state: "not-applicable" }]);
    // No blocker sentence means the finalizer completes instead of parking on
    // `[post-merge gate unreachable: workspace]`, which is what the waiver stream existed for.
    expect(await getRequiredPostMergeEvidenceBlocker(storeFor(ir) as never, workspaceTask)).toBeUndefined();

    // The same gate on a singular-delivery card is still owed.
    expect(getPostMergeEvidenceGateStatuses(taskWith([GATE_ID]), ir))
      .toEqual([{ gateId: GATE_ID, state: "missing" }]);
    expect(await getRequiredPostMergeEvidenceBlocker(storeFor(ir) as never, taskWith([GATE_ID])))
      .toBe(`required post-merge evidence gate '${GATE_ID}' has not reported`);
  });

  it("still honours a real negative post-merge verdict on a workspace-shaped card", async () => {
    const ir = irWithPostMergeGate(true);
    const workspaceTask = {
      id: "SANE-447",
      enabledWorkflowSteps: [GATE_ID],
      workspaceWorktrees: { app: { path: "/repo/.worktrees/app" } },
      workflowStepResults: [{ workflowStepId: GATE_ID, status: "failed", phase: "post-merge" }],
    } as never;

    expect(getPostMergeEvidenceGateStatuses(workspaceTask, ir))
      .toEqual([{ gateId: GATE_ID, state: "not-approved" }]);
    expect(await getRequiredPostMergeEvidenceBlocker(storeFor(ir) as never, workspaceTask))
      .toBe(`required post-merge evidence gate '${GATE_ID}' is not approved`);
  });

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

  /*
  FNXC:PostMergeGateOperatorWaiver 2026-09-29-15:49 (RUFU-408):
  The RUFU-370 handoff notice promises "an operator bypass of the gate", and on the saneca board that
  promise was unfulfillable twice over: `bypassFailedPreMergeReviewStep` looked only at pre-merge gates
  (`no failed pre-merge review step found`), and even a written waiver row would not have satisfied this
  resolver, because `skipped` is not `passed`. Seven merge-CONFIRMED cards therefore sat in `in-review`
  with a recorded human decision on them and emitted 5,319
  `task:auto-merge-finalize-post-merge-gate-unreachable` rows in a single day (measured 2026-09-29,
  saneca proj_e70af3a5554a4f03).

  The waiver is accepted through the SAME predicate the pre-merge door uses
  (`isAuditedOperatorBypass`), so the automated fast-mode actor stays excluded: a bypass is a named
  human decision or it is not a waiver at all. The two negative cases below are what keep this from
  becoming a way to walk a landed card into `done` without a human signing anything.
  */
  it("treats an audited operator waiver as satisfying evidence, not as a reviewer verdict", async () => {
    const ir = irWithPostMergeGate(true);
    const task = {
      ...taskWith([GATE_ID]),
      workflowStepResults: [{
        workflowStepId: GATE_ID,
        workflowStepName: GATE_ID,
        phase: "post-merge",
        status: "skipped",
        bypassedBy: "dashboard-operator",
        bypassedAt: "2026-09-29T15:00:00.000Z",
        bypassReason: "gate cannot run on this project",
        bypassedFromStatus: "absent",
      }],
    } as never;

    expect(getPostMergeEvidenceGateStatuses(task, ir)).toEqual([]);
    expect(await getRequiredPostMergeEvidenceBlocker(storeFor(ir) as never, task)).toBeUndefined();
  });

  it("refuses a skipped row that carries no waiver metadata (an automated skip is not a human decision)", () => {
    const ir = irWithPostMergeGate(true);
    const task = {
      ...taskWith([GATE_ID]),
      workflowStepResults: [{ workflowStepId: GATE_ID, phase: "post-merge", status: "skipped" }],
    } as never;

    expect(getPostMergeEvidenceGateStatuses(task, ir)).toEqual([{ gateId: GATE_ID, state: "not-approved" }]);
  });

  it("refuses the automated fast-mode actor's waiver metadata on a post-merge gate", () => {
    const ir = irWithPostMergeGate(true);
    const task = {
      ...taskWith([GATE_ID]),
      workflowStepResults: [{
        workflowStepId: GATE_ID,
        phase: "post-merge",
        status: "skipped",
        bypassedBy: FAST_MODE_BYPASS_ACTOR,
        bypassedAt: "2026-09-29T15:00:00.000Z",
        bypassReason: "fast lane",
      }],
    } as never;

    expect(getPostMergeEvidenceGateStatuses(task, ir)).toEqual([{ gateId: GATE_ID, state: "not-approved" }]);
  });
});
