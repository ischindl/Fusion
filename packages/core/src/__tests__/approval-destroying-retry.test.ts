/*
FNXC:ApprovalDestroyingRetry 2026-11-14-01:35 (RUFU-599 reproduction 4, RUFU-472 / RUFU-474 / RUFU-284 / RUFU-304):
One Retry erased the approval that remained the card's only remedy. Each reported card had a required pre-merge
gate whose APPROVE still stood plus a blocker no Retry can re-produce — a post-merge gate holding a never-ran or
verdict-less carrier on an already-landed delivery, or a review the convergence ladder already escalated to a
human. The restart discards this column's gate rows, so the Retry destroyed the approval, left the blocker
standing, and re-burned review cycles RUFU-284 and RUFU-304 measured in hours.

The predicate answers from a TASK and an IR (not a row pair), because four surfaces ask it and only two of them
own a discard list. Pinned here:
  - the refusal needs all three halves: a review lane, a waiver this Retry cannot re-run, and an approving row
    belonging to THIS column;
  - a waiver on a gate the restarted column replays is a legitimate Retry, not a refusal;
  - an already-waived post-merge row offers no waiver, so nothing is refused;
  - a card outside a review lane, or with no approval in its own column, keeps its Retry;
  - the one restart planner refuses exactly what the classifier refuses (one predicate, not one CLI branch).
*/
import { describe, expect, it } from "vitest";
import {
  classifyApprovalDestroyingRetry,
  findApprovalDestroyingRetry,
  planTaskColumnRestart,
  type Task,
  type WorkflowIr,
  type WorkflowStepResult,
} from "@fusion/core";

const ir: WorkflowIr = {
  version: "v2",
  name: "approval-destroying-retry",
  columns: [
    { id: "hold", name: "Hold", traits: [{ trait: "hold" }] },
    { id: "review", name: "Review", traits: [{ trait: "human-review" }, { trait: "merge-blocker" }] },
    { id: "merging", name: "Merging", traits: [{ trait: "merge-orchestration" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "plan-review", kind: "optional-group", column: "hold", config: { phase: "pre-merge", defaultOn: true, template: { nodes: [], edges: [] } } },
    { id: "implementation", kind: "prompt", column: "hold" },
    { id: "code-review", kind: "optional-group", column: "review", config: { phase: "pre-merge", defaultOn: true, template: { nodes: [{ id: "code-review-step", kind: "prompt", config: { gateMode: "gate", prompt: "review" } }], edges: [] } } },
    { id: "merge", kind: "merge", column: "merging" },
    { id: "ci-report", kind: "optional-group", column: "merging", config: { phase: "post-merge", defaultOn: true, template: { nodes: [{ id: "ci-report-step", kind: "script", config: { gateMode: "gate" } }], edges: [] } } },
  ],
  edges: [],
};

function row(stepId: string, over: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    workflowStepId: stepId,
    workflowStepName: stepId,
    status: "passed",
    completedAt: "2026-11-14T10:00:00.000Z",
    ...over,
  } as unknown as WorkflowStepResult;
}

/** A landed card in its review lane: the shape every reported reproduction stood in. */
function task(results: WorkflowStepResult[], over: Partial<Task> = {}): Task {
  return {
    id: "RUFU-474",
    description: "retry",
    column: "review",
    steps: [],
    currentStep: 0,
    dependencies: [],
    mergeDetails: { mergeConfirmed: true },
    enabledWorkflowSteps: ["plan-review", "code-review", "ci-report"],
    workflowStepResults: results,
    ...over,
  } as Task;
}

/** RUFU-474's own blocker: an honest `ci-repository-unresolved` not-run carrier the door refuses on. */
const notRunPostMerge = row("ci-report", {
  phase: "post-merge",
  status: "skipped",
  notRunReason: "ci-repository-unresolved",
});

function restart(subject: Task) {
  return planTaskColumnRestart({
    task: subject,
    ir,
    entryNode: { id: "code-review", column: "review" },
    now: "2026-11-14T10:00:00.000Z",
  });
}

const APPROVED = [
  row("plan-review", { verdict: "APPROVE" }),
  row("implementation", { status: "passed" }),
  row("code-review", { verdict: "APPROVE" }),
];

describe("classifyApprovalDestroyingRetry, the one answer four surfaces ask", () => {
  it("refuses the RUFU-474 shape and names the waiver instead of Retry", () => {
    const refusal = findApprovalDestroyingRetry({
      task: task([...APPROVED, notRunPostMerge]),
      ir,
    });

    expect(refusal?.destroyedApproval.workflowStepId).toBe("code-review");
    expect(refusal?.waiver).toMatchObject({ workflowStepId: "ci-report", phase: "post-merge" });
    expect(refusal?.sentence).toContain("operator waiver");
    expect(refusal?.sentence).toContain("ci-report");
    // The sentence never offers Retry as the fix.
    expect(refusal?.sentence).toContain("Retry is refused");
  });

  it("refuses on a plain verdict-less skipped post-merge row too", () => {
    const refusal = findApprovalDestroyingRetry({
      task: task([...APPROVED, row("ci-report", { phase: "post-merge", status: "skipped" })]),
      ir,
    });
    expect(refusal?.waiver.workflowStepId).toBe("ci-report");
  });

  it("refuses on an audited-waiver approval being destroyed by the restart", () => {
    const refusal = findApprovalDestroyingRetry({
      task: task([
        row("plan-review", { verdict: "APPROVE" }),
        row("code-review", {
          status: "skipped",
          bypassedBy: "operator",
          bypassedAt: "2026-11-14T09:00:00.000Z",
          bypassReason: "reviewer unavailable",
        }),
        notRunPostMerge,
      ]),
      ir,
    });
    expect(refusal?.destroyedApproval.workflowStepId).toBe("code-review");
  });

  it("keeps an ordinary re-review Retry: no waiver is offered when every gate approved", () => {
    expect(classifyApprovalDestroyingRetry({ task: task(APPROVED), ir }).kind)
      .toBe("not-approval-destroying");
  });

  it("keeps the Retry whose waiver target sits in the column being replayed (a failed review re-runs)", () => {
    // `code-review` failed with no verdict: the restart replays that node, so Retry IS the remedy.
    const subject = task([
      row("plan-review", { verdict: "APPROVE" }),
      row("code-review", { status: "failed" }),
    ]);
    expect(findApprovalDestroyingRetry({ task: subject, ir })).toBeUndefined();
  });

  it("keeps the Retry when the gate the waiver names lives in a later column the card is not restarting", () => {
    // The card sits in `merging`: `code-review` is not this column's row to discard.
    const refusal = findApprovalDestroyingRetry({
      task: task([...APPROVED, notRunPostMerge], { column: "merging" }),
      ir,
    });
    expect(refusal).toBeUndefined();
  });

  it("keeps the Retry for a card outside every review lane", () => {
    const refusal = findApprovalDestroyingRetry({
      task: task([...APPROVED, notRunPostMerge], { column: "hold", status: "failed" }),
      ir,
    });
    expect(refusal).toBeUndefined();
  });

  it("keeps the Retry where an operator hold already suppresses the waiver itself", () => {
    // offer == refusal == Retry door: a hand-placed hold offers no waiver, so it refuses no Retry either.
    const refusal = findApprovalDestroyingRetry({
      task: task([...APPROVED, notRunPostMerge], { paused: true, userPaused: true }),
      ir,
    });
    expect(refusal).toBeUndefined();
  });

  it("keeps the Retry once the post-merge row carries a real verdict (the waiver is no longer offered)", () => {
    const refusal = findApprovalDestroyingRetry({
      task: task([...APPROVED, row("ci-report", { phase: "post-merge", status: "passed", verdict: "APPROVE" })]),
      ir,
    });
    expect(refusal).toBeUndefined();
  });

  it("keeps the Retry once an audited waiver has already been applied to the post-merge gate", () => {
    const refusal = findApprovalDestroyingRetry({
      task: task([...APPROVED, row("ci-report", {
        phase: "post-merge",
        status: "skipped",
        bypassedBy: "operator",
        bypassedAt: "2026-11-14T09:00:00.000Z",
        bypassReason: "reporter unavailable",
      })]),
      ir,
    });
    expect(refusal).toBeUndefined();
  });

  it("refuses nothing when the IR is unresolvable", () => {
    expect(findApprovalDestroyingRetry({ task: task([...APPROVED, notRunPostMerge]), ir: undefined })).toBeUndefined();
  });
});

describe("the one restart planner refuses exactly what the classifier refuses", () => {
  it("refuses the review restart that would erase the approval past an un-rerunnable blocker", () => {
    const plan = restart(task([...APPROVED, notRunPostMerge]));

    expect(plan.kind).toBe("refused");
    if (plan.kind !== "refused") return;
    expect(plan.reason).toBe("approval-destroying-retry");
    expect(plan.detail?.retryRefusal?.waiver.workflowStepId).toBe("ci-report");
    // The refusal is a pure decision: no patch, so nothing was staged for publication.
    expect((plan as { patch?: unknown }).patch).toBeUndefined();
  });

  it("still restarts the review stage when the approval is the only thing standing", () => {
    expect(restart(task(APPROVED)).kind).toBe("restart");
  });

  it("still restarts the review stage when the gate needing the waiver is this column's own to replay", () => {
    const plan = restart(task([
      row("plan-review", { verdict: "APPROVE" }),
      row("code-review", { status: "failed" }),
    ]));
    expect(plan.kind).toBe("restart");
  });
});
