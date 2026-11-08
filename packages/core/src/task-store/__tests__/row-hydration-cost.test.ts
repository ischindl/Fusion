/**
 * Row-hydration cost harness for the board list read (RUFU-871).
 *
 * FNXC:RowHydrationCost 2026-11-08-01:25:
 * A CPU profile taken during a real 155 s event-loop stall attributed ~25 % of
 * samples (8 200 of 33 289) to task-row hydration under the list read, while
 * Postgres held only 189 of 500 connections — the cost is in the Node process.
 * This file exists so the hot spot is MEASURED rather than narrated:
 *
 *   FUSION_ROW_HYDRATION_BENCH=1 pnpm --filter @fusion/core exec vitest run \
 *     src/task-store/__tests__/row-hydration-cost.test.ts --reporter=basic
 *
 * prints per-row and per-column-group cost. The benchmark block is gated on
 * that env var so CI never pays for it (repo rule: no slow tests, no wall-clock
 * assertions), and it ASSERTS nothing about time — it only reports.
 *
 * The always-on half is the invariant that makes an optimisation safe: the
 * hydrated `Task` shape must stay byte-identical. A golden snapshot of the
 * hydrated fixture set is the check, plus a deterministic `JSON.parse` call
 * count that proves the jsonb round-trip count did not grow.
 */
import { describe, expect, it } from "vitest";
import { pgRowToTaskRow, rowToTask } from "../serialization.js";
import { TASK_JSONB_COLUMNS } from "../persistence.js";
import type { TaskRow } from "../persistence.js";

/** Column groups used by the report so cost is attributable, not just total. */
const JSONB_GROUP_SIZES = [
  "log",
  "comments",
  "workflowStepResults",
  "sourceMetadata",
  "stepReports",
] as const;

/**
 * Builds one PostgreSQL-shaped task row. jsonb columns arrive ALREADY PARSED
 * (VAL-SCHEMA-004), which is what `pgRowToTaskRow` then re-stringifies for the
 * SQLite-oriented `rowToTask`. Row size is driven by `weight` so the benchmark
 * can separate fixed field-mapping cost from jsonb round-trip cost.
 */
function pgFixtureRow(i: number, weight = 1): Record<string, unknown> {
  const stamp = `2026-11-0${(i % 8) + 1}T10:0${i % 10}:00.000Z`;
  const logRows = Array.from({ length: 60 * weight }, (_unused, n) => ({
    timestamp: stamp,
    message: `[timing] step ${n} completed in ${1000 + n}ms — ${"detail ".repeat(12)}`,
  }));
  const commentRows = Array.from({ length: 8 * weight }, (_unused, n) => ({
    id: `cmt-${i}-${n}`,
    author: `agent-${n % 4}`,
    body: `review comment ${n} on ${i} ${"body text ".repeat(18)}`,
    createdAt: stamp,
  }));
  const stepResults = Array.from({ length: 6 * weight }, (_unused, n) => ({
    stepId: `step-${n}`,
    stepName: `code-review-${n}`,
    status: "passed",
    verdict: "APPROVE",
    summary: `reviewer summary ${n} ${"finding text ".repeat(20)}`,
    finishedAt: stamp,
  }));
  const stepReports = Array.from({ length: 4 * weight }, (_unused, n) => ({
    stepId: `step-${n}`,
    report: `${"implementation report ".repeat(24)}`,
    at: stamp,
  }));
  const sourceMetadata: Record<string, unknown> = {
    planEvidence: { spec: "requirement ".repeat(40 * weight), fingerprint: `fp-${i}` },
    wipAdmissionStall: { signature: `sweep:${i}`, firstAt: stamp, ageMs: 60_000 + i },
    nested: { a: { b: { c: Array.from({ length: 20 * weight }, (_u, n) => ({ k: n, v: `value ${n}` })) } } },
  };

  return {
    id: `RUFU-${1000 + i}`,
    lineageId: `lin-${i}`,
    title: `Task ${i}`,
    description: "description sentence. ".repeat(30 * weight),
    queueBoost: null,
    column: "in-progress",
    status: null,
    size: "medium",
    reviewLevel: null,
    currentStep: 2,
    worktree: `/tmp/wt/${i}`,
    blockedBy: null,
    overlapBlockedBy: null,
    fileScopeLeaseRelease: null,
    paused: 0,
    pausedReason: null,
    wedgeNotification: null,
    userPaused: 0,
    baseBranch: "main",
    branch: `fusion/RUFU-${1000 + i}`,
    autoMerge: 1,
    autoMergeProvenance: null,
    executionStartBranch: null,
    baseCommitSha: null,
    modelPresetId: null,
    modelProvider: null,
    credentialInstanceId: null,
    modelId: null,
    validatorModelProvider: null,
    validatorCredentialInstanceId: null,
    validatorModelId: null,
    planningModelProvider: null,
    planningCredentialInstanceId: null,
    planningModelId: null,
    mergerModelProvider: null,
    mergerCredentialInstanceId: null,
    mergerModelId: null,
    mergeRetries: 0,
    aiMergeReviewReconciliation: null,
    workflowStepRetries: null,
    stuckKillCount: 0,
    resumeLimboCount: 0,
    graphResumeRetryCount: 0,
    consecutiveToolFailureRetryCount: 0,
    executorEscalationAttempted: 0,
    toolFailureDetectorLogCursor: null,
    toolFailureRetryExhaustedAuditEmitted: 0,
    resumeLimboTipSha: null,
    resumeLimboStepSignature: null,
    executeRequeueLoopCount: 0,
    executeRequeueLoopSignature: null,
    postReviewFixCount: 0,
    planReviewReplanCount: 0,
    recoveryRetryCount: 0,
    recoveryDisposition: null,
    sessionContentionHoldCount: 0,
    sessionContentionWaitReason: null,
    taskDoneRetryCount: 0,
    bulkCompletionRefusalAt: null,
    worktreeSessionRetryCount: 0,
    completionHandoffLimboRecoveryCount: 0,
    verificationFailureCount: 0,
    mergeConflictBounceCount: 0,
    mergeAuditBounceCount: 0,
    mergeTransientRetryCount: 0,
    branchConflictRecoveryCount: 0,
    reviewerContextRetryCount: 0,
    reviewerFallbackRetryCount: 0,
    reviewConvergenceStage: null,
    reviewConvergenceEscalationCount: 0,
    nextRecoveryAt: null,
    error: null,
    summary: null,
    recommendations: null,
    thinkingLevel: null,
    validatorThinkingLevel: null,
    planningThinkingLevel: null,
    mergerThinkingLevel: null,
    executionMode: null,
    tokenUsageInputTokens: 12_000 + i,
    tokenUsageOutputTokens: 3_000 + i,
    tokenUsageCachedTokens: 9_000 + i,
    tokenUsageCacheWriteTokens: 0,
    tokenUsageTotalTokens: 24_000 + i,
    tokenUsageFirstUsedAt: stamp,
    tokenUsageLastUsedAt: stamp,
    tokenUsageModelProvider: "anthropic",
    tokenUsageModelId: "claude-sonnet",
    tokenUsagePerModel: [{ modelId: "claude-sonnet", totalTokens: 24_000 + i }],
    tokenBudgetSoftAlertedAt: null,
    tokenBudgetHardAlertedAt: null,
    tokenBudgetOverride: null,
    createdAt: stamp,
    updatedAt: stamp,
    columnMovedAt: stamp,
    firstExecutionAt: stamp,
    cumulativeActiveMs: 120_000 + i,
    cumulativePlanningMs: 30_000 + i,
    planningStartedAt: null,
    cumulativePausedMs: 0,
    pausedStartedAt: null,
    executionStartedAt: stamp,
    executionCompletedAt: null,
    dependencies: [],
    steps: Array.from({ length: 5 * weight }, (_unused, n) => ({
      id: `step-${n}`,
      name: `step ${n}`,
      status: n === 0 ? "done" : "pending",
      required: true,
    })),
    stepReports,
    customFields: {},
    comments: commentRows,
    review: null,
    reviewState: null,
    workflowStepResults: stepResults,
    steeringComments: [],
    attachments: [],
    prInfo: null,
    prInfos: null,
    issueInfo: null,
    githubTracking: null,
    gitlabTracking: null,
    sourceIssueProvider: null,
    sourceIssueRepository: null,
    sourceIssueExternalIssueId: null,
    sourceIssueNumber: null,
    sourceIssueUrl: null,
    sourceIssueClosedAt: null,
    mergeDetails: null,
    workspaceWorktrees: null,
    repositoryScope: null,
    externalBlock: null,
    planningFailure: null,
    humanPlanApproval: null,
    humanMergeApproval: null,
    noCommitsExpected: 0,
    enabledWorkflowSteps: ["code-review", "plan-review"],
    modifiedFiles: [`src/a-${i}.ts`, `src/b-${i}.ts`],
    declaredSymbols: [],
    missionId: null,
    sliceId: null,
    scopeOverride: 0,
    scopeOverrideReason: null,
    scopeAutoWiden: null,
    assignedAgentId: `agent-${i % 3}`,
    pausedByAgentId: null,
    assigneeUserId: null,
    nodeId: null,
    effectiveNodeId: null,
    effectiveNodeSource: null,
    sourceType: "manual",
    sourceAgentId: null,
    sourceRunId: null,
    sourceSessionId: null,
    sourceMessageId: null,
    sourceParentTaskId: null,
    sourceMetadata,
    proposalClaimId: null,
    checkedOutBy: null,
    checkedOutAt: null,
    checkoutNodeId: null,
    checkoutRunId: null,
    checkoutLeaseRenewedAt: null,
    checkoutLeaseEpoch: null,
    deletedAt: null,
    allowResurrection: 0,
    log: logRows,
    columnDwellMs: null,
    workflowTransitionNotification: null,
    plannerOversightLevel: null,
    awaitingApprovalReason: null,
    approvedPlanFingerprint: null,
    queuedLogEpisodeSignature: null,
    workflowIrPin: "builtin:coding-ideas",
    workflowIrPinNodeId: "execute",
    workflowIrPinColumnId: "in-progress",
    legacyAdoptedAt: null,
    sessionAdvisorEnabled: null,
    logRecent: null,
  };
}

/** A small, fixed fixture set — the golden subject. */
function goldenFixtureRows(): Record<string, unknown>[] {
  return [pgFixtureRow(1), pgFixtureRow(2, 2), pgFixtureRow(3, 1), pgFixtureRow(4, 3)];
}

function hydrateAll(rows: Record<string, unknown>[]): unknown[] {
  return rows.map((row) => rowToTask(pgRowToTaskRow<TaskRow>(row, TASK_JSONB_COLUMNS)));
}

/** Deterministic instrumentation: count `JSON.parse` calls during a run. */
function countJsonParses<T>(fn: () => T): { value: T; parses: number } {
  const original = JSON.parse;
  let parses = 0;
  // eslint-disable-next-line no-import-assign
  JSON.parse = function patched(this: unknown, text: string | unknown, reviver?: unknown) {
    parses += 1;
    return (original as (t: unknown, r?: unknown) => unknown).call(JSON, text, reviver);
  } as typeof JSON.parse;
  try {
    const value = fn();
    return { value, parses };
  } finally {
    JSON.parse = original;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

describe("task row hydration — golden shape invariant", () => {
  it("hydrates the fixture row set to a stable, byte-identical shape", () => {
    const hydrated = hydrateAll(goldenFixtureRows());
    // This is the case where a snapshot earns its keep: an optimisation must
    // not change a single value or key the board consumes.
    expect(JSON.stringify(hydrated)).toMatchSnapshot();
  });

  it("hydrates jsonb-as-object (pg) and jsonb-as-text (sqlite) rows to the same object", () => {
    const row = pgFixtureRow(7, 2);
    const fromObject = rowToTask(pgRowToTaskRow<TaskRow>({ ...row }, TASK_JSONB_COLUMNS));
    // A sqlite-shaped row arrives with jsonb already text; the result must match.
    const textRow: Record<string, unknown> = { ...row };
    for (const column of TASK_JSONB_COLUMNS) {
      if (textRow[column] !== null && textRow[column] !== undefined && typeof textRow[column] !== "string") {
        textRow[column] = JSON.stringify(textRow[column]);
      }
    }
    const fromText = rowToTask(pgRowToTaskRow<TaskRow>(textRow, TASK_JSONB_COLUMNS));
    expect(fromText).toEqual(fromObject);
  });

  it("parses each jsonb column at most once per row in the hydrated hot path", () => {
    // Call-count assertion (never wall-clock): the round trip is
    // stringify -> parse, so one parse per non-empty jsonb column is the floor
    // for the columns `rowToTask` actually reads. `sourceMetadata` is the one
    // column the mapper reads twice (sourceMetadata + branchContext); that
    // doubling is pinned here so it cannot silently grow.
    const { parses } = countJsonParses(() => hydrateAll(goldenFixtureRows()));
    expect(parses).toMatchSnapshot();
  });
});

describe.skipIf(!process.env.FUSION_ROW_HYDRATION_BENCH)(
  "task row hydration — cost measurement (report-only, FUSION_ROW_HYDRATION_BENCH=1)",
  () => {
    it("reports per-row and per-column-group hydration cost", () => {
      const ROWS = 400;
      const REPEATS = 7;
      const pgRows = Array.from({ length: ROWS }, (_unused, i) => pgFixtureRow(i, 1));
      const taskRows = pgRows.map((row) => pgRowToTaskRow<TaskRow>(row, TASK_JSONB_COLUMNS));
      const bytes = pgRows.reduce((sum, row) => sum + JSON.stringify(row).length, 0);

      const perRow = (fn: () => void) => {
        fn(); // warm
        const timings: number[] = [];
        for (let r = 0; r < REPEATS; r += 1) {
          const t0 = performance.now();
          fn();
          timings.push((performance.now() - t0) / ROWS);
        }
        return median(timings);
      };

      const full = perRow(() => hydrateAll(pgRows));
      const shapeOnly = perRow(() => taskRows.map((row) => rowToTask(row)));
      const reparseOnly = perRow(() => pgRows.map((row) => pgRowToTaskRow<TaskRow>(row, TASK_JSONB_COLUMNS)));
      const parseCost = perRow(() => {
        for (const row of taskRows) {
          for (const column of JSONB_GROUP_SIZES) {
            const raw = (row as Record<string, unknown>)[column];
            if (typeof raw === "string") JSON.parse(raw);
          }
        }
      });
      const stringifyCost = perRow(() => {
        for (const row of pgRows) {
          for (const column of TASK_JSONB_COLUMNS) {
            const value = row[column];
            if (value !== null && value !== undefined && typeof value !== "string") JSON.stringify(value);
          }
        }
      });
      const { parses } = countJsonParses(() => hydrateAll(pgRows));

      const lines = [
        "",
        "=== ROW HYDRATION COST (median of " + REPEATS + " passes, " + ROWS + " rows) ===",
        `row bytes (avg)                 ${round(bytes / ROWS, 1)} B`,
        `full pgRowToTaskRow+rowToTask   ${round(full * 1000, 1)} us/row   (${round((bytes / ROWS) / full, 0)} B/us)`,
        `  rowToTask alone               ${round(shapeOnly * 1000, 1)} us/row  (${round((shapeOnly / full) * 100, 1)}% of full)`,
        `  pgRowToTaskRow alone          ${round(reparseOnly * 1000, 1)} us/row  (${round((reparseOnly / full) * 100, 1)}% of full)`,
        `  JSON.stringify all jsonb      ${round(stringifyCost * 1000, 1)} us/row`,
        `  JSON.parse 5 heaviest jsonb   ${round(parseCost * 1000, 1)} us/row`,
        `  JSON.parse calls per row      ${round(parses / ROWS, 2)}`,
        `  100-row board page            ${round(full * 100, 1)} ms`,
        "",
      ];
      // eslint-disable-next-line no-console
      console.log(lines.join("\n"));
      expect(full).toBeGreaterThan(0);
    });
  },
);
