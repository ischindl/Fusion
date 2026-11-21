/*
FNXC:OriginalDescriptionInPrompt 2026-07-14-23:35:
Unit coverage for deterministic ## Original Description injection used by non-AI
generateSpecifiedPrompt and AI-planning finalize hygiene.

FNXC:OriginalDescriptionInPrompt 2026-07-15-00:40:
Also covers embedded-H2 operator text so description updates cannot duplicate or
corrupt PROMPT.md when the raw request contains lines like `## Required behavior`.
*/
import { describe, expect, it } from "vitest";
import { computePlanApprovalFingerprint } from "../planner/plan-approval.js";
import { canonicalizePlan } from "../planner/spec-lock.js";
import { isDuplicateRedirectOnlyPrompt, parseExplicitDuplicateMarker } from "../duplicates/explicit-duplicate-marker.js";
import { applyFrontendUxCriteria } from "../tasks/frontend-ux-policy.js";
import {
  ORIGINAL_DESCRIPTION_ENCODING_MARKER,
  ORIGINAL_DESCRIPTION_END_MARKER,
  ORIGINAL_DESCRIPTION_ESCAPE_PREFIX,
  ORIGINAL_DESCRIPTION_HEADING,
  ORIGINAL_DESCRIPTION_START_MARKER,
  applyOriginalDescription,
  buildOriginalDescriptionSection,
  decodeOriginalDescriptionBody,
  encodeOriginalDescriptionBody,
  extractOriginalDescriptionBody,
  resolveOriginalDescriptionEnd,
} from "../tasks/original-description-policy.js";

const SAMPLE_DESC = "Fix the board blank state when autoMerge is off on mobile Android.";

function sampleSpec(opts?: { withOriginal?: boolean; originalBody?: string; marked?: boolean }): string {
  let original = "";
  if (opts?.withOriginal) {
    const body = opts.originalBody ?? "paraphrased planner text";
    if (opts.marked) {
      original =
        `${ORIGINAL_DESCRIPTION_HEADING}\n\n` +
        `${ORIGINAL_DESCRIPTION_START_MARKER}\n` +
        `${body}\n` +
        `${ORIGINAL_DESCRIPTION_END_MARKER}\n\n`;
    } else {
      original = `${ORIGINAL_DESCRIPTION_HEADING}\n\n${body}\n\n`;
    }
  }
  return `# Task: FN-1000 - Fix blank board

**Created:** 2026-07-14
**Size:** M

${original}## Before → After Transformation

- **Before:** blank board
- **After:** board shows tasks

## Mission

Implement the fix across desktop and mobile.
`;
}

describe("original description policy", () => {
  it("builds a marked section with a single trailing newline", () => {
    const section = buildOriginalDescriptionSection(SAMPLE_DESC);
    expect(section).toContain(ORIGINAL_DESCRIPTION_START_MARKER);
    expect(section).toContain(ORIGINAL_DESCRIPTION_END_MARKER);
    expect(section).toContain(SAMPLE_DESC);
    expect(section.startsWith(`${ORIGINAL_DESCRIPTION_HEADING}\n\n`)).toBe(true);
    expect(section.endsWith("\n")).toBe(true);
    expect(section.endsWith("\n\n")).toBe(false);
  });

  it("inserts ## Original Description after title/metadata and before other ## sections", () => {
    const injected = applyOriginalDescription(sampleSpec(), SAMPLE_DESC);

    const titleIdx = injected.indexOf("# Task: FN-1000");
    const originalIdx = injected.indexOf(ORIGINAL_DESCRIPTION_HEADING);
    const transformIdx = injected.indexOf("## Before → After Transformation");
    const missionIdx = injected.indexOf("## Mission");

    expect(titleIdx).toBeGreaterThan(-1);
    expect(originalIdx).toBeGreaterThan(titleIdx);
    expect(transformIdx).toBeGreaterThan(originalIdx);
    expect(missionIdx).toBeGreaterThan(transformIdx);
    expect(injected).toContain(SAMPLE_DESC);
    expect(injected.match(/## Original Description/g)).toHaveLength(1);
    expect(extractOriginalDescriptionBody(injected)).toBe(SAMPLE_DESC);
  });

  it("preserves the operator description verbatim including multi-line and markdown-like text", () => {
    const multi = [
      "Please fix ## Mission drift.",
      "",
      "Also handle:",
      "- empty state",
      "- **Created:** in body text",
    ].join("\n");

    const injected = applyOriginalDescription(sampleSpec(), multi);
    expect(extractOriginalDescriptionBody(injected)).toBe(multi);
    // Verbatim body must not strip operator markdown-looking lines
    expect(injected).toContain("Please fix ## Mission drift.");
    expect(injected).toContain("- **Created:** in body text");
  });

  it("replaces a paraphrased Original Description with the verbatim task description", () => {
    const withParaphrase = sampleSpec({ withOriginal: true, originalBody: "planner rewrote this" });
    const injected = applyOriginalDescription(withParaphrase, SAMPLE_DESC);

    expect(extractOriginalDescriptionBody(injected)).toBe(SAMPLE_DESC);
    expect(injected).not.toContain("planner rewrote this");
    expect(injected.match(/## Original Description/g)).toHaveLength(1);
  });

  it("is idempotent when the section already matches with markers", () => {
    const once = applyOriginalDescription(sampleSpec(), SAMPLE_DESC);
    const twice = applyOriginalDescription(once, SAMPLE_DESC);
    expect(twice).toBe(once);
  });

  it("appends the section when the prompt has no ## headings", () => {
    const bare = "# FN-1: Title\n\nSome body without sections.\n";
    const injected = applyOriginalDescription(bare, SAMPLE_DESC);
    expect(injected).toContain(ORIGINAL_DESCRIPTION_HEADING);
    expect(extractOriginalDescriptionBody(injected)).toBe(SAMPLE_DESC);
    expect(injected.indexOf(ORIGINAL_DESCRIPTION_HEADING)).toBeGreaterThan(injected.indexOf("# FN-1"));
  });

  it("returns empty input unchanged", () => {
    expect(applyOriginalDescription("", SAMPLE_DESC)).toBe("");
  });

  /*
  FNXC:OriginalDescriptionInPrompt 2026-07-15-00:40:
  Greptile P1: embedded H2 in the operator description must not end the section.
  A description update must replace the full body without leaving a duplicated suffix.
  */
  it("does not corrupt PROMPT.md when the description contains embedded ## headings", () => {
    const withEmbeddedH2 = [
      "Please keep this request intact.",
      "",
      "## Required behavior",
      "",
      "- blank board stays fixed",
      "- mobile Android included",
      "",
      "## Mission",
      "",
      "Note: this H2 is operator prose, not the PROMPT Mission section.",
    ].join("\n");

    // Planner-written section without markers, body already contains embedded H2s.
    const plannerWritten = sampleSpec({
      withOriginal: true,
      originalBody: withEmbeddedH2,
      marked: false,
    });

    // First apply pins markers and full body (including embedded ## Mission prose).
    const once = applyOriginalDescription(plannerWritten, withEmbeddedH2);
    expect(extractOriginalDescriptionBody(once)).toBe(withEmbeddedH2);
    expect(once).toContain(ORIGINAL_DESCRIPTION_START_MARKER);
    expect(once.match(/## Original Description/g)).toHaveLength(1);
    // One ## Mission inside the marked body + one structural PROMPT Mission section.
    expect(once.match(/^## Mission\s*$/gm)?.length).toBe(2);
    expect(once).toContain("## Before → After Transformation");
    // Structural Mission is outside the markers.
    const endMarkerIdx = once.indexOf(ORIGINAL_DESCRIPTION_END_MARKER);
    expect(once.indexOf("Implement the fix across desktop and mobile", endMarkerIdx)).toBeGreaterThan(
      endMarkerIdx,
    );

    // Description update (greptile corruption path): new text with more H2s.
    const updated = [
      withEmbeddedH2,
      "",
      "## Extra section from operator",
      "more text",
    ].join("\n");
    const twice = applyOriginalDescription(once, updated);
    expect(extractOriginalDescriptionBody(twice)).toBe(updated);
    expect(twice.match(/## Original Description/g)).toHaveLength(1);
    expect(twice.match(/^## Mission\s*$/gm)?.length).toBe(2);
    // No duplicated leftover suffix from the previous body.
    expect(twice.split("## Required behavior").length - 1).toBe(1);
    expect(twice.split("Note: this H2 is operator prose").length - 1).toBe(1);
    expect(twice.split("## Extra section from operator").length - 1).toBe(1);
  });

  it("uses the first H2 for an unmarked section when operator text is unavailable", () => {
    const bodyWithUnknownH2 = "Intro\n\n## Required behavior\n\n- do the thing";
    const unmarked = sampleSpec({ withOriginal: true, originalBody: bodyWithUnknownH2, marked: false });
    expect(extractOriginalDescriptionBody(unmarked)).toBe("Intro");
  });

  it("preserves a custom section after an unmarked non-empty description", () => {
    const prompt = `# Task: FN-8659\n\n## Original Description\n\n${SAMPLE_DESC}\n\n## Product Overview\n\nCustom planner context.\n\n## Before → After Transformation\n\n- before\n`;
    const once = applyOriginalDescription(prompt, SAMPLE_DESC);

    expect(once).toContain("## Product Overview\n\nCustom planner context.");
    expect(applyOriginalDescription(once, SAMPLE_DESC)).toBe(once);
  });

  it("preserves a custom section after an unmarked empty description", () => {
    const prompt = "# Task: FN-8659\n\n## Original Description\n\n\n## Product Overview\n\nCustom planner context.\n\n## Mission\n\nShip it.\n";
    const once = applyOriginalDescription(prompt, "   ");

    expect(once).toContain("## Product Overview\n\nCustom planner context.");
    expect(applyOriginalDescription(once, "   ")).toBe(once);
  });

  it("preserves a custom section whose title collides with operator prose", () => {
    const description = "Operator context:\n## Product Overview\nKeep this as prose.";
    const prompt = `# Task: FN-8659\n\n## Original Description\n\n${description}\n\n## Product Overview\n\nCustom planner context.\n\n## Mission\n\nShip it.\n`;
    const once = applyOriginalDescription(prompt, description);

    expect(once).toContain(`${ORIGINAL_DESCRIPTION_START_MARKER}\n${description}\n${ORIGINAL_DESCRIPTION_END_MARKER}`);
    expect(once).toContain("## Product Overview\n\nCustom planner context.");
    expect(applyOriginalDescription(once, description)).toBe(once);
  });

  it("inserts Original Description above a leading custom section", () => {
    const prompt = "# Task: FN-8659\n\n## Product Overview\n\nCustom planner context.\n\n## Mission\n\nShip it.\n";
    const once = applyOriginalDescription(prompt, SAMPLE_DESC);

    expect(once.indexOf(ORIGINAL_DESCRIPTION_HEADING)).toBeLessThan(once.indexOf("## Product Overview"));
    expect(once).toContain("## Product Overview\n\nCustom planner context.");
    expect(applyOriginalDescription(once, SAMPLE_DESC)).toBe(once);
  });

  it("keeps marker-bounded sections unchanged", () => {
    const marked = sampleSpec({ withOriginal: true, originalBody: SAMPLE_DESC, marked: true });
    expect(applyOriginalDescription(marked, SAMPLE_DESC)).toBe(marked);
  });

  it("preserves What This Delivers when an unmarked description cannot align", () => {
    const summary = "Operators can confirm the planned outcome before reading technical details.";
    const prompt = `# Task: FN-195\n\n## Original Description\n\nPlanner paraphrase that does not align.\n\n## What This Delivers\n\n${summary}\n\n## Before → After Transformation\n\n- **Before:** intent is buried\n`;
    const rewritten = applyOriginalDescription(prompt, SAMPLE_DESC);

    expect(extractOriginalDescriptionBody(rewritten)).toBe(SAMPLE_DESC);
    expect(rewritten).toContain(`## What This Delivers\n\n${summary}`);
    expect(rewritten).toContain("## Before → After Transformation");
  });

  it("preserves a marker-bounded product summary byte-identically", () => {
    const summary = "Operators see the expected outcome at a glance.\n\n- No technical jargon";
    const prompt = `# Task: FN-195\n\n${buildOriginalDescriptionSection("planner paraphrase")}\n## What This Delivers\n\n${summary}\n\n## Mission\n\nImplement it.\n`;
    const rewritten = applyOriginalDescription(prompt, SAMPLE_DESC);

    expect(rewritten).toContain(`## What This Delivers\n\n${summary}`);
  });

  it("inserts Original Description above a leading What This Delivers section", () => {
    const prompt = "# Task: FN-195\n\n## What This Delivers\n\nOperators can confirm the outcome.\n\n## Mission\n\nImplement it.\n";
    const rewritten = applyOriginalDescription(prompt, SAMPLE_DESC);

    expect(rewritten.indexOf(ORIGINAL_DESCRIPTION_HEADING)).toBeLessThan(
      rewritten.indexOf("## What This Delivers"),
    );
    expect(rewritten).toContain("## What This Delivers\n\nOperators can confirm the outcome.");
  });

  it("uses the allowlist-priority tiebreak after alignment failure", () => {
    const prompt = "# Task: FN-8659\n\n## Original Description\n\nPlanner rewrite has no matching opening line.\n\n## Mission\n\nEarlier lower-priority heading.\n\n## Before → After Transformation\n\nChosen by allowlist priority.\n";
    const once = applyOriginalDescription(prompt, "Operator opening line.");

    // FNXC:OriginalDescriptionInPrompt 2026-08-01-05:18: Historical priority selects the later
    // Before heading, so the earlier Mission remains in the unmarked body being replaced.
    expect(once).not.toContain("Earlier lower-priority heading.");
    expect(once).toContain("## Before → After Transformation\n\nChosen by allowlist priority.");
    expect(once.indexOf(ORIGINAL_DESCRIPTION_END_MARKER)).toBeLessThan(
      once.indexOf("## Before → After Transformation"),
    );
    expect(applyOriginalDescription(once, "Operator opening line.")).toBe(once);
  });

  it("does not trust unsafe partial alignment before an embedded operator H2", () => {
    const description = "Opening line.\n\n## Mission\n\nThis is operator prose.";
    const prompt = "# Task: FN-8659\n\n## Original Description\n\nOpening line.\n\nPlanner changed this line.\n\n## Mission\n\nThis is operator prose.\n\n## Product Overview\n\nCustom planner context.\n\n## Before → After Transformation\n\nStructural boundary.\n";
    const once = applyOriginalDescription(prompt, description);

    // The unmatched description still has an H2, so the legacy tiebreak—not Mission—sets the bound.
    expect(once.indexOf(ORIGINAL_DESCRIPTION_END_MARKER)).toBeLessThan(
      once.indexOf("## Before → After Transformation"),
    );
    expect(once).not.toContain("Planner changed this line.");
    expect(applyOriginalDescription(once, description)).toBe(once);
  });

  it("uses safe partial alignment after every embedded operator H2 was consumed", () => {
    const description = "Opening line.\n\n## Mission\n\nOperator prose after the H2.";
    const prompt = "# Task: FN-8659\n\n## Original Description\n\nOpening line.\n\n## Mission\n\nPlanner divergence after the embedded H2.\n\n## Product Overview\n\nCustom planner context.\n\n## Before → After Transformation\n\nStructural boundary.\n";
    const once = applyOriginalDescription(prompt, description);

    expect(once).toContain("## Product Overview\n\nCustom planner context.");
    expect(once.indexOf(ORIGINAL_DESCRIPTION_END_MARKER)).toBeLessThan(
      once.indexOf("## Product Overview"),
    );
    expect(applyOriginalDescription(once, description)).toBe(once);
  });

  it("keeps an embedded operator H2 inside the aligned body before a custom section", () => {
    const description = "Opening line.\n\n## Mission\n\nThis is operator prose.";
    const prompt = `# Task: FN-8659\n\n## Original Description\n\n${description}\n\n## Product Overview\n\nCustom planner context.\n\n## Before → After Transformation\n\nStructural boundary.\n`;
    const once = applyOriginalDescription(prompt, description);

    expect(extractOriginalDescriptionBody(once, description)).toBe(description);
    expect(once).toContain("## Product Overview\n\nCustom planner context.");
    expect(applyOriginalDescription(once, description)).toBe(once);
  });

  it("anchors insertion above a colliding leading custom heading", () => {
    const description = "Operator context:\n## Product Overview\nKeep this as prose.";
    const prompt = "# Task: FN-8659\n\n## Product Overview\n\nCustom planner context.\n\n## Mission\n\nShip it.\n";
    const once = applyOriginalDescription(prompt, description);

    expect(once.indexOf(ORIGINAL_DESCRIPTION_HEADING)).toBeLessThan(once.indexOf("## Product Overview"));
    expect(once).toContain("## Product Overview\n\nCustom planner context.");
    expect(applyOriginalDescription(once, description)).toBe(once);
  });

  it("declares marker encoding and repairs quoted end markers without duplicating operator prose", () => {
    const description = [
      "Operator context.",
      ORIGINAL_DESCRIPTION_END_MARKER,
      "",
      "## Do NOT",
      "operator-owned sentinel",
    ].join("\n");
    const prompt = sampleSpec();
    const once = applyOriginalDescription(prompt, description);
    const start = once.indexOf(ORIGINAL_DESCRIPTION_START_MARKER);
    const resolution = resolveOriginalDescriptionEnd(
      once,
      start + ORIGINAL_DESCRIPTION_START_MARKER.length,
    );

    expect(once).toContain(`${ORIGINAL_DESCRIPTION_START_MARKER}\n${ORIGINAL_DESCRIPTION_ENCODING_MARKER}`);
    expect(resolution.resolved).toBe(true);
    expect(once.slice(start + ORIGINAL_DESCRIPTION_START_MARKER.length, resolution.end))
      .not.toContain(ORIGINAL_DESCRIPTION_END_MARKER);
    expect(extractOriginalDescriptionBody(once)).toBe(description);
    expect(once.split("operator-owned sentinel")).toHaveLength(2);
    expect(applyOriginalDescription(once, description)).toBe(once);
  });

  it("repairs a corrupted P3-a region before later description updates preserve planner marker quotes", () => {
    const oldSuffix = "legacy operator suffix sentinel";
    const trueDescription = [
      "legacy operator prefix",
      ORIGINAL_DESCRIPTION_END_MARKER,
      "",
      "## What This Delivers",
      "",
      oldSuffix,
      "",
      "## Do NOT",
      "old operator restriction",
    ].join("\n");
    const corrupted = [
      "# Task: FN-9272",
      "",
      ORIGINAL_DESCRIPTION_HEADING,
      "",
      ORIGINAL_DESCRIPTION_START_MARKER,
      "legacy operator prefix",
      ORIGINAL_DESCRIPTION_END_MARKER,
      "",
      "## What This Delivers",
      "",
      oldSuffix,
      "",
      "## Do NOT",
      "old operator restriction",
      ORIGINAL_DESCRIPTION_END_MARKER,
      "",
      "## What This Delivers",
      "",
      "Planner summary.",
      "",
      "Planner prose quoting a marker:",
      ORIGINAL_DESCRIPTION_END_MARKER,
      "",
      "## Mission",
      "",
      "Repair the boundary.",
      "",
      "## Do NOT",
      "",
      "Planner restriction.",
    ].join("\n");

    const repaired = applyOriginalDescription(corrupted, trueDescription);
    const updatedDescription = "A replacement operator description.";
    const updated = applyOriginalDescription(repaired, updatedDescription);

    expect(extractOriginalDescriptionBody(repaired, trueDescription)).toBe(trueDescription);
    expect(repaired.split(oldSuffix)).toHaveLength(2);
    expect(extractOriginalDescriptionBody(updated, updatedDescription)).toBe(updatedDescription);
    expect(updated).toContain("Planner prose quoting a marker:");
    expect(updated).toContain(`${ORIGINAL_DESCRIPTION_END_MARKER}\n\n## Mission`);
    expect(updated).toContain("Planner restriction.");
    expect(canonicalizePlan(updated).status).toBe("available");
  });

  it("round-trips reserved tokens and escape-prefix text through the declared codec", () => {
    const bodies = [
      "plain prose",
      ORIGINAL_DESCRIPTION_START_MARKER,
      ORIGINAL_DESCRIPTION_END_MARKER,
      ORIGINAL_DESCRIPTION_ENCODING_MARKER,
      ORIGINAL_DESCRIPTION_ESCAPE_PREFIX,
      `${ORIGINAL_DESCRIPTION_ESCAPE_PREFIX}end -->`,
      "prefix fusion-original-description:en",
      " leading\r\ntrailing  \n",
      "   ",
      "",
    ];
    for (const body of bodies) {
      expect(decodeOriginalDescriptionBody(encodeOriginalDescriptionBody(body))).toBe(body);
    }
  });

  it("keeps hygiene-before-fingerprint stable across a second pass", () => {
    const planner = `# Task: FN-8659\n\n## Original Description\n\n${SAMPLE_DESC}\n\n## Product Overview\n\nCustom planner context.\n\n## Mission\n\nShip it.\n`;
    const once = applyOriginalDescription(planner, SAMPLE_DESC);
    const twice = applyOriginalDescription(once, SAMPLE_DESC);

    expect(computePlanApprovalFingerprint(twice)).toBe(computePlanApprovalFingerprint(once));
    expect(twice).toBe(once);
  });
});

/*
FNXC:OriginalDescriptionInPrompt 2026-11-20-23:55 (RUFU-775):
Two invariants that a single description edit used to destroy, asserted at the policy seam.

1. A duplicate-redirect-only PROMPT.md is the verdict itself. `parseExplicitDuplicateMarker` recognizes
   it only when the whole document is one non-blank line, so any spliced section un-parks the card and
   the engine reads a parked duplicate as a plan (the FN-8600 re-plan loop that module documents).
   Observed on RUFU-774: a 20 B marker survived the prompt write and was re-injected by the next
   description write. The guard is asserted for BOTH write modes because it is unconditional by design.

2. A recorded Original Description is a record, and only `authoritative` may republish it.
   `preserve-recorded` is the mode for cosmetic sync paths that hold a newer row value but not the
   operator's intent.

Assertions go through the parser and the returned bytes, never through source comments.
*/
describe("original description policy: duplicate-marker and write-mode authority (RUFU-775)", () => {
  const MARKER_ID = "FN-5211";
  const OPERATOR_TEXT = "Operator's verbatim intake request.";
  const PLANNER_TEXT = "Planner's later summary of the same card.";

  /** Every shape the parser accepts as a redirect-only document, including its whitespace wrappers. */
  const markerOnlyDocuments: Array<[label: string, content: string]> = [
    ["canonical with trailing newline", `DUPLICATE: ${MARKER_ID}\n`],
    ["no trailing newline", `DUPLICATE: ${MARKER_ID}`],
    ["lowercase id", "duplicate: fn-5211"],
    ["surrounding spaces and blank lines", `   DUPLICATE: ${MARKER_ID}  \n\n  `],
    ["backtick-wrapped", "`DUPLICATE: FN-5211`\n"],
    ["bold-wrapped", "**DUPLICATE: FN-5211**\n"],
    ["fenced plain", "```\nDUPLICATE: FN-5211\n```\n"],
    ["fenced with language", "```text\nDUPLICATE: FN-5211\n```"],
  ];

  it.each(markerOnlyDocuments)(
    "returns the marker-only document byte-for-byte: %s",
    (_label, content) => {
      expect(parseExplicitDuplicateMarker(content)?.canonicalId).toBe(MARKER_ID);

      for (const result of [
        applyOriginalDescription(content, PLANNER_TEXT),
        applyOriginalDescription(content, PLANNER_TEXT, "authoritative"),
        applyOriginalDescription(content, PLANNER_TEXT, "preserve-recorded"),
        applyOriginalDescription(content, ""),
      ]) {
        expect(result).toBe(content);
        expect(parseExplicitDuplicateMarker(result)?.canonicalId).toBe(MARKER_ID);
        expect(isDuplicateRedirectOnlyPrompt(result)).toBe(true);
      }
    },
  );

  it("still runs hygiene when the marker line shares the document with real headings", () => {
    // The guard is about document SHAPE, not the word: two non-blank lines is no longer a verdict.
    const mixed = `DUPLICATE: ${MARKER_ID}\n\n# Task: FN-1001 - Real spec\n\n## Mission\n\nWork.\n`;
    expect(parseExplicitDuplicateMarker(mixed)).toBeNull();

    const injected = applyOriginalDescription(mixed, OPERATOR_TEXT);
    expect(injected).not.toBe(mixed);
    expect(extractOriginalDescriptionBody(injected)).toBe(OPERATOR_TEXT);
  });

  it("preserve-recorded leaves an already-recorded body untouched under a different description", () => {
    const recorded = sampleSpec({ withOriginal: true, marked: true, originalBody: OPERATOR_TEXT });

    const preserved = applyOriginalDescription(recorded, PLANNER_TEXT, "preserve-recorded");

    expect(preserved).toBe(recorded);
    expect(extractOriginalDescriptionBody(preserved)).toBe(OPERATOR_TEXT);
    expect(preserved).not.toContain(PLANNER_TEXT);
    expect(preserved.match(/## Original Description/g)).toHaveLength(1);
  });

  it("preserve-recorded preserves an unmarked planner-written body too", () => {
    const recorded = sampleSpec({ withOriginal: true, originalBody: OPERATOR_TEXT });

    expect(applyOriginalDescription(recorded, PLANNER_TEXT, "preserve-recorded")).toBe(recorded);
  });

  it("preserve-recorded still inserts the section when the spec has none", () => {
    const bare = sampleSpec();
    expect(extractOriginalDescriptionBody(bare)).toBeNull();

    const injected = applyOriginalDescription(bare, OPERATOR_TEXT, "preserve-recorded");

    expect(extractOriginalDescriptionBody(injected)).toBe(OPERATOR_TEXT);
    expect(injected.match(/## Original Description/g)).toHaveLength(1);
    // A second preserve-recorded pass now sees a recorded region and refuses its own work.
    expect(applyOriginalDescription(injected, PLANNER_TEXT, "preserve-recorded")).toBe(injected);
  });

  it("authoritative still republishes the verbatim operator text over a paraphrase", () => {
    const recorded = sampleSpec({ withOriginal: true, marked: true, originalBody: OPERATOR_TEXT });

    // Same input, opposite authority: this contrast is the mode split, pinned from both directions.
    expect(applyOriginalDescription(recorded, PLANNER_TEXT, "preserve-recorded")).toBe(recorded);

    const republished = applyOriginalDescription(recorded, PLANNER_TEXT, "authoritative");
    expect(republished).not.toBe(recorded);
    expect(extractOriginalDescriptionBody(republished)).toBe(PLANNER_TEXT);
    // The pre-existing 2-argument call shape defaults to authoritative.
    expect(applyOriginalDescription(recorded, PLANNER_TEXT)).toBe(republished);
  });

  it("leaves a marker-only document unchanged through the Frontend UX hygiene tail", () => {
    const marker = `DUPLICATE: ${MARKER_ID}\n`;
    // By construction: a marker-only file has no `## File Scope`, so the same finalisation tail that
    // runs applyFrontendUxCriteria after the Original Description injection parses an empty scope and
    // returns its input untouched. Asserted rather than assumed (RUFU-775 Step 3).
    expect(applyFrontendUxCriteria(marker)).toBe(marker);
  });
});
