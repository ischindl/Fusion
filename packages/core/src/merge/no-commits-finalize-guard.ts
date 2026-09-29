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

  // FN-8141: skipped step + empty diff. Applies to ALL tasks regardless of `noCommitsExpected`.
  if (skippedSteps.length > 0) {
    const verificationSkipped = skippedSteps.filter((step) =>
      VERIFICATION_STEP_NAME.test(step.name ?? "") || isRemediationStep(step),
    );

    // A skipped verification/QA/review step over an empty diff blocks unconditionally:
    // there is no reviewer or test evidence, so `done` cannot be trusted.
    if (verificationSkipped.length > 0) {
      const names = verificationSkipped.map((step) => step.name).join(", ");
      return block(`skipped verification step(s) with no net branch changes: ${names}`);
    }

    // Other skipped steps only pass for the legacy ops shape: every non-skipped step
    // completed (`done`) AND the task explicitly expected no commits. Anything else
    // (e.g. a reverted commit-expected task like FN-8141) blocks.
    const everyNonSkippedDone = steps
      .filter((step) => step.status !== "skipped")
      .every((step) => step.status === "done");
    if (!(everyNonSkippedDone && noCommitsExpected)) {
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
