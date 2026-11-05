/*
FNXC:ReviewRevisionWait 2026-09-29-14:12 (RUFU-280):
A code-review gate that AUTHORED a `REVISE` verdict and published named remediation is a card with
live work owed to it, not a card that has stopped. Before this predicate existed, both stall
authorities — `getInReviewStallReason` (which drives the engine's in-review stall park) and
`deriveTaskStallReason` (which drives the operator's chip) — classified it as a plain
`merge-blocker`, so `surfaceInReviewStalls` logged an identical observation every
`taskStuckTimeoutMs` and, at `inReviewStallDeadlockThreshold`, wrote `paused: true` +
`status: "failed"` onto a card whose own review had just asked for corrections. The one reviewer
verdict that CREATES work was the one verdict that guaranteed the card would be failed out.

FNXC:ReviewRevisionWaitHorizon 2026-11-05-18:05 (RUFU-447):
THE NARROW SECOND CLAUSE LEFT A HOLE EXACTLY AS WIDE AS THE REMEDIATION APPENDER'S CRASH WINDOW.

RUFU-280 keyed the second clause on `hasPendingRemediationWork`, which requires structural
provenance (`step.remediation !== undefined`). Two real shapes carry an authored `REVISE` with a
durable `reviewInputFingerprint` and no such step: (1) a reviewer who names the work in the
verdict's NOTES instead of publishing `Fix:` steps — RUFU-269's tracker held seven ordinary steps
and no provenance anywhere, while the review named three artifacts in notes; (2) the executor dying
between writing the `REVISE` row and `appendReviewRemediationSteps` landing, since the provenance
writer and the verdict writer are not one transaction. Both fell through to `merge-blocker`,
accumulated byte-identical observations, and reached the same
`pausedReason: "in-review-stall-deadlock"` + `status: "failed"` park RUFU-280 exists to prevent —
with no wedge alert to warn anyone first, because the deferred wait is deliberately alert-silent.

The second clause is therefore broadened to ANY `pending` step, and the bound the provenance clause
used to supply implicitly is now explicit: `REVIEW_REVISION_PARK_DEFER_HORIZON_MS`, measured against
the authored row's own completion time. Past the horizon this returns `undefined`, which is the
age-bound fallback that hands the card back to `merge-blocker` so the terminal park — and its
operator alert — still exists. The wait can be deferred, never deferred forever.

Why the broadening is not simply `hasPendingReviewRemediationWork(task, { stepReopenPolicy })`: that
helper ORs named remediation with ANY ordinary pending step whenever the workflow uses the
`reopen-trailing` policy, so it is true for a card mid-implementation, and labeling ordinary
execution a review revision is the false claim RUFU-280's narrow half was chosen to avoid. The
distinction survives here because the broad pending-step clause is only ever reached AFTER the
authored-verdict proof below, which an ordinary mid-implementation card cannot pass.

The verdict clause stays deliberately content-keyed and never text-keyed. `verdict` is the
machine-readable field of a structured review row and `reviewInputFingerprint` is the durable proof
the reviewer actually inspected a diff; neither can be produced by prose. Matching the blocker or
error SENTENCE instead would recreate the exact defect RUFU-280 removes — a plumbing death whose
error text happened to mention a revision would be read as a review finding, and it would be
UNRECOVERABLE, because the verdict-less failed-gate lane (RUFU-204/217/234) re-runs a gate it
recognizes as verdict-less and this predicate claims first. A row with no `verdict` is invisible
here, so that lane keeps its cards.
*/

import type { TaskStep } from "../types/task/task-log.js";
import type { WorkflowStepResult } from "../types/workflow/workflow-steps.js";

/**
 * Fixed operator-facing sentence for the awaiting-revision state.
 *
 * Exported so the stall signal and the derived chip render the SAME words, and deliberately free of
 * "merge" next to "blocked": nothing is refusing this card, it is finishing corrections its own
 * reviewer asked for. A card told it is merge-blocked in that state sends the operator to the Review
 * tab for a remedy that does not exist there.
 *
 * FNXC:ReviewRevisionWaitHorizon 2026-11-05-18:05 (RUFU-447): the clause says "unfinished work the
 * card still has to run", not "unfinished remediation steps". RUFU-280 shipped the remediation
 * wording while its own second clause still required provenance; once that clause widened to any
 * pending step, the sentence became a claim about the step board the board may not honour — the
 * RUFU-269 shape has no remediation step at all, and it is the case this sentence now describes.
 */
export const AWAITING_REVIEW_REVISION_STALL_REASON =
  "Working through review corrections: the latest review asked for changes and this card still has unfinished work to run";

/**
 * How long the deferral may hold after the authored `REVISE` row was written.
 *
 * A code-owned constant, not a setting: this is the bound on a terminal action the engine decides
 * for itself, and a knob would let a project turn the deadlock park off entirely. The value is ~3.6x
 * the default episode budget (`DEFAULT_IN_REVIEW_STALL_DEADLOCK_THRESHOLD` = 10 observations x
 * `taskStuckTimeoutMs` 10 min = ~100 min), so a card with genuine work owed is never terminalized
 * mid-correction by the ordinary ladder, while a card whose remediation provenance was lost in a
 * crash is terminalized hours later instead of never.
 */
export const REVIEW_REVISION_PARK_DEFER_HORIZON_MS = 6 * 60 * 60 * 1000;

/** The row fields the predicate reads. Deliberately excludes `status`, `paused`, and `pausedReason`. */
export type ReviewRevisionWaitSubject = {
  steps?: readonly TaskStep[];
  workflowStepResults?: WorkflowStepResult[];
};

/**
 * Optional clock. Injected by tests so the horizon is never proven with real timers; every
 * production caller omits it and gets `Date.now()`.
 */
export type ReviewRevisionWaitOptions = {
  nowMs?: number;
};

/**
 * True when the newest authored result of a pre-merge review gate demanded changes, that verdict is
 * still inside the defer horizon, AND the step board still holds any unfinished step to run.
 */
export function isAwaitingReviewRevision(task: ReviewRevisionWaitSubject, options: ReviewRevisionWaitOptions = {}): boolean {
  return findAwaitingReviewRevisionGate(task, options) !== undefined;
}

/**
 * The `workflowStepId` of the gate whose newest authored row demanded corrections, or `undefined`.
 *
 * Exists so the bounded park repair can name WHICH gate owed the revision in its audit row: run-audit
 * metadata is ids/counts/fixed-outcomes only, so a gate id is admissible where the reviewer's findings
 * never would be. `isAwaitingReviewRevision` is the same call reduced to a boolean.
 *
 * "Newest per gate" is load-bearing. Review rounds append rows rather than replacing them, so a scan
 * for ANY row carrying `REVISE` would keep a card deferred forever after one revision that was later
 * approved — the later `APPROVE` row must win its own gate. This is the same newest-row-per-gate shape
 * the approval authority reduces its own rows with.
 *
 * The clause ORDER is load-bearing: the authored-verdict proof runs first, and only a card that
 * passes it may reach the pending-step clause. Reversing them would let any mid-implementation card
 * (pending steps, no review verdict yet) read as a review revision.
 */
export function findAwaitingReviewRevisionGate(
  task: ReviewRevisionWaitSubject,
  options: ReviewRevisionWaitOptions = {},
): string | undefined {
  const results = task.workflowStepResults;
  if (!results?.length) return undefined;

  const nowMs = Number.isFinite(options.nowMs) ? (options.nowMs as number) : Date.now();

  /** Newest row seen per `workflowStepId`, by completion time (start time as the fallback clock). */
  const newestByGate = new Map<string, WorkflowStepResult>();
  for (const result of results) {
    if ((result.phase ?? "pre-merge") !== "pre-merge") continue;
    const prior = newestByGate.get(result.workflowStepId);
    if (!prior || resultTimeMs(result) >= resultTimeMs(prior)) {
      newestByGate.set(result.workflowStepId, result);
    }
  }

  for (const result of newestByGate.values()) {
    if (result.verdict !== "REVISE") continue;
    if (!hasDurableReviewInput(result)) continue;
    if (!isInsideDeferHorizon(resultTimeMs(result), nowMs)) continue;
    if (!hasPendingStepWork(task)) continue;
    return result.workflowStepId;
  }
  return undefined;
}

/** Parseable completion time, falling back to start time; an unparseable row sorts oldest. */
function resultTimeMs(result: WorkflowStepResult): number {
  const completed = Date.parse(result.completedAt ?? "");
  if (Number.isFinite(completed)) return completed;
  const started = Date.parse(result.startedAt ?? "");
  return Number.isFinite(started) ? started : 0;
}

/**
 * Age bound on the deferral. Measured from the authored row's own clock, never from `task.updatedAt`,
 * which every unrelated write bumps and which would therefore extend the grace period forever.
 *
 * An untimeable row reads as epoch-old (`resultTimeMs` → 0) and so is OUTSIDE the horizon: a verdict
 * that cannot be dated cannot buy a card a reprieve, which is the fail-closed direction — the card
 * keeps the pre-existing `merge-blocker` classification and its alert.
 */
function isInsideDeferHorizon(authoredAtMs: number, nowMs: number): boolean {
  if (!Number.isFinite(authoredAtMs) || !Number.isFinite(nowMs)) return false;
  const ageMs = nowMs - authoredAtMs;
  // A row stamped ahead of the clock (clock skew) is treated as just authored rather than expired.
  return ageMs <= REVIEW_REVISION_PARK_DEFER_HORIZON_MS;
}

/**
 * Any unfinished step — structural remediation OR an ordinary planned step.
 *
 * The broadened clause is deliberately this wide: a reviewer who named the corrections only in the
 * verdict's notes still owes the card steps to run, and a crash between the verdict write and the
 * remediation append leaves the same shape. Safe only because the caller reaches this AFTER the
 * authored-verdict proof.
 */
function hasPendingStepWork(task: ReviewRevisionWaitSubject): boolean {
  return (task.steps ?? []).some((step) => step.status === "pending");
}

/**
 * A `REVISE` counts only with a real review-input fingerprint present.
 *
 * The fingerprint is what distinguishes an authored verdict from an unproven one: FN-279's recovery
 * treats a singular content-review approval WITHOUT a fingerprint as needing repair, so a verdict with
 * no fingerprint is evidence the review is not settled, not evidence a revision is owed. Blank-only
 * strings count as absent — a persisted ` ` must not flip a card into the exempt class.
 */
function hasDurableReviewInput(result: WorkflowStepResult): boolean {
  return typeof result.reviewInputFingerprint === "string" && result.reviewInputFingerprint.trim().length > 0;
}
