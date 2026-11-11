import { describe, expect, it } from "vitest";

import {
  PROMPT_STEP_PARSER_ID,
  matchStepHeadings,
  parseStepHeadings,
} from "../tasks/step-parsers.js";

/*
FNXC:StepSingleSource 2026-11-11-07:05:
RUFU-536 requires that a card's board step list derives from exactly the document the registry's
`step-headings` parser reads, and that the operator's quoted request text can never be read as authored
structure. Two independent properties make that safe, and both were untested before this change:
1. the parser's view of the document excludes the generated `## Original Description` region, so a plan the
   operator pasted into their own request cannot contribute steps;
2. `matchStepHeadings` returns offsets into the CALLER's raw bytes even though the scan runs over masked
   text — every consumer (`step-session-executor.ts`, `reviewer.ts`, the spec-validation reader) slices the
   unmasked document with them, so a mask that changed byte length would silently mis-slice every step body.
*/

const QUOTED_STEP_DOC = [
  "# Current plan",
  "",
  "<!-- fusion-original-description:start -->",
  "The operator asked for the old plan back, verbatim:",
  "",
  "### Step 0: Quoted from last time",
  "Quoted instructions are evidence of what was asked, not a step to run.",
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

describe("step-headings parser reads only the authored document", () => {
  it("ignores step headings quoted inside the operator-request region", () => {
    expect(parseStepHeadings(QUOTED_STEP_DOC).map((step) => step.name)).toEqual(["Survey", "Change"]);
  });

  it("reports offsets that still address the caller's raw document", () => {
    const matches = matchStepHeadings(QUOTED_STEP_DOC);

    expect(matches).toHaveLength(2);
    for (const match of matches) {
      // The scan sees masked bytes; the offsets must still land on the caller's unmasked text, because
      // consumers slice the raw document with them.
      expect(QUOTED_STEP_DOC.slice(match.index, match.index + match.match.length)).toBe(match.match);
      expect(QUOTED_STEP_DOC.slice(match.index, match.headingLineEnd).startsWith("### Step")).toBe(true);
    }
  });

  it("parses CRLF and LF documents to the same step list", () => {
    const crlf = QUOTED_STEP_DOC.replace(/\n/g, "\r\n");

    expect(parseStepHeadings(crlf)).toEqual(parseStepHeadings(QUOTED_STEP_DOC));
  });

  it("never reads a `## Steps` heading out of the quoted region", () => {
    const quotedStepsHeading = [
      "# Plan",
      "",
      "<!-- fusion-original-description:start -->",
      "## Steps",
      "",
      "### Step 0: Quoted",
      "Not authored.",
      "<!-- fusion-original-description:end -->",
      "",
      "## Mission",
      "",
      "Authored mission.",
      "",
      "## Do NOT",
      "",
      "Do not schedule the quoted copy.",
      "",
    ].join("\n");

    // Without masking, the plain-heading fallback finds the quoted `## Steps` section and returns
    // `Quoted` — a step nobody authored — so an empty list here is the guard on that fallback.
    expect(parseStepHeadings(quotedStepsHeading)).toEqual([]);
  });

  it("keeps the registry id the store resolves as the parser the document is read with", () => {
    expect(PROMPT_STEP_PARSER_ID).toBe("step-headings");
  });
});
