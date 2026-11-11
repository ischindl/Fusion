import { describe, expect, it } from "vitest";

import {
  StepDependencyValidationError,
  matchStepHeadings,
  parseJsonSteps,
  parseStepHeadings,
  validateStepDependencies,
} from "../tasks/step-parsers.js";

/*
FNXC:StepDependencyValidation 2026-11-11-09:05 (RUFU-545):
These cases own token *classification* (negative / malformed / duplicate / out-of-range /
self-or-forward) rather than the frame the tokens live in, which
`step-parsers-heading-frame.test.ts` owns. The shared base document is contiguous from 0 and the
annotated heading is the middle one, because the annotated step must not be the last: its own label
is then a legal token (the redundant-token collapse) instead of a refusal, and the class under test
would silently disappear. The `zero` class is absent from this table by design — a `0` token is legal
in a zero-based document and only refuses inside the legacy fully-1-based frame, so it is covered
against that frame in the heading-frame file rather than here.
*/

const BASE_DOC = [
  "### Step 0: One",
  "### Step 1: Two",
  "### Step 2 (depends: TOKEN): Three",
  "### Step 3: Four",
];

function docWith(token: string): string {
  return BASE_DOC.map((line) => line.replace("TOKEN", token)).join("\n");
}

describe("step parser dependency indexing", () => {
  it("resolves a prefix annotation by its authored label, which is not its parse position", () => {
    // The legacy shape the parser still reads: headings numbered from 1. Label `1` is the FIRST step,
    // so a token cannot be read as the number's own position — that off-by-one is what RUFU-545 removes.
    const content = ["### Step 1: First", "### Step 2: Second", "### Step 3 (depends: 1): Third"].join("\n");
    expect(matchStepHeadings(content).map((match) => match.headingNumber)).toEqual([1, 2, 3]);
    // Only an annotated heading produces a `dependsOn`; the previous-step default stays a downstream
    // projection rule, which is why an unannotated plan remains sequential without materialising edges.
    const steps = parseStepHeadings(content);
    expect(steps.map((step) => step.dependsOn)).toEqual([undefined, undefined, [0]]);
  });

  it("resolves every named label in a zero-based document, including the very first one", () => {
    const content = ["### Step 0: First", "### Step 1: Second", "### Step 2 (depends: 0,1): Third"].join("\n");
    const steps = parseStepHeadings(content);
    expect(steps.map((step) => step.dependsOn)).toEqual([undefined, undefined, [0, 1]]);
  });

  it("refuses a document whose wild heading labels are not a readable sequence", () => {
    // The matcher still reports the labels it found — only their translation is refused, and the
    // refusal names the annotated heading so the author knows which line to fix.
    const content = [
      "### Step 0: First",
      "### Step 12: Second",
      "### Step 99: Third",
      "### Step 12 (depends: 1,2): Fourth",
    ].join("\n");
    expect(matchStepHeadings(content).map((match) => match.headingNumber)).toEqual([0, 12, 99, 12]);
    try {
      parseStepHeadings(content);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StepDependencyValidationError);
      expect(error).toMatchObject({
        reason: "ambiguous-labels",
        dependentPosition: 4,
        token: "1,2",
        coordinate: "markdown-position",
      });
      expect((error as Error).message).toContain("0, 12, 12, 99");
    }
  });

  it.each([0, 1])("accepts legacy suffix dependencies for contiguous headings starting at %s", (offset) => {
    const steps = parseStepHeadings([
      `### Step ${offset}: Preflight`,
      `### Step ${offset + 1}: Implement (depends: ${offset})`,
      `### Step ${offset + 2}: Check (depends: ${offset},${offset + 1})`,
    ].join("\n"));
    expect(steps.map(step => ({ name: step.name, dependsOn: step.dependsOn }))).toEqual([
      { name: "Preflight", dependsOn: undefined }, { name: "Implement", dependsOn: [0] }, { name: "Check", dependsOn: [0, 1] },
    ]);
  });

  it("preserves an explicit independent root in a legacy suffix", () => {
    expect(parseStepHeadings("### Step 0: First\n### Step 1: Independent (depends:)")[1])
      .toEqual({ name: "Independent", status: "pending", dependsOn: [] });
  });

  it("resolves both annotation forms in the one label coordinate, while the suffix keeps its document-order gate", () => {
    // RUFU-545 removed the second coordinate: a prefix token and a suffix token in the same document
    // name the same authored heading. What still differs is the gate each form applies — the prefix
    // form asks whether the labels can be READ, the suffix form asks whether they ASCEND in document
    // order — so the identical shape refuses with a different reason per form.
    const mixed = "### Step 0: First\n### Step 1 (depends: 1): Second\n### Step 2: Third (depends: 1)";
    expect(parseStepHeadings(mixed).map(step => step.dependsOn)).toEqual([undefined, [0], [1]]);

    const outOfOrder = "### Step 0: First\n### Step 2: Second";
    expect(() => parseStepHeadings(`${outOfOrder} (depends: 0)`)).toThrow(StepDependencyValidationError);
    try {
      parseStepHeadings(`${outOfOrder} (depends: 0)`);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ reason: "malformed", coordinate: "markdown-position" });
    }
    try {
      parseStepHeadings(`${outOfOrder}\n### Step 3 (depends: 0): Third`);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ reason: "ambiguous-labels", dependentPosition: 3 });
    }
  });

  it("preserves omitted dependencies and explicit roots", () => {
    const steps = parseStepHeadings("### Step 12: First\n### Step 42 (depends:): Independent");
    expect(steps[0]).not.toHaveProperty("dependsOn");
    expect(steps[1]?.dependsOn).toEqual([]);
  });

  it.each([
    ["-1", "negative"],
    ["no", "malformed"],
    ["1,1", "duplicate"],
    ["8", "out-of-range"],
    ["3", "self-or-forward"],
  ] as const)("rejects invalid Markdown token %s as %s", (token, reason) => {
    const content = docWith(token);
    expect(() => parseStepHeadings(content)).toThrow(StepDependencyValidationError);
    try { parseStepHeadings(content); } catch (error) {
      expect(error).toMatchObject({ dependentPosition: 3, token: token === "1,1" ? "1" : token, reason, coordinate: "markdown-position" });
    }
  });

  it.each([
    "### Step 0: First\n### Step 2: Gap (depends: 0)",
    "### Step 0: First\n### Step 0: Duplicate (depends: 0)",
    "### Step 0: First\n### Step 1: Self (depends: 1)",
    "### Step 0: First (depends: 1)\n### Step 1: Cycle (depends: 0)",
    "### Step 0: First\n### Step 1: Missing (depends: 8)",
    "### Step 0: First\n### Step 1: Invalid (depends: -1)",
    "### Step 0: First\n### Step 1: Invalid (depends: 0,0)",
    "### Step 0: First\n### Step 1: Invalid (depends: nope)",
    "### Step 0: First\n### Step 1 (depends: 1): Duplicate declaration (depends: 0)",
  ])("rejects invalid or unreadable Markdown dependency annotations: %s", (content) => {
    expect(() => parseStepHeadings(content)).toThrow(StepDependencyValidationError);
  });

  it("names the authored label range in the out-of-range diagnostic", () => {
    // The token the author wrote is a label, so the remedy has to say which labels exist. The old
    // message named 1-based positions, which pointed the author at a coordinate they never used.
    const content = Array.from({ length: 7 }, (_, index) =>
      index === 3 ? "### Step 3 (depends: 99): Four" : `### Step ${index}: Item ${index + 1}`,
    ).join("\n");
    expect(() => parseStepHeadings(content)).toThrow("step 4 depends on out-of-range step 99 (authored labels: 0-6)");
  });

  it("keeps the storage-index diagnostic in persisted positions", () => {
    expect(() => validateStepDependencies([{ dependsOn: [] }, { dependsOn: [9] }]))
      .toThrow("step 2 depends on out-of-range step 10 (valid positions: 1-2)");
  });

  it("rejects invalid persisted plugin or JSON graph edges without reinterpreting them", () => {
    expect(() => validateStepDependencies([{ dependsOn: [] }, { dependsOn: [2] }])).toThrow("out-of-range step 3");
    expect(() => validateStepDependencies([{ dependsOn: [] }, { dependsOn: [2] }, { dependsOn: [] }])).toThrow(/self-or-forward/);
    expect(() => validateStepDependencies([{ dependsOn: [1] }, { dependsOn: [0] }])).toThrow(/self-or-forward/);
    expect(() => parseJsonSteps(JSON.stringify([{ name: "First" }, { name: "Second", depends: [1] }]))).toThrow(/self-or-forward/);
    expect(() => parseJsonSteps(JSON.stringify([{ name: "First" }, { name: "Second", depends: [0, 0] }]))).toThrow(/duplicate/);
  });

  it("keeps JSON dependencies as 0-based document indices", () => {
    expect(parseJsonSteps(JSON.stringify([{ name: "First" }, { name: "Second", depends: [0] }])).steps).toEqual([
      { name: "First" },
      { name: "Second", dependsOn: [0] },
    ]);
  });
});
