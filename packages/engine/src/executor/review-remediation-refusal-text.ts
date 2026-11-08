/**
 * FNXC:ReviewRemediationDeclineNarration 2026-09-27-06:25 (RUFU-351):
 * One canonical home for every sentence that tells an operator a review-remediation recovery was
 * DECLINED. Before this leaf, the sentences lived inline in `recover-failed-pre-merge-step.ts`, so
 * the self-healing revival sweep — which declines the same conditions in its candidate filter,
 * BEFORE the helper can be reached — had no sentence to borrow and declined in silence. RUFU-274
 * sat ownerless in review on exactly that mute path.
 *
 * Rule this leaf exists to enforce: an admission-side decline reuses these sentences VERBATIM.
 * A fourth near-duplicate for one condition is the failure mode — the operator must be able to
 * group every "why is this card not moving" line by its `action` string regardless of which owner
 * (recovery helper, revival sweep filter, or revival sweep outcome arm) wrote it.
 */

/**
 * Declines that MUST reach the card. The first four are the recovery helper's own sentences; the
 * last three are revival-sweep outcome-arm classes for an admitted card whose recovery produced
 * nothing — a producer refusal, a silent skip, or a throw.
 */
export type ReviewRemediationNarratedDecline =
  | "operator-task-hold"
  | "checkout-unavailable"
  | "revision-budget-zero-or-invalid"
  | "revision-budget-exhausted"
  | "producer-refused"
  | "skipped-without-narration"
  | "recovery-threw";

/**
 * FNXC:ReviewRemediationDeclineNarration 2026-09-27-06:25 (RUFU-351):
 * Declines that stay ENGINE-LOG-ONLY on purpose. Each is either already operator-visible (a pause,
 * a terminal status, a non-review lane) or owned by another narrator (the verdictless re-seed
 * pre-pass, the convergence ladder, the empty-review close, the merge-PR blocker surface). Writing a
 * card line here would put two explanations on one card for one condition, which is the duplication
 * half of the invariant this task restores.
 */
export type ReviewRemediationSilentDecline =
  | "lane-mismatch"
  | "auto-merge-ineligible"
  | "paused"
  | "terminal-status"
  | "executing"
  | "no-verdict-owned"
  | "convergence-ladder-owned"
  | "no-failed-step"
  | "blocker-family-mismatch";

export type ReviewRemediationDecline = ReviewRemediationNarratedDecline | ReviewRemediationSilentDecline;

/**
 * The classes the revival sweep's admission filter can itself take. `revision-budget-exhausted` is
 * deliberately absent: the filter's exhaustion predicate is gated on `reviewConvergenceStage >= 3`, so
 * the card it rejects is already human-escalated and the convergence ladder owns that explanation.
 * Exhaustion for a still-climbable card is admitted and narrated by the recovery helper instead, and
 * the sweep's witness gate keeps the two from writing the same sentence twice.
 */
export type ReviewRemediationAdmissionDecline =
  | ReviewRemediationSilentDecline
  | "checkout-unavailable"
  | "revision-budget-zero-or-invalid";

/** The narrated classes carried as the `code` value on `task:review-remediation-declined`. */
export const REVIEW_REMEDIATION_DECLINE_CODES = [
  "operator-task-hold",
  "checkout-unavailable",
  "revision-budget-zero-or-invalid",
  "revision-budget-exhausted",
  "producer-refused",
  "skipped-without-narration",
  "recovery-threw",
] as const satisfies readonly ReviewRemediationNarratedDecline[];

export type ReviewRemediationDeclineText = { action: string; outcome: string };

export type ReviewRemediationDeclineFacts = {
  /**
   * Human-readable failed-gate name (`workflowStepName || workflowStepId || "Unknown"`). Optional only
   * for the hold class, whose card text never names a step; every step-naming class resolves it upstream.
   */
  stepName?: string;
  /** Per-step revision attempts already charged. Required by both budget classes. */
  attempts?: number;
  /** Resolved revision ceiling. `String(max)` is what the operator sees, so `Infinity` renders literally. */
  max?: number;
  /** Decline sentence for the hold/skip/throw classes. Never reviewer prose or an exception message. */
  reason?: string;
  /** Review gate the refusal is keyed to (defaults to `stepName`). */
  gate?: string;
};

/** The recovery helper's action strings; the sweep reuses them so both owners group together. */
const ACTION = {
  "operator-task-hold": "Failed pre-merge step recovery not scheduled — operator task hold",
  "checkout-unavailable": "Failed pre-merge step recovery not scheduled — checkout unavailable",
  "revision-budget-zero-or-invalid": "Failed pre-merge step recovery not scheduled — revision budget zero/invalid",
  "revision-budget-exhausted": "Failed pre-merge step recovery not scheduled — revision budget exhausted",
  "not-produced": "Failed pre-merge step remediation not produced — card left in review",
} as const;

/**
 * FNXC:ReviewRemediationDeclineNarration 2026-09-27-06:25 (RUFU-351):
 * The shared tail for every "the card stays in review" sentence. It names the two operator remedies
 * (re-run the review once the findings are addressed, or the privileged bypass when the gate is
 * known non-blocking) so no surface has to restate them.
 */
function cardRemainsInReviewTail(): string {
  return "This review is not retried until its findings change. Re-run the review after addressing it manually, "
    + "or use the privileged review bypass when the failed review is known to be non-blocking.";
}

/**
 * Render the canonical card-level text for one declined review-remediation recovery.
 *
 * Exhaustive by construction: adding a narrated class to the union without a case here is a compile
 * error, which is what keeps a new decline from shipping mute again.
 */
export function reviewRemediationDeclineText(
  decline: ReviewRemediationNarratedDecline,
  facts: ReviewRemediationDeclineFacts,
): ReviewRemediationDeclineText {
  const stepName = facts.stepName ?? "Unknown";
  const { attempts, max } = facts;
  switch (decline) {
    case "operator-task-hold":
      return {
        action: ACTION["operator-task-hold"],
        outcome: `Reason: ${facts.reason ?? "an operator action holds this card"}`,
      };
    case "checkout-unavailable":
      return {
        action: ACTION["checkout-unavailable"],
        outcome: `Step: ${stepName}\nNo singular worktree or acquired workspace repository worktree is available. `
          + "Retry after restoring the task checkout, or use the privileged review bypass when the failed review is known to be non-blocking.",
      };
    case "revision-budget-zero-or-invalid":
      return {
        action: ACTION["revision-budget-zero-or-invalid"],
        outcome: `Step: ${stepName}\nAttempts: ${attempts}\nMax: ${String(max)}`,
      };
    case "revision-budget-exhausted":
      return {
        action: ACTION["revision-budget-exhausted"],
        outcome: `Step: ${stepName}\nAttempts: ${attempts}\nMax: ${String(max)}`,
      };
    case "producer-refused":
    case "skipped-without-narration":
    case "recovery-threw":
      return {
        action: ACTION["not-produced"],
        outcome: `Step: ${stepName}\nGate: ${facts.gate ?? stepName}\nReason: ${facts.reason ?? decline}\n`
          + cardRemainsInReviewTail(),
      };
  }
}

/**
 * The durable sentence for a recovery that was admitted, reached its producer, and produced nothing.
 * Shared with the `refused` outcome arm so a refused round and an un-narrated skip read as the same
 * family with a different `Reason:` line, not as two different conditions.
 */
export function reviewRemediationNotProducedText(input: {
  stepName: string;
  gate: string;
  reason: string;
}): ReviewRemediationDeclineText {
  return reviewRemediationDeclineText("producer-refused", input);
}
