import { describe, expect, it } from "vitest";

import { BASELINE_PROMPT, createPromptWriteHarness, stepNames } from "./prompt-write-harness.js";

/**
 * RUFU-536 — the step-list half of an authoritative publication.
 *
 * The board step list is a projection of `PROMPT.md`, so publishing a new document must re-derive it in the
 * same write. Four things must hold at once: the document decides which steps exist and in what order; a step
 * that survives by name keeps its own status (a re-publish must never reset execution progress); a step the
 * new document no longer declares is dropped and named on the card; and review remediation steps keep their
 * provenance. A caller that passes `steps` explicitly is a deliberate list write and wins — that is the
 * `parse-steps` node's policy, not this one.
 */
describe("a prompt publication re-derives the board step list", () => {
  const RENAMED = [
    "# Replacement spec",
    "",
    "## Mission",
    "",
    "Same Preflight, new second half.",
    "",
    "## Steps",
    "",
    "### Step 0: Preflight",
    "Still the first step.",
    "### Step 1: Refactor",
    "A different second step.",
    "### Step 2: Confirm",
    "A different third step.",
    "",
  ].join("\n");

  it("adopts the new document's steps, keeping the status of the step that survived by name", async () => {
    const harness = createPromptWriteHarness({});
    await harness.publish(BASELINE_PROMPT);
    expect(stepNames(harness.durableSteps())).toEqual(["Preflight", "Implement", "Verify", "Deliver"]);

    await harness.publish(RENAMED);

    expect(stepNames(harness.durableSteps())).toEqual(["Preflight", "Refactor", "Confirm"]);
    expect(harness.durableSteps()[0]).toMatchObject({ name: "Preflight", status: "done" });
    expect(harness.durableSteps()[1]).toMatchObject({ name: "Refactor", status: "pending" });
    expect(harness.durableSteps()[2]).toMatchObject({ name: "Confirm", status: "pending" });
  });

  it("names the dropped steps in a task-history entry", async () => {
    const harness = createPromptWriteHarness({});
    await harness.publish(BASELINE_PROMPT);

    await harness.publish(RENAMED);

    const entry = harness.reDerivationLog();
    expect(entry).toContain("Step list re-derived from PROMPT.md");
    expect(entry).toContain("Implement");
    expect(entry).toContain("Verify");
  });

  it("keeps review remediation steps, their status, and their provenance when the new document drops the step it repairs", async () => {
    const harness = createPromptWriteHarness({
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "done" },
        { name: "Address review findings", status: "pending", remediation: { stepId: "code-review" } },
      ],
    });
    await harness.publish(BASELINE_PROMPT);

    await harness.publish(RENAMED);

    const remediation = harness.durableSteps().find((step) => step.remediation);
    expect(remediation).toMatchObject({
      name: "Address review findings",
      status: "pending",
      remediation: { stepId: "code-review" },
    });
  });

  it("leaves an empty board list when the new document declares no steps", async () => {
    const harness = createPromptWriteHarness({});
    await harness.publish(BASELINE_PROMPT);

    await harness.publish("# Bare spec\n\n## Mission\n\nNo step headings here.\n");

    expect(harness.durableSteps()).toEqual([]);
    expect(harness.reDerivationLog()).toContain("dropped");
  });

  it("does not override an explicit steps write", async () => {
    const harness = createPromptWriteHarness({});
    await harness.publish(BASELINE_PROMPT);
    const explicit = [{ name: "Graph-owned step", status: "pending" as const }];

    await harness.publishWithStepWrite(RENAMED, explicit);

    expect(stepNames(harness.durableSteps())).toEqual(["Graph-owned step"]);
    expect(harness.reDerivationLog()).toBeUndefined();
  });

  it("never turns a step quoted inside the operator-request region into a board step", async () => {
    const harness = createPromptWriteHarness({});
    await harness.publish(BASELINE_PROMPT);

    const quoted = [
      "# Current plan",
      "",
      "<!-- fusion-original-description:start -->",
      "The operator pasted an older plan:",
      "",
      "### Step 0: Quoted in the request",
      "This text is evidence of what was asked, not a step to run.",
      "<!-- fusion-original-description:end -->",
      "",
      "## Mission",
      "",
      "Do the real work.",
      "",
      "## Steps",
      "",
      "### Step 0: Survey",
      "Read the tree.",
      "### Step 1: Change",
      "Edit the code.",
      "",
    ].join("\n");

    await harness.publish(quoted);

    expect(stepNames(harness.durableSteps())).toEqual(["Survey", "Change"]);
  });
});
