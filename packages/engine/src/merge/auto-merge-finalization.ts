import {
  getPostMergeFinalizeBlocker,
  getRequiredPostMergeEvidenceBlocker,
  planConfirmedMergeChecklistReconciliation,
  resolveWorkflowIrForTask,
  resolveCompleteColumn,
  resolveMergeOrchestrationColumn,
  columnHasFlag,
  clearMergeConfirmedTransientStatus,
  type MergeResult,
  type Task,
  type TaskStore,
} from "@fusion/core";
import {
  isTerminalPostMergeReseedRefusal,
  reseedUnrunPostMergeGate,
  type PostMergeGateReseedReason,
} from "./post-merge-gate-reseed.js";
import { deliverMailboxMessageOnce } from "../notification/mailbox-delivery.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { createRunAuditor, generateSyntheticRunId, type DatabaseMutationType, type RunAuditor } from "../util/run-audit.js";
import { cleanupLandedTaskWorktree } from "./post-landing-worktree-cleanup.js";
import { DASHBOARD_USER_ID, type MessageStore } from "@fusion/core";
import type { MergeWriteFence } from "./merge-write-fence.js";
/*
FNXC:ZeroCommitDeliveryProof 2026-09-26-09:40 (RUFU-274):
This module is the shared finalize primitive every merge lane ends in, so it is the last place a
`mergeConfirmed` / no-op claim can be tested against git before a card becomes `done`. `hasDurableMergeProof`
below proves that a CLAIM is durable; it cannot prove the claim is TRUE — RUFU-262's card reached done with
a confirmed no-op claim while its deliverable sat uncommitted in the worktree. The landing-proof door is
therefore asked separately, and before any cleanup, because a cleanup would destroy the evidence it reads.
*/
import { enforceZeroCommitLandingProof } from "./zero-commit-finalization-guard.js";

/*
FNXC:WorkflowMergeFinalization 2026-07-19-07:20 (U7 / R2/R3/KTD-1):
Finalization moves a confirmed-merged card to the workflow's COMPLETE-trait column
(not the literal "done"), and treats the merge-orchestration column (not literal
"in-review") as the normal pre-complete review column. builtin:coding resolves to
`done` / `in-review` so the default pipeline is byte-identical; a custom workflow
(the benchmark) lands in its own `Done` / `Merging` columns. Resolution failure
falls back to the legacy literals so a bad IR never strands a proven-merged task.
*/
async function resolveFinalizationColumns(
  store: TaskStore,
  taskId: string,
): Promise<{ completeColumn: string; mergeColumn: string; isCompleteColumn: (columnId: string) => boolean }> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    return {
      completeColumn: resolveCompleteColumn(ir) ?? "done",
      mergeColumn: resolveMergeOrchestrationColumn(ir) ?? "in-review",
      isCompleteColumn: (columnId: string) => columnHasFlag(ir, columnId, "complete"),
    };
  } catch {
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-23:51 (DELIBERATE-LITERAL — the FAIL-SOFT arm of an
    already-converted resolver): the resolved path is the `try` above. This block runs only when the
    workflow IR cannot be read at all, and its whole job is to answer with the built-in vocabulary so
    finalization keeps working rather than throwing. Resolving here is impossible by construction —
    the resolver is what just failed — so this is not pending conversion work and is marked instead of
    being left to re-offer itself as available on every census.
    */
    return {
      completeColumn: "done",
      mergeColumn: "in-review",
      /* DELIBERATE-LITERAL — the degraded fallback arm; the live arm above calls `columnHasFlag`.
         Reached only when IR resolution throws, where the legacy id is the only answer left. */
      isCompleteColumn: (columnId: string) => columnId === "done",
    };
  }
}

/*
FNXC:WorkflowMergeFinalization 2026-07-19-09:40 (R2/R7b):
The transition-race classifier must match the workflow's resolved COMPLETE column,
not the literal "done". moveTask targets the resolved completeColumn, so a race
error for a custom complete column (e.g. the benchmark's "shipped") says
"→ 'shipped'"; hardcoding "→ 'done'" skipped the already-done recovery branch and
rethrew, stranding a proven-merged task. Default stays "done" for builtin:coding
and legacy fallbacks.
*/
export function isInvalidDoneTransitionError(error: unknown, targetColumn = "done"): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Invalid transition:") && message.includes(`→ '${targetColumn}'`);
}

export interface AutoMergeFinalizationResult {
  outcome: "done" | "already-done" | "blocked" | "missing";
  task: Task | null;
  previousColumn: string | null;
  reason?: string;
  /** True only for the graph-owned post-merge gate that must run before retrying finalization. */
  deferredPostMergeEvidence?: boolean;
}

export interface FinalizeProvenAutoMergeTaskOptions {
  store: TaskStore;
  taskId: string;
  result?: MergeResult;
  rootDir?: string;
  audit?: RunAuditor;
  auditAgentId?: string;
  auditPhase?: string;
  source: "direct-ai-merge" | "merge-confirmed-fast-path" | "self-healing" | "workflow-graph-merge-finalize";
  log?: (message: string) => void | Promise<void>;
  fence?: MergeWriteFence;
  /*
  FNXC:UnrunPostMergeGateRecovery 2026-09-28-07:34 (RUFU-370):
  Optional by design. The mailbox lives on `MessageStore`, which `TaskStore` does not expose, so a finalizer
  only hands off through the mailbox where the caller already holds one (self-healing, project-engine).
  Every other caller still gets the durable audit row, and `deliverMailboxMessageOnce` reports
  `unavailable` rather than failing finalization when no store is wired.
  */
  messageStore?: Pick<MessageStore, "sendMessageOnce"> | null;
}

export type WorkflowDoneMergeProofVerdict =
  | { ok: true }
  | { ok: false; reason: string; metadata?: Record<string, unknown> };

function mergeProofLandedFiles(task: Task, result?: MergeResult): string[] {
  const files = result?.landedFiles ?? task.mergeDetails?.landedFiles ?? [];
  return Array.from(new Set(files.map((file) => file.trim()).filter(Boolean)));
}

function hasIncompleteWorkflowSteps(task: Task): boolean {
  return (task.steps ?? []).some((step) => step.status !== "done" && step.status !== "skipped");
}

export async function validateWorkflowDoneMergeProof(
  task: Task,
  options: {
    result?: MergeResult;
    checkWorkflowSteps?: boolean;
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-23:20:
    The RESOLVED complete test, supplied by the caller. Omitted → the `done` literal, i.e. today's
    behaviour, which is the same default-to-legacy contract the lane-parameter vocabulary uses
    elsewhere. `resolveFinalizationColumns` in this file already builds exactly this predicate for
    its own guard; the two callers below now hand it down instead of re-asking with an id.
    */
    isCompleteColumn?: (columnId: string) => boolean;
  } = {},
): Promise<WorkflowDoneMergeProofVerdict> {
  const hasProof = hasDurableMergeProof(task, options.result);
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-23:25 (the deferral is now paid — see the note above):
  This literal selects which REASON STRING is reported, not which branch runs. Both arms return
  `{ ok: false }`, so on a renamed board a card sitting in the complete lane was refused with the
  generic `missing-merge-confirmation` instead of the specific `done-without-merge-confirmation`.

  The earlier note recorded this as "REAL but DIAGNOSTIC-ONLY" and declined it on the grounds that
  widening a signature to improve an error string is a poor trade. That undersold the consequence:
  this reason is not a log line. It is asserted as run-audit metadata alongside `previousColumn`
  (`merger-merge-lifecycle.test.ts`), so the audit trail — the record an operator reads to find out
  why a merge was refused — carried the wrong classification for every renamed board.

  The trade is also cheaper than it looked. This function is ALREADY async and ALREADY takes an
  options bag, and `resolveFinalizationColumns` two functions up ALREADY builds this exact predicate
  for its own guard. Nothing new is resolved; the answer that existed is handed down instead of
  being re-asked with an id — which is the half-conversion shape this program keeps finding, here
  within one file.
  */
  /* DELIBERATE-LITERAL: the fallback arm of the conversion described directly above — reached only
     when a caller passes no resolved predicate. The resolved path is `options.isCompleteColumn`. */
  const isCompleteLane = options.isCompleteColumn ? options.isCompleteColumn(task.column) : task.column === "done";
  if (!hasProof) return { ok: false, reason: isCompleteLane ? "done-without-merge-confirmation" : "missing-merge-confirmation" };
  if (options.checkWorkflowSteps !== false && hasIncompleteWorkflowSteps(task)) {
    return { ok: false, reason: "incomplete-workflow-steps" };
  }

  const noOp = options.result?.noOp === true || task.mergeDetails?.noOpMerge === true;
  const landedFiles = mergeProofLandedFiles(task, options.result);
  if (noOp && landedFiles.length > 0) {
    return { ok: false, reason: "noop-merge-with-landed-files", metadata: { landedFiles: landedFiles.length } };
  }
  /*
   * FNXC:AutoMergeFinalization 2026-07-01-10:22:
   * Finalization cares whether the task patch landed on the integration branch, not whether the task branch history is clean after squash merges. Historical task branches can retain patch-equivalent foreign commits whose SHAs are not ancestors of main; once durable merge proof exists, branch residue must not strand the task in review.
   */

  return { ok: true };
}

function buildMismatchMetadata(task: Task, reason: string): Record<string, unknown> {
  return {
    taskId: task.id,
    previousColumn: task.column,
    targetColumn: "done",
    commitSha: task.mergeDetails?.commitSha ?? null,
    status: task.status ?? null,
    blockedBy: task.blockedBy ?? null,
    overlapBlockedBy: task.overlapBlockedBy ?? null,
    reason,
  };
}

/**
 * FNXC:UnrunPostMergeGateRecovery 2026-09-28-07:34 (RUFU-370):
 * One operator-visible notice per (task, gate, refusal) per cooldown window. The key carries a time
 * bucket so repeats of the same refusal collapse to one mailbox row while a genuinely new refusal (or a
 * refusal still unaddressed after the window) announces again — the same discipline as RUFU-283's
 * `system:vanished-work:*` notice, chosen because this class has no wedge row to hang dedupe off. The
 * write goes through `deliverMailboxMessageOnce`, so a missing, throwing, or stalled mailbox store cannot
 * delay or change finalization: it returns `unavailable` and the deferral stands on its own.
 */
const POST_MERGE_GATE_NOTICE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * The blocker sentence plus the machine-readable terminal marker. The suffix is what lets the merge-retry
 * router and an operator tell "deferred, try again" from "this seam can never produce the evidence" —
 * RUFU-370's whole point is that the two used to be one indistinguishable warn line.
 */
export function unreachablePostMergeGateReason(
  evidenceBlocker: string,
  refusal: PostMergeGateReseedReason,
): string {
  return `${evidenceBlocker} [post-merge gate unreachable: ${refusal}]`;
}

export function unreachablePostMergeGateNoticeKey(
  taskId: string,
  gateId: string | undefined,
  refusal: PostMergeGateReseedReason,
  now: number,
): string {
  const bucket = Math.floor(now / POST_MERGE_GATE_NOTICE_COOLDOWN_MS);
  return `system:unrun-post-merge-gate:${taskId}:${gateId ?? "unknown"}:${refusal}:${bucket}`;
}

export async function notifyUnreachablePostMergeGate(args: {
  store: TaskStore;
  messageStore?: Pick<MessageStore, "sendMessageOnce"> | null;
  taskId: string;
  gateId?: string;
  refusal: PostMergeGateReseedReason;
  evidenceBlocker: string;
  /** Injectable clock so the cooldown bucket is testable without waiting for a window to roll. */
  now?: number;
  /** Bound on the optional mailbox write; forwarded to `deliverMailboxMessageOnce`. */
  timeoutMs?: number;
}): Promise<"delivered" | "unavailable"> {
  const now = args.now ?? Date.now();
  const sentence = `Auto-merge cannot finish ${args.taskId}: ${args.evidenceBlocker}, and the post-merge gate `
    + `cannot be re-seeded (${args.refusal}). The landed work is preserved — this card needs a human decision, `
    + `either an operator bypass of the gate or a workflow whose post-merge node can run.`;
  const notice = await deliverMailboxMessageOnce(
    args.messageStore ?? undefined,
    {
      fromId: "system",
      fromType: "system",
      toId: DASHBOARD_USER_ID,
      toType: "user",
      type: "system",
      content: sentence,
      metadata: {
        kind: "unreachable-post-merge-gate",
        taskId: args.taskId,
        workflowStepId: args.gateId ?? null,
        refusal: args.refusal,
      },
    },
    unreachablePostMergeGateNoticeKey(args.taskId, args.gateId, args.refusal, now),
    args.timeoutMs,
  );
  // Best-effort telemetry must never become a finalization dependency (FN-9175).
  await emitBoundedRunAudit(args.store, {
    taskId: args.taskId,
    agentId: "merger",
    runId: generateSyntheticRunId("auto-merge-finalize", args.taskId),
    domain: "database",
    mutationType: "task:auto-merge-finalize-post-merge-gate-unreachable" as DatabaseMutationType,
    target: args.taskId,
    metadata: {
      taskId: args.taskId,
      workflowStepId: args.gateId ?? null,
      refusal: args.refusal,
      notice,
    },
  });
  return notice;
}

async function recordFinalizationAudit(args: {
  store: TaskStore;
  audit?: RunAuditor;
  task: Task;
  type: DatabaseMutationType;
  reason: string;
  auditAgentId?: string;
  auditPhase?: string;
}): Promise<void> {
  try {
    const auditor = args.audit ?? createRunAuditor(args.store, {
      runId: generateSyntheticRunId("auto-merge-finalize", args.task.id),
      agentId: args.auditAgentId ?? "merger",
      taskId: args.task.id,
      taskLineageId: args.task.lineageId,
      phase: args.auditPhase ?? "auto-merge-finalize",
    });
    await auditor.database({
      type: args.type,
      target: args.task.id,
      metadata: buildMismatchMetadata(args.task, args.reason),
    });
  } catch {
    // Best effort: audit persistence must never strand a proven landed task.
  }
}

function buildFinalizationMergeDetails(task: Task, result?: MergeResult): NonNullable<Task["mergeDetails"]> {
  const mergedAt = task.mergeDetails?.mergedAt ?? new Date().toISOString();
  /*
   * FNXC:WorkflowMerge 2026-06-29-09:04:
   * Workflow graph merge finalization must never promote loose `merged:true` or `noOp:true` results into durable merge proof. A task can reach `done` only when the merger records `mergeConfirmed:true`; otherwise replay/recovery must block so the branch is merged instead of bypassed.
   */
  const mergeConfirmed =
    result?.mergeConfirmed === true || task.mergeDetails?.mergeConfirmed === true;
  return {
    ...(task.mergeDetails ?? {}),
    ...(result?.commitSha ? { commitSha: result.commitSha } : {}),
    ...(result?.rebaseBaseSha ? { rebaseBaseSha: result.rebaseBaseSha } : {}),
    ...(result?.landedFiles ? { landedFiles: result.landedFiles } : {}),
    ...(typeof result?.filesChanged === "number" ? { filesChanged: result.filesChanged } : {}),
    ...(typeof result?.insertions === "number" ? { insertions: result.insertions } : {}),
    ...(typeof result?.deletions === "number" ? { deletions: result.deletions } : {}),
    ...(result?.mergeCommitMessage ? { mergeCommitMessage: result.mergeCommitMessage } : {}),
    mergedAt,
    mergeConfirmed,
    ...(result?.noOp && mergeConfirmed ? { noOpMerge: true, noOpReason: result.reason } : {}),
  };
}

function hasDurableMergeProof(task: Task, result?: MergeResult): boolean {
  return task.mergeDetails?.mergeConfirmed === true || result?.mergeConfirmed === true;
}

/**
 * FNXC:AutoMergeLifecycle 2026-06-22-19:28:
 * Proven auto-merge completion must refresh the authoritative row before moving to done because the merge CAS and queue retry paths can leave a landed task in todo with stale queued/overlap state. Use TaskStore recovery rehome for those column mismatches so completion remains idempotent without direct database surgery.
 */
export async function finalizeProvenAutoMergeTask({
  store,
  taskId,
  result,
  rootDir,
  audit,
  auditAgentId,
  auditPhase,
  source,
  log,
  fence,
  messageStore,
}: FinalizeProvenAutoMergeTaskOptions): Promise<AutoMergeFinalizationResult> {
  const initialTask = await store.getTask(taskId).catch(() => null);
  if (!initialTask) {
    return { outcome: "missing", task: null, previousColumn: null, reason: "task-not-found" };
  }
  let latest: Task = initialTask;

  // U7: resolve the workflow's complete/merge columns once (byte-identical to
  // done/in-review for builtin:coding).
  const { completeColumn, mergeColumn, isCompleteColumn } = await resolveFinalizationColumns(store, taskId);

  /*
  FNXC:PostMergeRecovery 2026-09-30-04:56:
  A successful integration write is irreversible and its proof must become durable before an enabled
  post-merge gate can defer the terminal move. Previously the evidence check returned first, leaving
  merge confirmation only in the caller's in-memory MergeResult; a restart then saw no worktree and
  no proof, so self-healing could only surface and eventually pause the card as a deadlock. Persist
  only the merge evidence here—never completion or approval—so graph traversal can still produce the
  required gate result and restart recovery can distinguish landed work from an unmerged branch.
  */
  if (result?.mergeConfirmed === true && latest.mergeDetails?.mergeConfirmed !== true) {
    const persistProof = () => store.updateTaskAtomic(taskId, (current) => ({
      mergeDetails: buildFinalizationMergeDetails(current, result),
    }));
    const persisted = fence
      ? await fence.write("finalization", persistProof)
      : await persistProof();
    if (persisted) latest = persisted;
  }

  const evidenceBlocker = await getRequiredPostMergeEvidenceBlocker(store, latest);
  if (evidenceBlocker) {
    /*
    FNXC:UnrunPostMergeGateRecovery 2026-09-25-15:35 (RUFU-306):
    This is the loop production showed all day: `Auto-merge finalization deferred for DGXS-313 /
    ROZV-290: required post-merge evidence gate 'post-merge-verification' has not reported`, retried
    forever, deferring forever, because nothing ever put the card back in front of that node. The
    deferral now tries the seed itself, so the next finalize pass can find real evidence instead of
    the same absence. A refused seed is reported by reason (budget, active continuation, operator
    hold) rather than as an unexplained deferral, and the blocker still stands — seeding is not a
    verdict, and this path never completes a card on its own authority.
    */
    const reseed = await reseedUnrunPostMergeGate(store, latest, { source: "auto-merge" });
    /*
    FNXC:UnrunPostMergeGateRecovery 2026-09-28-07:34 (RUFU-370):
    A terminal reseed refusal is not a transient deferral, and treating it as one is what made the pair
    dominate production warn output: SANE-452 (`reseed: workspace`, refused by this seam by construction)
    and STAS-288 (`reseed: active-continuation`) were re-announced seconds apart forever, with no
    operator-visible artifact and no named terminal state. For a refusal that cannot ever produce
    evidence, finalization now (a) hands the card to the operator once through the idempotent mailbox
    upsert, (b) writes one bounded audit row per (task, gate, refusal), and (c) returns a reason the
    merge-retry router can classify instead of a sentence it will re-log. Lifecycle stays untouched —
    no backward move, no verdict, and the card keeps the column it stands in.
    */
    if (!reseed.seeded && isTerminalPostMergeReseedRefusal(reseed.reason)) {
      const notice = await notifyUnreachablePostMergeGate({
        store,
        messageStore,
        taskId,
        gateId: reseed.workflowStepId,
        refusal: reseed.reason,
        evidenceBlocker,
      });
      await log?.(`Auto-merge finalization deferred for ${taskId}: ${evidenceBlocker}`
        + ` [post-merge gate reseed: ${reseed.reason}; operator handoff: ${notice}]`);
      return {
        outcome: "blocked",
        task: latest,
        previousColumn: latest.column,
        reason: unreachablePostMergeGateReason(evidenceBlocker, reseed.reason),
      };
    }
    await recordFinalizationAudit({
      store,
      audit,
      task: latest,
      type: "task:auto-merge-finalize-column-mismatch-no-action",
      reason: evidenceBlocker,
      auditAgentId,
      auditPhase,
    });
    await log?.(`Auto-merge finalization deferred for ${taskId}: ${evidenceBlocker}`
      + ` [post-merge gate reseed: ${reseed.seeded ? `seeded '${reseed.workflowStepId}'` : reseed.reason}]`);
    return {
      outcome: "blocked",
      task: latest,
      previousColumn: latest.column,
      reason: evidenceBlocker,
      /*
      FNXC:PostMergeEvidenceOrdering 2026-09-25-20:05:
      Only an absent result can be claimed by the active graph traversal. A pending or terminal
      non-approval is durable evidence that must remain a blocker, not a retry signal.
      */
      deferredPostMergeEvidence: evidenceBlocker.includes("has not reported") || undefined,
    };
  }

  const validationMergeDetails = buildFinalizationMergeDetails(latest, result);
  const cleanupLandedWorktree = async (task: Task, mergeDetails: NonNullable<Task["mergeDetails"]>): Promise<void> => {
    if (!rootDir) return;
    await cleanupLandedTaskWorktree({
      store,
      taskId,
      worktreePath: task.worktree,
      rootDir,
      landedSha: mergeDetails.commitSha ?? result?.commitSha,
      // RUFU-274 Step 5: the row is passed so cleanup can see a durable delivery-unproven hold.
      task,
      source,
      audit,
      log: async (message) => {
        if (fence) {
          await fence.write("log", () => store.logEntry(taskId, message).catch(() => undefined));
        } else {
          await store.logEntry(taskId, message).catch(() => undefined);
        }
        await log?.(message);
      },
      fence,
    });
  };
  /*
   * FNXC:WorkflowMerge 2026-06-29-10:35:
   * Workflow-owned completion requires current merge proof, not just a stale `mergeConfirmed` flag. A task cannot reach or remain accepted as `done` when workflow steps are still pending or a no-op claims landed files. Branch-only residue is ignored because squash landing validates the task patch, not branch-history cleanliness.
   */
  if (isCompleteColumn(latest.column)) {
    const proofVerdict = await validateWorkflowDoneMergeProof({ ...latest, mergeDetails: validationMergeDetails } as Task, { result, isCompleteColumn });
    if (!proofVerdict.ok) {
      await recordFinalizationAudit({
        store,
        audit,
        task: latest,
        type: "task:auto-merge-finalize-column-mismatch-no-action",
        reason: proofVerdict.reason,
        auditAgentId,
        auditPhase,
      });
      await log?.(`Auto-merge finalization blocked for ${taskId}: ${proofVerdict.reason}`);
      return { outcome: "blocked", task: latest, previousColumn: latest.column, reason: proofVerdict.reason };
    }
    /*
    FNXC:WorkflowMergeFinalization 2026-08-29-01:06:
    This is convergence, not the ordering gate: a task that reached complete before FN-251 still
    receives proof-gated cleanup when the finalizer sees its durable landing again. No root directory
    means there is no trustworthy cleanup boundary, so preserve the historical no-op finalization.
    */
    await cleanupLandedWorktree(latest, validationMergeDetails);
    const converged = await store.getTask(taskId).catch(() => latest);
    if (result) result.task = converged;
    return { outcome: "already-done", task: converged, previousColumn: latest.column };
  }

  const mergeDetails = validationMergeDetails;
  const hasProof = hasDurableMergeProof({ ...latest, mergeDetails } as Task, result);
  if (!hasProof) {
    const reason = "missing-merge-confirmation";
    await recordFinalizationAudit({
      store,
      audit,
      task: latest,
      type: "task:auto-merge-finalize-column-mismatch-no-action",
      reason,
      auditAgentId,
      auditPhase,
    });
    return { outcome: "blocked", task: latest, previousColumn: latest.column, reason };
  }

  /*
  FNXC:ZeroCommitDeliveryProof 2026-09-26-09:45 (RUFU-274):
  The delivery-proof door on the shared finalize primitive. It runs only when both facts needed to probe are
  on the row: a repository root, and the integration branch the landing claims to have reached. Without
  either there is nothing to corroborate against, and inventing a ref (or trusting a `mergeConfirmed` flag
  to substitute for a probe) is the failure mode this door exists to remove — so the historical behaviour
  stands for those cards. A `held` refusal has already written its durable hold, row sentence, and bounded
  audit row inside the guard; here the only job is to stop — before cleanup and before the complete-column
  move — and to report a deferral, the same non-burning `blocked` class `missing-merge-confirmation` uses.
  A `retry` is the opposite case: the probe could not see the content, which is not evidence that work is at
  risk, so finalizing proceeds on today's rules rather than wedging a card over an unreadable checkout. The
  guard's own deferred row records that abstention, and this lane adds no audit event of its own: the
  refusal's forensic record and its fixed reason codes belong to the one writer.
  */
  const landingProofBranch = mergeDetails.mergeTargetBranch;
  if (rootDir && landingProofBranch) {
    const landingProof = await enforceZeroCommitLandingProof({
      store,
      task: latest,
      repoDir: rootDir,
      integrationBranch: landingProofBranch,
      source: "finalize-proven-auto-merge",
      fence,
    });
    if (landingProof.disposition === "held") {
      const reason = landingProof.refusal;
      await log?.(`Auto-merge finalization refused for ${taskId}: ${reason}`);
      return { outcome: "blocked", task: latest, previousColumn: latest.column, reason };
    }
    if (landingProof.disposition === "retry") {
      await log?.(`Auto-merge finalization proceeding without a zero-commit delivery probe for ${taskId}: ${landingProof.reason}`);
    }
  }

  /*
  FNXC:ConfirmedMergeFinalization 2026-08-23-07:25:
  FN-180 forbids re-running the pre-merge checklist after durable merge proof.
  A concurrent review bounce can leave that checklist stale, so reconcile it
  before moving to complete; only an independent status may still defer.
  */
  const postMergeBlocker = getPostMergeFinalizeBlocker({
    status: clearMergeConfirmedTransientStatus(latest.status),
    error: undefined,
  });
  if (postMergeBlocker) {
    await recordFinalizationAudit({
      store,
      audit,
      task: latest,
      type: "task:auto-merge-finalize-column-mismatch-no-action",
      reason: postMergeBlocker,
      auditAgentId,
      auditPhase,
    });
    return { outcome: "blocked", task: latest, previousColumn: latest.column, reason: postMergeBlocker };
  }
  const proofVerdict = await validateWorkflowDoneMergeProof({ ...latest, mergeDetails } as Task, {
    result,
    checkWorkflowSteps: false,
    isCompleteColumn,
  });
  if (!proofVerdict.ok) {
    await recordFinalizationAudit({
      store,
      audit,
      task: latest,
      type: "task:auto-merge-finalize-column-mismatch-no-action",
      reason: proofVerdict.reason,
      auditAgentId,
      auditPhase,
    });
    await log?.(`Auto-merge finalization blocked for ${taskId}: ${proofVerdict.reason}`);
    return { outcome: "blocked", task: latest, previousColumn: latest.column, reason: proofVerdict.reason };
  }

  const shouldRecoveryRehome = latest.column !== mergeColumn;
  if (shouldRecoveryRehome) {
    await log?.(
      `Auto-merge finalization repairing ${taskId}: authoritative row is ${latest.column}; clearing stale lifecycle blockers and moving to ${completeColumn}`,
    );
  }

  /*
  FNXC:WorkflowMergeFinalization 2026-08-29-01:06:
  For a proven single-repository landing, resolve cleanup before the complete-column move. Preserved
  deliverable, unverifiable, and active-session outcomes are logged but never reclassify a durable
  landing as a merge failure, because blocking this transition would permanently wedge the card.
  */
  await cleanupLandedWorktree(latest, mergeDetails);

  try {
    fence?.assertOwned("finalization");
    /*
    FNXC:AutoMergeMoveAttribution 2026-08-29-07:37:
    Proven merge finalization advances review to the complete lane. Use a dedicated neutral
    provenance instead of workflow-graph, workflow-remediation, or plan-approval: those literals
    carry in-review-entry and reopen semantics. The value is also forwarded to plugin move policies.
    */
    /*
    FNXC:PostMergeEvidenceFence 2026-09-23-08:10:
    Post-merge approval is mutable graph state, so the optimistic evidence read above cannot
    authorize a later terminal move. Re-read it under moveTaskIf's task-row fence: a superseded
    result refuses this move instead of allowing a done card without durable evidence.
    */
    let finalizationBlocker: string | undefined;
    const move = await store.moveTaskIf(taskId, completeColumn, async (live) => {
      const liveMergeDetails = buildFinalizationMergeDetails(live, result);
      if (!hasDurableMergeProof({ ...live, mergeDetails: liveMergeDetails } as Task, result)) {
        finalizationBlocker = "missing-merge-confirmation";
        return false;
      }
      finalizationBlocker = await getRequiredPostMergeEvidenceBlocker(store, live);
      if (finalizationBlocker) return false;
      finalizationBlocker = getPostMergeFinalizeBlocker({
        status: clearMergeConfirmedTransientStatus(live.status),
        error: undefined,
      });
      if (finalizationBlocker) return false;
      const liveProofVerdict = await validateWorkflowDoneMergeProof({ ...live, mergeDetails: liveMergeDetails } as Task, {
        result,
        checkWorkflowSteps: false,
        isCompleteColumn,
      });
      if (!liveProofVerdict.ok) {
        finalizationBlocker = liveProofVerdict.reason;
        return false;
      }
      return true;
    }, shouldRecoveryRehome
      ? { moveSource: "engine", workflowMoveSource: "auto-merge-finalization", recoveryRehome: true, preserveProgress: true }
      : { moveSource: "engine", workflowMoveSource: "auto-merge-finalization", preserveProgress: true });
    if (!move.moved) {
      const currentBlocker = finalizationBlocker
        ?? await getRequiredPostMergeEvidenceBlocker(store, move.task)
        ?? "finalization-fence-refused";
      await recordFinalizationAudit({
        store,
        audit,
        task: move.task,
        type: "task:auto-merge-finalize-column-mismatch-no-action",
        reason: currentBlocker,
        auditAgentId,
        auditPhase,
      });
      return { outcome: "blocked", task: move.task, previousColumn: latest.column, reason: currentBlocker };
    }
    const finalized = await store.updateTaskAtomic(taskId, (current) => {
      const reconciliation = planConfirmedMergeChecklistReconciliation(current);
      return {
        paused: false,
        status: null,
        error: null,
        blockedBy: null,
        overlapBlockedBy: null,
        mergeRetries: 0,
        mergeDetails: buildFinalizationMergeDetails(current, result),
        steps: current.steps.map((step, index) =>
          reconciliation.skippedStepIndexes.includes(index) ? { ...step, status: "skipped" as const } : step,
        ),
        workflowStepResults: (current.workflowStepResults ?? []).map((entry) =>
          reconciliation.reconciledWorkflowStepIds.includes(entry.workflowStepId)
            ? { ...entry, status: "skipped" as const }
            : entry,
        ),
      } as Pick<Task, "steps" | "workflowStepResults">;
    });
    if (result) result.task = finalized;
    if (shouldRecoveryRehome) {
      await recordFinalizationAudit({
        store,
        audit,
        task: latest,
        type: "task:auto-merge-finalize-column-mismatch-reconciled",
        reason: `${source}:recovery-rehome`,
        auditAgentId,
        auditPhase,
      });
      fence?.assertOwned("finalization");
      await store.logEntry(
        taskId,
        `Auto-merge finalization repaired column mismatch: ${latest.column} → ${completeColumn} after proven merge; cleared stale status/blockers`,
      ).catch(() => undefined);
    }
    const finalTask = finalized;
    return { outcome: shouldRecoveryRehome ? "done" : "done", task: finalTask, previousColumn: latest.column };
  } catch (error) {
    if (isInvalidDoneTransitionError(error, completeColumn)) {
      const refreshed = await store.getTask(taskId).catch(() => null);
      if (refreshed && isCompleteColumn(refreshed.column)) {
        if (result) result.task = refreshed;
        return { outcome: "already-done", task: refreshed, previousColumn: latest.column };
      }
      if (refreshed) {
        await recordFinalizationAudit({
          store,
          audit,
          task: refreshed,
          type: "task:auto-merge-finalize-column-mismatch-no-action",
          reason: `invalid-done-transition:${refreshed.column}`,
          auditAgentId,
          auditPhase,
        });
      }
    }
    throw error;
  }
}
