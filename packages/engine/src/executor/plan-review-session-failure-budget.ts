/**
 * FNXC:PlanReplanSessionBudget 2026-09-21-10:45 (RUFU-251):
 * A planner session that dies instead of revising the specification was invisible to every
 * automatic bound, so the Plan Review → replan → plan loop could run forever. The graph's Plan
 * Review revision ceiling (`planReviewReplanCap`, node `maxRevisions`, the shared absolute
 * backstop, and the same-episode verdict count in `countPlanReviewRevisionAttempts`) only advances
 * when Plan Review persists a new REVISE verdict, and a failed planner session persists nothing:
 * triage's clean-attempt guard and deterministic-validation branch record only the filesystem
 * twin's `recoveryRetryCount` (MAX_RECOVERY_RETRIES = 3 with backoff, cleared at exhaustion) and
 * the scheduler's spec-staleness rebound wrote `needs-replan` with no counter at all. Meanwhile
 * `plan-review-replan-cap` exhaustion had exactly one producer — the graph remediation seam in
 * `request-pre-merge-optional-step-fix.ts` — so it could never fire for this shape.
 *
 * This module folds those planner-session failures into the SAME budget the graph consumes rather
 * than authorizing a second planning authority:
 *
 * - the ledger stays the revision-keyed accounting the graph already writes
 *   (`countOptionalStepRevisionAttempts` over the append-only task log plus the persisted
 *   same-episode verdict count), never a parallel persisted field;
 * - a charge is a revision-keyed task-log marker on the `plan-review` key, so the graph's next
 *   remediation sees the consumed turn through `loggedAttemptCount` and parks on its own if triage
 *   never gets there;
 * - exhaustion is decided with the graph's own arithmetic and parks through the existing
 *   `parkPlanReviewReplanCapExhausted` seam, whose `awaiting-approval` +
 *   `awaitingApprovalReason: "plan-review-replan-cap"` operator surface is preserved verbatim.
 *
 * Scope guard: charging happens ONLY inside a live Plan Review REVISE episode — the latest
 * unsuperseded Plan Review projection says `REVISE` and does not satisfy
 * `isPlanReviewSatisfied`. A first-pass plan with no Plan Review verdict yet, a superseded
 * projection, a passed row, or a plan failure with no REVISE verdict keeps today's exact behavior:
 * bounded filesystem-twin retry, then failed. Nothing here approves, fabricates, or synthesizes a
 * Plan Review verdict.
 */
import type { Settings, Task, TaskStore, WorkflowStepResult } from "@fusion/core";
import {
  ABSOLUTE_MAX_AUTOMATIC_REVIEW_REVISIONS,
  DEFAULT_MAX_POST_REVIEW_FIXES,
  DEFAULT_PLAN_REVIEW_REPLAN_CAP,
  PLAN_REVIEW_GROUP_ID,
  isPlanReviewSatisfied,
  resolveOptionalReviewRevisionBudget,
  resolveOptionalStepRevisionBudget,
  resolveWorkflowIrForTask,
} from "@fusion/core";
import { countPlanReviewRevisionAttempts } from "../plan-review-feedback-history.js";
import {
  countOptionalStepRevisionAttempts,
  optionalStepRevisionLogOutcome,
} from "./optional-step-revision.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { generateSyntheticRunId } from "../util/run-audit.js";
import type { EngineRunContext } from "../util/run-audit.js";

/** Revision-keyed budget state for one live Plan Review REVISE episode. */
export type PlanReviewSessionFailureBudget = {
  /** True when the latest unsuperseded Plan Review projection is an unsatisfied `REVISE`. */
  inRevisionEpisode: boolean;
  /** Budget partition this episode charges (`plan-review` for the built-in gate). */
  revisionKey: string;
  /** Planning turns already charged to this episode before the one being evaluated. */
  attemptsConsumed: number;
  /** Effective ceiling after clamping node/settings values by the absolute backstop. */
  cap: number;
  /** Turn number this session failure would consume (`attemptsConsumed + 1`). */
  attempt: number;
  /** Turns still grantable after the evaluated attempt (`max(0, cap - attempt)`). */
  remaining: number;
  /** True when granting this attempt would exceed the ceiling the graph enforces. */
  exhausted: boolean;
};

/** Outcome vocabulary recorded on the budget run-audit event (fixed enum, never prose). */
export type PlanReviewSessionFailureOutcome = "consumed" | "exhausted" | "spec-complete-recycled";

export type PlanReviewSessionFailureDeps = {
  store: TaskStore;
};

/** The plan-review budget partition is keyed by the built-in optional-group id. */
export const PLAN_REVIEW_REVISION_KEY = PLAN_REVIEW_GROUP_ID;

function planReviewProjection(results: readonly WorkflowStepResult[] | undefined): WorkflowStepResult | undefined {
  // Newest projection wins: `workflowStepResults` is persisted oldest-first, and a superseded
  // row is a closed episode boundary that must not be read as a live request.
  for (let index = (results?.length ?? 0) - 1; index >= 0; index -= 1) {
    const result = results?.[index];
    if (!result) continue;
    if (result.workflowStepId === PLAN_REVIEW_REVISION_KEY || result.workflowStepName === "Plan Review") return result;
  }
  return undefined;
}

/**
 * Resolve the Plan Review replan ceiling the graph would enforce for this task, reusing the exact
 * seam `request-pre-merge-optional-step-fix.ts` consumes so the two producers can never disagree.
 * `nodeMaxRevisions` is read from the task's own workflow IR; an unreadable IR falls back to the
 * resolver's plan-review default, which the caller still clamps with `planReviewReplanCap`.
 */
export async function resolvePlanReviewReplanCeiling(
  deps: PlanReviewSessionFailureDeps,
  task: Task,
  settings: Settings,
): Promise<{ cap: number; unbounded: boolean }> {
  const fallbackMaxRevisions = settings.maxPostReviewFixes ?? DEFAULT_MAX_POST_REVIEW_FIXES;
  let nodeMaxRevisions: unknown;
  try {
    const ir = await resolveWorkflowIrForTask(deps.store, task.id);
    if (ir.version === "v2") {
      const node = ir.nodes.find((candidate) => candidate.id === PLAN_REVIEW_REVISION_KEY && candidate.kind === "optional-group");
      nodeMaxRevisions = node?.config?.maxRevisions;
    }
  } catch {
    nodeMaxRevisions = undefined;
  }
  const maxRevisions = resolveOptionalReviewRevisionBudget({
    optionalGroupId: PLAN_REVIEW_REVISION_KEY,
    workflowSettings: settings as Record<string, unknown>,
    nodeMaxRevisions,
    fallbackMaxRevisions,
  });
  const budget = resolveOptionalStepRevisionBudget(maxRevisions, fallbackMaxRevisions);
  const configuredCap = typeof settings.planReviewReplanCap === "number"
    && Number.isInteger(settings.planReviewReplanCap)
    && settings.planReviewReplanCap >= 0
    ? settings.planReviewReplanCap
    : DEFAULT_PLAN_REVIEW_REPLAN_CAP;
  // Mirrors the remediation seam: an unbounded node budget is still clamped by the configured
  // replan cap, and a bounded one is already clamped by the absolute backstop.
  const cap = budget.unbounded
    ? Math.min(budget.max, configuredCap)
    : Math.min(budget.max, ABSOLUTE_MAX_AUTOMATIC_REVIEW_REVISIONS);
  return { cap, unbounded: budget.unbounded };
}

/**
 * True when the task carries a live Plan Review `REVISE` request: the latest unsuperseded Plan
 * Review projection asked for a revision and nothing satisfies the gate since. Cheap and pure, so
 * callers can gate the (slightly more expensive) budget resolution on it.
 */
export function isPlanReviewRevisionEpisode(task: Pick<Task, "workflowStepResults">): boolean {
  const projection = planReviewProjection(task.workflowStepResults);
  return projection !== undefined
    && projection.supersededAt == null
    && projection.verdict === "REVISE"
    && !isPlanReviewSatisfied(projection);
}

/**
 * Evaluate the shared budget for one planner-session failure. Pure over persisted state so the
 * arithmetic is testable without a store: `attemptsConsumed` reuses the remediation seam's own
 * `currentCount` formula (`max(same-episode verdicts - 1, revision-keyed log markers)`), which
 * counts the turns the graph already granted.
 */
export function evaluatePlanReviewSessionFailureBudget(
  task: Pick<Task, "workflowStepResults" | "log">,
  options: { cap: number },
): PlanReviewSessionFailureBudget {
  const revisionKey = PLAN_REVIEW_REVISION_KEY;
  const projection = planReviewProjection(task.workflowStepResults);
  const inRevisionEpisode = isPlanReviewRevisionEpisode(task);
  if (!inRevisionEpisode || !projection) {
    return {
      inRevisionEpisode: false,
      revisionKey,
      attemptsConsumed: 0,
      cap: options.cap,
      attempt: 1,
      remaining: options.cap,
      exhausted: false,
    };
  }

  const episodeAttemptCount = countPlanReviewRevisionAttempts(task.workflowStepResults, { revisionKey });
  const loggedAttemptCount = countOptionalStepRevisionAttempts(task, revisionKey, "Plan Review");
  const hasEpisodeBoundary = projection.supersededAt != null
    || projection.priorAttempts?.some((attempt) => attempt.supersededAt != null) === true;
  // Same arithmetic as the graph remediation seam, whose `currentCount` is `nextCount - 1`.
  const attemptsConsumed = hasEpisodeBoundary
    ? Math.max(0, episodeAttemptCount - 1)
    : Math.max(episodeAttemptCount - 1, loggedAttemptCount);
  const attempt = attemptsConsumed + 1;
  return {
    inRevisionEpisode: true,
    revisionKey,
    attemptsConsumed,
    cap: options.cap,
    attempt,
    remaining: Math.max(0, options.cap - attempt),
    // The graph grants a revision while its pre-existing consumed count is below the cap, i.e.
    // turn numbers 1..cap. Consuming turn cap+1 is what parks.
    exhausted: attempt > options.cap,
  };
}

/** Read the live budget for a task without charging anything. */
export async function resolvePlanReviewSessionFailureBudget(
  deps: PlanReviewSessionFailureDeps,
  task: Task,
  settings: Settings,
): Promise<PlanReviewSessionFailureBudget> {
  const { cap } = await resolvePlanReviewReplanCeiling(deps, task, settings);
  return evaluatePlanReviewSessionFailureBudget(task, { cap });
}

/**
 * Charge one failed planner session against the episode budget by appending the revision-keyed
 * attempt marker the graph counts. Returns `charged: false` outside a live REVISE episode, and
 * `exhausted: true` when the ceiling is reached — in which case no marker is written, matching the
 * remediation seam, which parks without granting another turn.
 */
export async function chargePlanReviewSessionFailureAttempt(
  deps: PlanReviewSessionFailureDeps & { getRunContextFor?: (taskId: string) => EngineRunContext | undefined },
  task: Task,
  settings: Settings,
  options: { runContext?: EngineRunContext | undefined },
): Promise<{ budget: PlanReviewSessionFailureBudget; charged: boolean }> {
  const budget = await resolvePlanReviewSessionFailureBudget(deps, task, settings);
  if (!budget.inRevisionEpisode) {
    return { budget, charged: false };
  }
  if (budget.exhausted) {
    await emitPlanReviewSessionFailureBudgetAudit(deps.store, {
      taskId: task.id,
      runContext: options.runContext,
      budget,
      outcome: "exhausted",
    });
    return { budget, charged: false };
  }

  await deps.store.logEntry(
    task.id,
    `Plan Review replanner session ended without a specification update (attempt ${budget.attempt}/${budget.cap})`,
    optionalStepRevisionLogOutcome(
      "The planner session for this Plan Review revision request ended without changing PROMPT.md, "
      + "so the turn is charged to the Plan Review replan budget instead of the filesystem recovery budget.",
      budget.revisionKey,
    ),
    options.runContext,
  );
  await emitPlanReviewSessionFailureBudgetAudit(deps.store, {
    taskId: task.id,
    runContext: options.runContext,
    budget,
    outcome: "consumed",
  });
  return { budget, charged: true };
}

/** Record the shared-budget decision for one planner session. Metadata is ids/counts/outcomes only. */
export function emitPlanReviewSessionFailureBudgetAudit(
  store: TaskStore,
  input: {
    taskId: string;
    runContext?: EngineRunContext | undefined;
    budget: Pick<PlanReviewSessionFailureBudget, "revisionKey" | "attempt" | "cap" | "remaining">;
    outcome: PlanReviewSessionFailureOutcome;
  },
): Promise<void> {
  return emitBoundedRunAudit(store, {
    taskId: input.taskId,
    agentId: input.runContext?.agentId ?? "triage",
    runId: input.runContext?.runId ?? generateSyntheticRunId("plan-review-session-failure-budget", input.taskId),
    domain: "database",
    mutationType: "task:plan-replan-session-failure-budget",
    target: input.taskId,
    metadata: {
      taskId: input.taskId,
      revisionKey: input.budget.revisionKey,
      attempt: input.budget.attempt,
      cap: input.budget.cap,
      remaining: input.budget.remaining,
      outcome: input.outcome,
    },
  });
}
