import type { TaskStep } from "../types/task/task-log.js";
import { isRemediationStep } from "./remediation-steps.js";

/*
FNXC:StepRoleVocabulary 2026-11-18-14:53 (RUFU-659):
One code-owned answer to "what kind of work is this step?", shared by every consumer that has to decide
whether SKIPPED step evidence is missing quality work.

The measured failure this replaces: RUFU-292's card was complete, reviewer-approved over the canonical
empty review input, and zero commits ahead of `main`, yet it could not finalize. The zero-diff finalize
guard carried `const VERIFICATION_STEP_NAME = /test|verif|qa|review/i` and filtered its skipped steps with
it, so the planner-generated implementation step "Destructive reclaim sweeps - make the activation
deliberate and tested" fell into the verification bucket on the substring "test" inside "tested" and the
guard refused with `skipped verification step(s) with no net branch changes: ...` forever. That single card
then pinned both execution slots behind its file-scope lease (a review-lane holder is excluded from the
dormant-proof candidate set, so `checkoutEmptiness` stayed absent and "absent keeps the lease" kept it
`active`), and 317 Todo cards re-queued every cycle.

The rule this module encodes: **a step's TITLE is never a role verdict.** A role comes from (1) an
anchored role label at the HEAD of the name, after normalization, or (2) structural remediation
provenance (`step.remediation`, owned by `isRemediationStep`). An unanchored substring test over a
planner-written name may not exist anywhere: prose like "make it tested", "Add regression tests for the
guard", or "Reviewed findings" is implementation work, and every one of those contains a gate word.

Deliberate direction of the tightening: anchored labels make the verification set strictly SMALLER than
the old substring set, so a card whose only "verification-like" step is prose-named loses the
`verifiedIntentionalNoOp` exception and hits the FN-6461 ratio arm instead. Stricter is allowed; looser
never is, because a mis-filed skip that finalizes is the FN-8141 laundering shape.
*/
export type StepRole = "implementation" | "verification" | "remediation";

/** Parser/planner prefix that decorates a persisted step name without being part of its role. */
const STEP_NUMBER_PREFIX = /^\s*Step\s+\d+\s*:\s*/i;

/*
FNXC:StepRoleVocabulary 2026-11-18-14:53 (RUFU-659):
Anchored at the head, with a word-boundary lookahead so an inflected or compound word cannot borrow a
label: "Reviewed findings" is implementation because `review` is followed by `e`, while `Review`,
`Review the findings`, `QA sign-off`, `Verify`, `Testing` and `Testing & Verification` are verification.
The `Optional` qualifier is stripped in the same anchor because the planner prefixes conditional steps
with it and `Optional Testing & Verification` is still the verification gate.
*/
const VERIFICATION_ROLE_LABEL =
  /^(?:optional\s+)?(?:testing|tests?|verification|verif(?:y|ied|ication)|qa|reviews?)(?![a-z])/i;

/** Strip the `Step N:` prefix and surrounding whitespace; role identity lives in the remaining label. */
export function normalizeStepName(name: string | undefined): string {
  return (name ?? "").replace(STEP_NUMBER_PREFIX, "").trim();
}

/**
 * Resolve one step's role. Verification identity is checked FIRST so a remediation-marked step named
 * like a gate still reads as verification (that is what keeps the executor's fresh-verification prompt
 * line firing for it); remediation provenance is next; ordinary work is the default, never a guess.
 */
export function resolveStepRole(step: TaskStep): StepRole {
  if (VERIFICATION_ROLE_LABEL.test(normalizeStepName(step.name))) return "verification";
  if (isRemediationStep(step)) return "remediation";
  return "implementation";
}

/** Consumer-facing predicate for the gate role alone; callers deciding on MISSING quality work want
 * `resolveStepRole(step) !== "implementation"`, which also catches skipped remediation work. */
export function isVerificationRoleStep(step: TaskStep): boolean {
  return resolveStepRole(step) === "verification";
}
