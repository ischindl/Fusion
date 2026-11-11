/*
FNXC:PromptSpecIntegrity 2026-11-11-07:05 (RUFU-536):
A durable PROMPT.md may hold each lockable section exactly once outside the fenced verbatim
operator-request region. These tests pin the ONE detector that decides that (`inspectPromptDocument`,
a report over `canonicalizePlan`, not a second parser) and the publication gate built on it, because
the failure this replaces shipped twice: a card carrying `## Original Description`, `## What This
Delivers`, `## Steps` and `## Non-Goals` twice each, and a board still listing the previous
generation's steps (RUFU-519).

The set is deliberately wider than the reported reproduction, per the fix-the-invariant rule: the
same invariant is asserted for the alias pair (`## Non-Goals` beside `## Do NOT` is ONE section), for
line-ending variants, for quoted content that is legal inside the region but not outside it, for
fenced content, and for the successor vocabulary the planner template actually emits.
*/
import { describe, expect, it } from "vitest";
import {
  assertPromptDocumentPublishable,
  inspectPromptDocument,
  isDuplicatedPromptSectionError,
} from "../tasks/prompt-document-integrity.js";
import {
  ORIGINAL_DESCRIPTION_END_MARKER,
  ORIGINAL_DESCRIPTION_START_MARKER,
  isKnownPromptSectionHeading,
} from "../tasks/original-description-policy.js";
import {
  findGeneratedOriginalDescriptionRange,
  maskGeneratedOriginalDescription,
} from "../tasks/original-description-region.js";
import { parseStepHeadings } from "../tasks/step-parsers.js";

const START = ORIGINAL_DESCRIPTION_START_MARKER;
const END = ORIGINAL_DESCRIPTION_END_MARKER;

/** The generated region exactly as specification hygiene writes it. */
function generatedRegion(body: string): string {
  return `## Original Description\n\n${START}\n${body}\n${END}\n`;
}

/** One clean generation of every lockable section, in the planner template's order. */
const PLAN_TAIL = `## What This Delivers\n\nOne line of operator-visible outcome.\n\n## Before -> After Transformation\n\nBefore: two generations. After: one.\n\n## Mission\n\nPublish one generation per section.\n\n## Plan Premises\n\n- Assumed vitest.\n\n## File Scope\n\n- packages/core/src/store.ts\n\n## Steps\n\n### Step 0: Preflight\n\n- [ ] Read the contract\n\n### Step 1: Implementation\n\n- [ ] Ship it\n\n## Completion Criteria\n\n- [ ] Targeted tests green\n\n## Do NOT\n\n- No second detector\n\n## Non-Goals\n\n- No rewrite of the operator's request\n\n## Dependencies\n\n- None\n\n## Mission Lineage\n\n- None\n\n## Documentation & Delivery\n\n- CHANGELOG entry\n\n## Testing & Verification\n\n- Targeted vitest\n`;

const CLEAN = `# Task: one generation per section\n\n${generatedRegion("please fix the lockfile drift")}\n${PLAN_TAIL}`;

function kinds(document: string) {
  return inspectPromptDocument(document).issues.map((issue) => `${issue.kind}${issue.blocking ? ":blocking" : ":advisory"}`);
}

function gateOutcome(document: string): string {
  try {
    assertPromptDocumentPublishable("RUFU-536", document);
    return "published";
  } catch (error) {
    return isDuplicatedPromptSectionError(error) ? `refused:${error.section ?? "original-description"}` : `other:${String(error)}`;
  }
}

describe("inspectPromptDocument — one generation per section", () => {
  it("accepts a clean single-generation document", () => {
    const report = inspectPromptDocument(CLEAN);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(gateOutcome(CLEAN)).toBe("published");
  });

  it("treats a section alias as the same section instead of a duplicate", () => {
    // `## Non-Goals` is the alias of `## Do NOT`; both present is ONE section, not two. The alias
    // rules belong to the spec lock, and this is the assertion that keeps this module from forking
    // its own heading table.
    expect(CLEAN).toContain("## Do NOT");
    expect(CLEAN).toContain("## Non-Goals");
    expect(inspectPromptDocument(CLEAN).duplicatedSections).toEqual([]);
  });

  it("reports the same verdict for a CRLF document as for its LF form", () => {
    const crlf = CLEAN.replace(/\n/g, "\r\n");
    expect(kinds(crlf)).toEqual(kinds(CLEAN));
    expect(gateOutcome(crlf)).toBe(gateOutcome(CLEAN));
    expect(parseStepHeadings(crlf).map((step) => step.name)).toEqual(
      parseStepHeadings(CLEAN).map((step) => step.name),
    );
  });

  it("refuses a document that repeats a lockable section below the first one", () => {
    const spliced = `${CLEAN}\n## Steps\n\n### Step 0: Preflight\n\n- [ ] An older plan's step\n`;
    const report = inspectPromptDocument(spliced);
    expect(report.ok).toBe(false);
    expect(report.duplicatedSections).toEqual(["steps"]);
    expect(report.blockingIssues[0]?.reason).toBe("section-duplicate");
    expect(gateOutcome(spliced)).toBe("refused:steps");
  });

  it("names the offending heading and the fix in the refusal, and never rewrites the candidate", () => {
    const spliced = `${CLEAN}\n## Do NOT\n\n- An older plan's prohibition\n`;
    let message = "";
    try {
      assertPromptDocumentPublishable("RUFU-519", spliced);
      expect.unreachable("a duplicated section must refuse publication");
    } catch (error) {
      expect(isDuplicatedPromptSectionError(error)).toBe(true);
      message = (error as Error).message;
    }
    expect(message).toContain("RUFU-519");
    expect(message).toContain("Do NOT");
    expect(message).toContain("Publish one generation");
    // The candidate is never repaired: the gate returns void or throws, so no caller can persist
    // half-fixed bytes.
    expect(spliced.split("\n## Do NOT").length).toBe(3);
  });

  it("refuses an authored Original Description heading that sits outside the generated region", () => {
    // This is the hygiene splice: the regenerated region was written over a document that already
    // carried the section, stranding the previous copy. The text below an unmasked heading is read
    // as document structure by both the spec lock and the board's step parser.
    const spliced = `${CLEAN}\n## Original Description\n\nAn older request copy\n`;
    expect(kinds(spliced)).toContain("original-description-heading-duplicated:blocking");
    expect(inspectPromptDocument(spliced).ok).toBe(false);
  });

  it("does not count an Original Description heading that only appears inside a fenced code block", () => {
    const fenced = `${CLEAN}\n\`\`\`markdown\n## Original Description\n\nquoted markup, not structure\n\`\`\`\n`;
    expect(kinds(fenced)).toEqual([]);
    expect(gateOutcome(fenced)).toBe("published");
  });

  it("keeps an unmarked legacy document advisory, so the refusal always has a recovery owner", () => {
    // A document with no markers cannot be bounded from its own text. Refusing it would create a
    // refusal the detector cannot diagnose and no lane knows how to recover.
    const legacy = `# Task\n\n## Mission\n\nm\n\n## File Scope\n\n- x\n\n## Steps\n\n### Step 0: a\n\n- [ ] x\n\n## Completion Criteria\n\n- [ ] y\n\n## Do NOT\n\n- z\n\n## Dependencies\n\n- None\n\n## Original Description\n\nlegacy unmarked request\n`;
    expect(findGeneratedOriginalDescriptionRange(legacy)).toBeNull();
    expect(inspectPromptDocument(legacy).ok).toBe(true);
    expect(gateOutcome(legacy)).toBe("published");
  });

  it("reports an unresolvable region as geometry, never as a duplicate a planner cannot fix", () => {
    const unresolved = `# Task\n\n## Mission\n\nm\n\n## File Scope\n\n- x\n\n## Completion Criteria\n\n- [ ] y\n\n## Do NOT\n\n- z\n\n## Dependencies\n\n- None\n\n## Original Description\n\n${START}\nquoted plan follows\n\n## Wholly Synthetic Section\n\n### Step 0: QUOTED\n\n- [ ] q\n`;
    expect(findGeneratedOriginalDescriptionRange(unresolved)).toBeNull();
    expect(kinds(unresolved)).toContain("original-description-successor-unknown:advisory");
    expect(inspectPromptDocument(unresolved).ok).toBe(true);
  });

  it("agrees with the step parser about a quoted older generation inside the region", () => {
    // One generation, two reports: the quoted copy is legal operator text for the publication gate,
    // and it must be equally invisible to the board's step list. If the two views disagreed, the
    // card would carry a step list derived from a plan the lock says does not exist.
    const quoted = `# Task\n\n${generatedRegion("previous plan:\n\n## Steps\n\n### Step 0: QUOTED\n\n### Step 1: QUOTED AGAIN\n")}\n${PLAN_TAIL}`;
    expect(gateOutcome(quoted)).toBe("published");
    expect(parseStepHeadings(quoted).map((step) => step.name)).toEqual(["Preflight", "Implementation"]);
  });
});

describe("maskGeneratedOriginalDescription — offsets stay addressable", () => {
  it("hides the region without changing the document's byte length", () => {
    const document = `# Task\n\n${generatedRegion("### Step 0: QUOTED\n\n## Steps")}\n${PLAN_TAIL}`;
    const masked = maskGeneratedOriginalDescription(document);
    expect(masked.length).toBe(document.length);
    expect(masked).not.toContain("QUOTED");
    // Everything outside the region addresses the same byte, which is why the step matcher may hand
    // its callers indices from the masked text and let them slice the raw prompt.
    expect(masked.slice(masked.indexOf("## What This Delivers"))).toBe(document.slice(document.indexOf("## What This Delivers")));
  });

  it("returns the document unchanged when there is no generated region to mask", () => {
    const legacy = `# Task\n\n## Original Description\n\nunmarked\n`;
    expect(maskGeneratedOriginalDescription(legacy)).toBe(legacy);
  });
});

describe("prompt section vocabulary", () => {
  /*
  FNXC:PromptSpecIntegrity 2026-11-11-07:05 (RUFU-536):
  The region boundary is resolved by the heading that follows it, so a heading the planner template
  emits but the vocabulary does not list silently unbounds the region — and an unbounded region
  promotes every heading the operator quoted into document structure. RUFU-536's own spec carried an
  ASCII `->` arrow heading and `## Documentation & Delivery`, neither of which was listed.
  */
  const templateSuccessors = [
    "## What This Delivers",
    "## Before -> After Transformation",
    "## Before \u2192 After Transformation",
    "## Mission",
    "## Plan Premises",
    "## Surface Enumeration",
    "## Symptom Verification",
    "## File Scope",
    "## Steps",
    "## Completion Criteria",
    "## Do NOT",
    "## Non-Goals",
    "## Dependencies",
    "## Mission Lineage",
    "## Parent-Child Lineage",
    "## Documentation & Delivery",
    "## Documentation and Delivery",
    "## Testing & Verification",
    "## Testing and Verification",
  ];

  it.each(templateSuccessors)("resolves a region followed by %s", (heading) => {
    expect(isKnownPromptSectionHeading(heading)).toBe(true);
    const document = `${generatedRegion("quoted operator request")}\n${heading}\n\ncontent\n`;
    expect(findGeneratedOriginalDescriptionRange(document)).not.toBeNull();
    expect(inspectPromptDocument(document).ok).toBe(true);
  });

  it("does not treat an arbitrary heading as a region boundary", () => {
    expect(isKnownPromptSectionHeading("## Wholly Synthetic Section")).toBe(false);
  });
});
