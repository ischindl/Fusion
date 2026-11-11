/*
FNXC:StepSingleSource 2026-11-11-07:05 (RUFU-536):
A prompt replacement re-derives the board's step list from the new document, and this merge decides
what survives. The rules are the contract, so they are pinned individually: a surviving step keeps its
own status by NAME (a renamed step is a different step and starts over), review remediation steps keep
their provenance untouched, a step the new document no longer declares is dropped, and an edge the drop
made unrepresentable is pruned rather than left to break the next step write — `updateStep` and the
foreach scheduler validate the whole persisted array, not just the step being written.

This merge is deliberately NOT the parse-steps graph node's wholesale replacement. Two actors, two
policies, one parser: unifying them would either reset execution progress on every re-publication or
let the graph node rewrite remediation status it does not own.
*/
import { describe, expect, it } from "vitest";
import type { TaskStep } from "../../types.js";
import { mergeReDerivedSteps } from "../tasks/step-rederivation.js";
import type { ParsedStep } from "../tasks/step-parsers.js";

const derived = (...names: string[]): ParsedStep[] => names.map((name) => ({ name }));

const remediation = (overrides: Partial<TaskStep> = {}): TaskStep => ({
  name: "Fix: portal workflow controls",
  status: "pending",
  remediation: { wave: 1, gate: "Code Review", gateStepId: "code-review", filePath: "src/example.ts", detail: "Inactive retained views still portal workflow controls" },
  ...overrides,
});

describe("mergeReDerivedSteps — the derived list is the plan", () => {
  it("adopts the derived order and declares a new step pending", () => {
    const previous: TaskStep[] = [{ name: "Preflight", status: "done" }, { name: "Implementation", status: "pending" }];
    const result = mergeReDerivedSteps(previous, derived("Implementation", "Preflight", "Delivery"));
    expect(result.steps.map((step) => [step.name, step.status])).toEqual([
      ["Implementation", "pending"],
      ["Preflight", "done"],
      ["Delivery", "pending"],
    ]);
    expect(result.preservedStepNames).toEqual(["Implementation", "Preflight"]);
    expect(result.droppedStepNames).toEqual([]);
    expect(result.unchanged).toBe(false);
  });

  it("carries each surviving step's status by name rather than by array position", () => {
    // Position is the execution index; a step that completed under the previous document must not
    // be re-opened just because the new document lists it later or earlier.
    const previous: TaskStep[] = [
      { name: "Preflight", status: "done" },
      { name: "Implementation", status: "done" },
      { name: "Verification", status: "in-progress" },
    ];
    const result = mergeReDerivedSteps(previous, derived("Verification", "Preflight", "Implementation"));
    expect(result.steps.map((step) => step.status)).toEqual(["in-progress", "done", "done"]);
  });

  it("treats a renamed step as a different step", () => {
    const previous: TaskStep[] = [{ name: "Testing & Verification", status: "done" }];
    const result = mergeReDerivedSteps(previous, derived("Testing and Verification"));
    expect(result.steps).toEqual([{ name: "Testing and Verification", status: "pending" }]);
    expect(result.droppedStepNames).toEqual(["Testing & Verification"]);
  });

  it("matches names ignoring layout whitespace but not case", () => {
    const previous: TaskStep[] = [{ name: "Step  One", status: "done" }, { name: "Step Two", status: "pending" }];
    const result = mergeReDerivedSteps(previous, derived("Step One", "step two"));
    expect(result.steps.map((step) => step.status)).toEqual(["done", "pending"]);
  });

  it("consumes a repeated persisted name in document order instead of reusing one row", () => {
    const previous: TaskStep[] = [
      { name: "Implementation", status: "done" },
      { name: "Implementation", status: "pending" },
    ];
    const result = mergeReDerivedSteps(previous, derived("Implementation", "Implementation", "Implementation"));
    expect(result.steps.map((step) => step.status)).toEqual(["done", "pending", "pending"]);
  });

  it("drops a step the new document no longer declares", () => {
    const previous: TaskStep[] = [
      { name: "Preflight", status: "done" },
      { name: "Old Experiment", status: "skipped" },
    ];
    const result = mergeReDerivedSteps(previous, derived("Preflight"));
    expect(result.steps.map((step) => step.name)).toEqual(["Preflight"]);
    expect(result.droppedStepNames).toEqual(["Old Experiment"]);
  });

  it("drops authored steps when the new document declares no steps at all", () => {
    // Board equals document: a document with no step headings has no steps to show. Remediation work
    // is kept, because its provenance is a review verdict and no document rewrite cancels it.
    const previous: TaskStep[] = [{ name: "Preflight", status: "done" }, remediation()];
    const result = mergeReDerivedSteps(previous, []);
    expect(result.steps.map((step) => step.name)).toEqual(["Fix: portal workflow controls"]);
    expect(result.droppedStepNames).toEqual(["Preflight"]);
  });
  it("reports the merge unchanged when the document says what the board already shows", () => {
    const previous: TaskStep[] = [{ name: "Preflight", status: "done" }, { name: "Implementation", status: "pending" }];
    const result = mergeReDerivedSteps(previous, derived("Preflight", "Implementation"));
    expect(result.unchanged).toBe(true);
    expect(result.steps).toEqual(previous);
  });
});

describe("mergeReDerivedSteps — remediation provenance and dead edges", () => {
  it("keeps a remediation step's name, status, and provenance untouched after the plan", () => {
    const previous: TaskStep[] = [
      { name: "Preflight", status: "done" },
      remediation({ status: "in-progress" }),
    ];
    const result = mergeReDerivedSteps(previous, derived("Preflight", "Implementation"));
    // The remediation step travels behind the newly derived plan, unchanged, and is never mistaken
    // for a step the document declares.
    expect(result.steps.map((step) => step.name)).toEqual(["Preflight", "Implementation", "Fix: portal workflow controls"]);
    expect(result.steps[2]).toEqual(remediation({ status: "in-progress" }));
    expect(result.steps[1]!.remediation).toBeUndefined();
    expect(result.prunedRemediationEdgeCount).toBe(0);
  });

  it("prunes a remediation edge the drop made unrepresentable and counts it", () => {
    // The edge addressed persisted index 2 — the step being dropped. Keeping it would hand the next
    // `updateStep` an out-of-range dependency and refuse the card's own step write.
    const previous: TaskStep[] = [
      { name: "Preflight", status: "done" },
      { name: "Implementation", status: "done" },
      remediation({ dependsOn: [1] }),
    ];
    const result = mergeReDerivedSteps(previous, derived("Preflight"));
    expect(result.steps.map((step) => step.name)).toEqual(["Preflight", "Fix: portal workflow controls"]);
    expect(result.steps[1]!.dependsOn).toBeUndefined();
    expect(result.steps[1]!.remediation?.gateStepId).toBe("code-review");
    expect(result.prunedRemediationEdgeCount).toBe(1);
  });

  it("keeps a remediation edge that still addresses a real step", () => {
    const previous: TaskStep[] = [
      { name: "Preflight", status: "done" },
      { name: "Implementation", status: "done" },
      remediation({ dependsOn: [0, 1] }),
    ];
    const result = mergeReDerivedSteps(previous, derived("Preflight", "Implementation"));
    expect(result.steps[2]!.dependsOn).toEqual([0, 1]);
    expect(result.prunedRemediationEdgeCount).toBe(0);
  });

  it("never re-aims a remediation step onto a different array position", () => {
    // The kept edge set is bounded by the merged prefix that existed BEFORE this remediation step was
    // appended, so a surviving edge still names the same work it named before the re-derivation.
    const previous: TaskStep[] = [
      { name: "Preflight", status: "done" },
      { name: "Implementation", status: "done" },
      remediation({ dependsOn: [1] }),
    ];
    const result = mergeReDerivedSteps(previous, derived("Preflight", "Implementation"));
    expect(result.steps[2]).toEqual(previous[2]);
  });
});

describe("mergeReDerivedSteps — an unschedulable plan is refused", () => {
  it("throws when the derived document declares a forward or out-of-range edge", () => {
    expect(() => mergeReDerivedSteps([], [{ name: "A", dependsOn: [4] }])).toThrowError(/./);
    expect(() => mergeReDerivedSteps([], [{ name: "A" }, { name: "B", dependsOn: [1] }])).toThrowError(/./);
  });

  it("carries the document's own dependency edges into the persisted list", () => {
    const result = mergeReDerivedSteps(
      [{ name: "Preflight", status: "done" }, { name: "Implementation", status: "pending" }],
      [{ name: "Preflight" }, { name: "Implementation", dependsOn: [0] }],
    );
    expect(result.steps[1]).toEqual({ name: "Implementation", status: "pending", dependsOn: [0] });
  });
});
