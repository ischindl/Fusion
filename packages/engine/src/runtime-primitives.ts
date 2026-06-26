import type { TaskDetail, TaskStep, WorkflowIrNode } from "@fusion/core";

import type { PrMergeCallResult } from "./pr-nodes.js";
import type { RunTaskStepResult, ResetStepResult } from "./step-runner.js";
import type { WorkflowNodeOutcome } from "./workflow-graph-executor.js";

export type RuntimePrimitiveName =
  | "prepare-worktree"
  | "read-artifact"
  | "write-artifact"
  | "planning-session"
  | "coding-session"
  | "step-session"
  | "reset-step"
  | "review"
  | "verification"
  | "transition"
  | "merge"
  | "abort"
  | "audit";

export interface WorkflowRuntimeRunContext {
  runId: string;
  taskId: string;
  workflowId: string;
  /** True after any primitive with task/git/session side effects starts. */
  sideEffectsStarted?: boolean;
  recoveryEventId?: string;
}

export interface WorkflowRuntimeNodeContext {
  node: Pick<WorkflowIrNode, "id" | "kind" | "column" | "config">;
  effectivePrincipalId?: string;
  attempt?: number;
  context?: Record<string, unknown>;
}

export interface WorkflowPrimitiveContext {
  run: WorkflowRuntimeRunContext;
  node: WorkflowRuntimeNodeContext;
}

export interface RuntimePrimitiveResult<TValue = unknown> {
  outcome: WorkflowNodeOutcome;
  value?: string;
  data?: TValue;
  contextPatch?: Record<string, unknown>;
}

export interface PreparedWorktree {
  worktreePath: string;
  branchName?: string;
  baseCommitSha?: string;
  modifiedFiles?: string[];
}

export interface PlanningSessionResult {
  approved: boolean;
  artifactKeys: string[];
  createdTaskIds?: string[];
  feedback?: string;
}

export interface CodingSessionResult {
  taskDone: boolean;
  modifiedFiles: string[];
  summary?: string;
}

export interface ReviewPrimitiveResult {
  verdict: "APPROVE" | "REVISE" | "RETHINK" | "UNAVAILABLE";
  review?: string;
  summary?: string;
}

export interface VerificationPrimitiveResult {
  verdict: "approve" | "revise" | "failed" | "advisory-failed" | "skipped";
  feedback?: string;
  stepName?: string;
}

// FNXC:WorkflowExecution 2026-06-25-00:00: U4 (KTD-2) — the `runWorkflowStep`
// primitive and its `WorkflowStepPrimitiveInput`/`WorkflowStepPrimitiveResult`
// shapes were removed. Workflow quality gates run as the graph's own
// optional-group / gate nodes which record into `task.workflowStepResults` (U2);
// there is no dedicated workflow-step runtime primitive.

export interface TransitionPrimitiveInput {
  column?: string;
  status?: string | null;
  reason: string;
  preserveProgress?: boolean;
}

export interface MergePrimitiveInput {
  expectedHeadOid?: string;
  manualAllowed?: boolean;
}

export type MergePrimitiveResult =
  | { status: "merged"; noOp?: boolean }
  | { status: "manual-required"; reason?: string }
  | { status: "failed"; reason: string }
  | { status: "timeout" }
  | PrMergeCallResult;

export interface AbortPrimitiveInput {
  reason: string;
  hardCancel?: boolean;
}

export interface AuditPrimitiveInput {
  type: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowRuntimePrimitives {
  prepareWorktree(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
  ): Promise<RuntimePrimitiveResult<PreparedWorktree>>;

  readArtifact(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    key: string,
  ): Promise<string | undefined>;

  writeArtifact(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    key: string,
    content: string,
  ): Promise<RuntimePrimitiveResult<{ key: string }>>;

  runPlanningSession(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
  ): Promise<RuntimePrimitiveResult<PlanningSessionResult>>;

  runCodingSession(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    prepared: PreparedWorktree,
  ): Promise<RuntimePrimitiveResult<CodingSessionResult>>;

  runTaskStep(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    stepIndex: number,
  ): Promise<RunTaskStepResult>;

  resetTaskStep(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    stepIndex: number,
    baselineSha?: string,
    checkpointId?: string,
  ): Promise<ResetStepResult>;

  runReview(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    input: { type: "plan" | "code"; stepIndex?: number; baselineSha?: string },
  ): Promise<RuntimePrimitiveResult<ReviewPrimitiveResult>>;

  runVerification(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    prepared: PreparedWorktree,
  ): Promise<RuntimePrimitiveResult<VerificationPrimitiveResult>>;

  updateSteps(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    steps: TaskStep[],
  ): Promise<RuntimePrimitiveResult<{ count: number }>>;

  transitionTask(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    input: TransitionPrimitiveInput,
  ): Promise<RuntimePrimitiveResult>;

  requestMerge(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    input?: MergePrimitiveInput,
  ): Promise<RuntimePrimitiveResult<MergePrimitiveResult>>;

  abortRun(
    ctx: WorkflowPrimitiveContext,
    task: TaskDetail,
    input: AbortPrimitiveInput,
  ): Promise<RuntimePrimitiveResult>;

  audit(ctx: WorkflowPrimitiveContext, input: AuditPrimitiveInput): Promise<void> | void;
}

export function markSideEffectsStarted(ctx: WorkflowPrimitiveContext): WorkflowPrimitiveContext {
  return {
    ...ctx,
    run: {
      ...ctx.run,
      sideEffectsStarted: true,
    },
  };
}

export function primitiveNodeContext(
  run: WorkflowRuntimeRunContext,
  node: WorkflowRuntimeNodeContext["node"],
  extras: Omit<WorkflowRuntimeNodeContext, "node"> = {},
): WorkflowPrimitiveContext {
  return {
    run,
    node: {
      ...extras,
      node,
    },
  };
}

