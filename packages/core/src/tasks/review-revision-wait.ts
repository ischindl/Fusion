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

Why a new predicate rather than reuse: `hasPendingReviewRemediationWork(task, { stepReopenPolicy })`
ORs named remediation together with ANY ordinary pending step under the `reopen-trailing` policy, so
it answers "does this card have anything left to run", which is true for a card mid-implementation
and false as a signal of a review revision. This predicate takes the narrow half — `hasPendingRemediationWork`,
which requires structural remediation provenance (`step.remediation !== undefined`) — and conjoins it
with the authored-verdict half below. Neither clause alone is sufficient: pending remediation with no
authored revision is ordinary execution, and an authored revision with nothing pending has already
been corrected (or its work was exhausted, which is a different, parkable state).

The verdict clause is deliberately content-keyed and never text-keyed. `verdict` is the machine-readable
field of a structured review row and `reviewInputFingerprint` is the durable proof the reviewer actually
inspected a diff; neither can be produced by prose. Matching the blocker or error SENTENCE instead would
recreate the exact defect RUFU-280 removes — a plumbing death whose error text happened to mention a
revision would be read as a review finding, and it would be UNRECOVERABLE, because the verdict-less
failed-gate lane (RUFU-204/217/234) re-runs a gate it recognizes as verdict-less and this predicate
claims first. A row with no `verdict` is invisible here, so that lane keeps its cards.
*/

import { hasPendingRemediationWork } from "./remediation-steps.js";
import type { TaskStep } from "../types/task/task-log.js";
import type { WorkflowStepResult } from "../types/workflow/workflow-steps.js";

/**
 * Fixed operator-facing sentence for the awaiting-revision state.
 *
 * Exported so the stall signal and the derived chip render the SAME words, and deliberately free of
 * "merge" next to "blocked": nothing is refusing this card, it is finishing corrections its own
 * reviewer asked for. A card told it is merge-blocked in that state sends the operator to the Review
 * tab for a remedy that does not exist there.
 */
export const AWAITING_REVIEW_REVISION_STALL_REASON =
  "Working through review corrections: the latest review asked for changes and this card still has unfinished remediation work";

/** The row fields the predicate reads. Deliberately excludes `status`, `paused`, and `pausedReason`. */
export type ReviewRevisionWaitSubject = {
  steps?: readonly TaskStep[];
  workflowStepResults?: WorkflowStepResult[];
};

/**
 * True when the newest authored result of a pre-merge review gate demanded changes AND the step board
 * still holds unfinished remediation for them.
 */
export function isAwaitingReviewRevision(task: ReviewRevisionWaitSubject): boolean {
  return findAwaitingReviewRevisionGate(task) !== undefined;
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
 */
export function findAwaitingReviewRevisionGate(task: ReviewRevisionWaitSubject): string | undefined {
  if (!hasPendingRemediationWork(task)) return undefined;

  const results = task.workflowStepResults;
  if (!results?.length) return undefined;

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
