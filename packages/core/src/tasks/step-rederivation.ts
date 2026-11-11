/*
FNXC:StepSingleSource 2026-11-11-07:05 (RUFU-536):
A card's step list must be derived from exactly one document — its durable PROMPT.md — and a prompt
replacement must re-derive it. Until this module, `updateTask({ prompt })` wrote the document and
left `task.steps` at whatever the previous generation had persisted, while the read paths re-derived
only when the stored array was EMPTY. A card whose newest document carried a different plan therefore
kept showing the older plan's steps: measured live on RUFU-519, eight board steps whose names were an
earlier generation of the same card's own plan, while the durable document described a different
eight. The array position is the execution index for the executor's per-step sessions, so a lagging
list is not cosmetic — it points the executor at step titles that no longer exist in the spec.

Merging (rather than wholesale replacement) is what keeps that honest. The parse-steps graph node
replaces the entire list and preserves remediation status as a whole list (see
`packages/engine/src/workflow-node-runners/parse-steps-runner.ts`); that is a different contract
belonging to a different actor, and this merge deliberately does the opposite: it keeps each
SURVIVING step's own status by name, so re-publishing a document never resets execution progress.
Two policies, one parser — the shapes differ on purpose and must not be unified.

Rules, in order:
1. The freshly derived list defines which steps exist, in what order, and which edges they declare.
2. A step that survives by name keeps its persisted status. Matching is by normalized name, and a
   repeated name is consumed in document order, because a renamed step is a different step.
3. Review remediation steps are kept untouched with their `dependsOn` provenance. Redistributing a
   remediation step's provenance onto a different array position would silently re-aim a reviewer's
   named correction at other work.
4. A step that is gone is gone: it is dropped, and a later generation cannot resurrect it by index.
5. An edge the merge made unrepresentable is refused for authored steps and pruned for remediation
   steps, for the reason recorded on `prunedRemediationEdgeCount`.
*/

import type { TaskStep } from "../types.js";
import { isRemediationStep } from "./remediation-steps.js";
import { validateStepDependencies, type ParsedStep } from "./step-parsers.js";

export interface StepReDerivationResult {
  /** The list to persist: derived order, statuses carried over, remediation steps appended last. */
  steps: TaskStep[];
  /** Authored steps the new document no longer declares (rule 4). */
  droppedStepNames: string[];
  /** Authored steps whose persisted status this re-derivation carried over (rule 2). */
  preservedStepNames: string[];
  /**
   * Remediation edges the drop made unrepresentable and therefore removed.
   *
   * `updateStep` and the foreach scheduler validate the WHOLE persisted array, so a remediation edge
   * pointing past a shortened list would break the card's next step write rather than be ignored.
   * Pruning the dead edge is the minimal repair that leaves the remediation step itself — its name,
   * status, and finding provenance — untouched, which is what the lifecycle gates actually read.
   */
  prunedRemediationEdgeCount: number;
  /** True when the merged list is identical to the persisted one, so callers may skip the write. */
  unchanged: boolean;
}

/** Normalize a step name for survival matching: trimmed, whitespace-collapsed, case-sensitive. */
function stepNameKey(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/**
 * Merge a freshly derived step list onto the persisted one.
 *
 * `derived` must come from the same registry parse the read paths use, over the same bytes the
 * document now holds. Throws `StepDependencyValidationError` when the derived plan's own edges are
 * invalid — a plan that cannot be scheduled is refused, never persisted in a repaired shape.
 */
export function mergeReDerivedSteps(
  previous: readonly TaskStep[],
  derived: readonly ParsedStep[],
): StepReDerivationResult {
  // The derived list is the plan; validate it in its own coordinate system before anything is merged.
  validateStepDependencies(derived);

  const priorAuthored = previous.filter((step) => !isRemediationStep(step));
  const priorRemediation = previous.filter((step) => isRemediationStep(step));

  // Rule 2: first unconsumed occurrence of the same name wins.
  const survivors = new Map<string, TaskStep[]>();
  for (const step of priorAuthored) {
    const queue = survivors.get(stepNameKey(step.name));
    if (queue) queue.push(step);
    else survivors.set(stepNameKey(step.name), [step]);
  }

  const preservedStepNames: string[] = [];
  const steps: TaskStep[] = derived.map((entry) => {
    const survivor = survivors.get(stepNameKey(entry.name))?.shift();
    const dependsOn = Array.isArray(entry.dependsOn) ? [...entry.dependsOn] : undefined;
    if (!survivor) {
      return dependsOn ? { name: entry.name, status: "pending" as const, dependsOn } : { name: entry.name, status: "pending" as const };
    }
    preservedStepNames.push(entry.name);
    if (survivor.status === "pending" && !dependsOn) return { name: entry.name, status: survivor.status };
    const carried: TaskStep = { name: entry.name, status: survivor.status };
    if (dependsOn) carried.dependsOn = dependsOn;
    return carried;
  });

  const preserved = new Set(preservedStepNames.map(stepNameKey));
  const droppedStepNames = priorAuthored
    .filter((step) => !preserved.has(stepNameKey(step.name)))
    .map((step) => step.name);

  // Rule 3: remediation steps keep name, status, and provenance; they are appended after the plan.
  let prunedRemediationEdgeCount = 0;
  const merged = [...steps];
  for (const step of priorRemediation) {
    const mergedIndex = merged.length;
    const carries = (step.dependsOn ?? []).filter((dependency) =>
      Number.isInteger(dependency) && dependency >= 0 && dependency < mergedIndex,
    );
    prunedRemediationEdgeCount += (step.dependsOn?.length ?? 0) - carries.length;
    const kept: TaskStep = { ...step };
    if (step.dependsOn) {
      if (carries.length > 0) kept.dependsOn = carries;
      else delete kept.dependsOn;
    }
    merged.push(kept);
  }

  // The persisted array is what every later validator reads, so prove it valid before returning it.
  validateStepDependencies(merged);

  return {
    steps: merged,
    droppedStepNames,
    preservedStepNames,
    prunedRemediationEdgeCount,
    unchanged: sameStepList(previous, merged),
  };
}

function sameStepList(left: readonly TaskStep[], right: readonly TaskStep[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((step, index) => {
    const other = right[index]!;
    const sameEdges = (step.dependsOn ?? []).join(",") === (other.dependsOn ?? []).join(",");
    return step.name === other.name && step.status === other.status && sameEdges && step.remediation === other.remediation;
  });
}
