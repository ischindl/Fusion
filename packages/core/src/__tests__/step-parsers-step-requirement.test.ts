import { describe, expect, it } from "vitest";

/*
FNXC:PlanArtifactIntegrity 2026-11-13-01:05 (RUFU-693):
These two predicates are the whole contract between a plan being published and a plan being executable.
They are asserted against the REAL `step-headings` parser rather than a restated regex, because the
parser's heading tolerance is the fact that matters: `matchStepHeadings` requires `### Step <n>` followed
by a colon and a non-empty title, so a bare `### Step 1` and an empty `### Step 1:` are NOT steps. The
plan-write refusal (engine) and the parse node (graph) both decide from these predicates, so a test that
guessed the tolerance would let the two sides disagree while staying green.
*/
import {
  promptDeclaresNoCommitsExpected,
  promptLacksRequiredImplementationSteps,
} from "../tasks/step-parsers.js";

describe("promptLacksRequiredImplementationSteps", () => {
  it("does not flag a plan that carries a numbered step heading with a title", () => {
    const content = [
      "## Steps",
      "### Step 0: Preflight",
      "- [ ] read the file",
      "### Step 1: Change the behaviour",
      "- [ ] edit it",
    ].join("\n");
    expect(promptLacksRequiredImplementationSteps(content)).toBe(false);
  });

  it("flags prose-only plan as having no executable step", () => {
    const content = [
      "# Task: RUFU-518 - Cold-engine project scope must not borrow the launch project's onMerge",
      "## What to do",
      "Fix the routing so the target project's onMerge runs.",
      "## Surface Enumeration",
      "- packages/dashboard/src/routes/register-task-workflow-routes.ts",
    ].join("\n");
    expect(promptLacksRequiredImplementationSteps(content)).toBe(true);
  });

  it("accepts plain `### Heading` entries inside a `## Steps` section, which is the parser's documented fallback", () => {
    /*
    Measured, not assumed: `step-headings` first tries `### Step <n><...>: <title>` and falls back to
    plain `### Heading` entries when they sit inside `## Steps`. So an unnumbered plan is executable and
    must NOT be refused, even though it is not the authored shape. The refusible case is a plan with no
    step section at all, asserted above.
    */
    const content = [
      "## Steps",
      "### Gather context",
      "### Implement",
      "### Verify",
    ].join("\n");
    expect(promptLacksRequiredImplementationSteps(content)).toBe(false);
  });

  it("honours the parser tolerance: a heading without a colon is not a step", () => {
    expect(promptLacksRequiredImplementationSteps("### Step 1 Do the thing\n")).toBe(true);
  });

  it("honours the parser tolerance: a colon with an empty title is not a step", () => {
    expect(promptLacksRequiredImplementationSteps("### Step 1:\n")).toBe(true);
  });

  it("accepts an authored zero-based first step, which is the frame most plans use", () => {
    expect(promptLacksRequiredImplementationSteps("### Step 0: Preflight\n- [ ] look\n")).toBe(false);
  });
});

describe("promptDeclaresNoCommitsExpected", () => {
  it("recognises the declared form", () => {
    expect(promptDeclaresNoCommitsExpected("**No commits expected:** true")).toBe(true);
    expect(promptDeclaresNoCommitsExpected("**No commits expected:** yes")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(promptDeclaresNoCommitsExpected("**NO COMMITS EXPECTED:** TRUE")).toBe(true);
  });

  it("matches on any line, not only the first", () => {
    const content = [
      "# Task: RUFU-999 - Answer a question",
      "## Original Description",
      "Some prose about the question.",
      "",
      "**No commits expected:** true",
    ].join("\n");
    expect(promptDeclaresNoCommitsExpected(content)).toBe(true);
  });

  it("does not fire on unrelated prose about commits", () => {
    expect(promptDeclaresNoCommitsExpected("This card makes no commits and that is fine.")).toBe(false);
  });
});

describe("the two predicates stay separate", () => {
  it("a no-commits plan still lacks steps, and the exemption is a separate decision", () => {
    const content = "## Original Description\n**No commits expected:** true\n";
    expect(promptLacksRequiredImplementationSteps(content)).toBe(true);
    expect(promptDeclaresNoCommitsExpected(content)).toBe(true);
  });
});
