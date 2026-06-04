import { WorkflowIrError } from "@fusion/core";
import type { TaskDetail, WorkflowIrNode } from "@fusion/core";

import type { WorkflowNodeHandler, WorkflowNodeResult } from "./workflow-graph-executor.js";

export type WorkflowSeamName = "planning" | "execute" | "review" | "merge" | "schedule" | "step-execute";

export interface WorkflowLegacySeams {
  /** Planning/spec stage. Built-in triage runs upstream of the interpreter
   *  today, so the default engine seam is a no-op for already-specified tasks;
   *  custom planning behavior is expressed as a custom prompt node. */
  planning: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  execute: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  review: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  merge: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  schedule: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  /**
   * Step-inversion (KTD-2/KTD-4, U3): run exactly the foreach-active step inside
   * the task's session/worktree. Only invoked for `step-execute` prompt nodes
   * inside a foreach template, where `context["foreach:active"]` carries the
   * active instance's `stepIndex`. Optional — a workflow that never uses a
   * foreach/step-execute node needs no implementation (the noop seams omit it,
   * and a step-execute node reached without this wired fails cleanly rather than
   * silently no-opping). The engine wires this to `runTaskStep` (executor.ts
   * createGraphSeams); it returns the per-step `baselineSha`/`checkpointId` in
   * its `contextPatch` so a later RETHINK (U5) can reset the step.
   */
  stepExecute?: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  /**
   * Step-inversion (KTD-4, U5): review the foreach-active step. Only invoked for
   * `step-review` nodes inside a foreach template, where `context["foreach:active"]`
   * carries the active instance. The seam calls `reviewStep` (reviewer.ts) under
   * `semaphore.runNested` against the instance's step + the task's PROMPT content
   * (the same way `fn_review_step` does), and — on an authoritative (non-advisory)
   * APPROVE — marks the step `done` through the projection (`updateStep(source:"graph")`,
   * KTD-7). It persists the verdict back into the active context so the foreach
   * sub-walk can write it into the instance row (KTD-6). It returns the raw verdict;
   * the {@link createStepReviewHandler} handler maps it to the outcome value the
   * `outcome:approve|revise|rethink|unavailable` edges route on. Optional — a
   * workflow without a step-review node needs no implementation.
   *
   * @param advisory when true (the node is inside a `split` branch — single-writer
   *   rule, KTD-4) the seam must NOT write the projection and only logs an audit
   *   note; the verdict is advisory and never routes the authoritative instance.
   */
  stepReview?: (
    task: TaskDetail,
    context: Record<string, unknown>,
    config: StepReviewConfig,
  ) => Promise<StepReviewSeamResult>;
}

/** Config a `step-review` node carries (KTD-4). */
export interface StepReviewConfig {
  type: "plan" | "code";
  model?: string;
  /** Single-writer rule (KTD-4): true when the node is inside a split branch, so
   *  the review is advisory-only — no projection write, no authoritative verdict. */
  advisory?: boolean;
}

/** Verdict surface the step-review seam returns (mirrors reviewer.ts ReviewResult). */
export interface StepReviewSeamResult {
  verdict: "APPROVE" | "REVISE" | "RETHINK" | "UNAVAILABLE";
  review?: string;
  summary?: string;
}

/** The reserved context key carrying the active foreach instance (KTD-3, U3).
 *  Template node handlers (step-execute now; step-review in U5) read it to learn
 *  which step they operate on and the per-instance baseline/checkpoint state. */
export const FOREACH_ACTIVE_CONTEXT_KEY = "foreach:active";

/**
 * Reserved context marker set by the split sub-walk (`runSplitJoin`) for the
 * duration of its branches' execution and cleared at the join (KTD-4, U5). A
 * `step-review` node that reads this as `true` is running inside a split branch,
 * so its verdict is **advisory-only** (single-writer rule): it never writes the
 * projection nor authors the routing verdict. `step-execute` is validator-forbidden
 * in splits, so only step-review needs to consult this.
 */
export const SPLIT_ACTIVE_CONTEXT_KEY = "split:active";

/** Shape of the value stored under {@link FOREACH_ACTIVE_CONTEXT_KEY}. */
export interface ForeachActiveContext {
  foreachNodeId: string;
  stepIndex: number;
  instanceId: string;
  baselineSha?: string;
  checkpointId?: string;
  /** Latest authoritative step-review verdict for this instance (KTD-4/KTD-6, U5).
   *  Written by the step-review handler (non-advisory only); the foreach sub-walk
   *  persists it into the instance row. */
  verdict?: "APPROVE" | "REVISE" | "RETHINK" | "UNAVAILABLE";
  /**
   * True when the foreach template contains a `step-review` node (U6/KTD-4), so a
   * successful `step-execute` must NOT mark the step done — the review's APPROVE
   * verdict is the single authority that does (`markDoneOnSuccess: false`). The
   * foreach sub-walk sets this at instance entry; the step-execute seam reads it.
   */
  deferDoneToReview?: boolean;
}

/**
 * Runs a custom (non-seam) prompt/script/gate node for a task — typically by
 * delegating to the WorkflowStep prompt-session/script machinery. Injected so
 * the graph layer stays engine-agnostic and unit-testable with fakes.
 */
export type WorkflowCustomNodeRunner = (
  node: WorkflowIrNode,
  task: TaskDetail,
  context: Record<string, unknown>,
) => Promise<WorkflowNodeResult>;

/** Resolve a node's seam name, or undefined for custom (non-seam) nodes. */
export function resolveSeamName(node: { config?: Record<string, unknown> }): WorkflowSeamName | undefined {
  const seam = node.config?.seam;
  if (seam === undefined) return undefined;
  if (
    seam === "planning" ||
    seam === "execute" ||
    seam === "review" ||
    seam === "merge" ||
    seam === "schedule" ||
    seam === "step-execute"
  ) {
    return seam;
  }
  throw new WorkflowIrError(`Unsupported workflow seam: ${String(seam)}`);
}

/**
 * Prompt/script handler: seam-configured nodes delegate to the legacy seam;
 * custom nodes run through the injected custom-node runner.
 */
export function createPromptLikeHandler(
  seams: WorkflowLegacySeams,
  runCustomNode?: WorkflowCustomNodeRunner,
): WorkflowNodeHandler {
  return async (node, context) => {
    const seam = resolveSeamName(node);
    if (seam === "step-execute") {
      // Step-inversion (U3): step-execute resolves the active foreach instance
      // from the reserved context key and runs exactly that step. The active
      // context is set by the executor's foreach sub-walk on instance entry.
      const active = context.context[FOREACH_ACTIVE_CONTEXT_KEY] as
        | ForeachActiveContext
        | undefined;
      if (!active || typeof active.stepIndex !== "number") {
        throw new WorkflowIrError(
          `step-execute node '${node.id}' reached without an active foreach instance context`,
        );
      }
      if (!seams.stepExecute) {
        // Fail closed: a step-execute node with no seam wired must NOT silently
        // succeed — that would merge a task with no step work done.
        return { outcome: "failure", value: "step-execute-unwired" };
      }
      return seams.stepExecute(context.task, context.context);
    }
    if (seam) {
      return seams[seam]!(context.task, context.context);
    }
    if (!runCustomNode) {
      throw new WorkflowIrError(`No custom-node runner registered for node: ${node.id}`);
    }
    return runCustomNode(node, context.task, context.context);
  };
}

/**
 * Gate handler. Two forms:
 * - Context gate (original scaffold contract): `config.expect` compared against
 *   a context key — pure, no execution.
 * - Executable gate: a gate node carrying a prompt/script config runs through
 *   the custom-node runner; its outcome decides whether the gate passes.
 */
export function createGateHandler(runCustomNode?: WorkflowCustomNodeRunner): WorkflowNodeHandler {
  return async (node, context) => {
    const expected = node.config?.expect;
    if (typeof expected === "string") {
      const actual = context.context[String(node.config?.contextKey ?? "outcome")];
      if (actual !== expected) {
        return { outcome: "failure", value: "gate-mismatch" };
      }
      return { outcome: "success" };
    }

    const hasExecutableConfig =
      typeof node.config?.prompt === "string" || typeof node.config?.scriptName === "string";
    if (hasExecutableConfig) {
      // Fail closed: an executable gate with no runner must NOT auto-pass — that
      // would silently bypass the gate and let the workflow continue. Mirror the
      // prompt/script handler, which throws in the same situation.
      if (!runCustomNode) {
        throw new WorkflowIrError(`No custom-node runner registered for node: ${node.id}`);
      }
      return runCustomNode(node, context.task, context.context);
    }

    return { outcome: "success" };
  };
}

/** Per-step-review-node cap on UNAVAILABLE retries before routing the
 *  `outcome:unavailable` edge (KTD-4 — mirrors the in-session
 *  `planSpecUnavailableCounts` limiter posture, executor.ts ~7297). */
const STEP_REVIEW_UNAVAILABLE_RETRY_CAP = 2;

/** Resolve a step-review node's config (KTD-4). Defaults `type` to `code` (the
 *  enforcing review level — matches the legacy code-review authority). */
function resolveStepReviewConfig(node: WorkflowIrNode, advisory: boolean): StepReviewConfig {
  const raw = (node.config ?? {}) as { type?: unknown; model?: unknown };
  const type = raw.type === "plan" ? "plan" : "code";
  const model = typeof raw.model === "string" ? raw.model : undefined;
  return { type, model, advisory };
}

/**
 * Handler for the `step-review` node kind (KTD-4, U5). Resolves the active
 * foreach instance from {@link FOREACH_ACTIVE_CONTEXT_KEY}, detects the
 * single-writer/advisory posture from {@link SPLIT_ACTIVE_CONTEXT_KEY}, delegates
 * the actual review to `seams.stepReview` (which calls `reviewStep` under the
 * semaphore and — on an authoritative APPROVE — marks the step done through the
 * projection), and maps the verdict to the outcome value the
 * `outcome:approve|revise|rethink|unavailable` edges route on:
 *
 *   - APPROVE     → `value: "approve"`  (seam already marked the step done)
 *   - REVISE      → `value: "revise"`   (rework edge, no reset — revise in place)
 *   - RETHINK     → `value: "rethink"`  (rework edge whose traversal resets, U5 foreach)
 *   - UNAVAILABLE → bounded retry (cap {@link STEP_REVIEW_UNAVAILABLE_RETRY_CAP});
 *                   still unavailable → `value: "unavailable"`
 *
 * The verdict + reworkCount are persisted via the foreach sub-walk: the handler
 * writes the latest verdict back onto the active context so the sub-walk's
 * `saveInstanceState` carries it into the instance row (KTD-6).
 */
export function createStepReviewHandler(seams: WorkflowLegacySeams): WorkflowNodeHandler {
  return async (node, ctx) => {
    const active = ctx.context[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext | undefined;
    if (!active || typeof active.stepIndex !== "number") {
      throw new WorkflowIrError(
        `step-review node '${node.id}' reached without an active foreach instance context`,
      );
    }
    if (!seams.stepReview) {
      // Fail closed: a step-review node with no seam wired must NOT silently pass
      // — that would let an unreviewed step route forward (mirrors step-execute).
      return { outcome: "failure", value: "step-review-unwired" };
    }

    const advisory = ctx.context[SPLIT_ACTIVE_CONTEXT_KEY] === true;
    const config = resolveStepReviewConfig(node, advisory);

    // UNAVAILABLE bounded retry (KTD-4): re-invoke the reviewer up to the cap,
    // mirroring the in-session planSpecUnavailableCounts limiter. A usable verdict
    // short-circuits; exhaustion routes outcome:unavailable.
    let result: StepReviewSeamResult = { verdict: "UNAVAILABLE" };
    for (let attempt = 0; attempt <= STEP_REVIEW_UNAVAILABLE_RETRY_CAP; attempt++) {
      result = await seams.stepReview(ctx.task, ctx.context, config);
      if (result.verdict !== "UNAVAILABLE") break;
    }

    // Persist the verdict onto the active context so the foreach sub-walk writes
    // it into the instance row (KTD-6). Advisory (split-branch) reviews record the
    // verdict for audit but never become the authoritative instance verdict.
    if (!advisory) {
      active.verdict = result.verdict;
    }
    const patch: Record<string, unknown> = {
      [FOREACH_ACTIVE_CONTEXT_KEY]: active,
      [`node:${node.id}:verdict`]: result.verdict,
    };

    const value =
      result.verdict === "APPROVE"
        ? "approve"
        : result.verdict === "REVISE"
        ? "revise"
        : result.verdict === "RETHINK"
        ? "rethink"
        : "unavailable";

    return { outcome: "success", value, contextPatch: patch };
  };
}

export function createDefaultNodeHandlers(
  seams: WorkflowLegacySeams,
  runCustomNode?: WorkflowCustomNodeRunner,
): Record<"prompt" | "script" | "gate" | "step-review", WorkflowNodeHandler> {
  const promptLike = createPromptLikeHandler(seams, runCustomNode);
  return {
    prompt: promptLike,
    script: promptLike,
    gate: createGateHandler(runCustomNode),
    "step-review": createStepReviewHandler(seams),
  };
}

/** Back-compat export: the original context-only gate handler. */
export const gateNodeHandler: WorkflowNodeHandler = createGateHandler();

export function createNoopLegacySeams(): WorkflowLegacySeams {
  const success = async (): Promise<WorkflowNodeResult> => ({ outcome: "success" });
  return {
    planning: success,
    execute: success,
    review: success,
    merge: success,
    schedule: success,
  };
}
