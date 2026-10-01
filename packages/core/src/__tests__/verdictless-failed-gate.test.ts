import { describe, expect, it } from "vitest";
import {
  findVerdictLessFailedRequiredGates,
  isVerdictLessFailedGateRow,
  evaluatePreMergeApprovals,
  resolveUnprovenReviewApproval,
} from "../merge/pre-merge-approval.js";
import {
  buildPreMergeGateApprovalBlocker,
  getTaskMergeBlocker,
  hasFailedPreMergeWorkflowStepRow,
  isPreMergeGateFailedBlocker,
  namesVerdictLessFailedGate,
  parsePreMergeGateApprovalBlocker,
  PRE_MERGE_STEPS_FAILED_BLOCKER,
  PRE_MERGE_STEPS_NOT_RUN_BLOCKER,
  STALE_CONTENT_APPROVAL_BLOCKER,
} from "../merge/task-merge.js";

/*
FNXC:VerdictlessFailedGate 2026-09-14-13:32 (RUFU-217):
RUFU-204's live repro: a required Plan Review row `failed` with `verdict: null` (a plumbing failure,
FN-295-restored as collateral) was refused by the merge door exactly like an authored REVISE and was
invisible to every re-run route. These tests name the class and pin that the merge-door refusal stays
byte-identical for it (FN-180 / AC2) while the classifier admits it to bounded automatic re-runs.
*/

const base = {
  column: "in-review", paused: false, steps: [], repositoryScope: undefined,
};

const verdictlessPlanRow = {
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  phase: "pre-merge" as const,
  status: "failed" as const,
  reviewKind: "plan" as const,
};

describe("isVerdictLessFailedGateRow", () => {
  it("names the RUFU-204 shape: failed plan gate with no verdict", () => {
    expect(isVerdictLessFailedGateRow(verdictlessPlanRow)).toBe(true);
  });

  it("names a literal JSON null verdict (stored rows predate the optional-field type)", () => {
    expect(isVerdictLessFailedGateRow({ ...verdictlessPlanRow, verdict: null } as never)).toBe(true);
  });

  it("excludes authored non-approvals — reviewer authority is untouched (AC2)", () => {
    expect(isVerdictLessFailedGateRow({ ...verdictlessPlanRow, verdict: "REVISE" as const })).toBe(false);
    expect(isVerdictLessFailedGateRow({ ...verdictlessPlanRow, verdict: "RETHINK" as never })).toBe(false);
    expect(isVerdictLessFailedGateRow({ ...verdictlessPlanRow, verdict: "UNAVAILABLE" as never })).toBe(false);
  });

  it("excludes rows other recovery lanes own (FN-8492, waivers, archives, arbitration)", () => {
    expect(isVerdictLessFailedGateRow({ ...verdictlessPlanRow, status: "pending" as const })).toBe(false);
    expect(isVerdictLessFailedGateRow({ ...verdictlessPlanRow, status: "advisory_failure" as const })).toBe(false);
    expect(isVerdictLessFailedGateRow({
      ...verdictlessPlanRow,
      status: "skipped" as const,
      bypassedBy: "operator-1",
      bypassedAt: "2026-09-01T00:00:00.000Z",
      bypassReason: "transport failed",
    })).toBe(false);
    // FN-295 PRE-restore archived carrier: the restore lane owns it, not the reseed.
    expect(isVerdictLessFailedGateRow({
      ...verdictlessPlanRow,
      status: "skipped" as const,
      remediationArchivedAt: "2026-09-05T00:00:00.000Z",
      remediationArchivedFromStatus: "failed" as const,
    })).toBe(false);
    expect(isVerdictLessFailedGateRow({ ...verdictlessPlanRow, arbitrationDecision: "UPHOLD_REVIEW" as const })).toBe(false);
  });

  it("excludes gates that never owed a verdict (script-mode verification gates)", () => {
    expect(isVerdictLessFailedGateRow({
      workflowStepId: "verification", workflowStepName: "Verify", phase: "pre-merge", status: "failed",
    })).toBe(false);
    // ... but a gate that explicitly opted into verdict semantics is in the class.
    expect(isVerdictLessFailedGateRow({
      workflowStepId: "browser-review", workflowStepName: "Browser", phase: "pre-merge", status: "failed", verdictRequired: true,
    })).toBe(true);
    // ... and Code Review owes one by identity even without reviewKind metadata.
    expect(isVerdictLessFailedGateRow({
      workflowStepId: "code-review", workflowStepName: "Code", phase: "pre-merge", status: "failed",
    })).toBe(true);
  });

  it("excludes post-merge rows and passed rows", () => {
    expect(isVerdictLessFailedGateRow({ ...verdictlessPlanRow, phase: "post-merge" as const })).toBe(false);
    expect(isVerdictLessFailedGateRow({ ...verdictlessPlanRow, status: "passed" as const })).toBe(false);
  });

  it("names the FN-279 invalidated approval (verdict stripped, status failed)", () => {
    const approval = {
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge" as const,
      status: "passed" as const,
      verdict: "APPROVE" as const,
      reviewKind: "code" as const,
    };
    const downgraded = resolveUnprovenReviewApproval(approval, { workspace: false })!.downgraded;
    expect(isVerdictLessFailedGateRow(downgraded)).toBe(true);
  });
});

describe("evaluatePreMergeApprovals verdict-less marking", () => {
  const required = new Set(["plan-review", "code-review"]);

  it("marks the verdict-less not-approved row and keeps every other shape byte-stable", () => {
    const approvals = evaluatePreMergeApprovals({
      ...base,
      workflowStepResults: [
        verdictlessPlanRow,
        {
          workflowStepId: "code-review", workflowStepName: "Code", phase: "pre-merge" as const,
          status: "failed" as const, reviewKind: "code" as const, verdict: "REVISE" as const,
        },
      ],
    }, { requiredPreMergeStepIds: required });
    const plan = approvals.find((a) => a.workflowStepId === "plan-review")!;
    const code = approvals.find((a) => a.workflowStepId === "code-review")!;
    expect(plan.state).toBe("not-approved");
    expect(plan.verdictLessFailed).toBe(true);
    expect(code.state).toBe("not-approved");
    // Byte-stability for non-members: the key is ABSENT, not present-undefined, so every
    // existing consumer sees the exact pre-RUFU-217 approval shape.
    expect(Object.keys(code)).not.toContain("verdictLessFailed");

    const missing = evaluatePreMergeApprovals({ ...base, workflowStepResults: [] }, { requiredPreMergeStepIds: required });
    for (const approval of missing) expect(Object.keys(approval)).not.toContain("verdictLessFailed");
  });
});

describe("findVerdictLessFailedRequiredGates", () => {
  it("finds the stranded plan gate on RUFU-204's card", () => {
    expect(findVerdictLessFailedRequiredGates({
      ...base,
      workflowStepResults: [
        verdictlessPlanRow,
        {
          workflowStepId: "code-review", workflowStepName: "Code", phase: "pre-merge" as const,
          status: "passed" as const, reviewKind: "code" as const, verdict: "APPROVE" as const,
          reviewInputFingerprint: "a",
        },
      ],
    }, { requiredPreMergeStepIds: new Set(["plan-review", "code-review"]) })).toEqual(["plan-review"]);
  });

  it("resolves nothing without required gate ids (no gate the engine could re-run)", () => {
    expect(findVerdictLessFailedRequiredGates({ ...base, workflowStepResults: [verdictlessPlanRow] })).toEqual([]);
    expect(findVerdictLessFailedRequiredGates({ ...base, workflowStepResults: [verdictlessPlanRow] }, { requiredPreMergeStepIds: new Set() })).toEqual([]);
  });

  it("reads the latest row per gate: superseded verdict-less rows drop out and fresh ones win", () => {
    const authoredLater = { ...base, workflowStepResults: [
      { ...verdictlessPlanRow, completedAt: "2026-09-09T01:00:00.000Z" },
      { ...verdictlessPlanRow, verdict: "REVISE" as const, completedAt: "2026-09-09T02:00:00.000Z" },
    ] };
    expect(findVerdictLessFailedRequiredGates(authoredLater, { requiredPreMergeStepIds: new Set(["plan-review"]) })).toEqual([]);

    const verdictLessLater = { ...base, workflowStepResults: [
      { ...verdictlessPlanRow, verdict: "REVISE" as const, completedAt: "2026-09-09T01:00:00.000Z" },
      { ...verdictlessPlanRow, completedAt: "2026-09-09T02:00:00.000Z" },
    ] };
    expect(findVerdictLessFailedRequiredGates(verdictLessLater, { requiredPreMergeStepIds: new Set(["plan-review"]) })).toEqual(["plan-review"]);
  });

  it("lists every verdict-less gate when several crashed", () => {
    const ids = findVerdictLessFailedRequiredGates({
      ...base,
      workflowStepResults: [
        verdictlessPlanRow,
        { workflowStepId: "code-review", workflowStepName: "Code", phase: "pre-merge" as const, status: "failed" as const, reviewKind: "code" as const },
      ],
    }, { requiredPreMergeStepIds: new Set(["plan-review", "code-review"]) });
    expect(ids.sort()).toEqual(["code-review", "plan-review"]);
  });
});

describe("pre-merge gate failure blocker contract (keyed text)", () => {
  it("builds the gate-named refusal byte-identically to the historical inline template", () => {
    expect(buildPreMergeGateApprovalBlocker("plan-review"))
      .toBe("task has enabled pre-merge workflow steps without a current approval (gate 'plan-review')");
    expect(buildPreMergeGateApprovalBlocker("code-review"))
      .toBe("task has enabled pre-merge workflow steps without a current approval (gate 'code-review')");
    expect(PRE_MERGE_STEPS_FAILED_BLOCKER).toBe("task has failed pre-merge workflow steps");
  });

  it("the merge door keeps refusing the verdict-less class byte-identically (AC2), with and without gate ids", () => {
    const card = { ...base, workflowStepResults: [verdictlessPlanRow] };
    expect(getTaskMergeBlocker(card, { requiredPreMergeStepIds: new Set(["plan-review"]) }))
      .toBe(buildPreMergeGateApprovalBlocker("plan-review"));
    // Recovery semantics (no gate ids) keep the generic sentence byte-stable.
    expect(getTaskMergeBlocker(card)).toBe(PRE_MERGE_STEPS_FAILED_BLOCKER);
  });

  it("parses the named gate back out and rejects everything else", () => {
    expect(parsePreMergeGateApprovalBlocker(buildPreMergeGateApprovalBlocker("code-review"))).toBe("code-review");
    expect(parsePreMergeGateApprovalBlocker(PRE_MERGE_STEPS_FAILED_BLOCKER)).toBeUndefined();
    expect(parsePreMergeGateApprovalBlocker(PRE_MERGE_STEPS_NOT_RUN_BLOCKER)).toBeUndefined();
    expect(parsePreMergeGateApprovalBlocker("task is paused")).toBeUndefined();
    expect(parsePreMergeGateApprovalBlocker(
      "task is marked 'failed': In-review stall deadlock: merge-blocker repeated 3\u00d7 without progress",
    )).toBeUndefined();
    expect(parsePreMergeGateApprovalBlocker(
      "task has enabled pre-merge workflow steps without a current approval (gate '')",
    )).toBeUndefined();
  });

  it("isPreMergeGateFailedBlocker accepts both sentences of the family and refuses foreign blockers", () => {
    expect(isPreMergeGateFailedBlocker(PRE_MERGE_STEPS_FAILED_BLOCKER)).toBe(true);
    expect(isPreMergeGateFailedBlocker(buildPreMergeGateApprovalBlocker("plan-review"))).toBe(true);
    expect(isPreMergeGateFailedBlocker(PRE_MERGE_STEPS_NOT_RUN_BLOCKER)).toBe(false);
    expect(isPreMergeGateFailedBlocker(STALE_CONTENT_APPROVAL_BLOCKER)).toBe(false);
    expect(isPreMergeGateFailedBlocker("task has no provable approval for the content being merged")).toBe(false);
    expect(isPreMergeGateFailedBlocker("task is marked 'failed': boom")).toBe(false);
  });

  it("hasFailedPreMergeWorkflowStepRow mirrors the door's own failed-row evidence", () => {
    // The door turns exactly this scan into PRE_MERGE_STEPS_FAILED_BLOCKER when gate ids are omitted,
    // so recovery admissions can pair a gate-named refusal with the same fact (RUFU-217 hazard-1).
    expect(hasFailedPreMergeWorkflowStepRow({ workflowStepResults: [verdictlessPlanRow] })).toBe(true);
    expect(hasFailedPreMergeWorkflowStepRow({ workflowStepResults: [
      { ...verdictlessPlanRow, phase: "post-merge" as const },
    ] })).toBe(false);
    expect(hasFailedPreMergeWorkflowStepRow({ workflowStepResults: [
      { ...verdictlessPlanRow, status: "pending" as const },
    ] })).toBe(false);
    expect(hasFailedPreMergeWorkflowStepRow({ workflowStepResults: [] })).toBe(false);
    expect(hasFailedPreMergeWorkflowStepRow({})).toBe(false);
  });
});

describe("namesVerdictLessFailedGate (shared re-run class condition)", () => {
  const required = new Set(["plan-review", "code-review"]);

  it("admits only when the NAMED gate's latest required row is verdict-less failed", () => {
    const card = { ...base, workflowStepResults: [verdictlessPlanRow] };
    expect(namesVerdictLessFailedGate(card, buildPreMergeGateApprovalBlocker("plan-review"), { requiredPreMergeStepIds: required }))
      .toBe(true);
  });

  it("refuses an authored REVISE named by the same refusal — reviewer authority keeps the remediation lane", () => {
    const authored = { ...base, workflowStepResults: [
      { ...verdictlessPlanRow, verdict: "REVISE" as const },
    ] };
    expect(namesVerdictLessFailedGate(authored, buildPreMergeGateApprovalBlocker("plan-review"), { requiredPreMergeStepIds: required }))
      .toBe(false);
  });

  it("refuses a live pending row and a superseded verdict-less row (FN-8492 owns pending)", () => {
    const pending = { ...base, workflowStepResults: [
      { ...verdictlessPlanRow, status: "pending" as const },
    ] };
    expect(namesVerdictLessFailedGate(pending, buildPreMergeGateApprovalBlocker("plan-review"), { requiredPreMergeStepIds: required }))
      .toBe(false);
    const superseded = { ...base, workflowStepResults: [
      { ...verdictlessPlanRow, completedAt: "2026-09-09T01:00:00.000Z" },
      { ...verdictlessPlanRow, verdict: "REVISE" as const, completedAt: "2026-09-09T02:00:00.000Z" },
    ] };
    expect(namesVerdictLessFailedGate(superseded, buildPreMergeGateApprovalBlocker("plan-review"), { requiredPreMergeStepIds: required }))
      .toBe(false);
  });

  it("refuses refusals that name another gate or no gate at all", () => {
    const card = { ...base, workflowStepResults: [verdictlessPlanRow] };
    // The refusal names code-review, whose only row is missing — not this card's verdict-less gate.
    expect(namesVerdictLessFailedGate(card, buildPreMergeGateApprovalBlocker("code-review"), { requiredPreMergeStepIds: required }))
      .toBe(false);
    expect(namesVerdictLessFailedGate(card, PRE_MERGE_STEPS_FAILED_BLOCKER, { requiredPreMergeStepIds: required })).toBe(false);
    expect(namesVerdictLessFailedGate(card, PRE_MERGE_STEPS_NOT_RUN_BLOCKER, { requiredPreMergeStepIds: required })).toBe(false);
    expect(namesVerdictLessFailedGate(card, STALE_CONTENT_APPROVAL_BLOCKER, { requiredPreMergeStepIds: required })).toBe(false);
    expect(namesVerdictLessFailedGate(card, "task is paused", { requiredPreMergeStepIds: required })).toBe(false);
    expect(namesVerdictLessFailedGate(card, undefined, { requiredPreMergeStepIds: required })).toBe(false);
    // Without resolved gate ids there is no named-gate approval to inspect — refuse, stay result-only.
    expect(namesVerdictLessFailedGate(card, buildPreMergeGateApprovalBlocker("plan-review"))).toBe(false);
  });

  it("stale and unprovable refusals can never reach the reseed lane through this condition", () => {
    // Same shape the door emits them with: the sentences fail the gate-name parse outright.
    const card = { ...base, workflowStepResults: [verdictlessPlanRow] };
    expect(namesVerdictLessFailedGate(card, STALE_CONTENT_APPROVAL_BLOCKER, { requiredPreMergeStepIds: required })).toBe(false);
    expect(namesVerdictLessFailedGate(card, "task has no provable approval for the content being merged", { requiredPreMergeStepIds: required })).toBe(false);
  });

  it("the door blocker it was built beside resolves the class end-to-end", () => {
    // getTaskMergeBlocker(names gate) -> namesVerdictLessFailedGate(true) for the class, (false) for
    // authored REVISE — the exact single-resolution parity the three admission gates depend on.
    const classCard = { ...base, workflowStepResults: [verdictlessPlanRow] };
    const authoredCard = { ...base, workflowStepResults: [
      { ...verdictlessPlanRow, verdict: "REVISE" as const },
    ] };
    for (const [card, expected] of [[classCard, true], [authoredCard, false]] as const) {
      const blocker = getTaskMergeBlocker(card, { requiredPreMergeStepIds: required });
      expect(namesVerdictLessFailedGate(card, blocker, { requiredPreMergeStepIds: required })).toBe(expected);
    }
  });
});
