import { describe, expect, it } from "vitest";

import {
  StepDependencyValidationError,
  matchStepHeadings,
  parseJsonSteps,
  parseStepHeadings,
  getStepParser,
  resolveAuthoredStepHeadingOffset,
  resolveStepHeadingLabelFrame,
} from "../tasks/step-parsers.js";

/*
FNXC:StepDependencyValidation 2026-11-11-08:26 (RUFU-545):
A Markdown `(depends: N)` annotation is authored in the coordinate of the visible heading label,
because that is the number the planner is looking at while it writes the token. These tests own that
coordinate end to end: the frame the parser reads out of a heading sequence, the translation of a
token into the persisted 0-based index, the collapse of a token that names its own step, and the one
new refusal for numbering that cannot be read at all.
*/

describe("step heading label frame", () => {
  it("classifies a contiguous sequence from zero as the zero-based frame", () => {
    expect(resolveStepHeadingLabelFrame([0, 1, 2])).toEqual({ kind: "zero-based", offset: 0 });
    expect(resolveStepHeadingLabelFrame([0])).toEqual({ kind: "zero-based", offset: 0 });
  });

  it("classifies a contiguous sequence from one as the legacy fully-1-based frame", () => {
    expect(resolveStepHeadingLabelFrame([1, 2, 3])).toEqual({ kind: "fully-1-based", offset: 1 });
    expect(resolveStepHeadingLabelFrame([1])).toEqual({ kind: "fully-1-based", offset: 1 });
  });

  it.each([
    [": gaps", [0, 1, 3]],
    [": wild labels", [12, 99, 2]],
    [": duplicates", [1, 1, 2]],
    [": empty", []],
  ])("classifies an unreadable sequence as ambiguous%s", (_label, labels) => {
    expect(resolveStepHeadingLabelFrame(labels)).toEqual({ kind: "ambiguous", sortedLabels: [...labels].sort((a, b) => a - b) });
  });

  it.each([
    [0, 1, 2],
    [0],
    [1, 2, 3],
    [1],
    [0, 1, 3],
    [12, 99, 2],
    [1, 1, 2],
    [],
  ])("keeps resolveAuthoredStepHeadingOffset at its pre-RUFU-545 value for %j", (...labels) => {
    // The pre-extraction rule, restated so a drift in the shared resolver is a red test and not a
    // silent file-scope mismatch in normalizeAuthoredStepScopes.
    const legacy = [...labels].sort((a, b) => a - b);
    const expected: 0 | 1 = legacy.length > 0 && legacy.every((heading, index) => heading === index + 1) ? 1 : 0;
    expect(resolveAuthoredStepHeadingOffset(labels)).toBe(expected);
  });

  it("reads the frame from real heading matches, not from a hand-typed array", () => {
    const content = "### Step 0: A\n### Step 12: B\n### Step 99: C";
    expect(matchStepHeadings(content).map((match) => match.headingNumber)).toEqual([0, 12, 99]);
    expect(resolveStepHeadingLabelFrame(matchStepHeadings(content).map((match) => match.headingNumber)).kind).toBe("ambiguous");
  });
});

describe("markdown (depends:) annotation coordinate", () => {
  it("resolves a token to the step whose heading carries that label (RUFU-545 repro)", () => {
    const content = "### Step 0: A\n### Step 1: B\n### Step 2 (depends: 1): C";
    expect(parseStepHeadings(content)[2]?.dependsOn).toEqual([1]);
  });

  it("keeps every named predecessor in a label-authored fan-in, including the last one", () => {
    const content = [
      "### Step 0: Preflight",
      "### Step 1: A",
      "### Step 2: B",
      "### Step 3: C",
      "### Step 4: D",
      "### Step 5: Register the audit events",
      "### Step 6 (depends: 1,2,3,4,5): Fan-in",
    ].join("\n");
    const steps = parseStepHeadings(content);
    expect(steps[6]?.dependsOn).toEqual([1, 2, 3, 4, 5]);
    // The reported symptom: the immediately preceding step dropped out of the set.
    expect(steps[6]?.dependsOn).toContain(5);
  });

  it("refuses numbering it cannot read, naming the annotated heading", () => {
    const content = "### Step 0: A\n### Step 2 (depends: 0): B\n### Step 3: C";
    expect(() => parseStepHeadings(content)).toThrow(StepDependencyValidationError);
    try {
      parseStepHeadings(content);
      expect.unreachable("an annotated plan with a gap in its labels must be refused");
    } catch (error) {
      expect(error).toMatchObject({
        reason: "ambiguous-labels",
        coordinate: "markdown-position",
        dependentPosition: 2,
        stepCount: 3,
        frame: "ambiguous",
      });
      const message = (error as Error).message;
      expect(message).toContain("annotated heading 2");
      expect(message).toContain("0, 2, 3");
      expect(message).toMatch(/[Rr]enumber contiguously from 0 or from 1/);
    }
  });

  it("keeps a fully-1-based legacy document resolving exactly as before", () => {
    const content = "### Step 1: A\n### Step 2 (depends: 1): B";
    expect(parseStepHeadings(content)[1]?.dependsOn).toEqual([0]);
  });

  it("keeps refusing a zero token inside a fully-1-based document", () => {
    const content = "### Step 1: A\n### Step 2 (depends: 0): B";
    expect(() => parseStepHeadings(content)).toThrow(/zero/);
    try {
      parseStepHeadings(content);
      expect.unreachable("token 0 has no meaning in the legacy 1-based frame");
    } catch (error) {
      expect(error).toMatchObject({ reason: "zero", frame: "fully-1-based", dependentPosition: 2 });
    }
  });

  it("collapses a token that names its own step onto the preceding step instead of refusing it", () => {
    const content = Array.from({ length: 9 }, (_, index) =>
      index === 0 ? "### Step 0: Preflight" : `### Step ${index} (depends: ${index}): Step ${index}`,
    ).join("\n");
    const steps = parseStepHeadings(content);
    expect(steps[8]?.dependsOn).toEqual([7]);
    expect(steps.map((step) => step.dependsOn)).toEqual([undefined, 0, 1, 2, 3, 4, 5, 6, 7].map((value) => (value === undefined ? undefined : [value])));
  });

  it("merges a self-trailing fan-in as a set without a duplicate refusal", () => {
    expect(parseStepHeadings("### Step 0: A\n### Step 1: B\n### Step 2: C\n### Step 3: D\n### Step 4: E\n### Step 5 (depends: 4,5): F")[5]?.dependsOn).toEqual([4]);
  });

  it("keeps a self token on the very first step an explicit empty set", () => {
    const steps = parseStepHeadings("### Step 0 (depends: 0): Preflight\n### Step 1: B");
    expect(steps[0]?.dependsOn).toEqual([]);
  });

  it("makes a zero token legal in a zero-based document, where it names Preflight", () => {
    const content = "### Step 0: Preflight\n### Step 1: B\n### Step 2 (depends: 0,1): C\n### Step 3 (depends: 0): D";
    const steps = parseStepHeadings(content);
    // Both named predecessors survive. The task spec sketched `[0]` here, but that is the position
    // reading: under the label coordinate `(depends: 0,1)` names two headings, and dropping one of
    // them is the exact bug this task exists to remove.
    expect(steps[2]?.dependsOn).toEqual([0, 1]);
    expect(steps[3]?.dependsOn).toEqual([0]);
    expect(steps[1]?.dependsOn).toBeUndefined();
    expect(parseStepHeadings("### Step 0: Preflight\n### Step 1 (depends: 0): B")[1]?.dependsOn).toEqual([0]);
  });

  it("resolves and refuses identically through the registry-registered parser", () => {
    // The engine consumes the registry entry, never `parseStepHeadings` directly, so the shipped
    // behaviour is whatever the registered parser does. Both the resolved edges and the refusal
    // class must be identical through it (the entry trims `status`, everything else transfers).
    const registered = getStepParser("step-headings");
    const fanIn = [
      "### Step 0: Preflight",
      "### Step 1: Establish the contract fails",
      "### Step 2: Implement",
      "### Step 3: Test",
      "### Step 4: Verify",
      "### Step 5: Deliver",
      "### Step 6 (depends: 1,2,3,4,5): Commit and finalize",
    ].join("\n");
    expect(registered!.parse(fanIn).steps).toEqual(
      parseStepHeadings(fanIn).map((step) => ({ name: step.name, dependsOn: step.dependsOn })),
    );
    expect(registered!.parse(fanIn).steps[6]?.dependsOn).toEqual([1, 2, 3, 4, 5]);

    const unreadable = "### Step 0: Preflight\n### Step 2 (depends: 0): Implement";
    try {
      registered!.parse(unreadable);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        reason: "ambiguous-labels",
        dependentPosition: 2,
        coordinate: "markdown-position",
      });
    }
    // The other registered source keeps its own coordinate: JSON `depends` stays a 0-based index.
    const json = getStepParser("json-steps")!.parse(
      JSON.stringify([{ name: "A" }, { name: "B", depends: [0] }]),
    );
    expect(json.steps).toEqual([{ name: "A" }, { name: "B", dependsOn: [0] }]);
  });

  it("cannot close a cycle in the label coordinate, because the closing edge refuses as self-or-forward", () => {
    // Every legal token names an EARLIER heading, so no set of label edges can form a cycle: the edge
    // that would close one points at or past its own step. The structural validator stays the backstop
    // for persisted plugin/JSON graphs, whose indices arrive with no heading to compare against.
    const closing = ["### Step 0: A (depends: 1)", "### Step 1: B (depends: 0)"].join("\n");
    try {
      parseStepHeadings(closing);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ reason: "self-or-forward", coordinate: "markdown-position" });
    }
    expect(parseStepHeadings("### Step 0: A\n### Step 1: B (depends: 0)")[1]?.dependsOn).toEqual([0]);
  });

  it("keeps json-steps dependencies as 0-based document indices", () => {
    // The two coordinates stay separate by parser, not by document. A `depends: [2]` in a JSON plan
    // means storage index 2 under the new rule exactly as under the old one.
    const steps = parseJsonSteps(JSON.stringify([
      { name: "Preflight" },
      { name: "Implement", depends: [0] },
      { name: "Verify", depends: [0, 1] },
    ])).steps;
    expect(steps.map((step) => step.dependsOn)).toEqual([undefined, [0], [0, 1]]);
    expect(() => parseJsonSteps(JSON.stringify([{ name: "A" }, { name: "B", depends: [1] }])))
      .toThrow(/self-or-forward/);
  });
});
