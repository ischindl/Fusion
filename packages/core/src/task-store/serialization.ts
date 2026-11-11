/**
 * Row <-> domain-object serialization for TaskStore satellite tables.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. These functions are leaf-level converters
 * with no `this` dependencies; store.ts delegates to them verbatim.
 * Every signature and every JSON-parse/default rule is byte-identical to
 * the pre-extraction class-body implementation.
 */
import type {
  AgentLogEntry,
  ArchivedTaskEntry,
  ArchiveAgentLogMode,
  Artifact,
  Column,
  GoalCitation,
  PrInfo,
  SourceType,
  Task,
  TaskAttachment,
} from "../types.js";
import { taskDocumentContentHash } from "../task-document-concurrency.js";
import type {
  ArtifactRow,
  BranchGroupRow,
  GoalCitationRow,
  TaskDocumentRevisionRow,
  TaskDocumentRow,
} from "./row-types.js";
import type { TaskRow } from "./persistence.js";
import { fromJson } from "../db/db.js";
import { generateTaskLineageId } from "../tasks/task-lineage.js";
import { normalizeTaskQueueBoost } from "../tasks/task-queue-order.js";
import { pickArchiveRestorableTaskFields } from "./archive-restoration-contract.js";
import { normalizeTaskReviewState } from "./review-state.js";
import {
  parseTaskBranchContextFromSourceMetadata,
  withTaskBranchContextInSourceMetadata,
} from "./branch-context.js";

const ARCHIVE_AGENT_LOG_SNAPSHOT_LIMIT = 25;
const ARCHIVE_AGENT_LOG_SNIPPET_LIMIT = 160;

/**
 * Normalize a PostgreSQL-shaped task row into the `TaskRow` shape `rowToTask()` consumes.
 *
 * PostgreSQL jsonb columns arrive already-parsed (VAL-SCHEMA-004); SQLite stores them as TEXT.
 *
 * FNXC:RowHydrationCost 2026-11-10-02:50 (RUFU-1046): this function no longer re-serializes jsonb.
 * It used to `JSON.stringify` every jsonb column of every row so `rowToTask`'s `fromJson()` could
 * parse it straight back, i.e. a serialize/parse round trip paid on every row of every board poll.
 * The measured shape: 135,6 us/row of hydration total, 70,1 us/row (51,7 %) of it in this function
 * alone, on a board hydrated ~11x/second (`FUSION_ROW_HYDRATION_BENCH=1`, median of 7 passes over
 * 400 realistic 24 kB rows). A CPU profile taken on production attributes 15,5 % of the main thread
 * to the collector and 7,4 % to this function, both under `listTasksImpl`.
 * `fromJson()` now accepts an already-parsed value, so the value reaches its output field directly.
 * The SQLite text branch is untouched, and `row-hydration-cost.test.ts` pins that both shapes still
 * hydrate to the same object with a byte-identical golden digest.
 *
 * Reversibility on the hot path, same reason the ceilings in the watchdog are env-flagged: restart
 * with `FUSION_JSONB_READ_PASSTHROUGH=0` to restore the round trip without rebuilding.
 */
let jsonbReadPassthrough = readJsonbReadPassthrough();

function readJsonbReadPassthrough(): boolean {
  const raw = process.env.FUSION_JSONB_READ_PASSTHROUGH;
  // Anything but an explicit 0/false/off keeps the fast path; an unset variable is the default.
  return raw === undefined || !/^(0|false|off)$/i.test(raw.trim());
}

/** Test seam only; production never calls this. Passing false restores the stringify round trip. */
export function setJsonbReadPassthroughForTests(enabled: boolean): void {
  jsonbReadPassthrough = enabled;
}

export function pgRowToTaskRow<T extends TaskRow>(
  row: Record<string, unknown>,
  pgJsonbTaskColumns: ReadonlySet<string> | readonly string[],
): T {
  // The copy stays: callers mutate the returned row (`preserveDurableTaskWedgeInvariants` writes
  // through it), and one shallow copy per row is what separates that from the driver's own result.
  const result: Record<string, unknown> = { ...row };
  if (jsonbReadPassthrough) return result as unknown as T;
  for (const column of pgJsonbTaskColumns) {
    if (result[column] !== undefined && result[column] !== null && typeof result[column] !== "string") {
      result[column] = JSON.stringify(result[column]);
    }
  }
  return result as unknown as T;
}

export function rowToTask(row: TaskRow): Task {
  /*
  FNXC:RowHydrationCost 2026-11-08-01:38 (RUFU-871):
  `sourceMetadata` and `prInfo` were each deserialized TWICE per row — once for their own
  field and once again by the `branchContext` / `prInfos` readers. A CPU profile taken during
  a 155 s event-loop stall attributed ~25 % of samples to row hydration under the list read
  (`pgRowToTaskRow` 4 295 + `rowToTask` 3 917 of 33 289 samples), and this file's own
  measurement (`FUSION_ROW_HYDRATION_BENCH=1`, median of 7 passes over 400 realistic rows)
  puts full hydration at 229.6 us/row for a ~24 kB row, of which JSON re-parse of the jsonb
  columns is the single largest group. Parsing one column into two local bindings is the same
  value with one fewer parse; the board reads every row on every poll, so the removed parse is
  removed from every row. Behavior is unchanged at the field level — the same parsed value
  simply reaches both output fields.
  */
  const sourceMetadataValue = fromJson<Record<string, unknown>>(row.sourceMetadata) ?? undefined;
  const branchContext = parseTaskBranchContextFromSourceMetadata(sourceMetadataValue);
  const prInfoValue = fromJson<PrInfo>(row.prInfo);
  return {
    id: row.id,
    lineageId: row.lineageId || generateTaskLineageId(),
    title: row.title || undefined,
    description: row.description,
    queueBoost: normalizeTaskQueueBoost(row.queueBoost) ?? undefined,
    column: row.column as Column,
    status: row.status || undefined,
    size: (row.size || undefined) as Task["size"],
    reviewLevel: row.reviewLevel ?? undefined,
    currentStep: row.currentStep || 0,
    worktree: row.worktree || undefined,
    blockedBy: row.blockedBy || undefined,
    overlapBlockedBy: row.overlapBlockedBy || undefined,
    /*
    FNXC:FileScopeRecovery 2026-10-12-16:07:
    A safe overlap release must survive PostgreSQL hydration; otherwise a restart
    silently recreates the speculative claim that Clear already proved safe.
    */
    fileScopeLeaseRelease: fromJson<Task["fileScopeLeaseRelease"]>(row.fileScopeLeaseRelease) ?? undefined,
    queuedLogEpisodeSignature: row.queuedLogEpisodeSignature || undefined,
    paused: row.paused ? true : undefined,
    pausedReason: row.pausedReason || undefined,
    externalBlock: fromJson<Task["externalBlock"]>(row.externalBlock) ?? undefined,
    planningFailure: fromJson<Task["planningFailure"]>(row.planningFailure) ?? undefined,
    humanPlanApproval: fromJson<Task["humanPlanApproval"]>(row.humanPlanApproval) ?? undefined,
    /* FNXC:HumanMergeApproval 2026-09-17-18:09: FN-514 — a legacy NULL row deserializes to undefined, which every predicate reads as "not armed". */
    humanMergeApproval: fromJson<Task["humanMergeApproval"]>(row.humanMergeApproval) ?? undefined,
    wedgeNotification: fromJson<Task["wedgeNotification"]>(row.wedgeNotification) ?? undefined,
    userPaused: row.userPaused ? true : undefined,
    baseBranch: row.baseBranch || undefined,
    executionStartBranch: row.executionStartBranch || undefined,
    branch: row.branch || undefined,
    autoMerge: row.autoMerge === null ? undefined : row.autoMerge === 1,
    autoMergeProvenance: row.autoMergeProvenance === "user" || row.autoMergeProvenance === "mission" || row.autoMergeProvenance === "legacy-stamp"
      ? row.autoMergeProvenance
      : undefined,
    baseCommitSha: row.baseCommitSha || undefined,
    scopeOverride: row.scopeOverride ? true : undefined,
    scopeOverrideReason: row.scopeOverrideReason || undefined,
    scopeAutoWiden: fromJson<string[]>(row.scopeAutoWiden) ?? [],
    modelPresetId: row.modelPresetId || undefined,
    modelProvider: row.modelProvider || undefined,
    // FNXC:CredentialInstanceSelection 2026-08-01-05:53: database NULL means omitted,
    // not an own `undefined` key, so legacy task reads stay byte-identical in this inert slice.
    ...(row.credentialInstanceId ? { credentialInstanceId: row.credentialInstanceId } : {}),
    modelId: row.modelId || undefined,
    validatorModelProvider: row.validatorModelProvider || undefined,
    ...(row.validatorCredentialInstanceId ? { validatorCredentialInstanceId: row.validatorCredentialInstanceId } : {}),
    validatorModelId: row.validatorModelId || undefined,
    planningModelProvider: row.planningModelProvider || undefined,
    ...(row.planningCredentialInstanceId ? { planningCredentialInstanceId: row.planningCredentialInstanceId } : {}),
    planningModelId: row.planningModelId || undefined,
    mergerModelProvider: row.mergerModelProvider || undefined,
    ...(row.mergerCredentialInstanceId ? { mergerCredentialInstanceId: row.mergerCredentialInstanceId } : {}),
    mergerModelId: row.mergerModelId || undefined,
    mergeRetries: row.mergeRetries ?? undefined,
    aiMergeReviewReconciliation: fromJson<Task["aiMergeReviewReconciliation"]>(row.aiMergeReviewReconciliation) ?? undefined,
    workflowStepRetries: row.workflowStepRetries ?? undefined,
    stuckKillCount: row.stuckKillCount ?? undefined,
    resumeLimboCount: row.resumeLimboCount ?? undefined,
    graphResumeRetryCount: row.graphResumeRetryCount ?? undefined,
    consecutiveToolFailureRetryCount: row.consecutiveToolFailureRetryCount ?? undefined,
    executorEscalationAttempted: row.executorEscalationAttempted ? true : undefined,
    toolFailureDetectorLogCursor: row.toolFailureDetectorLogCursor ?? undefined,
    toolFailureRetryExhaustedAuditEmitted: row.toolFailureRetryExhaustedAuditEmitted ? true : undefined,
    resumeLimboTipSha: row.resumeLimboTipSha || undefined,
    resumeLimboStepSignature: row.resumeLimboStepSignature || undefined,
    executeRequeueLoopCount: row.executeRequeueLoopCount ?? undefined,
    executeRequeueLoopSignature: row.executeRequeueLoopSignature || undefined,
    postReviewFixCount: row.postReviewFixCount ?? undefined,
    planReviewReplanCount: row.planReviewReplanCount ?? undefined,
    recoveryRetryCount: row.recoveryRetryCount ?? undefined,
    recoveryDisposition: (row.recoveryDisposition || undefined) as Task["recoveryDisposition"],
    sessionContentionHoldCount: row.sessionContentionHoldCount ?? undefined,
    sessionContentionWaitReason: row.sessionContentionWaitReason ?? undefined,
    taskDoneRetryCount: row.taskDoneRetryCount ?? undefined,
    // FNXC:Lifecycle 2026-07-16-21:40: FN-8141 skip-bypass taint marker; empty/null → undefined (no taint).
    bulkCompletionRefusalAt: row.bulkCompletionRefusalAt || undefined,
    // FNXC:WorkflowIrPin 2026-07-19-03:10: U9b/KTD-3 — hydrate the durable pin; empty/null → undefined (unpinned).
    workflowIrPin: row.workflowIrPin || undefined,
    workflowIrPinNodeId: row.workflowIrPinNodeId || undefined,
    workflowIrPinColumnId: row.workflowIrPinColumnId || undefined,
    // FNXC:LegacyAdoption 2026-07-19-03:10: U9b/KTD-8 — empty/null → undefined (never adopted).
    legacyAdoptedAt: row.legacyAdoptedAt || undefined,
    worktreeSessionRetryCount: row.worktreeSessionRetryCount ?? undefined,
    completionHandoffLimboRecoveryCount: row.completionHandoffLimboRecoveryCount ?? undefined,
    verificationFailureCount: row.verificationFailureCount ?? undefined,
    mergeConflictBounceCount: row.mergeConflictBounceCount ?? undefined,
    mergeAuditBounceCount: row.mergeAuditBounceCount ?? undefined,
    mergeTransientRetryCount: row.mergeTransientRetryCount ?? undefined,
    branchConflictRecoveryCount: row.branchConflictRecoveryCount ?? undefined,
    reviewerContextRetryCount: row.reviewerContextRetryCount ?? undefined,
    reviewerFallbackRetryCount: row.reviewerFallbackRetryCount ?? undefined,
    reviewConvergenceStage: row.reviewConvergenceStage ?? undefined,
    reviewConvergenceEscalationCount: row.reviewConvergenceEscalationCount ?? undefined,
    nextRecoveryAt: row.nextRecoveryAt || undefined,
    error: row.error || undefined,
    summary: row.summary || undefined,
    recommendations: fromJson<Task["recommendations"]>(row.recommendations) ?? undefined,
    thinkingLevel: (row.thinkingLevel || undefined) as Task["thinkingLevel"],
    validatorThinkingLevel: (row.validatorThinkingLevel || undefined) as Task["validatorThinkingLevel"],
    planningThinkingLevel: (row.planningThinkingLevel || undefined) as Task["planningThinkingLevel"],
    mergerThinkingLevel: (row.mergerThinkingLevel || undefined) as Task["mergerThinkingLevel"],
    executionMode: (row.executionMode || undefined) as Task["executionMode"],
    // FNXC:PlannerOversight 2026-07-14-18:11: null → undefined (inherit); 0/1 → boolean.
    sessionAdvisorEnabled: row.sessionAdvisorEnabled === null || row.sessionAdvisorEnabled === undefined
      ? undefined
      : row.sessionAdvisorEnabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    columnMovedAt: row.columnMovedAt || undefined,
    firstExecutionAt: row.firstExecutionAt || undefined,
    cumulativeActiveMs: row.cumulativeActiveMs ?? undefined,
    cumulativePlanningMs: row.cumulativePlanningMs ?? undefined,
    planningStartedAt: row.planningStartedAt || undefined,
    cumulativePausedMs: row.cumulativePausedMs ?? undefined,
    pausedStartedAt: row.pausedStartedAt || undefined,
    columnDwellMs: fromJson<Record<string, number>>(row.columnDwellMs) ?? undefined,
    workflowTransitionNotification: fromJson<import("../types.js").WorkflowTransitionNotificationMarker>(row.workflowTransitionNotification) ?? undefined,
    plannerOversightLevel: (row.plannerOversightLevel || undefined) as Task["plannerOversightLevel"],
    awaitingApprovalReason: (row.awaitingApprovalReason || undefined) as Task["awaitingApprovalReason"],
    approvedPlanFingerprint: row.approvedPlanFingerprint || undefined,
    executionStartedAt: row.executionStartedAt || undefined,
    executionCompletedAt: row.executionCompletedAt || undefined,
    dependencies: fromJson<string[]>(row.dependencies) || [],
    steps: fromJson<import("../types.js").TaskStep[]>(row.steps) || [],
    stepReports: (() => { const reports = fromJson<import("../types.js").TaskStepReport[]>(row.stepReports); return reports && reports.length > 0 ? reports : undefined; })(),
    customFields: fromJson<Record<string, unknown>>(row.customFields) ?? undefined,
    log: fromJson<import("../types.js").TaskLogEntry[]>(row.log) || [],
    tokenBudgetSoftAlertedAt: row.tokenBudgetSoftAlertedAt || undefined,
    tokenBudgetHardAlertedAt: row.tokenBudgetHardAlertedAt || undefined,
    tokenBudgetOverride: fromJson<import("../types.js").TaskTokenBudgetOverride>(row.tokenBudgetOverride) ?? undefined,
    tokenUsage: (() => {
      if (
        row.tokenUsageInputTokens === null
        || row.tokenUsageOutputTokens === null
        || row.tokenUsageCachedTokens === null
        || row.tokenUsageTotalTokens === null
      ) {
        return undefined;
      }

      /*
      FNXC:TaskCardCostBadge 2026-07-19-08:55:
      Legacy task rows can have NULL usage timestamps and cache-write totals even when their
      positive token totals are durable. Board list requests use this reconstruction before
      TaskCard derives its opt-in spend badge, so timestamp metadata must not erase valid usage.
      Fall back to the task timestamp only to retain the non-null usage contract; cost derivation
      reads token totals and model identity, never these fallback timestamps.
      */
      const firstUsedAt = row.tokenUsageFirstUsedAt ?? row.tokenUsageLastUsedAt ?? row.createdAt;
      const lastUsedAt = row.tokenUsageLastUsedAt ?? row.tokenUsageFirstUsedAt ?? row.createdAt;
      return {
        inputTokens: row.tokenUsageInputTokens,
        outputTokens: row.tokenUsageOutputTokens,
        cachedTokens: row.tokenUsageCachedTokens,
        cacheWriteTokens: row.tokenUsageCacheWriteTokens ?? 0,
        totalTokens: row.tokenUsageTotalTokens,
        firstUsedAt,
        lastUsedAt,
        modelProvider: row.tokenUsageModelProvider ?? undefined,
        modelId: row.tokenUsageModelId ?? undefined,
        perModel: fromJson<import("../types.js").TaskTokenUsagePerModel[]>(row.tokenUsagePerModel) ?? undefined,
      };
    })(),
    attachments: (() => { const a = fromJson<TaskAttachment[]>(row.attachments); return a && a.length > 0 ? a : undefined; })(),
    steeringComments: (() => {
      const sc = fromJson<import("../types.js").SteeringComment[]>(row.steeringComments);
      return sc && sc.length > 0 ? sc : undefined;
    })(),
    comments: (() => {
      // Comments column already contains steering comments (addSteeringComment calls addComment).
      // Do NOT merge steeringComments here — that caused duplication on every read-write cycle.
      const c = fromJson<import("../types.js").TaskComment[]>(row.comments) || [];
      // Deduplicate by id to recover from prior corruption
      const seen = new Set<string>();
      const deduped = c.filter(entry => {
        if (seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      });
      return deduped.length > 0 ? deduped : undefined;
    })(),
    review: fromJson<import("../types.js").TaskReview>(row.review) ?? undefined,
    reviewState: normalizeTaskReviewState(fromJson<import("../types.js").TaskReviewState>(row.reviewState) ?? undefined),
    workflowStepResults: (() => { const w = fromJson<import("../types.js").WorkflowStepResult[]>(row.workflowStepResults); return w && w.length > 0 ? w : undefined; })(),
    prInfo: prInfoValue,
    prInfos: (() => {
      const multi = fromJson<PrInfo[]>(row.prInfos);
      if (multi && multi.length > 0) return multi;
      return prInfoValue ? [prInfoValue] : undefined;
    })(),
    issueInfo: fromJson<import("../types.js").IssueInfo>(row.issueInfo),
    githubTracking: fromJson<import("../types.js").TaskGithubTracking>(row.githubTracking) ?? undefined,
    gitlabTracking: fromJson<import("../types.js").TaskGitLabTracking>(row.gitlabTracking) ?? undefined,
    sourceIssue: (() => {
      if (
        row.sourceIssueProvider === null
        || row.sourceIssueRepository === null
        || row.sourceIssueExternalIssueId === null
        || row.sourceIssueNumber === null
      ) {
        return undefined;
      }

      return {
        provider: row.sourceIssueProvider,
        repository: row.sourceIssueRepository,
        externalIssueId: row.sourceIssueExternalIssueId,
        issueNumber: row.sourceIssueNumber,
        url: row.sourceIssueUrl ?? undefined,
        closedAt: row.sourceIssueClosedAt ?? undefined,
      };
    })(),
    mergeDetails: fromJson<import("../types.js").MergeDetails>(row.mergeDetails),
    // FNXC:Workspace 2026-06-24-15:30: deserialize the per-sub-repo worktree map. An empty/null map
    // normalizes to undefined so isWorkspaceTask() (keys-length>0) and the scope verifier behave the
    // same as a task that never acquired a sub-repo.
    workspaceWorktrees: (() => {
      const w = fromJson<import("../types.js").Task["workspaceWorktrees"]>(row.workspaceWorktrees);
      return w && Object.keys(w).length > 0 ? w : undefined;
    })(),
    // FNXC:RepositoryScope 2026-08-20-23:07: legacy null remains absent; hydration must not convert acquired worktrees into intent.
    repositoryScope: fromJson<import("../types.js").Task["repositoryScope"]>(row.repositoryScope) ?? undefined,
    noCommitsExpected: row.noCommitsExpected ? true : undefined,
    // FNXC:WorkflowOptionalSteps 2026-06-29-02:55: an explicit empty optional-step
    // selection must hydrate back as [], not undefined — "all disabled" and "not
    // materialized" are different states (mirrors main's SQLite-path fix).
    enabledWorkflowSteps: (() => { const e = fromJson<string[]>(row.enabledWorkflowSteps); return Array.isArray(e) ? e : undefined; })(),
    modifiedFiles: (() => { const m = fromJson<string[]>(row.modifiedFiles); return Array.isArray(m) ? m : undefined; })(),
    declaredSymbols: (() => { const v = fromJson<string[]>(row.declaredSymbols); return v && v.length > 0 ? v : undefined; })(),
    missionId: row.missionId || undefined,
    sliceId: row.sliceId || undefined,
    assignedAgentId: row.assignedAgentId || undefined,
    pausedByAgentId: row.pausedByAgentId || undefined,
    assigneeUserId: row.assigneeUserId || undefined,
    nodeId: row.nodeId || undefined,
    effectiveNodeId: row.effectiveNodeId || undefined,
    effectiveNodeSource: (row.effectiveNodeSource as Task["effectiveNodeSource"]) || undefined,
    sourceType: (row.sourceType as SourceType) || undefined,
    sourceAgentId: row.sourceAgentId || undefined,
    sourceRunId: row.sourceRunId || undefined,
    sourceSessionId: row.sourceSessionId || undefined,
    sourceMessageId: row.sourceMessageId || undefined,
    sourceParentTaskId: row.sourceParentTaskId || undefined,
    proposalClaimId: row.proposalClaimId || undefined,
    sourceMetadata: withTaskBranchContextInSourceMetadata(sourceMetadataValue, branchContext),
    branchContext,
    checkedOutBy: row.checkedOutBy || undefined,
    checkedOutAt: row.checkedOutAt || undefined,
    checkoutNodeId: row.checkoutNodeId || undefined,
    checkoutRunId: row.checkoutRunId || undefined,
    checkoutLeaseRenewedAt: row.checkoutLeaseRenewedAt || undefined,
    checkoutLeaseEpoch: row.checkoutLeaseEpoch ?? undefined,
    deletedAt: row.deletedAt ?? undefined,
    allowResurrection: row.allowResurrection ? true : undefined,
  };
}

export function rowToBranchGroup(row: BranchGroupRow): import("../types.js").BranchGroup {
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    branchName: row.branchName,
    worktreePath: row.worktreePath ?? undefined,
    autoMerge: Boolean(row.autoMerge),
    prState: row.prState,
    prUrl: row.prUrl ?? undefined,
    prNumber: row.prNumber ?? undefined,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt ?? undefined,
  };
}

export function generateBranchGroupId(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `BG-${timestamp}-${random}`;
}

/*
FNXC:TaskLogProjections 2026-10-10-20:55 (RUFU-615): moved VERBATIM to `tasks/log-timing.ts`, a
browser-safe leaf, so the write-time projection module can use the rule without importing this file
(which pulls `node:crypto`). Re-exported here under the same name so no existing importer changes.
*/
export { computeTimedExecutionMs } from "../tasks/log-timing.js";
// A re-export does not bind the name locally, and this module's own `archiveEntryToTask` calls it.
import { computeTimedExecutionMs } from "../tasks/log-timing.js";


export function archiveEntryToTask(
  entry: ArchivedTaskEntry,
  slim = false,
): Task {
  return {
    id: entry.id,
    lineageId: entry.lineageId || generateTaskLineageId(),
    title: entry.title,
    description: entry.description,
    column: "archived",
    preArchiveColumn: entry.preArchiveColumn,
    dependencies: entry.dependencies ?? [],
    steps: entry.steps ?? [],
    currentStep: entry.currentStep ?? 0,
    customFields: entry.customFields ?? undefined,
    size: entry.size,
    reviewLevel: entry.reviewLevel,
    prInfo: slim ? undefined : entry.prInfo,
    prInfos: slim ? undefined : entry.prInfos,
    issueInfo: slim ? undefined : entry.issueInfo,
    githubTracking: entry.githubTracking,
    gitlabTracking: entry.gitlabTracking,
    sourceIssue: slim ? undefined : entry.sourceIssue,
    attachments: slim ? undefined : entry.attachments,
    comments: entry.comments,
    review: slim ? undefined : entry.review,
    // FNXC:ArchivedRecommendations 2026-09-20-17:23: archive reads retain actionable terminal recommendation state.
    recommendations: entry.recommendations,
    log: slim ? [] : entry.log ?? [],
    timedExecutionMs: slim ? computeTimedExecutionMs(entry.log) : undefined,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    columnMovedAt: entry.columnMovedAt,
    ...pickArchiveRestorableTaskFields(entry),
    /*
    FNXC:ArchiveLifecycle 2026-07-24-11:02:
    FN-8561 needs archived TaskCard completion fallback to use the immutable
    archive transition, not the pre-archive columnMovedAt snapshot or updatedAt.
    Preserve archivedAt on every slim and full archive read without changing
    restore persistence semantics.
    */
    archivedAt: entry.archivedAt,
  };
}

/*
FNXC:ArchiveSummary 2026-08-29-05:17:
FN-253 makes tool detail default-populated. The former detail-first snippet silently replaced every
identifying tool name with arguments, so archive summaries now keep text first inside the existing
160-character clamp and append available detail only after it.
*/
export function summarizeAgentLog(entries: AgentLogEntry[], totalCount: number): string | undefined {
  if (totalCount === 0) {
    return undefined;
  }

  const countsByType = new Map<string, number>();
  const countsByAgent = new Map<string, number>();
  for (const entry of entries) {
    countsByType.set(entry.type, (countsByType.get(entry.type) ?? 0) + 1);
    if (entry.agent) {
      countsByAgent.set(entry.agent, (countsByAgent.get(entry.agent) ?? 0) + 1);
    }
  }

  const typeSummary = Array.from(countsByType.entries())
    .map(([type, count]) => `${type}:${count}`)
    .join(", ");
  const agentSummary = Array.from(countsByAgent.entries())
    .map(([agent, count]) => `${agent}:${count}`)
    .join(", ");
  const recentText = entries
    .slice(-5)
    .map((entry) => {
      const source = entry.agent ? `${entry.agent}/${entry.type}` : entry.type;
      const content = entry.text
        ? entry.detail ? `${entry.text} — ${entry.detail}` : entry.text
        : entry.detail || "";
      const text = content.replace(/\s+/g, " ").trim();
      const snippet = text.length > ARCHIVE_AGENT_LOG_SNIPPET_LIMIT
        ? `${text.slice(0, ARCHIVE_AGENT_LOG_SNIPPET_LIMIT)}...`
        : text;
      return snippet ? `${source}: ${snippet}` : source;
    })
    .filter(Boolean)
    .join("\n");

  return [
    `Agent log entries: ${totalCount}`,
    typeSummary ? `Types: ${typeSummary}` : undefined,
    agentSummary ? `Agents: ${agentSummary}` : undefined,
    recentText ? `Recent entries:\n${recentText}` : undefined,
  ].filter(Boolean).join("\n");
}

export { ARCHIVE_AGENT_LOG_SNAPSHOT_LIMIT, ARCHIVE_AGENT_LOG_SNIPPET_LIMIT };

export function rowToTaskDocument(row: TaskDocumentRow): import("../types.js").TaskDocument {
  return {
    id: row.id,
    taskId: row.taskId,
    key: row.key,
    content: row.content,
    revision: row.revision,
    contentHash: taskDocumentContentHash(row.content),
    author: row.author,
    metadata: fromJson<Record<string, unknown>>(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function rowToArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    ...(row.description !== null ? { description: row.description } : {}),
    ...(row.mimeType !== null ? { mimeType: row.mimeType } : {}),
    ...(row.sizeBytes !== null ? { sizeBytes: row.sizeBytes } : {}),
    ...(row.uri !== null ? { uri: row.uri } : {}),
    ...(row.content !== null ? { content: row.content } : {}),
    authorId: row.authorId,
    authorType: row.authorType,
    ...(row.taskId !== null ? { taskId: row.taskId } : {}),
    metadata: fromJson<Record<string, unknown>>(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    /*
    FNXC:ArtifactRetraction 2026-11-11-12:16 (RUFU-433): the tombstone must be mapped here too. Two
    mappers turn one ArtifactRow into one Artifact (this one serves store.rowToArtifact, the async helper
    in async-comments-attachments.ts serves every PG read), and a field mapped in only one of them is how
    a retracted artifact comes back reading as live from whichever surface used the other. Absence still
    means "never retracted", so a pre-0097 row is unaffected.
    */
    ...(row.retractedAt != null ? { retractedAt: row.retractedAt } : {}),
    ...(row.retractedBy != null ? { retractedBy: row.retractedBy } : {}),
    ...(row.retractReason != null ? { retractReason: row.retractReason } : {}),
  };
}

export function rowToTaskDocumentRevision(row: TaskDocumentRevisionRow): import("../types.js").TaskDocumentRevision {
  return {
    id: row.id,
    taskId: row.taskId,
    key: row.key,
    content: row.content,
    revision: row.revision,
    author: row.author,
    metadata: fromJson<Record<string, unknown>>(row.metadata),
    createdAt: row.createdAt,
  };
}

export function rowToGoalCitation(row: GoalCitationRow): GoalCitation {
  return {
    id: row.id,
    goalId: row.goalId,
    agentId: row.agentId,
    ...(row.taskId ? { taskId: row.taskId } : {}),
    surface: row.surface,
    sourceRef: row.sourceRef,
    snippet: row.snippet,
    timestamp: row.timestamp,
  };
}

// Re-export types that callers may need alongside these converters.
export type { ArchiveAgentLogMode };
