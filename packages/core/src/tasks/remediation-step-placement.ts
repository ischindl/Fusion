import type { TaskStep } from "../types/task/task-log.js";
import { resolveStepRole } from "./step-role.js";

export const REMEDIATION_VERIFICATION_STEP_NAME = "Testing & Verification";

export interface RemediationPlacementPlan {
  steps: TaskStep[];
  insertionIndex: number;
  verificationStepIndex?: number;
}

/*
FNXC:StepRoleVocabulary 2026-11-18-14:53 (RUFU-659):
The PREDICATE converges onto the shared role vocabulary; the SELECTION contract does not move. This resolver
answers for the FINAL step of the list it is given and nothing else, which is what makes the single-element
call in `packages/engine/src/execution/step-session-executor.ts`
(`resolveTrailingVerificationStepIndex([step]) === 0`) correct: it asks "is THIS step the trailing verification
gate?", not "does this list contain one?". Turning this into a scan for the last verification-role index would
flip the protecting case `recognizes only a final verification-like step` and would silently attach the
"Run a fresh verification pass after the preceding fixes:" prompt to every remediation step in a wave.

The old predicate was an unanchored /(?:testing|verification)/i over the name, i.e. the same class of defect
that refused RUFU-292 finalization. Converging it has one deliberate widening, stated rather than smuggled:
a FINAL step named `QA sign-off`, `Verify`, `Review`, `Testing` or an `Optional`-qualified verification name
now resolves as the trailing verification occurrence and earns that prompt line, which the two-word pattern
ignored. A prose tail ("Testing notes", "Add regression tests") still resolves to `undefined`.
*/
/** Return the final step only when it is the task's trailing verification gate. */
export function resolveTrailingVerificationStepIndex(steps: readonly TaskStep[]): number | undefined {
  const index = steps.length - 1;
  if (index < 0) return undefined;
  // `resolveStepRole` owns the `Step N:` and `Optional` normalization; no stripping is duplicated here.
  return resolveStepRole(steps[index]!) === "verification" ? index : undefined;
}

/*
FNXC:ReviewGatedRemediation 2026-08-28-15:11:
A completed verification step is immutable task history. Append named fixes after the existing list and append a new pending verification occurrence so every revision visibly requires a fresh verification pass before review.
*/
export function planRemediationPlacement(
  existing: readonly TaskStep[],
  appended: readonly TaskStep[],
): RemediationPlacementPlan {
  const insertionIndex = existing.length;
  if (appended.length === 0) {
    return { steps: [...existing], insertionIndex };
  }

  const verificationStepIndex = insertionIndex + appended.length;
  return {
    steps: [
      ...existing,
      ...appended,
      { name: REMEDIATION_VERIFICATION_STEP_NAME, status: "pending" },
    ],
    insertionIndex,
    verificationStepIndex,
  };
}
