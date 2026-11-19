import { describe, expect, it } from "vitest";

import type { TaskStep } from "../types/task/task-log.js";
import {
  REMEDIATION_VERIFICATION_STEP_NAME,
  planRemediationPlacement,
  resolveTrailingVerificationStepIndex,
} from "../tasks/remediation-step-placement.js";

const step = (name: string, status: TaskStep["status"] = "done", dependsOn?: number[]): TaskStep => ({
  name,
  status,
  ...(dependsOn === undefined ? {} : { dependsOn }),
});
const fix = step("Fix: handle missing workspace checkout", "pending");

describe("remediation step placement", () => {
  it("appends remediation and verification to an empty step list", () => {
    const plan = planRemediationPlacement([], [fix]);
    expect(plan).toMatchObject({ insertionIndex: 0, verificationStepIndex: 1 });
    expect(plan.steps).toEqual([
      fix,
      { name: REMEDIATION_VERIFICATION_STEP_NAME, status: "pending" },
    ]);
  });

  it("appends remediation and verification when no verification-like step exists", () => {
    const existing = [step("Implement")];
    const plan = planRemediationPlacement(existing, [fix]);
    expect(plan).toMatchObject({ insertionIndex: 1, verificationStepIndex: 2 });
    expect(plan.steps.map((entry) => entry.name)).toEqual([
      "Implement",
      fix.name,
      REMEDIATION_VERIFICATION_STEP_NAME,
    ]);
    expect(plan.steps[0]).toBe(existing[0]);
  });

  it("preserves completed verification history and appends a fresh verification pass", () => {
    const existing = [
      step("Design", "done"),
      step("Implement", "done", [0]),
      step(REMEDIATION_VERIFICATION_STEP_NAME, "done", [0, 1]),
    ];
    const plan = planRemediationPlacement(existing, [fix]);
    expect(plan).toMatchObject({ insertionIndex: 3, verificationStepIndex: 4 });
    expect(plan.steps.map((entry) => entry.name)).toEqual([
      "Design",
      "Implement",
      REMEDIATION_VERIFICATION_STEP_NAME,
      fix.name,
      REMEDIATION_VERIFICATION_STEP_NAME,
    ]);
    expect(plan.steps[2]).toBe(existing[2]);
    expect(plan.steps[2]).toMatchObject({ status: "done", dependsOn: [0, 1] });
    expect(plan.steps[4]).toEqual({ name: REMEDIATION_VERIFICATION_STEP_NAME, status: "pending" });
  });

  it("preserves a skipped trailing verification occurrence", () => {
    const existing = [step(REMEDIATION_VERIFICATION_STEP_NAME, "skipped")];
    const plan = planRemediationPlacement(existing, [fix]);
    expect(plan.steps[0]).toBe(existing[0]);
    expect(plan.steps.map((entry) => entry.status)).toEqual(["skipped", "pending", "pending"]);
  });

  it("preserves an earlier verification when documentation is trailing", () => {
    const existing = [
      step(REMEDIATION_VERIFICATION_STEP_NAME),
      step("Documentation & Delivery"),
    ];
    const plan = planRemediationPlacement(existing, [fix]);
    expect(plan).toMatchObject({ insertionIndex: 2, verificationStepIndex: 3 });
    expect(plan.steps.map((entry) => entry.name)).toEqual([
      REMEDIATION_VERIFICATION_STEP_NAME,
      "Documentation & Delivery",
      fix.name,
      REMEDIATION_VERIFICATION_STEP_NAME,
    ]);
    expect(plan.steps.slice(0, 2)).toEqual(existing);
  });

  it("keeps every completed verification occurrence across remediation waves", () => {
    const existing = [
      step(REMEDIATION_VERIFICATION_STEP_NAME),
      step("Fix: wave one", "done"),
      step(REMEDIATION_VERIFICATION_STEP_NAME),
    ];
    const plan = planRemediationPlacement(existing, [step("Fix: wave two", "pending")]);
    expect(plan.steps.filter((entry) => entry.name === REMEDIATION_VERIFICATION_STEP_NAME)).toEqual([
      existing[0],
      existing[2],
      { name: REMEDIATION_VERIFICATION_STEP_NAME, status: "pending" },
    ]);
    expect(plan.steps.map((entry) => entry.status)).toEqual(["done", "done", "done", "pending", "pending"]);
  });

  it("does not synthesize verification when there is no appended remediation", () => {
    const existing = [step("Implement"), step(REMEDIATION_VERIFICATION_STEP_NAME)];
    const plan = planRemediationPlacement(existing, []);
    expect(plan).toEqual({ steps: existing, insertionIndex: existing.length });
    expect(plan.steps[0]).toBe(existing[0]);
    expect(plan.steps[1]).toBe(existing[1]);
  });

  it("preserves absent and explicitly empty dependency declarations", () => {
    const existing = [
      step("Implicit dependency"),
      step("Independent root", "done", []),
    ];
    const plan = planRemediationPlacement(existing, [fix]);
    expect(plan.steps[0]).not.toHaveProperty("dependsOn");
    expect(plan.steps[1]?.dependsOn).toEqual([]);
    expect(plan.steps[0]).toBe(existing[0]);
    expect(plan.steps[1]).toBe(existing[1]);
    expect(plan.steps.at(-1)).not.toHaveProperty("dependsOn");
  });

  it("recognizes only a final verification-like step", () => {
    expect(resolveTrailingVerificationStepIndex([step("Testing notes"), step("Implement")])).toBeUndefined();
    expect(resolveTrailingVerificationStepIndex([step("Step 4: Testing and Verification")])).toBe(0);
    expect(resolveTrailingVerificationStepIndex([])).toBeUndefined();
  });

  /*
  FNXC:StepRoleVocabulary 2026-11-18-14:53 (RUFU-659):
  The three cases below pin what converged and what deliberately did not. The predicate above is now the same
  `resolveStepRole` the finalize guard asks; the selection rule (final step only) is untouched, because
  `packages/engine/src/execution/step-session-executor.ts` calls it with ONE step and reads `=== 0`.
  */
  it("keeps the final-step-only contract after the role convergence", () => {
    // The resolver never scans backwards: a gate-named step that is not the tail resolves to undefined.
    expect(resolveTrailingVerificationStepIndex([
      step("Testing & Verification"),
      step("Documentation & Delivery"),
    ])).toBeUndefined();
    expect(resolveTrailingVerificationStepIndex([
      step("Implement"),
      step("Testing & Verification"),
      step("Fix: wave one", "pending"),
    ])).toBeUndefined();
  });

  it("resolves the trailing gate for every anchored role label, not only the two words it knew", () => {
    // The one deliberate widening the predicate swap causes, named as a consequence: the removed
    // /(?:testing|verification)/i ignored all five, so these tails never got the executor's
    // "Run a fresh verification pass after the preceding fixes:" prompt line. They do now.
    for (const name of ["QA sign-off", "Verify", "Review", "Testing", "Optional Testing & Verification"]) {
      expect(resolveTrailingVerificationStepIndex([step("Implement"), step(name)]), name).toBe(1);
    }
  });

  it("no longer reads a prose implementation tail as the verification occurrence", () => {
    // "...testing" matched the removed substring pattern; anchored role labels do not match it.
    expect(resolveTrailingVerificationStepIndex([
      step("Implement"),
      step("Add regression testing for the guard"),
    ])).toBeUndefined();
  });

  it("still appends the canonical remediation occurrence as the trailing verification step", () => {
    const plan = planRemediationPlacement([step("Implement"), step("Add regression testing for the guard")], [fix]);
    expect(resolveTrailingVerificationStepIndex(plan.steps)).toBe(plan.verificationStepIndex);
    expect(plan.steps.at(-1)).toEqual({ name: REMEDIATION_VERIFICATION_STEP_NAME, status: "pending" });
  });
});
