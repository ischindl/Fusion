import { describe, expect, it } from "vitest";

import type { TaskStep } from "../types/task/task-log.js";
import { REMEDIATION_VERIFICATION_STEP_NAME } from "../tasks/remediation-step-placement.js";
import { isVerificationRoleStep, normalizeStepName, resolveStepRole } from "../tasks/step-role.js";

const step = (name: string | undefined, extra: Partial<TaskStep> = {}): TaskStep =>
  ({ name: name as string, status: "done", ...extra }) as TaskStep;

const remediation = { wave: 1, gate: "Code Review", gateStepId: "code-review", findingId: "F1" };

/*
FNXC:StepRoleVocabulary 2026-11-18-14:53 (RUFU-659):
These two lists ARE the invariant. RUFU-292 was refused finalization for a whole fortnight because a
prose implementation title contained the letters "test", so the positive list below is the closure of
what may be a gate and the negative list is the set of planner names that previously read as one.
Adding a name to the negative list that starts with a gate word is a role change, not a test addition.
*/
const VERIFICATION_NAMES = [
  "Testing & Verification",
  "Testing",
  "Tests",
  "Test",
  "Verify",
  "Verified behavior",
  "Verification",
  "QA",
  "QA sign-off",
  "Review",
  "Review the findings",
  // Normalized forms: parser prefix and the planner's `Optional` qualifier.
  "Step 4: Testing and Verification",
  "Step 2: Verify the fix",
  "Optional Testing & Verification",
  "optional QA sign-off",
  "  Testing & Verification  ",
];

const IMPLEMENTATION_NAMES = [
  // The measured RUFU-292 refusal: the gate word sits mid-sentence, inside the word "tested".
  "Destructive reclaim sweeps - make the activation deliberate and tested",
  "Add regression tests for the guard",
  "Update review docs",
  "Reviewed findings",
  "Reviewer-approved follow-up wiring",
  "Wire the QA hook into the scheduler",
  "Implement verification plumbing",
  "Preflight",
  "Shared attribution helper (`task-id-attribution.ts`)",
  "Documentation & Delivery",
  "Fix: inverted reclaim guard",
  "Step 3: Wire the guard",
  // `verify`/`qa` at a non-head position must not carry a step into the gate set either.
  "Re-verify main before merge",
  "Deploy and announce",
];

describe("resolveStepRole", () => {
  it("classifies every anchored role label as verification", () => {
    for (const name of VERIFICATION_NAMES) {
      expect(resolveStepRole(step(name)), name).toBe("verification");
      expect(isVerificationRoleStep(step(name)), name).toBe(true);
    }
  });

  it("keeps every prose implementation name out of the verification set", () => {
    for (const name of IMPLEMENTATION_NAMES) {
      expect(resolveStepRole(step(name)), name).toBe("implementation");
      expect(isVerificationRoleStep(step(name)), name).toBe(false);
    }
  });

  it("never lets an unanchored gate word inside a title decide the role", () => {
    // The exact substring set the removed classifier matched on, each one mid-sentence.
    for (const name of [
      "Make the activation deliberate and tested",
      "Ship it, then verify nothing regressed",
      "Instrument the review loop",
      "Document the qa handoff",
    ]) {
      expect(resolveStepRole(step(name)), name).toBe("implementation");
    }
  });

  it("reports the canonical remediation verification occurrence as verification", () => {
    // Imported here, not in the source module, so step-role never imports the placement module.
    expect(resolveStepRole(step(REMEDIATION_VERIFICATION_STEP_NAME))).toBe("verification");
  });

  it("derives the remediation role from structural provenance, not from the title", () => {
    expect(resolveStepRole(step("Fix: inverted reclaim guard", { remediation }))).toBe("remediation");
    // A name that merely looks like remediation work is still ordinary implementation work.
    expect(resolveStepRole(step("Fix: inverted reclaim guard"))).toBe("implementation");
  });

  it("resolves verification ahead of remediation provenance", () => {
    // Stated consequence: the executor's trailing-verification prompt keys on the role, and a
    // remediation wave that appended a gate-named occurrence must still get that prompt line.
    expect(resolveStepRole(step("Testing & Verification", { remediation }))).toBe("verification");
  });

  it("treats a missing or empty name as implementation work rather than guessing a gate", () => {
    expect(resolveStepRole(step(undefined))).toBe("implementation");
    expect(resolveStepRole(step(""))).toBe("implementation");
    expect(resolveStepRole(step("   "))).toBe("implementation");
    expect(resolveStepRole(step(undefined, { remediation }))).toBe("remediation");
  });

  it("strips only the parser prefix and the Optional qualifier when normalizing", () => {
    expect(normalizeStepName("Step 12: Testing & Verification")).toBe("Testing & Verification");
    expect(normalizeStepName("  Step 1: Preflight  ")).toBe("Preflight");
    expect(normalizeStepName(undefined)).toBe("");
    expect(normalizeStepName("Step 3: Wire the guard")).toBe("Wire the guard");
  });
});
