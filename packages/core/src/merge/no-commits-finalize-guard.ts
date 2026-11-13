import { isRemediationStep } from "../tasks/remediation-steps.js";
import { evaluatePreMergeApprovals } from "./pre-merge-approval.js";
import {
  evaluateZeroCommitLandingProof,
  type LandingProof,
  type UncommittedWorkRefusalCode,
  type WorktreeContentClassification,
  type WorktreeContentState,
} from "./zero-commit-landing-proof.js";
import type { Task } from "../types.js";

/*
FNXC:ZeroCommitDeliveryProof 2026-09-26-01:30 (RUFU-274):
This module is the single contract for "this card may be finalized as having delivered nothing". Before
RUFU-274 it reasoned about steps and gates ONLY — every caller supplied no worktree evidence at all —
so each of the seven production lanes carried an implicit, unchecked "the tree is clean / it already
landed" assumption. RUFU-262 is what that assumption costs: a zero-commit branch plus a dirty worktree
reached `done`, its `branch`/`worktree`/`modifiedFiles` were cleared, and the only copy of the work
survived as uncommitted files in a tree cleanup was free to prune.

The evidence parameter is therefore REQUIRED and has no default: a lane that has not probed cannot
compile. `evaluateZeroCommitLandingProof` remains the pure decision table underneath (reused verbatim
by the cleanup-proof gate, which has no business evaluating workflow steps), and an absent
classification still refuses at runtime so a JavaScript caller cannot inherit the old permissive
behaviour by passing nothing.
*/

/** Fixed blocking reason for every non-clean worktree content state, so the reason is greppable. */
export const WORKTREE_CONTENT_UNPROVEN_REASON = "worktree-content-unproven";

/** Live evidence every zero-diff finalize lane must supply alongside its step/gate reading. */
export interface NoCommitsNoOpFinalizeEvidence {
  /**
   * Commits on the card's branch ahead of the integration branch. `null` = unreadable, which is NOT
   * zero — it means this lane cannot claim the zero-commit case and keeps its existing behaviour.
   */
  aheadCommitCount: number | null;
  /** What the worktree holds. Required; a lane that did not probe cannot ask this question. */
  worktreeContent: WorktreeContentClassification;
  /** Durable landing proof the lane actually verified, or `null` when it holds none. */
  landingProof: LandingProof | null;
  /** Required pre-merge verification gates, for lanes that gate on workflow step results. */
  requiredVerificationStepIds?: ReadonlySet<string>;
}

/** The refusal payload a blocked evaluation carries forward to the marker, hold and audit row. */
export interface NoCommitsDeliveryUnproven {
  contentState: WorktreeContentState;
  modifiedCount: number;
  untrackedCount: number;
  refusalCode: UncommittedWorkRefusalCode;
}

export interface NoCommitsNoOpFinalizeEvaluation {
  blocked: boolean;
  reason?: string;
  doneCount: number;
  incompleteCount: number;
  /**
   * Additive: populated when the worktree-content / landing-proof arm blocked the finalize, so the
   * refusing lane can write the hold, the row sentence and the ids/counts-only audit row from the same
   * evidence the decision was made from instead of re-probing (and possibly disagreeing with itself).
   */
  deliveryUnproven?: NoCommitsDeliveryUnproven;
}

/**
 * FNXC:Lifecycle 2026-06-14-19:54:
 * FN-6461/FN-6455 showed that release and ops tasks marked `noCommitsExpected` can be silently finalized as no-op after skipping substantive steps.
 * Zero-diff finalize lanes must only trust step evidence when completed work outweighs incomplete work; ties block because a todo requeue is recoverable while dropping operational work is not.
 *
 * FNXC:Lifecycle 2026-07-16-14:20:
 * FN-8141 laundered a REVERTED (commit-expected) task to `done`: pi SDK bumps kept breaking verify, the work was reverted 5x, and the agent marked "Testing & Verification" + "Documentation & Delivery" skipped. The branch was empty vs main, so the AI empty-merge lane finalized it as a no-op with `mergeConfirmed:true` and no reviewer ever saw it.
 * The FN-6461 rule missed it twice: it only fired for `noCommitsExpected === true` (FN-8141 was commit-expected), and even then only when incomplete >= done (FN-8141 had 3 done vs 2 skipped).
 * New invariant: a zero-diff/no-op finalize is blocked whenever ANY step is `skipped` (empty diff + skipped step means work was never done or was reverted, so `done` is unsafe). A verification-flavored skipped step (name matching /test|verif|qa|review/i) blocks unconditionally; any other skipped step blocks unless every non-skipped step is `done` AND the task is the legacy `noCommitsExpected` ops shape. This is evaluated only at zero-diff finalize lanes, so the empty-diff condition is supplied by the caller.
 *
 * FNXC:NoCommitReviewSignoff 2026-11-13-18:56 (RUFU-649): the clause "a verification-flavored skipped step
 * (name matching /test|verif|qa|review/i) blocks unconditionally" is SUPERSEDED for a name-only classification
 * once the card carries both proofs named in the RUFU-649 block below (`proven-legitimate-noop` plus an approved
 * `empty-review-input:v1` Code Review). It stands unchanged for remediation provenance and for every card that
 * cannot show its delivery. The clause was the defect RUFU-292 measured: a lexical match on a step TITLE became
 * a gate verdict, and no amount of reviewer sign-off could answer it.
 */
const VERIFICATION_STEP_NAME = /test|verif|qa|review/i;

export function evaluateNoCommitsNoOpFinalize(
  task: Pick<Task, "noCommitsExpected" | "steps" | "workflowStepResults" | "repositoryScope">,
  evidence: NoCommitsNoOpFinalizeEvidence,
): NoCommitsNoOpFinalizeEvaluation {
  const steps = task.steps ?? [];
  const doneCount = steps.filter((step) => step.status === "done").length;
  const incompleteCount = steps.length - doneCount;
  const noCommitsExpected = task.noCommitsExpected === true;

  /*
  FNXC:ZeroCommitDeliveryProof 2026-09-29-20:19 (RUFU-274 Step 11, Code Review finding 2 — high):
  The delivery verdict is evaluated up FRONT and its `deliveryUnproven` payload is attached to EVERY blocked
  return, because the old ordering let the winning block reason decide whether the work at risk was reported
  at all. Measured failure: a card with an unmet required gate AND modified/untracked files — the RUFU-337 +
  RUFU-262 shape — returned `blocked` naming only the gate, with no `deliveryUnproven`, so every lane that
  routes on that marker (AI merge, merge runner, self-healing, auto-merge finalization) fell through to its
  incomplete-work branch: `error` + `status: "failed"` + a backward rebound out of the review lane, with no
  durable hold, no run-audit row and no row-visible sentence naming the preserved worktree — while the
  uncommitted files stayed sitting in a tree the lane was about to clean up.
  Which reason WINS as the message is unchanged: `reason` still names the gate or step, because "run the
  gate" is more actionable than "content unproven". What changed is that the content risk is reported
  alongside it, so a lane can now only lose the hold by ignoring the marker.
  */
  const verdict = evaluateZeroCommitLandingProof({
    aheadCommitCount: evidence?.aheadCommitCount ?? null,
    worktreeContent: evidence?.worktreeContent,
    landingProof: evidence?.landingProof ?? null,
    noCommitsExpected,
    presentsNoOp: true,
  });
  const deliveryUnproven: NoCommitsDeliveryUnproven | undefined =
    verdict.kind === "refuse" || verdict.kind === "retry"
      ? {
          contentState: verdict.contentState,
          modifiedCount: verdict.kind === "refuse" ? verdict.modifiedCount : 0,
          untrackedCount: verdict.kind === "refuse" ? verdict.untrackedCount : 0,
          refusalCode: verdict.kind === "refuse" ? verdict.code : "content-unverifiable",
        }
      : undefined;

  /** One refusal from this guard: its `reason`, the step counts, and the content risk whenever it exists. */
  const block = (reason: string): NoCommitsNoOpFinalizeEvaluation => ({
    blocked: true,
    reason,
    doneCount,
    incompleteCount,
    ...(deliveryUnproven ? { deliveryUnproven } : {}),
  });

  /*
  FNXC:ZeroCommitDeliveryProof 2026-09-29-20:19 (RUFU-274 Step 11, Code Review finding 1 — critical):
  The required-gate arm used to scan for a raw `status: "passed"` row. The canonical merge door
  (`evaluatePreMergeApprovals`) accepts more than that, and the delta was a real operator decision being
  erased: `skipped` + `bypassedBy` is the audited FN-7720 waiver, and a `skipped` row carrying the
  `isWorkflowStepNotRun` carrier is a gate that could not run. Measured consequence: a card whose gate the
  operator explicitly bypassed — the documented remedy for a stranded review lane — failed this arm, so the
  finalize lanes classified it as unfinished work: `error` + `status: "failed"` + a backward rebound out of
  the review lane, undoing the waiver the operator had just recorded.

  The arm was unreachable until commit e5650000e4 made `resolveNoOpFinalizeGateIds` ask the same canonical
  resolver the merge door asks, which is what finally put default-on `builtin:coding` gates in front of it.
  It now asks that authority instead of reimplementing approval semantics, so it can never refuse a gate the
  door itself would accept, and the archived-remediation permissiveness the old raw scan accidentally
  provided defers to FN-295's canonical `not-approved` answer.

  The RUFU-337 refusal survives by that same authority: a required gate with NO row resolves to state
  `missing`, so a card that never ran its required gate still cannot finalize.

  FNXC:ZeroCommitDeliveryProof 2026-09-29-20:39 (RUFU-274 Step 11, alignment consequences made explicit):
  The question asked here is deliberately the DESCRIPTORLESS one: "does the latest row for each required gate
  carry an approving carrier?" A `MergeContentDescriptor` is a merge-time artifact the finalize lanes do not
  have, so a workspace gate is not re-checked per repository here and a fingerprint is not diff-compared; the
  merge door asks that stricter question with a real descriptor, which is why this guard can be no looser
  than the door without becoming the only authority that lets a card through. Two consequences of agreeing
  with the door are intentional, not collateral:
  - a `code-review` row `passed` with no authored `verdict` resolves to `not-approved` (FN-180/FN-288
    positive-approval contract; FN-279's self-healing rewrites exactly that row shape to `failed`), so it no
    longer finalizes here either — the owning test fixture now states the verdict the row always owed;
  - a `remediationArchivedAt` carrier is `not-approved` (FN-295) even though the old raw scan waved it
    through, which restores the audited recovery lane's remedy instead of silently stamping the card done.
  */
  const unmetGate = evaluatePreMergeApprovals(task, {
    requiredPreMergeStepIds: evidence?.requiredVerificationStepIds,
  }).find((approval) => approval.state !== "approved");
  if (unmetGate) {
    return block(`required verification gate '${unmetGate.workflowStepId}' has no approving result (canonical pre-merge state: ${unmetGate.state})`);
  }

  const skippedSteps = steps.filter((step) => step.status === "skipped");
  const hasCompletedVerification = steps.some((step) =>
    step.status === "done" && VERIFICATION_STEP_NAME.test(step.name ?? ""),
  );
  /*
  FNXC:NoCommitReviewSignoff 2026-09-30-04:56:
  An approved Code Review over the canonical empty review input is the reviewer sign-off named by
  this guard's refusal text. FN-9422 completed an operational reconciliation, intentionally skipped
  its conditional source-repair step, and received that exact approval, but the guard ignored all
  review evidence and self-healing could only repeat the same immutable blocker until deadlock
  disposal. Accept the narrow empty-input approval for non-verification skips; skipped verification
  or remediation work remains unconditionally blocking, and ordinary approvals over non-empty code
  cannot launder reverted implementation work.

  FNXC:NoCommitReviewSignoff 2026-11-13-18:56 (RUFU-649): "skipped verification ... work remains
  unconditionally blocking" is narrowed by the block below for the NAME-only case, which is exactly what
  stranded the card that requirement was written for. "or remediation work" is untouched and still absolute.
  */
  const hasApprovedEmptyCodeReview = task.workflowStepResults?.some((result) =>
    result.workflowStepId === "code-review"
    && result.reviewKind === "code"
    && result.status === "passed"
    && result.verdict === "APPROVE"
    && result.reviewInputFingerprint === "empty-review-input:v1",
  ) === true;

  /*
  FNXC:NoCommitReviewSignoff 2026-11-13-18:56 (RUFU-649):
  RUFU-292's operator requirement: a card whose work is provably already on the integration branch, whose
  reviewer approved the canonical empty input, and whose only loose end is an implementation step whose TITLE
  happens to contain a gate word, must be able to finalize itself. It sat `in-review` + `status=failed` on
  `skipped verification step(s) with no net branch changes: Destructive reclaim sweeps - make the activation
  deliberate and tested` and pinned 70 file-scope waiters, because the arm below asked a step's prose whether
  it was a verification gate and got an answer from the substring "tested".

  "Is this step a declared gate?" is never a question this regex answers. The `unmetGate` arm above already
  asks the only canonical authority for that (`evaluatePreMergeApprovals`, fed by
  `evidence.requiredVerificationStepIds`), and review-mandated work is already identified structurally by
  `isRemediationStep`. Those two arms keep their full force; the regex is demoted to the DEFAULT for a card
  that cannot produce its own evidence, never the primary key.

  The two proofs required to relax the name-only classification are exactly:
  1. `verdict.kind === "proven-legitimate-noop"` from `evaluateZeroCommitLandingProof` - the one delivery
     authority, consumed as a verdict, never re-derived here;
  2. `hasApprovedEmptyCodeReview` - a `code-review` row `passed` / `APPROVE` over `empty-review-input:v1`.
  With both, the skip falls through to the existing signature rule below rather than to a new bypass class,
  so no lane gains a way to finalize that the reviewer did not already sign.

  Supersession made explicit: the FN-9422 block above states "skipped verification or remediation work
  remains unconditionally blocking". That holds unchanged for REMEDIATION provenance (arm 1 below) and for
  any card missing either proof; it is superseded only for the name-only classification, because measured
  against RUFU-292 that sentence refused a card with the reviewer sign-off that same sentence names as the
  remedy.

  FNXC:NoCommitReviewSignoff 2026-11-13-18:56 (RUFU-649, Note B - measured correction to the operator tick):
  The relaxation keys on `verdict.kind`, which covers BOTH bases the delivery authority emits: `nothing-to-merge`
  (a durable landing proof) and `nothing-to-deliver` (a clean/nothing-deliverable tree at
  `aheadCommitCount === 0`, per RUFU-274 Step 4). Requiring the `nothing-to-merge` basis specifically would
  demand a durable landing proof the live card does not carry: neither a landing-proof key nor a
  `noCommitsExpected` key appears anywhere in RUFU-292's `task.json`, so its delivery arm is authorized today
  by the positive content probe, not by a sha. The unproven, dirty, unverifiable, and commits-ahead shapes
  stay refused by that same single authority, so this is not a looser door - it is the same door asked once.
  */
  const reviewedEmptyNoOp = verdict.kind === "proven-legitimate-noop" && hasApprovedEmptyCodeReview;

  // FN-8141: skipped step + empty diff. Applies to ALL tasks regardless of `noCommitsExpected`.
  if (skippedSteps.length > 0) {
    /*
    (1) Structural provenance first and unconditionally: a skipped step carrying `remediation` is named work a
    reviewer handed back, and skipping it is the FN-8141 laundering shape no amount of delivery evidence cures.
    When a card carries BOTH a skipped remediation step and a name-flagged skip, the refusal now names the
    remediation subset instead of the union. That is intentional and strictly more actionable: the remediation
    row is the one a reviewer can re-issue, and the name-flagged names it drops were either excused by the two
    proofs above or are about to be reported by the signature rule below.
    */
    const remediationSkipped = skippedSteps.filter((step) => isRemediationStep(step));
    if (remediationSkipped.length > 0) {
      const names = remediationSkipped.map((step) => step.name).join(", ");
      return block(`skipped verification step(s) with no net branch changes: ${names}`);
    }

    /*
    (2) A step flagged ONLY by the wording of its title. It keeps blocking whenever either proof is missing -
    no reviewer sign-off, an unproven or dirty tree, an unreadable ahead-count, or commits still ahead - so the
    FN-8141 anti-laundering invariant is byte-for-byte intact for every card that cannot show its delivery.
    */
    const verificationSkipped = skippedSteps.filter((step) => VERIFICATION_STEP_NAME.test(step.name ?? ""));
    if (verificationSkipped.length > 0 && !reviewedEmptyNoOp) {
      const names = verificationSkipped.map((step) => step.name).join(", ");
      return block(`skipped verification step(s) with no net branch changes: ${names}`);
    }

    // Other skipped steps only pass for the legacy ops shape: every non-skipped step
    // completed (`done`) AND the task explicitly expected no commits. Anything else
    // (e.g. a reverted commit-expected task like FN-8141) blocks.
    const everyNonSkippedDone = steps
      .filter((step) => step.status !== "skipped")
      .every((step) => step.status === "done");
    if (!(everyNonSkippedDone && (noCommitsExpected || hasApprovedEmptyCodeReview))) {
      const names = skippedSteps.map((step) => step.name).join(", ");
      return block(`skipped step(s) with no net branch changes and no operator/reviewer sign-off: ${names}`);
    }
  }

  // Legacy FN-6461 rule: no-commits ops tasks whose incomplete work (incl. pending/in-progress)
  // ties or outweighs completed work must not finalize on step evidence alone. A verified
  // no-op is the exception: skipped implementation steps are intentional when every other
  // step is done and a verification/review step positively confirmed there was no work to land.
  const verifiedIntentionalNoOp =
    skippedSteps.length > 0 &&
    skippedSteps.length === incompleteCount &&
    hasCompletedVerification;
  if (
    noCommitsExpected &&
    steps.length > 0 &&
    incompleteCount > 0 &&
    // Equal counts still block unless positive verification proves the skips were intentional.
    incompleteCount >= doneCount &&
    !verifiedIntentionalNoOp
  ) {
    return block(`no-commits task skipped/incomplete work outweighs completed work (done=${doneCount}, incomplete=${incompleteCount}) with no net branch changes`);
  }

  /*
  FNXC:ZeroCommitDeliveryProof 2026-09-26-01:30 (RUFU-274): delivery proof keeps the LAST `reason` on
  purpose. A pre-existing step/gate block already names a concrete remediation (a skipped verification step,
  a gate with no approving result) and the operator message for it is more actionable than
  "content unproven"; OD req 4 also requires the legitimate proven-already-on-main lane to keep
  finalizing, which is `evaluateZeroCommitLandingProof`'s `proven-legitimate-noop` arm. A missing
  evidence object (a JS caller that skipped the required parameter) is treated as the worst content
  state, never as clean.

  FNXC:ZeroCommitDeliveryProof 2026-09-29-20:19 (RUFU-274 Step 11, Code Review finding 2): only the
  `reason` is still ordered last — the verdict itself is evaluated up front and its payload rides on every
  earlier refusal, so a card that is blocked for TWO reasons no longer reports only the more actionable one.
  */
  if (verdict.kind === "refuse" || verdict.kind === "retry") {
    return block(WORKTREE_CONTENT_UNPROVEN_REASON);
  }

  return {
    blocked: false,
    doneCount,
    incompleteCount,
  };
}
