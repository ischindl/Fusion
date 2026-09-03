import type { Task, WorkflowStepResult } from "../types.js";
import { PLAN_REVIEW_GROUP_ID } from "../workflows/builtin-plan-review-group.js";
import { FAST_MODE_BYPASS_ACTOR } from "../workflows/workflow-fast-lane.js";
import { isWorkflowStepNotRun } from "../workflows/workflow-step-results.js";
import type { MergeContentDescriptor } from "./merge-content-descriptor.js";

export type PreMergeApprovalState = "approved" | "missing" | "not-approved" | "stale-content" | "unprovable-content";
export type PreMergeApproval = { workflowStepId: string; state: PreMergeApprovalState; repositories?: string[] };

/** The merge gate's sole definition of a review whose approval binds source content. */
export function requiresContentReviewProof(
  workflowStepId: string,
  result: Pick<WorkflowStepResult, "reviewKind">,
): boolean {
  return workflowStepId === "code-review" || result.reviewKind === "code";
}

export const AUTOMATED_BYPASS_ACTORS: ReadonlySet<string> = new Set([FAST_MODE_BYPASS_ACTOR]);

/*
FNXC:PreMergeApproval 2026-09-01-11:28:
Content binding prevents an automated approval from being reused against different source, while an
audited human waiver is not a source approval at all: FN-7720 promises to clear the failed gate, but
falling through to diff comparison made that operator escape inert. The actor is the discriminator
because fast mode writes the same timestamp, reason, and absent-gate fields as an operator bypass;
a passed proofless row remains refused regardless of any stray bypass metadata.
*/
export function isAuditedOperatorBypass(
  result: Pick<WorkflowStepResult, "status" | "bypassedBy" | "bypassedAt" | "bypassReason">,
): boolean {
  if (result.status !== "skipped") return false;
  const actor = result.bypassedBy?.trim();
  return Boolean(
    actor
    && !AUTOMATED_BYPASS_ACTORS.has(actor)
    && result.bypassedAt?.trim()
    && result.bypassReason?.trim(),
  );
}

/*
FNXC:PreMergeApproval 2026-09-02-21:57:
RUFU-172: `archiveTerminalWorkflowStepFailures` turns a terminal gate failure into `skipped` stamped
with `remediationArchivedAt`, and it deliberately strips bypass AND arbitration metadata. The refusal
below (`!!result.remediationArchivedAt` → not-approved) is correct — that carrier must never approve —
but `not-approved` is the *unsatisfiable* answer: FN-9243 re-seeds only gates with no result row,
FN-7720 operator bypass selects only `status === "failed"`, and FN-245 removed every `force` path. The
carrier therefore needed a recovery path and had none, so a fully Code-Review-approved card sat
`in-review` for ~14h and was landed by hand.

This carrier means exactly one observable thing: the gate produced no current verdict, which IS the
existing recoverable not-run state. Classifying it `missing` routes the card to
`PRE_MERGE_STEPS_NOT_RUN_BLOCKER` — a deferral that refuses every merge door AND feeds FN-9243's bounded
in-place re-seed, so the gate RUNS AGAIN and reports a genuine verdict. No verdict is invented: the two
skipped shapes that DO carry authority stay out of this rule — an audited operator bypass
(`isAuditedOperatorBypass`) and an arbitrated release (`arbitrationDecision`) — and the workspace branch
keeps its own `repositoryScope` proof carrier, mirroring the absent-row guard above.
*/
export function isReRunnableRemediationCarrier(
  result: Pick<
    WorkflowStepResult,
    "status" | "remediationArchivedAt" | "bypassedBy" | "bypassedAt" | "bypassReason" | "arbitrationDecision"
  >,
  descriptor: MergeContentDescriptor | undefined,
): boolean {
  return result.remediationArchivedAt != null
    && !isAuditedOperatorBypass(result)
    && result.arbitrationDecision === undefined
    && descriptor?.kind !== "workspace";
}

const UNPROVEN_REVIEW_APPROVAL_DIAGNOSTIC = "Content-binding review approval recorded without reviewInputFingerprint; approval invalidated so the gate can run again.";

/*
FNXC:ReviewInputProof 2026-09-01-11:28:
A proofless content approval is already terminal `passed`, so neither the failed-step bypass nor the
pending-step resume surface can select it. Rewrite only that invalid singular approval to `failed`,
never delete it, so recovery can re-run the gate and the operator retains a selectable audit carrier.
*/
export function resolveUnprovenReviewApproval(
  result: WorkflowStepResult,
  options: { workspace: boolean },
): { downgraded: WorkflowStepResult; reason: string } | undefined {
  if ((result.phase ?? "pre-merge") !== "pre-merge"
    || !requiresContentReviewProof(result.workflowStepId, result)
    || options.workspace
    || result.status !== "passed"
    || (result.verdict !== "APPROVE" && result.verdict !== "APPROVE_WITH_NOTES")
    || result.reviewInputFingerprint !== undefined
    || result.bypassedBy !== undefined
    || result.remediationArchivedAt != null) {
    return undefined;
  }
  const { verdict: _verdict, ...withoutVerdict } = result;
  return {
    downgraded: {
      ...withoutVerdict,
      status: "failed",
      output: UNPROVEN_REVIEW_APPROVAL_DIAGNOSTIC,
      notes: UNPROVEN_REVIEW_APPROVAL_DIAGNOSTIC,
    },
    reason: UNPROVEN_REVIEW_APPROVAL_DIAGNOSTIC,
  };
}

export function evaluatePreMergeApprovals(
  task: Pick<Task, "workflowStepResults" | "repositoryScope">,
  options: { requiredPreMergeStepIds?: ReadonlySet<string>; mergeContent?: MergeContentDescriptor } = {},
): PreMergeApproval[] {
  const required = options.requiredPreMergeStepIds;
  if (!required?.size) return [];
  const results = task.workflowStepResults ?? [];
  return [...required].map((workflowStepId) => evaluateStep(workflowStepId, results, task, options.mergeContent));
}

function evaluateStep(
  workflowStepId: string,
  results: readonly WorkflowStepResult[],
  task: Pick<Task, "repositoryScope">,
  descriptor: MergeContentDescriptor | undefined,
): PreMergeApproval {
  const result = results.filter((candidate) => candidate.workflowStepId === workflowStepId).at(-1);
  // Workspace Code Review persists its positive proof in repositoryScope so it survives
  // the intentional workflow-result remediation wipe; singular tasks have no such carrier.
  if (!result && descriptor?.kind !== "workspace") return { workflowStepId, state: "missing" };
  // RUFU-178: a remediation-archived carrier has no verdict to honour, so it is the not-run state
  // and must reach the re-seed seam rather than the unsatisfiable `not-approved` refusal.
  if (result && isReRunnableRemediationCarrier(result, descriptor)) return { workflowStepId, state: "missing" };
  if (result) {
    /*
    FNXC:PreMergeApproval 2026-08-23-08:51:
    FN-180 requires a positive current Code Review verdict, not a passed transport result. Code-review
    results may reach `passed` without a reviewer callback, so only APPROVE/APPROVE_WITH_NOTES opens a
    diff-bound gate; plan-domain rows retain their established status-only behavior because they bind
    plan text rather than source content. An absent verdict therefore exits as not-approved.
    */
    const requiresExplicitVerdict = requiresContentReviewProof(workflowStepId, result);
    const approvedVerdict = result.verdict === "APPROVE" || result.verdict === "APPROVE_WITH_NOTES";
    /*
    FNXC:WorkflowStepNotRun 2026-08-28-14:13:
    A check that could not run must not block a task, but its honest skipped carrier can open only a
    non-content, non-plan gate. Code-domain checks still require a positive current verdict, and the
    plan-domain exclusion is load-bearing because the status-only return below would otherwise let an
    unexecuted Plan Review open the merge door despite `isPlanReviewSatisfied` refusing it.
    */
    const isPlanDomain = workflowStepId === PLAN_REVIEW_GROUP_ID || result.reviewKind === "plan";
    const notRunApproves = isWorkflowStepNotRun(result) && !requiresExplicitVerdict && !isPlanDomain;
    const approved = (result.status === "passed" && (requiresExplicitVerdict ? approvedVerdict : (result.verdict === undefined || approvedVerdict)))
      || (result.status === "skipped" && !!result.bypassedBy)
      || notRunApproves;
    /*
    FNXC:PreMergeApproval 2026-09-02-22:35 (RUFU-178):
    The archive refusal inside this block used to be unconditional, so even a fully audited FN-7720
    operator bypass recorded on top of an archived carrier stayed `not-approved` — recreating the
    unsatisfiable class this card removes (a waiver that waives nothing). The refusal now yields only
    to `isAuditedOperatorBypass` on a singular task: the operator's audited release IS the answer, so
    it may not route back into the re-seed either. Arbitration records keep today's refusal (they are
    verify-and-file scope), workspace carriers keep byte-identical evidence semantics because their
    positive proof lives in `repositoryScope`, and verdict-less archives never reach here at all —
    they classify `missing` earlier and get the gate re-run.
    */
    const archivedReleasedByAuditedBypass = result.remediationArchivedAt != null
      && descriptor?.kind !== "workspace"
      && isAuditedOperatorBypass(result);
    if (!approved || (!!result.remediationArchivedAt && !archivedReleasedByAuditedBypass)) {
      return { workflowStepId, state: "not-approved" };
    }
    // Plan fingerprints bind plan text rather than source diff and must never be cross-compared.
    if (result.reviewKind === "plan") return { workflowStepId, state: "approved" };
    if (isAuditedOperatorBypass(result) && descriptor?.kind !== "workspace") {
      return { workflowStepId, state: "approved" };
    }
    /*
    FNXC:PreMergeApproval 2026-08-24-07:10:
    A required pre-merge step is not necessarily a CONTENT REVIEW. Review-column workflows also
    require deterministic verification and documentation/delivery gates, which pass on an exit code
    or a completed action and never record a `reviewInputFingerprint` — there is no diff for them to
    bind. Falling through to the diff comparison classified every one of them as
    `unprovable-content`, so `canMergeTask` answered "task has no provable approval for the content
    being merged" and NOTHING could ever merge on such a workflow. Measured on
    builtin:coding-ideas-v2 via pipeline-smoke S01; builtin:review-gated-coding carries the same
    latent defect and simply never reached its merge.
    The carve-out is deliberately narrow: it applies only when the step is neither `code-review` nor
    a `reviewKind: "code"` result AND recorded no fingerprint of its own. A content review that DID
    record one still gets compared, and a code review missing its fingerprint is still refused — the
    FN-180 guarantee it exists to protect is untouched.
    */
    const bindsContent = requiresExplicitVerdict || result.reviewInputFingerprint !== undefined;
    if (!bindsContent) return { workflowStepId, state: "approved" };
  }
  if (!descriptor) return { workflowStepId, state: "approved" };
  if (descriptor.kind === "singular") {
    if (descriptor.diff.state === "empty") return { workflowStepId, state: "approved" };
    if (descriptor.diff.state === "unavailable") return { workflowStepId, state: "unprovable-content" };
    return result?.reviewInputFingerprint === descriptor.diff.fingerprint
      ? { workflowStepId, state: "approved" }
      : { workflowStepId, state: result?.reviewInputFingerprint ? "stale-content" : "unprovable-content" };
  }
  if (task.repositoryScope?.state !== "confirmed" || descriptor.repositories.state === "unavailable") {
    return { workflowStepId, state: "unprovable-content" };
  }
  if (task.repositoryScope.reviewRemediation?.scopeRevision === task.repositoryScope.revision) {
    return { workflowStepId, state: "not-approved" };
  }
  if (result?.repositoryScopeRevision !== undefined && result.repositoryScopeRevision !== task.repositoryScope.revision) {
    return { workflowStepId, state: "stale-content" };
  }
  const missing: string[] = [];
  const stale: string[] = [];
  for (const repository of descriptor.repositories.inScopeModified) {
    const expected = descriptor.repositories.fingerprints[repository];
    const evidence = task.repositoryScope.reviewEvidence?.[repository];
    if (!evidence) missing.push(repository);
    else if (expected && evidence.fingerprint !== expected) stale.push(repository);
  }
  if (missing.length) return { workflowStepId, state: "missing", repositories: missing };
  if (stale.length) return { workflowStepId, state: "stale-content", repositories: stale };
  return { workflowStepId, state: "approved" };
}
