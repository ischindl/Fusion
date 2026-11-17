import type { TFunction } from "i18next";
import type { ReviewBypassDeclineReason, ReviewBypassTargetKind } from "@fusion/core";
import type { TaskContextMenuColumnFlags } from "../components/TaskContextMenu";

export type RetryStage = "plan" | "implementation" | "review" | "generic";

/*
FNXC:ApprovalDestroyingRetry 2026-11-14-01:35 (RUFU-599 reproduction 4, RUFU-472 / RUFU-474):
THE COPY FOR A RETRY THAT IS NOT OFFERED. A refusal whose remedy is a different action has to say so in the
place the click would have happened, and the words must be the server's: `Task.retryRefusal.sentence` is
produced by the same classifier that refuses `fn task retry`, the extension tool, the chat tool and the stage
restart, so the board can never tell a friendlier story than the API does. The local string exists only for a
payload that predates the field (an older daemon behind a newer dashboard), where naming the waiver generically
is still truer than offering Retry.
*/
export function resolveRetryRefusalHint(
  t: TFunction<"app">,
  refusal: { sentence?: string } | undefined,
): string {
  return refusal?.sentence ?? t(
    "taskDetail.retry.refusalFallback",
    "Retry is refused here: this card already has an approving gate and the blocker that remains is waiting on an operator waiver, which Retry would not clear.",
  );
}

export interface RetryStageCopy {
  stage: RetryStage;
  confirmTitle: string;
  confirmMessage: string;
  confirmLabel: string;
  successMessage: string;
  /*
  FNXC:ColumnRestart 2026-09-17-09:16:
  FN-499: only the WIP stage owns in-flight execution artifacts, so only it may offer the
  preserve-work checkbox. Planning and review confirmations stay exactly as they are.
  */
  preserveWorkAvailable: boolean;
  preserveWorkLabel: string;
  preserveWorkDescription: string;
  preservedSuccessMessage: string;
}

/**
 * FNXC:TaskRecoveryVocabulary 2026-08-28-00:38:
 * Retry repeats the current stage without moving the card. This mirrors the durable restart
 * planner's review-over-WIP-over-planning trait order so each host explains the same destructive
 * boundary before an operator confirms it. Missing column metadata deliberately uses generic copy
 * during first paint instead of guessing a stage from an unresolved column id.
 */
export function resolveRetryStageCopy(
  t: TFunction<"app">,
  flags: TaskContextMenuColumnFlags | undefined,
  _column: string,
): RetryStageCopy {
  const common = {
    confirmTitle: t("taskDetail.retry.confirmTitle", "Retry this stage?"),
    confirmLabel: t("taskDetail.retry.confirmLabel", "Retry"),
    preserveWorkAvailable: false,
    preserveWorkLabel: t("taskDetail.retry.preserveWorkLabel", "Keep the work already produced"),
    preserveWorkDescription: t("taskDetail.retry.preserveWorkDescription", "Keep the worktree, branch, and finished steps, and replay only the step that was running."),
    preservedSuccessMessage: t("taskDetail.retry.implementationPreservedSuccess", "The current step will run again and the work already produced is kept."),
  };
  if (flags?.mergeBlocker || flags?.humanReview) {
    return {
      stage: "review",
      ...common,
      confirmMessage: t("taskDetail.retry.reviewConfirmMessage", "Discard the review verdicts and review the produced work again. This card stays in its current column."),
      successMessage: t("taskDetail.retry.reviewSuccess", "Review will run again in this column."),
    };
  }
  if (flags?.countsTowardWip) {
    return {
      stage: "implementation",
      ...common,
      preserveWorkAvailable: true,
      confirmMessage: t("taskDetail.retry.implementationConfirmMessage", "Discard the in-flight work and start it again on the approved plan. This card stays in its current column."),
      successMessage: t("taskDetail.retry.implementationSuccess", "Work will restart in this column."),
    };
  }
  if (flags?.intake || flags?.hold) {
    return {
      stage: "plan",
      ...common,
      confirmMessage: t("taskDetail.retry.planConfirmMessage", "Rebuild the plan from the original request. This card stays in its current column."),
      successMessage: t("taskDetail.retry.planSuccess", "Planning will restart in this column."),
    };
  }
  return {
    stage: "generic",
    ...common,
    confirmMessage: t("taskDetail.retry.genericConfirmMessage", "Repeat the current stage and keep this card in its current column."),
    successMessage: t("taskDetail.retry.genericSuccess", "This stage will restart in its current column."),
  };
}

/*
FNXC:PostMergeGateOperatorWaiver 2026-11-14-02:10 (RUFU-599 Step 7, reproductions 1 and 2 / RUFU-474):
ONE VOCABULARY FOR AN AUDITED OPERATOR WAIVER. The waiver offer, the store write that accepts it, and the merge
door's remedy sentence all answer from one derivation (Steps 2-3), but the SURFACES still spelled their own
copy out of `kind === "absent"`, which left every class the derivation newly answers - a `verdictless-skipped`
carrier, and anything on the post-merge side - labelled "Bypass failed review", i.e. a failed PRE-merge row
that does not exist on the card. `phase` is tested before `kind` on purpose: the phase is what makes the
sentence true, and a post-merge gate described as a pre-merge step is the same offer/accept drift RUFU-474
reported one level further down. The two classes that already had words keep them byte-for-byte, because an
audit prompt is read back by whoever reviews the card later.
*/
export interface BypassReviewCopy {
  label: string;
  promptMessage: string;
  success: (taskId: string) => string;
}

export function resolveBypassReviewCopy(
  t: TFunction<"app">,
  target: { kind: ReviewBypassTargetKind; phase?: "pre-merge" | "post-merge" },
): BypassReviewCopy {  if (target.phase === "post-merge") {
    return target.kind === "verdictless-skipped"
      ? {
        label: t("taskDetail.bypassReview.btnPostMergeVerdictless", "Waive post-merge gate that never reported"),
        promptMessage: t(
          "taskDetail.bypassReview.promptMessagePostMergeVerdictless",
          "Reason for waiving the post-merge gate that ended without a verdict (required, audit-logged):",
        ),
        success: (taskId) => t("taskDetail.bypassReview.successPostMergeVerdictless", "Waived post-merge gate for {{id}}", { id: taskId }),
      }
      : {
        label: t("taskDetail.bypassReview.btnPostMergeUnrun", "Waive post-merge gate that never ran"),
        promptMessage: t(
          "taskDetail.bypassReview.promptMessagePostMergeUnrun",
          "Reason for waiving the post-merge gate that never ran (required, audit-logged):",
        ),
        success: (taskId) => t("taskDetail.bypassReview.successPostMergeUnrun", "Waived post-merge gate for {{id}}", { id: taskId }),
      };
  }
  if (target.kind === "absent") {
    return {
      label: t("taskDetail.bypassReview.btnUnrun", "Bypass unrun review gate"),
      promptMessage: t("taskDetail.bypassReview.promptMessageUnrun", "Reason for bypassing the review gate that never ran (required, audit-logged):"),
      success: (taskId) => t("taskDetail.bypassReview.successUnrun", "Bypassed unrun review gate for {{id}}", { id: taskId }),
    };
  }
  if (target.kind === "verdictless-skipped") {
    return {
      label: t("taskDetail.bypassReview.btnVerdictless", "Waive review gate that ended without a verdict"),
      promptMessage: t(
        "taskDetail.bypassReview.promptMessageVerdictless",
        "Reason for waiving the review gate that ended without a verdict (required, audit-logged):",
      ),
      success: (taskId) => t("taskDetail.bypassReview.successVerdictless", "Waived review gate for {{id}}", { id: taskId }),
    };
  }
  return {
    label: t("taskDetail.bypassReview.btn", "Bypass failed review"),
    promptMessage: t("taskDetail.bypassReview.promptMessage", "Reason for bypassing the failed pre-merge review step (required, audit-logged):"),
    success: (taskId) => t("taskDetail.bypassReview.success", "Bypassed failed review lane for {{id}}", { id: taskId }),
  };
}

/*
FNXC:ReviewBypassDecline 2026-11-17-18:05 (RUFU-583, folded from RUFU-243):
THE SENTENCE FOR A WAIVER THAT IS NOT OFFERED. Six classes refuse this affordance, and until now every one
of them reached the operator as the absence of a row - measured on RUFU-583, a card held by hand in the
review lane showed no item on either Actions surface and no line on the detail modal, while the API answered
`task is paused`. Each class gets its OWN sentence with its own remedy: two classes sharing one string would
put words in the operator's mouth about a distinction the server never drew, which is how a refusal becomes a
second, more confident bug. The class arrives as `Task.reviewBypassDecline.reason`, derived server-side in
`@fusion/core` - the browser may import types only from that package, so nothing here re-decides anything, it
only words what was decided. A reason this build does not know (a newer daemon behind an older dashboard) gets
the generic sentence rather than silence, because silence is the defect being removed.
*/
export interface ReviewBypassDeclineHint {
  /** Operator-facing explanation of the refusal; rendered where the offer would have stood. */
  sentence: string;
}

export function resolveReviewBypassDeclineHint(
  t: TFunction<"app">,
  decline: { reason: ReviewBypassDeclineReason; workflowStepId?: string } | undefined,
): ReviewBypassDeclineHint | undefined {
  if (!decline) return undefined;
  switch (decline.reason) {
    case "operator-task-hold":
      return {
        sentence: t(
          "taskDetail.bypassReview.decline.operatorTaskHold",
          "No waiver is offered while you hold this card by hand. Unpause it to let the engine work the gate, or move the card - a waiver answers a gate that is refusing an unheld card.",
        ),
      };
    case "not-in-review-lane":
      return {
        sentence: t(
          "taskDetail.bypassReview.decline.notInReviewLane",
          "No waiver is offered in this column: the card is not standing in a review lane, so no review gate is holding it here. Retry repeats this card's current stage instead.",
        ),
      };
    case "no-refusing-gate":
      return {
        sentence: t(
          "taskDetail.bypassReview.decline.noRefusingGate",
          "No waiver is offered: every review gate this card owes has already produced its evidence, so nothing here is refusing it. Retry would discard verdicts that were reached.",
        ),
      };
    case "post-merge-review-not-owed":
      return {
        sentence: t(
          "taskDetail.bypassReview.decline.postMergeReviewNotOwed",
          "No waiver is offered yet: this card's post-merge gate has no evidence owed against it until its landing is confirmed, so there is nothing to waive. Waiting on the merge, not on you.",
        ),
      };
    case "workspace-scope-withheld":
      return {
        sentence: t(
          "taskDetail.bypassReview.decline.workspaceScopeWithheld",
          "No waiver is offered for this card: it delivers across several repositories, and one audited waiver cannot stand in for each repository's own review evidence. Clear the gate in the repository that owes it.",
        ),
      };
    case "workflow-ir-unreadable":
      return {
        sentence: t(
          "taskDetail.bypassReview.decline.workflowIrUnreadable",
          "No waiver can be decided for this card: its workflow definition could not be read, so the board cannot tell which gate a waiver would speak for. Repair or reselect the workflow before looking for this action.",
        ),
      };
    default:
      return {
        sentence: t(
          "taskDetail.bypassReview.decline.unknown",
          "No waiver is offered for this card. The reason the board recorded is one this view does not describe - see this card's history for the refusal.",
        ),
      };
  }
}
