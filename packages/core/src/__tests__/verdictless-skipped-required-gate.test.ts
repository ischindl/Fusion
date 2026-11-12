import { describe, expect, it } from "vitest";
/*
FNXC:VerdictlessSkippedGate 2026-11-12-19:36 (RUFU-657):
THE INVARIANT: a required pre-merge gate whose latest row owes an authored verdict and reports
neither a verdict, nor an honest fixed not-run reason, nor an audited waiver is never left without
an owner — and never left silent.

The fixtures below are the field sets MEASURED off the live disk mirrors of the two cards that
proved the class (`.fusion/tasks/RUFU-343/task.json`, `.fusion/tasks/RUFU-366/task.json`, read
2026-11-12T19:1xZ), plus the shape-A exemplars (RUFU-351 / RUFU-455). Reproduced as fixtures, not
described, because a repro-only test regresses (the FN-5787 / FN-5751 / FN-6115 lesson).

Ownership map this file pins, so a future widening cannot silently steal another lane's row:
- `failed` + no verdict                            -> RUFU-217 (`isVerdictLessFailedGateRow`)
- no result row at all                             -> FN-9243 / RUFU-276 zero-row seed lane
- `skipped` + `remediationArchivedAt` (shape A)     -> FN-295 restore lane + FN-7720 audited bypass
- `skipped` + honest `notRunReason`                 -> RUFU-375 refused-to-run, merges on its own terms
- `skipped` + audited `bypassedBy`                  -> FN-7720 waiver, approved, untouchable
- `skipped` + verdict (any)                         -> the verdict's own veto
- `skipped` + nothing that proves a decision        -> THIS card's owed-verdict class
*/
import {
  countOwedVerdictRequiredGateAttempts,
  evaluatePreMergeApprovals,
  findOwedVerdictRequiredPreMergeGates,
  findUnrunRequiredPreMergeStepIds,
  findVerdictLessFailedRequiredGates,
  isAuditedOperatorBypass,
  isVerdictLessFailedGateRow,
  isVerdictLessSkippedOwedVerdictRow,
  OWED_VERDICT_GATE_RERUN_ATTEMPT_LIMIT,
} from "../merge/pre-merge-approval.js";
import {
  buildPreMergeGateApprovalBlocker,
  getTaskMergeBlocker,
  PRE_MERGE_STEPS_NOT_RUN_BLOCKER,
} from "../merge/task-merge.js";
import { getInReviewStallReason } from "../tasks/in-review-stall.js";
import { deriveReviewBypassTarget } from "../merge/review-bypass-target.js";
import { buildStrandedGateRetryPatch, type StrandedGateRetryTask } from "../tasks/stranded-gate-retry.js";
import { isWorkflowStepNotRun, WORKFLOW_STEP_NOT_RUN_REASONS } from "../workflows/workflow-step-results.js";
import { FAST_MODE_BYPASS_ACTOR } from "../workflows/workflow-fast-lane.js";
import type { Task, WorkflowStepResult } from "../types.js";

const GATE = "code-review";
const REQUIRED = new Set<string>(["plan-review", GATE]);
const NOW = Date.parse("2026-11-12T12:00:00.000Z");

const approvedPlanReview: WorkflowStepResult = {
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  phase: "pre-merge",
  status: "passed",
  verdict: "APPROVE",
  reviewKind: "plan",
  verdictRequired: true,
};

/** One verdict-less `failed` attempt, the shape RUFU-343 carries four of in `priorAttempts`. */
const verdictlessAttempt = (startedAt: string): WorkflowStepResult => ({
  workflowStepId: GATE,
  workflowStepName: "Code Review",
  phase: "pre-merge",
  status: "failed",
  reviewKind: "code",
  startedAt,
  completedAt: startedAt,
  output: "Code Review failed before producing a verdict: failed",
});

/*
The RUFU-343 row exactly: `skipped`, no verdict, no `bypassedBy`, no `notRunReason`, no archive
stamp, no fingerprint, and an automated stale-callback waiver carrier. The carrier is part of the
reproduction, not decoration: it is what `issueStaleReviewCallbackWaiverImpl` actually leaves behind
(packages/core/src/task-store/task-mutation-ops.ts), and it is NOT an audited operator waiver
(`isAuditedOperatorBypass` reads `bypassedBy`, which this row never gains).
*/
const rufu343CodeReview: WorkflowStepResult = {
  workflowStepId: GATE,
  workflowStepName: "Code Review",
  phase: "pre-merge",
  status: "skipped",
  reviewKind: "code",
  startedAt: "2026-10-10T00:46:40.532Z",
  completedAt: "2026-10-10T01:32:50.084Z",
  output: "Code Review failed before producing a verdict: failed",
  automatedStaleCallbackWaiver: {
    actor: "system:stale-review-callback-waiver",
    reason: "proven-stale-code-review-callback",
    issuedAt: "2026-10-10T01:32:50.084Z",
    attemptId: "failed:2026-10-10T00:29:16.357Z:2026-10-10T00:46:40.532Z",
    receiptId: "2e9d3c12-8a3c-4604-ac87-164fbdf1cdd1",
    priorStatus: "failed",
    policyVersion: "fn-9429-v1",
  },
  priorAttempts: [
    verdictlessAttempt("2026-10-10T00:29:16.357Z"),
    verdictlessAttempt("2026-10-10T00:04:00.000Z"),
    verdictlessAttempt("2026-10-09T23:42:00.000Z"),
    verdictlessAttempt("2026-10-09T23:10:00.000Z"),
  ],
};

/** The RUFU-366 row: same terminal shape, one prior verdict-less attempt instead of four. */
const rufu366CodeReview: WorkflowStepResult = {
  ...rufu343CodeReview,
  completedAt: "2026-11-08T23:21:52.359Z",
  priorAttempts: [verdictlessAttempt("2026-11-08T22:49:31.479Z")],
};

/** Shape A (RUFU-351 / RUFU-455): the FN-295 collateral-carrier veto. Never this class's. */
const archivedCarrierRow: WorkflowStepResult = {
  workflowStepId: GATE,
  workflowStepName: "Code Review",
  phase: "pre-merge",
  status: "skipped",
  reviewKind: "code",
  reviewInputFingerprint: "sha256:aaaabbbbccccdddd",
  remediationArchivedAt: "2026-11-01T10:00:00.000Z",
  remediationArchivedFromStatus: "failed",
  priorAttempts: [{ ...verdictlessAttempt("2026-11-01T09:00:00.000Z"), verdict: "REVISE" }],
};

type FixtureTask = Task & Record<string, unknown>;

/**
 * The two lease shapes the class is measured on: a singular checkout (`worktree`) and a workspace
 * card (`workspaceWorktrees`). Lease classification participates in the bypass lever, so both are
 * exercised everywhere the row shape alone is not enough to decide.
 */
function card(
  overrides: Partial<Pick<Task, "workflowStepResults" | "steps" | "error" | "status" | "mergeRetries">> = {},
  lease: "singular" | "workspace" = "singular",
): FixtureTask {
  const base = {
    id: "RUFU-343",
    column: "in-review",
    paused: false,
    userPaused: false,
    status: null,
    error: null,
    steps: Array.from({ length: 8 }, (_unused, index) => ({ name: `Step ${index + 1}`, status: "done" as const })),
    workflowStepResults: [approvedPlanReview, rufu343CodeReview],
    mergeDetails: {},
    mergeRetries: 0,
    updatedAt: new Date(NOW - 60 * 60_000).toISOString(),
    ...(lease === "singular"
      ? { worktree: "/fusion/worktrees/rufu-343" }
      : {
        // A workspace review card holds BOTH: its canonical lane worktree pointer and the per-member
        // entries. Same shape `zero-commit-workspace-land-park.test.ts` models, and the reason
        // `no-worktree-no-merge-confirmed` is not the honest answer for a workspace card that still
        // owns its checkouts.
        worktree: "/fusion/worktrees/rufu-343",
        workspaceWorktrees: { "packages/alpha": { worktreePath: "/fusion/worktrees/rufu-343/packages/alpha", branch: "fusion/rufu-343" } },
        repositoryScope: { state: "confirmed", revision: 1 },
      }),
  } as unknown as Task;
  return { ...base, ...overrides } as FixtureTask;
}

function stall(task: FixtureTask) {
  return getInReviewStallReason(task, {
    now: NOW,
    autoMerge: true,
    reviewColumns: new Set(["in-review"]),
    requiredPreMergeStepIds: REQUIRED,
  });
}

describe("owed-verdict terminal shape (RUFU-343 / RUFU-366)", () => {
  it("reproduces the measured refusal: the merge door refuses and no other lane names the gate", () => {
    const task = card();
    // The door refuses, so the card is genuinely blocked from merging.
    expect(getTaskMergeBlocker(task, { requiredPreMergeStepIds: REQUIRED }))
      .toBe(buildPreMergeGateApprovalBlocker(GATE));
    expect(getTaskMergeBlocker(task, { requiredPreMergeStepIds: REQUIRED }))
      .not.toBe(PRE_MERGE_STEPS_NOT_RUN_BLOCKER);
    // RUFU-217's re-run lane does not see it (its predicate requires `status: "failed"`).
    expect(findVerdictLessFailedRequiredGates(task, { requiredPreMergeStepIds: REQUIRED })).toEqual([]);
    // FN-9243 / RUFU-276's zero-row seed lane does not see it either: the row EXISTS, it just
    // never reported. This pair of facts is exactly the seedable set that lane builds, so pinning
    // them pins "the zero-row seed lane never admits this class" (RUFU-657 Step 5).
    expect(findUnrunRequiredPreMergeStepIds(task, { requiredPreMergeStepIds: REQUIRED })).toEqual([]);
    expect(evaluatePreMergeApprovals(task, { requiredPreMergeStepIds: REQUIRED })).toEqual([
      { workflowStepId: "plan-review", state: "approved" },
      { workflowStepId: GATE, state: "not-approved" },
    ]);
  });

  it("names the shape as owed-verdict while keeping every other lane's exclusion intact", () => {
    expect(isVerdictLessSkippedOwedVerdictRow(rufu343CodeReview)).toBe(true);
    expect(isVerdictLessFailedGateRow(rufu343CodeReview)).toBe(false);
    expect(isAuditedOperatorBypass(rufu343CodeReview)).toBe(false);
    expect(findOwedVerdictRequiredPreMergeGates(card(), { requiredPreMergeStepIds: REQUIRED })).toEqual([GATE]);
  });

  it("classifies the card instead of staying silent, on both lease shapes", () => {
    for (const lease of ["singular", "workspace"] as const) {
      const signal = stall(card({}, lease));
      expect(signal?.code, lease).toBe("rerun-exhausted");
      expect(signal?.reason, lease).toContain(GATE);
    }
  });

  it("reports the exhausted budget as an operator-owned stop naming the one remedy", () => {
    const signal = stall(card());
    expect(signal?.code).toBe("rerun-exhausted");
    // Never reads as "this card was re-reviewed" and never claims delivery.
    expect(signal?.reason.toLowerCase()).not.toContain("reviewed");
    expect(signal?.reason).toContain("bypass");
  });

  it("arms exactly one bounded re-run while the row's own attempt evidence leaves budget (RUFU-366)", () => {
    const task = card({ workflowStepResults: [approvedPlanReview, rufu366CodeReview] });
    expect(countOwedVerdictRequiredGateAttempts(task, GATE)).toBe(2);
    expect(countOwedVerdictRequiredGateAttempts(task, GATE)).toBeLessThan(OWED_VERDICT_GATE_RERUN_ATTEMPT_LIMIT);
    expect(stall(task)?.code).toBe("rerun-armed");
  });

  it("counts attempts from the row itself, so no new counter exists to drift", () => {
    expect(countOwedVerdictRequiredGateAttempts(card(), GATE)).toBe(5);
    expect(OWED_VERDICT_GATE_RERUN_ATTEMPT_LIMIT).toBe(3);
  });

  it("pre-empts the completed-review arm, which is why RUFU-343 wore the wrong badge", () => {
    // All steps done, no status, no error, zero merge retries: the completed arm used to answer
    // `completed-review-status-none` for a card whose gate had in fact refused to report.
    const task = card();
    expect(task.steps.every((step) => step.status === "done")).toBe(true);
    expect(task.status).toBeNull();
    expect(task.error).toBeNull();
    expect(stall(task)?.code).not.toBe("completed-review-status-none");
  });

  it("keeps the classifier silent when no gate ids resolve, byte-identical for fallback callers", () => {
    const task = card();
    const withoutGateIds = getInReviewStallReason(task, { now: NOW, autoMerge: true, reviewColumns: new Set(["in-review"]) });
    expect(withoutGateIds?.code).toBe("completed-review-status-none");
  });

  it("survives a literal JSON null verdict the way stored rows write it", () => {
    const task = card({
      workflowStepResults: [approvedPlanReview, { ...rufu343CodeReview, verdict: null } as unknown as WorkflowStepResult],
    });
    expect(findOwedVerdictRequiredPreMergeGates(task, { requiredPreMergeStepIds: REQUIRED })).toEqual([GATE]);
  });
});

describe("owed-verdict predicate refuses every shape another lane owns", () => {
  const owed = { workflowStepId: GATE, workflowStepName: "Code Review", phase: "pre-merge" as const, status: "skipped" as const, reviewKind: "code" as const };

  it("shape A: the FN-295 archived carrier is never admitted and keeps its veto", () => {
    const task = card({ workflowStepResults: [approvedPlanReview, archivedCarrierRow] });
    expect(isVerdictLessSkippedOwedVerdictRow(archivedCarrierRow)).toBe(false);
    expect(findOwedVerdictRequiredPreMergeGates(task, { requiredPreMergeStepIds: REQUIRED })).toEqual([]);
    // Unconditional merge veto, byte-for-byte, and no verdict is fabricated by anyone here.
    expect(evaluatePreMergeApprovals(task, { requiredPreMergeStepIds: REQUIRED }).at(-1)).toEqual({
      workflowStepId: GATE, state: "not-approved",
    });
    expect(task.workflowStepResults?.at(-1)?.verdict).toBeUndefined();
    // The classifier keeps its prior disposition for that carrier instead of arming.
    expect(stall(task)?.code).toBe("completed-review-status-none");
    expect(stall(task)?.code).not.toBe("rerun-armed");
  });

  it("an audited operator waiver is never re-armed and never re-waived", () => {
    const waived: WorkflowStepResult = {
      ...owed,
      bypassedBy: "operator-1",
      bypassedAt: "2026-11-10T00:00:00.000Z",
      bypassReason: "provider outage, zero-diff card",
      bypassedFromStatus: "failed",
    };
    expect(isAuditedOperatorBypass(waived)).toBe(true);
    expect(isVerdictLessSkippedOwedVerdictRow(waived)).toBe(false);
    const task = card({ workflowStepResults: [approvedPlanReview, waived] });
    expect(findOwedVerdictRequiredPreMergeGates(task, { requiredPreMergeStepIds: REQUIRED })).toEqual([]);
    expect(getTaskMergeBlocker(task, { requiredPreMergeStepIds: REQUIRED })).toBeUndefined();
    expect(deriveReviewBypassTarget(task, REQUIRED, new Set(["in-review"]))).toBeUndefined();
  });

  it("an honest not-run reason stays honest: not rerunnable through this arm", () => {
    expect(WORKFLOW_STEP_NOT_RUN_REASONS).toContain("required-gate-refused-owed-verdict");
    for (const notRunReason of WORKFLOW_STEP_NOT_RUN_REASONS) {
      if (notRunReason === "required-gate-refused-owed-verdict") continue;
      const honest = { ...owed, notRunReason };
      expect(isWorkflowStepNotRun(honest), notRunReason).toBe(true);
      expect(isVerdictLessSkippedOwedVerdictRow(honest), notRunReason).toBe(false);
    }
  });

  it("the owed-verdict discriminator is a refusal, never an honest not-run row", () => {
    const declared = { ...owed, notRunReason: "required-gate-refused-owed-verdict" as const };
    expect(isWorkflowStepNotRun(declared)).toBe(false);
    expect(isVerdictLessSkippedOwedVerdictRow(declared)).toBe(true);
  });

  it("an unregistered reason string is not a re-run trigger (the writer ratchet owns it)", () => {
    expect(isVerdictLessSkippedOwedVerdictRow({ ...owed, notRunReason: "my-brand-new-reason" as never })).toBe(false);
  });

  it("a fast-mode skip and an authored non-approving verdict keep their own dispositions", () => {
    expect(isVerdictLessSkippedOwedVerdictRow({ ...owed, bypassedBy: FAST_MODE_BYPASS_ACTOR })).toBe(false);
    for (const verdict of ["REVISE", "RETHINK", "UNAVAILABLE"] as const) {
      expect(isVerdictLessSkippedOwedVerdictRow({ ...owed, verdict }), verdict).toBe(false);
    }
  });

  it("a gate that never owed a verdict is not owed a verdict", () => {
    const scriptGate: WorkflowStepResult = { workflowStepId: "verification", workflowStepName: "Verify", phase: "pre-merge", status: "skipped" };
    expect(isVerdictLessSkippedOwedVerdictRow(scriptGate)).toBe(false);
  });

  it("an authored REVISE on the latest row is the remediation lane, not this one", () => {
    const task = card({
      workflowStepResults: [approvedPlanReview, {
        ...owed,
        status: "skipped",
        verdict: "REVISE",
        reviewInputFingerprint: "sha256:111122223333",
        completedAt: new Date(NOW - 60 * 60_000).toISOString(),
      }],
      steps: [{ name: "Remediate", status: "pending" as const }],
    });
    expect(findOwedVerdictRequiredPreMergeGates(task, { requiredPreMergeStepIds: REQUIRED })).toEqual([]);
    expect(stall(task)?.code).toBe("awaiting-review-revision");
  });
});

describe("owed-verdict witnesses keep their current behaviour everywhere else", () => {
  it("a skipped row still does NOT match isVerdictLessFailedGateRow (RUFU-217 stays failed-only)", () => {
    expect(isVerdictLessFailedGateRow(rufu343CodeReview)).toBe(false);
  });

  it("the stranded-gate retry patch leaves a skipped row in place (no row is ever dropped here)", () => {
    const task = card();
    const patch = buildStrandedGateRetryPatch(
      task as unknown as Pick<Task, "workflowStepResults">,
      findOwedVerdictRequiredPreMergeGates(task, { requiredPreMergeStepIds: REQUIRED }),
    );
    expect(patch.workflowStepResults).toHaveLength(2);
    expect((patch.workflowStepResults as WorkflowStepResult[]).some((row) => row.workflowStepId === GATE && row.status === "skipped")).toBe(true);
  });

  it("a second required gate that is genuinely failed still answers the failed lane", () => {
    const failedGate: WorkflowStepResult = { workflowStepId: "verification", workflowStepName: "Verify", phase: "pre-merge", status: "failed", reviewKind: "code" };
    const task = card({ workflowStepResults: [approvedPlanReview, rufu343CodeReview, failedGate] });
    expect(findOwedVerdictRequiredPreMergeGates(task, { requiredPreMergeStepIds: new Set(["plan-review", GATE, "verification"]) })).toEqual([GATE]);
    expect(findVerdictLessFailedRequiredGates(task, { requiredPreMergeStepIds: new Set(["verification"]) })).toEqual(["verification"]);
  });

  it("a card whose only required gate is an honest not-run row is untouched by this arm", () => {
    const honest: WorkflowStepResult = { workflowStepId: GATE, workflowStepName: "Code Review", phase: "pre-merge", status: "skipped", reviewKind: "code", notRunReason: "tooling-unavailable" };
    const task = card({ workflowStepResults: [approvedPlanReview, honest] });
    expect(findOwedVerdictRequiredPreMergeGates(task, { requiredPreMergeStepIds: REQUIRED })).toEqual([]);
    expect(stall(task)?.code).toBe("completed-review-status-none");
  });

  it("the retry surface that ignores gate ids never reports this class", () => {
    const task = card() as unknown as StrandedGateRetryTask;
    expect(findOwedVerdictRequiredPreMergeGates(task, {})).toEqual([]);
  });
});

describe("the operator bypass resolves the owed-verdict shape", () => {
  it("names the gate as a bypassable target a singular card can actually act on", () => {
    expect(deriveReviewBypassTarget(card(), REQUIRED, new Set(["in-review"]))).toEqual({
      kind: "verdictless-skipped",
      workflowStepId: GATE,
      workflowStepName: "Code Review",
    });
  });

  it("does not offer the lever on a workspace card, where an audited waiver does not bind content", () => {
    // `auditedOperatorWaiver` in evaluatePreMergeApprovals requires a non-workspace descriptor, so a
    // bypass written here would clear nothing — offering it would be the dead affordance RUFU-179
    // exists to delete. The refusal is the honest answer, not a missing feature.
    expect(deriveReviewBypassTarget(card({}, "workspace"), REQUIRED, new Set(["in-review"]))).toBeUndefined();
  });

  it("a failed gate still outranks the owed-verdict target", () => {
    const failed: WorkflowStepResult = { workflowStepId: "verification", workflowStepName: "Verify", phase: "pre-merge", status: "failed", reviewKind: "code" };
    const task = card({ workflowStepResults: [approvedPlanReview, rufu343CodeReview, failed] });
    expect(deriveReviewBypassTarget(task, new Set(["plan-review", GATE, "verification"]), new Set(["in-review"]))?.kind).toBe("failed");
  });

  it("a gate with no row at all still answers `absent`, and owed-verdict outranks it", () => {
    const absentOnly = card({ workflowStepResults: [approvedPlanReview] });
    expect(deriveReviewBypassTarget(absentOnly, REQUIRED, new Set(["in-review"]))).toEqual({
      kind: "absent", workflowStepId: GATE, workflowStepName: GATE,
    });
    const both = card({
      workflowStepResults: [
        approvedPlanReview,
        { ...rufu343CodeReview },
        { workflowStepId: "verification", workflowStepName: "Verify", phase: "pre-merge", status: "skipped", reviewKind: "code" },
      ],
    });
    expect(deriveReviewBypassTarget(both, new Set(["plan-review", GATE, "verification"]), new Set(["in-review"]))?.workflowStepId).toBe(GATE);
  });

  it("an operator hold and a non-review lane still refuse every target", () => {
    expect(deriveReviewBypassTarget({ ...card(), paused: true, userPaused: true }, REQUIRED, new Set(["in-review"]))).toBeUndefined();
    expect(deriveReviewBypassTarget({ ...card(), column: "done" as Task["column"] }, REQUIRED, new Set(["in-review"]))).toBeUndefined();
  });
});
