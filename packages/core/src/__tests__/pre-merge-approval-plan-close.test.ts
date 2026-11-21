/*
FNXC:PlanClosePreMergeApproval 2026-11-21-13:55 (RUFU-1097):
A card whose Plan Review row records an ACCEPTED terminal close - `passed` + verdict `CLOSE_NO_OP` + a
leading no-op sentinel - could not leave the review lane. FN-8841's authoring route
(`packages/engine/src/executor/plan-review-no-op.ts`) writes exactly that row, and `workflow-step-verdict.ts`
keeps the verdict Plan-Review-only, so it is a legitimate decision and not a malformed carrier. The may-land
doors nevertheless translated it as a gate that can never approve, because `approvedVerdict` knows only
APPROVE / APPROVE_WITH_NOTES. Measured on RUFU-718: `fn task reconcile` answered the bare
`workflow-approval-blocked` while its plan gate stood `passed`, and the complete-lane move guard refused the
same row, so not even an operator bypass of Code Review could finalize the card.

Three questions, three answers, and only the third one changed here:
  - may-EXECUTE   - `isPlanReviewSatisfied`               - true, untouched;
  - may-RESUME-PAST - `isGateReleased` (engine, RUFU-599) - false, untouched, and pinned in
    `packages/engine/src/__tests__/plan-review-terminal-close.test.ts`. Releasing a close is RUFU-599
    reproduction 3: the closed card resumes, executes its steps and completes as ordinary work;
  - may-LAND      - `evaluatePreMergeApprovals`, `getTaskHardMergeBlocker`,
    `evaluateNoCommitsNoOpFinalize`, `classifyPreMergeGateEvidence` - refused the row before this change and
    now accept it, through the ONE shared identity `isTerminalPlanReviewCloseRow`.

Every case below is asserted at a real production entry point, never against a sentence.
*/
import { describe, expect, it } from "vitest";
import {
  evaluateNoCommitsNoOpFinalize,
  evaluatePreMergeApprovals,
  getTaskHardMergeBlocker,
  isPlanReviewSatisfied,
  isTerminalPlanReviewCloseRow,
  type MergeContentDescriptor,
  type NoCommitsNoOpFinalizeEvidence,
  type Task,
  type TaskStep,
  type WorkflowStepResult,
} from "../index.js";
import { classifyPreMergeGateEvidence } from "../workflows/complete-column-gate-evidence.js";

const REQUIRED = ["plan-review", "code-review"];
const CLEAN_TREE = { state: "clean" } as const;
/** The canonical empty review diff the RUFU-384 empty-input arm recognizes. */
const EMPTY_DIFF = "0".repeat(64);

function row(stepId: string, overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    workflowStepId: stepId,
    workflowStepName: stepId,
    phase: "pre-merge",
    status: "passed",
    completedAt: "2026-11-11T15:25:00.000Z",
    ...overrides,
  } as WorkflowStepResult;
}

/** The accepted close FN-8841 authors: plan gate, passed, CLOSE_NO_OP, and the sentinel that legalised it. */
function closeRow(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return row("plan-review", {
    reviewKind: "plan",
    verdict: "CLOSE_NO_OP",
    notes: "NO-OP: the guard this card asks for already ships on main",
    ...overrides,
  });
}

/** RUFU-718's measured second gate: `skipped` carrying an audited FN-7720 operator waiver. */
function bypassedCodeReview(): WorkflowStepResult {
  return row("code-review", {
    status: "skipped",
    reviewKind: "code",
    bypassedBy: "dashboard-operator",
    bypassedAt: "2026-11-11T14:18:18.000Z",
    bypassReason: "no-op close; nothing to review",
  });
}

function approvals(
  results: readonly WorkflowStepResult[],
  mergeContent?: MergeContentDescriptor,
  required: readonly string[] = REQUIRED,
) {
  return evaluatePreMergeApprovals(
    { workflowStepResults: [...results] } as Task,
    { requiredPreMergeStepIds: new Set(required), mergeContent },
  );
}

const stateOf = (
  results: readonly WorkflowStepResult[],
  gateId: string,
  mergeContent?: MergeContentDescriptor,
  required: readonly string[] = REQUIRED,
) => approvals(results, mergeContent, required).find((gate) => gate.workflowStepId === gateId)?.state;

function reviewTask(results: readonly WorkflowStepResult[], overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-1097",
    title: "plan close",
    description: "",
    column: "in-review",
    priority: "normal",
    steps: [] as TaskStep[],
    dependencies: [],
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
    workflowStepResults: [...results],
    ...overrides,
  } as Task;
}

const hardBlocker = (
  results: readonly WorkflowStepResult[],
  overrides: Partial<Task> = {},
  mergeContent?: MergeContentDescriptor,
) =>
  getTaskHardMergeBlocker(reviewTask(results, overrides), {
    reviewColumns: new Set(["in-review"]),
    requiredPreMergeStepIds: new Set(REQUIRED),
    mergeContent,
  });

const finalizeEvidence = (
  overrides: Partial<NoCommitsNoOpFinalizeEvidence> = {},
): NoCommitsNoOpFinalizeEvidence => ({
  aheadCommitCount: 0,
  worktreeContent: CLEAN_TREE,
  landingProof: null,
  requiredVerificationStepIds: new Set(REQUIRED),
  ...overrides,
});

/** The zero-commit finalize door, asked the DESCRIPTORLESS question the finalize lanes ask it. */
const finalizeBlock = (results: readonly WorkflowStepResult[]) =>
  evaluateNoCommitsNoOpFinalize(
    {
      noCommitsExpected: true,
      steps: [{ name: "Implement", status: "done" }] as TaskStep[],
      workflowStepResults: [...results],
    },
    finalizeEvidence(),
  );

/** The RUFU-718 pair: plan gate closed as a no-op, code gate waived by an audited operator bypass. */
const disputedPair = (): WorkflowStepResult[] => [closeRow(), bypassedCodeReview()];

describe("accepted Plan Review close - the four may-land authorities agree (RUFU-1097 reproduction)", () => {
  it("approves the plan gate in every authority that refused it", () => {
    const results = disputedPair();

    expect(stateOf(results, "plan-review")).toBe("approved");
    expect(stateOf(results, "code-review")).toBe("approved");
    expect(hardBlocker(results)).toBeUndefined();
    expect(finalizeBlock(results)).toMatchObject({ blocked: false });
    expect(classifyPreMergeGateEvidence("plan-review", closeRow())).toBe("satisfied");
    expect(classifyPreMergeGateEvidence("code-review", bypassedCodeReview())).toBe("waived");
  });

  it("agrees with the may-execute authority on the disputed row while may-resume-past keeps its own answer", () => {
    const close = closeRow();
    // may-execute: unchanged, and the reason the card never needed a re-plan.
    expect(isPlanReviewSatisfied(close)).toBe(true);
    // may-land: the two doors this task aligned with it.
    expect(isTerminalPlanReviewCloseRow(close)).toBe(true);
    expect(stateOf([close], "plan-review")).toBe("approved");
    expect(classifyPreMergeGateEvidence("plan-review", close)).toBe("satisfied");
    /*
    may-resume-past is deliberately NOT aligned with the three above and lives in `@fusion/engine`, so it
    cannot be imported here. `plan-review-terminal-close.test.ts` owns that assertion (isGateReleased false,
    placement pinned back on Plan Review); `resume-placement.test.ts` carries the same row in that
    consumer's own table. A close that released its gate forward would execute the card it closed.
    */
  });
});

describe("accepted Plan Review close - the sentinel and the row's own history decide, not the status", () => {
  it.each([
    ["PREMISE STALE:", "PREMISE STALE: RUFU-1000 already specifies the read-back"],
    ["NO-OP:", "NO-OP: already shipped"],
    ["NOOP:", "NOOP: already shipped"],
    ["DUPLICATE:", "DUPLICATE: RUFU-2000 covers this"],
    ["REDUNDANT:", "REDUNDANT: covered by RUFU-3000"],
  ])("a %s sentinel is an accepted close and approves the plan gate", (_prefix, notes) => {
    const close = closeRow({ notes });
    expect(stateOf([close], "plan-review")).toBe("approved");
    expect(classifyPreMergeGateEvidence("plan-review", close)).toBe("satisfied");
    expect(hardBlocker([close, bypassedCodeReview()])).toBeUndefined();
  });

  it.each([
    ["empty notes", "NO-OP: already shipped", ""],
    ["absent notes", "NO-OP: already shipped", undefined],
    ["notes with no leading sentinel", "NO-OP: already shipped", "the reviewer thinks this looks like a no-op"],
    ["a mid-sentence sentinel mention", "NO-OP: already shipped", "closing this; NO-OP: mentioned in prose"],
  ] as const)("a close with %s stays not-approved - the sentinel is the authoring proof", (_label, _drop, notes) => {
    const close = closeRow({ notes });
    expect(stateOf([close], "plan-review")).toBe("not-approved");
    expect(classifyPreMergeGateEvidence("plan-review", close)).toBe("not-approved");
    expect(hardBlocker([close, bypassedCodeReview()])).toContain("plan-review");
  });

  it("refuses a superseded close although latestResultForStep takes the array-last row", () => {
    const superseded = closeRow({ supersededAt: "2026-11-12T09:00:00.000Z" });
    // The selected row IS the superseded one - the door filters no supersession of its own.
    expect(stateOf([superseded], "plan-review")).toBe("not-approved");
    expect(classifyPreMergeGateEvidence("plan-review", superseded)).toBe("not-approved");
    expect(hardBlocker([superseded, bypassedCodeReview()])).toContain("plan-review");
  });

  it("refuses a close carrying remediationArchivedAt IN THE DOOR, and names the mechanism that refuses it", () => {
    const archived = closeRow({
      remediationArchivedAt: "2026-11-12T10:00:00.000Z",
      remediationArchivedFromStatus: "failed",
    });
    // The identity helper does NOT read `remediationArchivedAt`; the door's archive suppression does.
    expect(isTerminalPlanReviewCloseRow(archived)).toBe(true);
    expect(stateOf([archived], "plan-review")).toBe("not-approved");
    expect(hardBlocker([archived, bypassedCodeReview()])).toContain("plan-review");
    /*
    The complete-lane classifier never read that field for any shape and classifies the same row
    `satisfied`. That permissive divergence is recorded, not hidden, in the divergence register of
    `complete-column-gate-evidence.ts`: the terminal lane opens, publication still does not, because the
    merge door stays the stricter authority. Asserted here so widening either guard is a visible change.
    */
    expect(classifyPreMergeGateEvidence("plan-review", archived)).toBe("satisfied");
  });

  it("lets the LATER plan row decide, and the array-last row win on identical stamps", () => {
    const later = closeRow({ status: "pending", verdict: undefined, notes: undefined, completedAt: "2026-11-12T12:00:00.000Z" });
    expect(stateOf([closeRow(), later], "plan-review")).toBe("not-approved");
    expect(stateOf([later, closeRow()], "plan-review")).toBe("approved");

    const tieA = closeRow({ notes: "NO-OP: first", completedAt: undefined, startedAt: "2026-11-12T12:00:00.000Z" });
    const tieB = row("plan-review", { reviewKind: "plan", status: "failed", verdict: "REVISE", notes: "rework", completedAt: undefined, startedAt: "2026-11-12T12:00:00.000Z" });
    // Same stamps: `.at(-1)` decides, so the second row is the live one and the close is not consulted.
    expect(stateOf([tieA, tieB], "plan-review")).toBe("not-approved");
  });
});

describe("accepted Plan Review close - the identity is PLAN_REVIEW_GROUP_ID-keyed", () => {
  it("refuses CLOSE_NO_OP authored on a custom plan-kind gate", () => {
    const custom = row("architectural-review", { reviewKind: "plan", verdict: "CLOSE_NO_OP", notes: "NO-OP: already decided" });
    expect(stateOf([custom], "architectural-review", undefined, ["architectural-review"])).toBe("not-approved");
    expect(classifyPreMergeGateEvidence("architectural-review", custom)).toBe("not-approved");
  });

  it("refuses a forged code-review row carrying the plan verdict", () => {
    const forged = row("code-review", { reviewKind: "code", verdict: "CLOSE_NO_OP", notes: "NO-OP: nothing to review" });
    expect(stateOf([forged], "code-review")).toBe("not-approved");
    expect(classifyPreMergeGateEvidence("code-review", forged)).toBe("not-approved");
    expect(hardBlocker([closeRow(), forged])).toContain("code-review");
  });

  it.each([
    ["passed + REVISE", { status: "passed", verdict: "REVISE" } as Partial<WorkflowStepResult>, "not-approved"],
    ["failed + REVISE", { status: "failed", verdict: "REVISE" } as Partial<WorkflowStepResult>, "not-approved"],
    ["passed + RETHINK", { status: "passed", verdict: "RETHINK" } as Partial<WorkflowStepResult>, "not-approved"],
    // An in-flight plan is refused too, and the complete lane names that state distinctly from a rejection.
    ["pending with no verdict", { status: "pending", verdict: undefined, notes: undefined } as Partial<WorkflowStepResult>, "in-flight"],
  ] as const)("a genuinely refused or unfinished plan (%s) still refuses", (_label, overrides, laneState) => {
    const refused = closeRow(overrides);
    expect(stateOf([refused], "plan-review")).toBe("not-approved");
    expect(classifyPreMergeGateEvidence("plan-review", refused)).toBe(laneState);
    expect(hardBlocker([refused, bypassedCodeReview()])).toContain("plan-review");
    expect(finalizeBlock([refused, bypassedCodeReview()])).toMatchObject({
      blocked: true,
      reason: expect.stringContaining("plan-review"),
    });
  });

  it("keeps an ordinary APPROVE answering exactly as before", () => {
    const approved = closeRow({ verdict: "APPROVE_WITH_NOTES", notes: "approved, proceed" });
    expect(stateOf([approved], "plan-review")).toBe("approved");
    expect(classifyPreMergeGateEvidence("plan-review", approved)).toBe("satisfied");
    expect(hardBlocker([approved, bypassedCodeReview()])).toBeUndefined();
  });

  it("answers a legacy row with no reviewKind and no verdict exactly as a passed+APPROVE row does", () => {
    const legacyClose = closeRow({ reviewKind: undefined });
    const legacyApprove = row("plan-review", { reviewKind: undefined, verdict: "APPROVE" });
    const legacyStatusOnly = row("plan-review", { reviewKind: undefined, verdict: undefined, notes: undefined });
    expect(stateOf([legacyClose], "plan-review")).toBe("approved");
    expect(stateOf([legacyApprove], "plan-review")).toBe(stateOf([legacyClose], "plan-review"));
    // A status-only plan row keeps today's permissive reading; this change did not touch that arm.
    expect(stateOf([legacyStatusOnly], "plan-review")).toBe("approved");
  });
});

describe("accepted Plan Review close - content descriptors and the FN-180 guarantee", () => {
  const singularEmpty: MergeContentDescriptor = { kind: "singular", diff: { state: "empty" } };
  const singularNonEmpty = (fingerprint: string): MergeContentDescriptor => ({
    kind: "singular",
    diff: { state: "captured", fingerprint },
  });
  const singularUnavailable: MergeContentDescriptor = {
    kind: "singular",
    diff: { state: "unavailable", reason: "missing-worktree-or-base" },
  };
  const workspaceDescriptor: MergeContentDescriptor = {
    kind: "workspace",
    repositories: { state: "captured", inScopeModified: ["apps/web"], fingerprints: {} },
  };

  it("approves descriptorless, empty-diff and unavailable-diff questions for the close", () => {
    const results = disputedPair();
    expect(stateOf(results, "plan-review")).toBe("approved");
    expect(stateOf(results, "plan-review", singularEmpty)).toBe("approved");
    expect(stateOf(results, "plan-review", singularUnavailable)).toBe("approved");
  });

  it("keeps the FN-180 refusal: a code-review passed+APPROVE with no fingerprint over a non-empty diff still refuses", () => {
    const contentRow = row("code-review", { reviewKind: "code", verdict: "APPROVE" });
    const descriptor = singularNonEmpty(EMPTY_DIFF);
    // The plan close is accepted and changes nothing about the content question.
    expect(stateOf([closeRow(), contentRow], "plan-review", descriptor)).toBe("approved");
    expect(stateOf([closeRow(), contentRow], "code-review", descriptor)).toBe("unprovable-content");
    // The door is asked WITH the same descriptor, because that question is what the refusal depends on.
    // FN-180's content arm emits its own gate-less sentence (`task has no provable approval for the content
    // being merged`); only the not-approved arm names a gate id, and this task leaves that split untouched.
    expect(hardBlocker([closeRow(), contentRow], {}, descriptor)).toBe(
      "task has no provable approval for the content being merged",
    );
  });

  it("leaves the plan arm's fingerprint non-comparison exactly as an APPROVE row experiences it", () => {
    /*
    A `reviewKind: "plan"` row returns from the plan arm before `bindsContent`, because plan fingerprints bind
    PLAN text and must never be cross-compared against a source diff. That is pre-existing and applies to
    APPROVE identically, so the invariant here is parity, not a new pass: the close and the approval answer the
    same thing to the same descriptor.
    */
    const boundClose = closeRow({ reviewInputFingerprint: EMPTY_DIFF });
    const boundApprove = closeRow({ verdict: "APPROVE", notes: "ok", reviewInputFingerprint: EMPTY_DIFF });
    const mismatch = singularNonEmpty("1".repeat(64));
    expect(stateOf([boundClose], "plan-review", mismatch)).toBe(stateOf([boundApprove], "plan-review", mismatch));
    expect(stateOf([boundClose], "plan-review", mismatch)).toBe("approved");
  });

  it("compares content for a legacy-shape close that carries a fingerprint, exactly as it compares an approval", () => {
    /*
    Without `reviewKind` the plan arm does not fire, so `bindsContent` is reached through the fingerprint the
    row itself recorded. The close must therefore be compared, not waved through - and the answer must equal
    the answer the same carrier gives under APPROVE.
    */
    const legacyClose = closeRow({ reviewKind: undefined, reviewInputFingerprint: EMPTY_DIFF });
    const legacyApprove = row("plan-review", { reviewKind: undefined, verdict: "APPROVE", reviewInputFingerprint: EMPTY_DIFF });
    expect(stateOf([legacyClose], "plan-review", singularNonEmpty(EMPTY_DIFF))).toBe("approved");
    expect(stateOf([legacyClose], "plan-review", singularNonEmpty("1".repeat(64)))).toBe("stale-content");
    expect(stateOf([legacyClose], "plan-review", singularNonEmpty("1".repeat(64))))
      .toBe(stateOf([legacyApprove], "plan-review", singularNonEmpty("1".repeat(64))));
  });

  it("does not let a plan close satisfy a workspace content question", () => {
    const results = [closeRow(), row("code-review", { reviewKind: "code", verdict: "APPROVE", repositoryScopeRevision: 7 })];
    expect(stateOf(results, "plan-review", workspaceDescriptor)).toBe("approved");
    // The code gate still answers from repositoryScope, which this fixture withholds: never from the close.
    expect(stateOf(results, "code-review", workspaceDescriptor)).toBe("unprovable-content");
  });

  it("refuses the close in a zero-commit finalize whose delivery the door cannot prove", () => {
    /*
    Approving the GATE is not a delivery proof, and the one delivery authority stays the decider: a tree
    holding deliverable work refuses the same card whose plan gate this change just accepted. The gate answer
    and the delivery answer are separate facts on purpose.
    */
    const dirty = finalizeEvidence({
      aheadCommitCount: 0,
      worktreeContent: { state: "deliverable", modifiedCount: 1, untrackedCount: 0 },
    });
    expect(finalizeBlock(disputedPair())).toMatchObject({ blocked: false });
    expect(
      evaluateNoCommitsNoOpFinalize(
        {
          noCommitsExpected: true,
          steps: [{ name: "Implement", status: "done" }] as TaskStep[],
          workflowStepResults: disputedPair(),
        },
        dirty,
      ),
    ).toMatchObject({ blocked: true, deliveryUnproven: { refusalCode: "uncommitted-work" } });
  });
});
