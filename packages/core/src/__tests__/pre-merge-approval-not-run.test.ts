import { describe, expect, it } from "vitest";
import { collectDeterministicSignals } from "../eval/eval-signal-collector.js";
import { evaluatePreMergeApprovals } from "../merge/pre-merge-approval.js";
import {
  getTaskMergeBlocker,
  PRE_MERGE_STEPS_NOT_RUN_BLOCKER,
} from "../merge/task-merge.js";
import { isPlanReviewSatisfied } from "../planner/plan-approval.js";
import type { MergeContentDescriptor } from "../merge/merge-content-descriptor.js";
import type { Task, TaskDetail, WorkflowStepResult } from "../types.js";

function result(
  workflowStepId: string,
  overrides: Partial<WorkflowStepResult> = {},
): WorkflowStepResult {
  return {
    workflowStepId,
    workflowStepName: workflowStepId,
    phase: "pre-merge",
    status: "skipped",
    notRunReason: "not-configured",
    ...overrides,
  };
}

function approvals(results: WorkflowStepResult[], required: string[], mergeContent?: MergeContentDescriptor) {
  return evaluatePreMergeApprovals(
    { workflowStepResults: results },
    { requiredPreMergeStepIds: new Set(required), mergeContent },
  );
}

/** The archive shape `archiveTerminalWorkflowStepFailures` writes: skipped + stamp, no bypass fields. */
function archivedCarrier(workflowStepId: string, overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return result(workflowStepId, {
    notRunReason: undefined,
    remediationArchivedAt: "2026-08-28T00:00:00.000Z",
    remediationArchivedFromStatus: "failed",
    ...overrides,
  });
}

const workspaceDiff: MergeContentDescriptor = {
  kind: "workspace",
  repositories: { state: "captured", inScopeModified: ["apps/web"], fingerprints: {} },
};

function reviewTask(workflowStepResults: WorkflowStepResult[]): Task {
  return {
    id: "FN-226",
    title: "Not-run checks",
    description: "",
    column: "in-review",
    priority: "normal",
    steps: [],
    dependencies: [],
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    workflowStepResults,
  } as Task;
}

describe("pre-merge approval for not-run workflow gates", () => {
  it("approves not-run non-review verification and browser gates", () => {
    expect(approvals([result("verification")], ["verification"])[0]?.state).toBe("approved");
    expect(approvals([
      result("browser-verification", { notRunReason: "tooling-unavailable" }),
    ], ["browser-verification"])[0]?.state).toBe("approved");
  });

  it("never substitutes a not-run row for Code Review", () => {
    expect(approvals([result("code-review")], ["code-review"])[0]?.state).toBe("not-approved");
    expect(approvals([
      result("custom-code-review", { reviewKind: "code" }),
    ], ["custom-code-review"])[0]?.state).toBe("not-approved");
  });

  it("never substitutes a not-run row for Plan Review", () => {
    expect(approvals([result("plan-review")], ["plan-review"])[0]?.state).toBe("not-approved");
    expect(approvals([
      result("custom-plan-review", { reviewKind: "plan" }),
    ], ["custom-plan-review"])[0]?.state).toBe("not-approved");
    expect(approvals([
      result("custom-plan-review", {
        status: "passed",
        notRunReason: undefined,
        reviewKind: "plan",
      }),
    ], ["custom-plan-review"])[0]?.state).toBe("approved");
  });

  it("keeps an honestly not-run non-content gate mergeable", () => {
    const task = reviewTask([
      result("code-review", {
        status: "passed",
        notRunReason: undefined,
        reviewKind: "code",
        verdict: "APPROVE",
      }),
      result("verification"),
    ]);
    const required = new Set(["code-review", "verification"]);
    expect(getTaskMergeBlocker(task, { requiredPreMergeStepIds: required })).toBeUndefined();

    expect(getTaskMergeBlocker(
      { ...task, workflowStepResults: task.workflowStepResults?.filter((entry) => entry.workflowStepId !== "verification") },
      { requiredPreMergeStepIds: required },
    )).toBe(PRE_MERGE_STEPS_NOT_RUN_BLOCKER);
  });

  it("keeps Plan Review satisfaction fail-closed", () => {
    expect(isPlanReviewSatisfied(result("plan-review", {
      notRunReason: "execution-mode-skip",
    }))).toBe(false);
  });

  /*
  FNXC:PreMergeApproval 2026-09-02-21:57 (RUFU-178):
  This case previously asserted that an archived carrier is `not-approved`. That was the defect: the
  archived shape carries no verdict, and `not-approved` is the unsatisfiable answer — no automatic,
  reviewer, or operator surface can clear it — so the card could only be landed by hand. The new truth
  is asserted here, with the controls that keep it from over-firing: an audited operator bypass, an
  arbitrated release, a workspace carrier, and a genuinely failed (unarchived) row all stay put.
  */
  it("classifies a verdict-less remediation carrier as the recoverable not-run state", () => {
    expect(approvals([archivedCarrier("verification")], ["verification"])[0]?.state).toBe("missing");
    // The gate stays refused: `missing` maps to the not-run DEFERRAL, never to an approval.
    expect(getTaskMergeBlocker(
      reviewTask([archivedCarrier("verification")]),
      { requiredPreMergeStepIds: new Set(["verification"]) },
    )).toBe(PRE_MERGE_STEPS_NOT_RUN_BLOCKER);

    // Code Review and Plan Review archives recover the same way — the rule is not plan-domain scoped.
    expect(approvals([archivedCarrier("code-review", { reviewKind: "code" })], ["code-review"])[0]?.state).toBe("missing");
    expect(approvals([archivedCarrier("plan-review", { reviewKind: "plan" })], ["plan-review"])[0]?.state).toBe("missing");
  });

  it("keeps the archived shapes that carry authority out of the not-run classification", () => {
    // An audited operator bypass on top of an archived row is still a human waiver, not a re-run request.
    const bypassedArchived = archivedCarrier("verification", {
      bypassedBy: "operator",
      bypassedAt: "2026-08-28T00:00:00.000Z",
      bypassReason: "Reviewed manually",
      bypassedFromStatus: "failed",
    });
    expect(approvals([bypassedArchived], ["verification"])[0]?.state).toBe("approved");

    // An arbitrated release stays outside scope: the arbiter's ruling is not a re-runnable gate.
    const arbitratedArchived = archivedCarrier("verification", {
      arbitrationDecision: "UPHOLD_IMPLEMENTER",
      arbitratedAt: "2026-08-28T00:00:00.000Z",
    });
    expect(approvals([arbitratedArchived], ["verification"])[0]?.state).toBe("not-approved");

    // Workspace gates keep their repositoryScope proof carrier instead of the workflowStepResult row.
    expect(approvals([archivedCarrier("code-review", { reviewKind: "code" })], ["code-review"], workspaceDiff)[0]?.state)
      .toBe("not-approved");

    // Control: a genuine failure with no archive stamp is still an ordinary not-approved refusal.
    expect(approvals([
      result("verification", { status: "failed", notRunReason: undefined }),
    ], ["verification"])[0]?.state).toBe("not-approved");

    // Control: a plain operator bypass (no archive) keeps its approved behavior.
    expect(approvals([result("verification", {
      notRunReason: undefined,
      bypassedBy: "operator",
      bypassedAt: "2026-08-28T00:00:00.000Z",
      bypassReason: "Reviewed manually",
      bypassedFromStatus: "failed",
    })], ["verification"])[0]?.state).toBe("approved");
  });

  it("answers from the latest duplicate result", () => {
    const first = result("verification");
    expect(approvals([
      first,
      result("verification", { status: "failed", notRunReason: undefined }),
    ], ["verification"])[0]?.state).toBe("not-approved");
    expect(approvals([
      first,
      result("verification", { status: "passed", notRunReason: undefined }),
    ], ["verification"])[0]?.state).toBe("approved");

    /*
    FNXC:PreMergeApproval 2026-09-02-22:35 (RUFU-178):
    Latest-wins must not resurrect the archive refusal: an archived carrier followed by a genuine
    passed verdict approves — the recovery the re-seed exists to produce, asserted at the classifier.
    */
    expect(approvals([
      archivedCarrier("verification"),
      result("verification", { status: "passed", notRunReason: undefined }),
    ], ["verification"])[0]?.state).toBe("approved");

    // Control: the archive still wins when it IS the latest row.
    expect(approvals([
      result("verification", { status: "passed", notRunReason: undefined }),
      archivedCarrier("verification"),
    ], ["verification"])[0]?.state).toBe("missing");
  });

  it("counts not-run evaluation evidence as neither passed nor failed", () => {
    const task = {
      ...reviewTask([result("verification")]),
      log: [],
    } as unknown as TaskDetail;
    expect(collectDeterministicSignals(task, {
      runId: "ER-FN-226",
      startedAt: "2026-08-28T00:00:00.000Z",
    }).workflowSummary).toEqual({ total: 1, passed: 0, failed: 0, pending: 0 });
  });
});
