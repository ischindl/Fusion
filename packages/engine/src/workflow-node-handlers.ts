import { WorkflowIrError } from "@fusion/core";
import type { TaskDetail, WorkflowIrNode } from "@fusion/core";

import type { WorkflowNodeHandler, WorkflowNodeResult } from "./workflow-graph-executor.js";

export type WorkflowSeamName = "planning" | "execute" | "review" | "merge" | "schedule";

export interface WorkflowLegacySeams {
  /** Planning/spec stage. Built-in triage runs upstream of the interpreter
   *  today, so the default engine seam is a no-op for already-specified tasks;
   *  custom planning behavior is expressed as a custom prompt node. */
  planning: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  execute: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  review: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  merge: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  schedule: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
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
  if (seam === "planning" || seam === "execute" || seam === "review" || seam === "merge" || seam === "schedule") {
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
    if (seam) {
      return seams[seam](context.task, context.context);
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

export function createDefaultNodeHandlers(
  seams: WorkflowLegacySeams,
  runCustomNode?: WorkflowCustomNodeRunner,
): Record<"prompt" | "script" | "gate", WorkflowNodeHandler> {
  const promptLike = createPromptLikeHandler(seams, runCustomNode);
  return {
    prompt: promptLike,
    script: promptLike,
    gate: createGateHandler(runCustomNode),
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
