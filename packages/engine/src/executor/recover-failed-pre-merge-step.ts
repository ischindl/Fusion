/**
 * FNXC:CodeOrganization 2026-08-03-09:20:
 * recoverFailedPreMergeWorkflowStep peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowPostMerge 2026-06-26-14:00:
 * A failed pre-merge result is a blocking gate failure by construction. Recovery revives the task
 * from that failed gate while retaining the gate's structured findings for the implementer.
 */
import type { Task, TaskStore, WorkflowStepResult as CoreWorkflowStepResult } from "@fusion/core";
import type { SendTaskBackForFixOutcome } from "./send-task-back-for-fix.js";
import { hasPreMergeRemediationAutoMergeHold, resolveStepReopenPolicy, resolveWorkflowIrForTask } from "@fusion/core";
import { executorLog } from "../logger.js";
import { generateSyntheticRunId, type EngineRunContext } from "../util/run-audit.js";
import { emitBoundedRunAudit } from "./emit-bounded-run-audit.js";
import type {
  AppendReviewRemediationOptions,
  AppendReviewRemediationOutcome,
} from "./append-review-remediation-steps.js";
import { reassertRemediationAttempt } from "./claim-review-remediation-attempt.js";
import { ClaimSupersededError, fenceStoreForClaim } from "./fence-store-for-claim.js";
import { routeReviewConvergenceLadder } from "./review-convergence-ladder.js";
import { hasRepeatedUnchangedReview, reviewInputSignature, type RequestPreMergeOptionalStepFixInfo } from "./request-pre-merge-optional-step-fix.js";
import { resolveReviewRemediationGate } from "./review-remediation-gate.js";
import { resolveRemediationCheckout } from "./resolve-remediation-checkout.js";
import {
  reviewRemediationDeclineText,
  type ReviewRemediationDeclineFacts,
  type ReviewRemediationNarratedDecline,
} from "./review-remediation-refusal-text.js";
import { isDefiniteEmptyCodeReviewRevise } from "./review-empty-content-close.js";
import {
  hasReviewRemediationAttemptForEpisode,
  reviewRemediationEpisodeIdentity,
} from "./optional-step-revision.js";

export type RemediationRefusalReason =
  | "no-actionable-findings"
  | "upstream-out-of-scope"
  | "unclassified-gate-no-reopen"
  | "appender-declined";

export type ReviewRemediationAttemptDescriptor = {
  workflowStepId: string;
  signature: string;
  owner: string;
};

/** The caller distinguishes a durable refusal from a transient skip or a stale claimed review. */
export type RecoverFailedPreMergeStepOutcome =
  | { kind: "scheduled"; producer: "named" | "trailing" }
  | { kind: "convergence" }
  | { kind: "refused"; reason: RemediationRefusalReason; gate: string }
  | { kind: "skipped" }
  | { kind: "superseded" };

export type RecoverFailedPreMergeStepDeps = {
  store: TaskStore;
  getRunContextFor?: (taskId: string) => EngineRunContext | undefined;
  resolveFailedPreMergeWorkflowStepBudget: (
    task: Task,
    target: CoreWorkflowStepResult,
  ) => Promise<{ unbounded: boolean; max: number; label: string; key: string; stepName?: string; attempts: number }>;
  appendReviewRemediationSteps?: (
    task: Task,
    info: RequestPreMergeOptionalStepFixInfo,
    options?: AppendReviewRemediationOptions,
  ) => Promise<AppendReviewRemediationOutcome>;
  sendTaskBackForFix: (
    task: Task,
    worktreePath: string,
    failureFeedback: string,
    stepName: string,
    reason: string,
    preserveResumeState?: boolean,
    mergeVerificationFailure?: boolean,
    retryPresentation?: { attempt: number; max?: number },
    findings?: CoreWorkflowStepResult["findings"],
    persistWorktreePath?: boolean,
    stepReopenPolicy?: "reopen-trailing" | "none",
    replayAccounting?: import("./reopen-last-step-for-revision.js").TrailingReplayAccounting,
  ) => Promise<void>;
};

function latestFailedPreMergeStep(task: Pick<Task, "workflowStepResults">): CoreWorkflowStepResult | undefined {
  return (task.workflowStepResults ?? [])
    .filter((result) => (result.phase || "pre-merge") === "pre-merge" && result.status === "failed")
    .sort((left, right) => {
      const leftTime = Date.parse(left.completedAt || left.startedAt || "");
      const rightTime = Date.parse(right.completedAt || right.startedAt || "");
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    })[0];
}

function refusalFromAppender(outcome: AppendReviewRemediationOutcome): RemediationRefusalReason {
  switch (outcome) {
    case "released-no-actionable-findings":
    case "released-no-pending-work":
      return "no-actionable-findings";
    case "released-upstream-out-of-scope":
      return "upstream-out-of-scope";
    default:
      return "appender-declined";
  }
}

/** True only for the successful hand-off outcome; callers must not treat every object as success. */
export function isRecoverFailedPreMergeStepScheduled(outcome: RecoverFailedPreMergeStepOutcome): boolean {
  return outcome.kind === "scheduled" || outcome.kind === "convergence";
}

/**
 * FNXC:LifecycleContainment 2026-08-30-13:36:
 * A claimed recovery runs against the same fenced store the live requester uses. Its refusal
 * branches — operator hold, checkout unavailable, zero/exhausted budget, the convergence ladder —
 * each NARRATE on the task, and a log entry cannot be withdrawn by a later fenced refusal. Fencing
 * the store, rather than adding a check per branch, is what stops the next branch from reopening
 * the hole: supersession surfaces as a thrown sentinel and becomes a silent `superseded` outcome.
 */
/**
 * FNXC:ReviewRemediationDeclineNarration 2026-09-27-06:25 (RUFU-351):
 * A caller that owns a fallback explanation needs to know whether this recovery already put a
 * sentence on the card. `narrationWitness.narrated` flips to true only after a decline entry is
 * durably written, so the self-healing revival sweep can suppress its own fallback without ever
 * leaving the card mute. Omitted by every other caller, which keeps their control flow and text
 * byte-identical.
 *
 * FNXC:ReviewRemediationDeclineNarration 2026-11-06-17:41 (RUFU-351 code review):
 * The witness is NOT a log of this function's own sentences — it is the fact that the card is
 * already explained. Two DELEGATED owners write their own durable card line and then hand back a
 * `skipped` outcome: the empty-review close (`No reviewable content — terminal park recorded for
 * <step>`) and the convergence ladder's human-escalation rungs (`Review convergence exhausted —
 * awaiting operator action` / `Review convergence stopped — no pending remediation work`). A hand-off
 * to either marks the witness; a hand-off that narrated nothing (the ladder's `"declined"`) must
 * not, so a genuinely mute decline still speaks.
 */
export type ReviewRemediationNarrationWitness = { narrated: boolean };

export type RecoverFailedPreMergeStepCallOptions = {
  claim?: ReviewRemediationAttemptDescriptor;
  narrationWitness?: ReviewRemediationNarrationWitness;
};

export async function recoverFailedPreMergeWorkflowStepDetailed(
  rawDeps: RecoverFailedPreMergeStepDeps,
  task: Task,
  options: RecoverFailedPreMergeStepCallOptions = {},
): Promise<RecoverFailedPreMergeStepOutcome> {
  const deps: RecoverFailedPreMergeStepDeps = options.claim
    ? { ...rawDeps, store: fenceStoreForClaim(rawDeps.store, task.id, options.claim) }
    : rawDeps;
  try {
    /*
    FNXC:LifecycleContainment 2026-08-30-12:57:
    A claim-scoped recovery must resolve its exact failed result before emitting a comment, logging a
    refusal, appending work, or asking for a move. The step id is the durable address and the review
    signature identifies its round; a moved or absent target is superseded and remains completely
    silent so an older worker cannot narrate or remediate a newer review.
    */
    let liveTask = task;
    let target: CoreWorkflowStepResult | undefined;
    if (options.claim) {
      const current = await deps.store.getTask(task.id);
      target = current?.workflowStepResults?.find((result) => result.workflowStepId === options.claim!.workflowStepId);
      if (!current || !target || reviewInputSignature(target) !== options.claim.signature) return { kind: "superseded" };
      liveTask = current;
    } else {
      target = latestFailedPreMergeStep(task);
    }
    if (!target) {
      executorLog.warn(`${task.id}: no failed pre-merge workflow step to recover from`);
      return { kind: "skipped" };
    }

    /*
    FNXC:ReviewRemediationDeclineNarration 2026-09-27-06:25 (RUFU-351):
    One seam for every narrated decline, so (a) `review-remediation-refusal-text.ts` is the only place
    these sentences are spelled and (b) the witness records that the card is already explained. The
    witness is set only AFTER the write lands: a failed write means the card is still mute, and the
    caller's fallback must then fire rather than be suppressed by a claim nobody can read.
    */
    const narrateDecline = async (
      decline: ReviewRemediationNarratedDecline,
      facts: ReviewRemediationDeclineFacts,
    ): Promise<void> => {
      const text = reviewRemediationDeclineText(decline, facts);
      await deps.store.logEntry(liveTask.id, text.action, text.outcome, deps.getRunContextFor?.(liveTask.id));
      if (options.narrationWitness) options.narrationWitness.narrated = true;
      /*
      FNXC:ReviewRemediationDeclineNarration 2026-09-27-07:12 (RUFU-351):
      One narrated decline = one audit row, written by whichever owner narrated it. The recovery helper
      narrates its own admission declines for every caller (self-healing sweep, retry router,
      in-process runtime), so crediting `executor` here is what keeps the invariant true for declines
      the revival sweep never reaches. Ids/column/gate only — the sentence lives on the card, refusal
      prose and error text never enter the row. Bounded and best-effort: telemetry cannot delay or
      alter the decline it describes.
      */
      await emitBoundedRunAudit(deps.store, {
        taskId: liveTask.id,
        agentId: "executor",
        runId: generateSyntheticRunId("review-remediation-declined", liveTask.id),
        domain: "database",
        mutationType: "task:review-remediation-declined",
        target: liveTask.id,
        metadata: {
          taskId: liveTask.id,
          column: liveTask.column,
          code: decline,
          gate: facts.gate ?? facts.stepName ?? "unknown",
        },
      });
    };

    /*
    FNXC:ReviewRemediationDeclineNarration 2026-11-06-17:41 (RUFU-351 code review):
    The second half of the witness contract. `narrateDecline` covers the sentences THIS function
    writes; this covers the sentences a delegated owner writes before handing the card back with a
    `skipped` outcome. Without it the caller reads "admitted, nothing scheduled, card mute" and
    appends its own fallback — two operator lines for one decline, and the fallback is false on both
    counts (an explanation exists, and the card is terminal-parked or operator-parked, not left
    awaiting a re-run). Only hand-offs whose owner provably narrated may mark it: the ladder's
    `"declined"` returns stay unmarked so a real silence is still narrated by the caller.
    */
    const markDelegatedNarration = (): void => {
      if (options.narrationWitness) options.narrationWitness.narrated = true;
    };

    if (hasPreMergeRemediationAutoMergeHold(liveTask, await deps.store.getSettings())) {
      const reason = "operator-authored task-level auto-merge Off holds failed-step recovery";
      executorLog.warn(`${liveTask.id}: failed pre-merge step recovery NOT scheduled — ${reason}. Card left parked.`);
      await narrateDecline("operator-task-hold", { reason });
      return { kind: "skipped" };
    }

    const feedback = target.output?.trim() || "(no feedback captured)";
    const stepName = target.workflowStepName || target.workflowStepId || "Unknown";
    const checkout = resolveRemediationCheckout(liveTask, target);
    if (!checkout) {
      executorLog.warn(`${liveTask.id}: failed pre-merge step recovery NOT scheduled for "${stepName}" — no remediation checkout is available. Card left parked.`);
      await narrateDecline("checkout-unavailable", { stepName });
      return { kind: "skipped" };
    }

    const info: RequestPreMergeOptionalStepFixInfo = {
      nodeId: target.workflowStepId,
      stepName,
      feedback,
      phase: target.phase ?? "pre-merge",
      status: target.status,
      verdict: target.verdict,
      findings: target.findings,
      reviewKind: target.reviewKind,
    };
    const gate = resolveReviewRemediationGate(info);
    const producesRemediation = Boolean(
      gate && deps.appendReviewRemediationSteps && (gate !== "Code Review" || target.verdict === "REVISE"),
    );

    /*
    FNXC:ReviewEmptyContent 2026-08-30-13:36:
    FN-267: the empty-diff close must never PRE-EMPT the deterministic Fix-step producer. A Code
    Review REVISE carrying the empty-diff fingerprint but no usable findings used to park terminally
    right here, which is the one outcome the operator requirement forbids — a REVISE may not block a
    card merely because fix steps were absent. The close is now the FALLBACK for a review no producer
    can serve: it keeps its original position (ahead of every budget branch) for gates with no
    producer, and otherwise runs only after the producer has actually declined.
    */
    const closeEmptyReviewContent = async (): Promise<boolean> => {
      const emptyTarget = target;
      if (!isDefiniteEmptyCodeReviewRevise(emptyTarget)) return false;
      const outcome = await routeReviewConvergenceLadder({
        ...deps,
        getRunContextFor: deps.getRunContextFor ?? (() => undefined),
      }, liveTask.id, {
        kind: "empty-review-input",
        workflowStepId: emptyTarget.workflowStepId,
        stepName,
        feedback,
        findings: emptyTarget.findings,
        attempt: 1,
        emptyInputFence: {
          workflowStepId: emptyTarget.workflowStepId,
          stepName,
          expectedStartedAt: emptyTarget.startedAt,
          expectedCompletedAt: emptyTarget.completedAt,
          expectedVerdict: emptyTarget.verdict,
          expectedReviewInputFingerprint: emptyTarget.reviewInputFingerprint!,
        },
      });
      return outcome === "empty-content-terminalized";
    };
    /*
    FNXC:ReviewRemediationDeclineNarration 2026-11-06-17:41 (RUFU-351 code review):
    `true` here means `terminalizeEmptyReviewContent` CAS-parked the card AND wrote its own card
    sentence, so the caller must not narrate this decline a second time.
    */
    if (!producesRemediation && await closeEmptyReviewContent()) {
      markDelegatedNarration();
      return { kind: "skipped" };
    }

    const budget = await deps.resolveFailedPreMergeWorkflowStepBudget(liveTask, target);
    const episodeIdentity = reviewRemediationEpisodeIdentity(target);
    /*
    FNXC:ReviewRemediationBudget 2026-09-08-01:46:
    A crash after the atomic publication may leave the task in review with the failed gate and its
    pending remediation still present. That is a handoff retry, not a new revision: bypass convergence
    admission only for the exact episode marker plus durable pending work, then let the producer resume
    scheduling without another append or charge.
    */
    const resumesCommittedRemediation = hasReviewRemediationAttemptForEpisode(liveTask, episodeIdentity)
      && (liveTask.steps ?? []).some((step) => step.status === "pending");
    if (!resumesCommittedRemediation && (!Number.isFinite(budget.max) || budget.max <= 0)) {
      executorLog.warn(`${liveTask.id}: failed pre-merge step recovery NOT scheduled for "${stepName}" — revision budget is zero/invalid (attempts=${budget.attempts}, max=${String(budget.max)}). Card left parked.`);
      await narrateDecline("revision-budget-zero-or-invalid", { stepName, attempts: budget.attempts, max: budget.max });
      return { kind: "skipped" };
    }

    if (!resumesCommittedRemediation && hasRepeatedUnchangedReview(liveTask, {
      nodeId: target.workflowStepId,
      stepName,
      feedback,
      phase: target.phase ?? "pre-merge",
      status: target.status,
      verdict: target.verdict,
      findings: target.findings,
    })) {
      const outcome = await routeReviewConvergenceLadder({
        ...deps,
        getRunContextFor: deps.getRunContextFor ?? (() => undefined),
      }, liveTask.id, {
        kind: "repeat-unchanged", workflowStepId: target.workflowStepId, stepName,
        feedback, findings: target.findings, attempt: budget.attempts,
        max: budget.max,
      });
      if (outcome === "escalated" || outcome === "arbitrated") return { kind: "convergence" };
      /*
      FNXC:ReviewRemediationDeclineNarration 2026-11-06-17:41 (RUFU-351 code review):
      `human-escalated` is returned ONLY from rungs that parked the card `awaiting-approval` after
      writing their own card sentence, so the ladder is the narrator of this decline and the outcome
      union stays unchanged (`skipped`, never a new kind). `"declined"` — a ladder that refused
      without saying anything on the card — deliberately leaves the witness alone.
      */
      if (outcome === "human-escalated") markDelegatedNarration();
      return { kind: "skipped" };
    }
    if (!resumesCommittedRemediation && budget.attempts >= budget.max) {
      const outcome = await routeReviewConvergenceLadder({
        ...deps,
        getRunContextFor: deps.getRunContextFor ?? (() => undefined),
      }, liveTask.id, {
        kind: "budget-exhausted", workflowStepId: target.workflowStepId, stepName,
        feedback, findings: target.findings, attempt: budget.attempts, max: budget.max,
      });
      if (outcome === "escalated" || outcome === "arbitrated") return { kind: "convergence" };
      executorLog.warn(`${liveTask.id}: failed pre-merge step recovery NOT scheduled for "${stepName}" — revision budget exhausted (attempts=${budget.attempts}, max=${String(budget.max)}). Card left parked.`);
      await narrateDecline("revision-budget-exhausted", { stepName, attempts: budget.attempts, max: budget.max });
      return { kind: "skipped" };
    }

    const workflowIr = await resolveWorkflowIrForTask(deps.store, liveTask.id).catch(() => undefined);
    const stepReopenPolicy = resolveStepReopenPolicy(workflowIr);

    /*
    FNXC:LifecycleContainment 2026-08-30-12:57:
    FN-267 reverses the deadlocking order for recovery. A classified Code Review or Verification
    first runs the shared named-remediation producer, which performs its own guarded hand-off only
    after the Fix work is durable. The direct send-back route is reserved for an unclassified
    trailing-reopen workflow, whose producer is its ordinary replay occurrence.
    */
    /*
    FNXC:LifecycleContainment 2026-08-30-13:36:
    The re-assert wraps the CALL to each hand-off, never its body: sendTaskBackForFix writes its
    comment and "moved back" entry as its first durable acts, and the appender updates the task
    before returning, so an inner check is already too late to keep the boundary. A refused
    re-assert means a newer review round replaced the claimed one; the overtaken runner then goes
    completely silent rather than narrating or remediating a round it never examined.
    */
    const holdsClaim = async (): Promise<boolean> => {
      if (!options.claim) return true;
      const reasserted = await reassertRemediationAttempt(deps.store, liveTask.id, options.claim);
      return reasserted.applied;
    };

    if (producesRemediation && deps.appendReviewRemediationSteps) {
      if (!await holdsClaim()) return { kind: "superseded" };
      const appenderOutcome = await deps.appendReviewRemediationSteps(liveTask, info, {
        attemptClaim: {
          revisionKey: budget.key,
          stepName,
          status: target.status,
          maxRevisions: budget.max,
          expectedWorkflowStepId: target.workflowStepId,
          expectedReviewSignature: reviewInputSignature(target),
          expectedReviewEpisodeIdentity: episodeIdentity,
          runContext: deps.getRunContextFor?.(liveTask.id),
        },
      });
      if (appenderOutcome === "appended") return { kind: "scheduled", producer: "named" };
      /* The producer genuinely declined; only now may a provably empty round close terminally. */
      if (await closeEmptyReviewContent()) {
        // Same delegated-narration fact as the pre-budget close above: the empty-content park spoke for itself.
        markDelegatedNarration();
        return { kind: "skipped" };
      }
      return { kind: "refused", reason: refusalFromAppender(appenderOutcome), gate: gate ?? stepName };
    }
    if (stepReopenPolicy !== "reopen-trailing") {
      return { kind: "refused", reason: "unclassified-gate-no-reopen", gate: stepName };
    }
    if (!await holdsClaim()) return { kind: "superseded" };
    const sendOutcome = await (deps.sendTaskBackForFix as unknown as (
      ...args: Parameters<RecoverFailedPreMergeStepDeps["sendTaskBackForFix"]>
    ) => Promise<SendTaskBackForFixOutcome>)(
      liveTask,
      checkout.path,
      feedback,
      stepName,
      `Auto-revived from in-review: pre-merge workflow step "${stepName}" had failed`,
      true,
      false,
      { attempt: budget.attempts + 1, max: budget.max },
      target.findings,
      checkout.persist,
      stepReopenPolicy,
      {
        revisionKey: budget.key,
        stepName,
        status: target.status ?? "failed",
        maxRevisions: budget.max,
        expectedWorkflowStepId: target.workflowStepId ?? stepName,
        expectedReviewSignature: reviewInputSignature(target),
        expectedReviewEpisodeIdentity: episodeIdentity,
        expectedColumn: liveTask.column,
        expectedStatus: liveTask.status,
        runContext: deps.getRunContextFor?.(liveTask.id),
      },
    );
    /* Legacy test/adapter callbacks reported only completion; production returns the committed producer result. */
    if (!sendOutcome) return { kind: "scheduled", producer: "trailing" };
    if (sendOutcome.kind === "scheduled" && sendOutcome.remediationCommitted) {
      return { kind: "scheduled", producer: "trailing" };
    }
    if (sendOutcome.kind === "superseded") return { kind: "superseded" };
    if (sendOutcome.kind === "budget-exhausted") return { kind: "skipped" };
    return { kind: "refused", reason: "appender-declined", gate: stepName };
  } catch (err: unknown) {
    if (err instanceof ClaimSupersededError) return { kind: "superseded" };
    const errorMessage = err instanceof Error ? err.message : String(err);
    executorLog.error(`Failed to recover failed pre-merge workflow step for ${task.id}: ${errorMessage}`);
    return { kind: "skipped" };
  }
}

/**
 * Compatibility entry point for existing non-claim callers. New owner-scoped recovery uses the
 * detailed outcome so a durable refusal, transient skip, and supersession remain distinguishable.
 *
 * FNXC:ReviewRemediationDeclineNarration 2026-11-06-18:10 (RUFU-351 code review):
 * This wrapper takes no call options: a boolean "was work scheduled?" answer cannot report a
 * narration event either, so the narration witness lives on the typed {@link
 * recoverFailedPreMergeWorkflowStepDetailed} lane — the lane production wires. A caller that needs to
 * know a decline was already explained calls the detailed entry point.
 */
export async function recoverFailedPreMergeWorkflowStep(
  deps: RecoverFailedPreMergeStepDeps,
  task: Task,
): Promise<boolean> {
  return isRecoverFailedPreMergeStepScheduled(await recoverFailedPreMergeWorkflowStepDetailed(deps, task));
}
