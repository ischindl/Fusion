import { getTaskHardMergeBlocker, type MergeResult, type Task, type TaskStore } from "@fusion/core";
import { createRunAuditor, generateSyntheticRunId, type DatabaseMutationType, type RunAuditor } from "./run-audit.js";

export function isInvalidDoneTransitionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Invalid transition:") && message.includes("→ 'done'");
}

export interface AutoMergeFinalizationResult {
  outcome: "done" | "already-done" | "blocked" | "missing";
  task: Task | null;
  previousColumn: string | null;
  reason?: string;
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
  options: { result?: MergeResult; checkWorkflowSteps?: boolean } = {},
): Promise<WorkflowDoneMergeProofVerdict> {
  const hasProof = hasDurableMergeProof(task, options.result);
  if (!hasProof) return { ok: false, reason: task.column === "done" ? "done-without-merge-confirmation" : "missing-merge-confirmation" };
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
  audit,
  auditAgentId,
  auditPhase,
  source,
  log,
}: FinalizeProvenAutoMergeTaskOptions): Promise<AutoMergeFinalizationResult> {
  const latest = await store.getTask(taskId).catch(() => null);
  if (!latest) {
    return { outcome: "missing", task: null, previousColumn: null, reason: "task-not-found" };
  }

  const validationMergeDetails = buildFinalizationMergeDetails(latest, result);
  /*
   * FNXC:WorkflowMerge 2026-06-29-10:35:
   * Workflow-owned completion requires current merge proof, not just a stale `mergeConfirmed` flag. A task cannot reach or remain accepted as `done` when workflow steps are still pending or a no-op claims landed files. Branch-only residue is ignored because squash landing validates the task patch, not branch-history cleanliness.
   */
  if (latest.column === "done") {
    const proofVerdict = await validateWorkflowDoneMergeProof({ ...latest, mergeDetails: validationMergeDetails } as Task, { result });
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
    if (result) result.task = latest;
    return { outcome: "already-done", task: latest, previousColumn: "done" };
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

  const hardBlocker = getTaskHardMergeBlocker({
    ...latest,
    /*
    FNXC:WorkflowMerge 2026-06-29-09:15:
    Proven merge finalization is a recovery path: durable `mergeConfirmed` means the branch already landed, even if a workflow graph crash left the card in `in-progress` or `todo`. Evaluate hard blockers as review-eligible so the column mismatch itself does not block the recovery rehome to `done`; real blockers such as paused/error/incomplete steps still apply.
    */
    column: "in-review",
    paused: false,
    status: latest.status === "merging" || latest.status === "merging-pr" || latest.status === "queued" ? undefined : latest.status,
    error: undefined,
  });
  if (hardBlocker) {
    await store.updateTask(taskId, {
      status: "failed",
      error: `Merge confirmed but finalization blocked: ${hardBlocker}`,
    }).catch(() => undefined);
    await recordFinalizationAudit({
      store,
      audit,
      task: latest,
      type: "task:auto-merge-finalize-column-mismatch-no-action",
      reason: hardBlocker,
      auditAgentId,
      auditPhase,
    });
    return { outcome: "blocked", task: latest, previousColumn: latest.column, reason: hardBlocker };
  }

  const proofVerdict = await validateWorkflowDoneMergeProof({ ...latest, mergeDetails } as Task, {
    result,
    checkWorkflowSteps: false,
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

  await store.updateTask(taskId, {
    paused: false,
    status: null,
    error: null,
    blockedBy: null,
    overlapBlockedBy: null,
    mergeRetries: 0,
    mergeDetails,
  } as unknown as Partial<Task>);

  const shouldRecoveryRehome = latest.column !== "in-review";
  if (shouldRecoveryRehome) {
    await log?.(
      `Auto-merge finalization repairing ${taskId}: authoritative row is ${latest.column}; clearing stale lifecycle blockers and moving to done`,
    );
  }

  try {
    const moved = await store.moveTask(taskId, "done", shouldRecoveryRehome
      ? { moveSource: "engine", recoveryRehome: true, preserveProgress: true }
      : { moveSource: "engine", preserveProgress: true });
    if (result) result.task = moved;
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
      await store.logEntry(
        taskId,
        `Auto-merge finalization repaired column mismatch: ${latest.column} → done after proven merge; cleared stale status/blockers`,
      ).catch(() => undefined);
    }
    const finalTask = moved ?? (await store.getTask(taskId).catch(() => null)) ?? latest;
    return { outcome: shouldRecoveryRehome ? "done" : "done", task: finalTask, previousColumn: latest.column };
  } catch (error) {
    if (isInvalidDoneTransitionError(error)) {
      const refreshed = await store.getTask(taskId).catch(() => null);
      if (refreshed?.column === "done") {
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
