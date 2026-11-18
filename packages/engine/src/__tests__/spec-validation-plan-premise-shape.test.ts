import { describe, expect, it } from "vitest";
import {
  detectSelfConsumingPremises,
  formatSelfConsumingPremiseDiagnostic,
} from "../spec-validation/plan-premise-shape.js";

/*
FNXC:PlanPremiseAuthoring 2026-11-18-06:36 (RUFU-727 Steps 5 and 6):
A plan that premises an ABSENCE on a path its own File Scope promises to write is self-contradictory on the
face of the spec, and the contradiction is readable from the two sections alone. Before this gate the shape
was discovered at the release door instead — after a pickaxe falsifier scan per premise — and ended as
`premise-invalidated-by-delivery`: a card that finished its work and could not be released while its own
delivery was attached, because a re-plan cannot make an absence premise survive the delivery that removes it.
RUFU-698 is the measured case: its deliverable introduced `rotated-deferred` in `hold-release.ts` while its
premise declared that literal absent.

These tests hold the RULE and its two failure directions. The over-refuse direction is the expensive one —
this gate runs before any reviewer sees the plan, and a false positive denies a healthy plan its reviewer —
so the "must not refuse" cases are not decoration: `text-present` on a self-edited path is the ordinary
shape of "the file I rely on still carries this fact", an exclusion bullet is a path the card must NOT
write, and a spec whose Premises section will not parse is `plan-premise-invalid`'s subject at the door, not
a revision request from here.
*/

function spec(premises: string[], fileScope: string[]): string {
  return [
    "# Task",
    "",
    "## Plan Premises",
    "",
    ...premises.map((premise) => `- ${premise}`),
    "",
    ...(fileScope.length > 0 ? ["## File Scope", "", ...fileScope.map((entry) => `- \`${entry}\``)] : []),
    "",
    "## Steps",
    "",
    "1. do the thing",
    "",
  ].join("\n");
}

const TEXT_ABSENT = (path: string, literal = "rotated-deferred") =>
  JSON.stringify({ kind: "text-absent", path, literal });
const FILE_ABSENT = (path: string) => JSON.stringify({ kind: "file-absent", path });
const TEXT_PRESENT = (path: string, literal = "const x = 1") =>
  JSON.stringify({ kind: "text-present", path, literal });
const FILE_EXISTS = (path: string) => JSON.stringify({ kind: "file-exists", path });

const DOOR = "packages/engine/src/execution/hold-release.ts";
const detect = (promptContent: string) => detectSelfConsumingPremises({ promptContent });

describe("detectSelfConsumingPremises", () => {
  it("refuses an absence premise on a path this card's File Scope declares it writes", () => {
    const findings = detect(spec([TEXT_ABSENT(DOOR), FILE_ABSENT("src/Generated.ts")], [DOOR, "src/Generated.ts"]));
    expect(findings.map((finding) => finding.kind)).toEqual(["text-absent", "file-absent"]);
    expect(findings[0]).toMatchObject({ path: DOOR, literal: "rotated-deferred", writeScopeEntry: DOOR });
    expect(findings[1]).not.toHaveProperty("literal");
  });

  it("matches a one-level glob over its own directory and refuses to cross a separator", () => {
    /*
    `*` covers one path segment and `**` covers any depth. A `src/*.ts` entry says the card writes the
    files sitting in `src/` — it does not license everything under every subdirectory — so treating it as
    recursive would refuse plans whose premise lives in a tree the card never touches.
    */
    const sameLevel = detect(spec([FILE_ABSENT("src/new-file.ts")], ["src/*.ts"]));
    expect(sameLevel).toHaveLength(1);
    expect(sameLevel[0]).toMatchObject({ path: "src/new-file.ts", writeScopeEntry: "src/*.ts" });
    expect(detect(spec([FILE_ABSENT("src/openapi/new-file.ts")], ["src/*.ts"]))).toEqual([]);
  });

  it("refuses an absence premise covered by a multi-level glob entry", () => {
    const findings = detect(
      spec([TEXT_ABSENT("packages/engine/src/spec-validation/new-check.ts")], ["packages/engine/src/spec-validation/**"]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ writeScopeEntry: "packages/engine/src/spec-validation/**" });
  });

  it("refuses a file-absent premise on a path the spec lists as a (new) artifact", () => {
    /*
    The artifact list is a second declaration of "this card creates this path", and
    `extractEffectiveWriteScopeFromPrompt` reads only `## File Scope`, so the artifact form is harvested by
    this gate. Without it the plan can promise to create a file in one section and premise its absence in
    another, in the same document, and pass. The layout below is the real one: an `**Artifacts:**` list sits
    under a step heading, so it is NOT part of the File Scope section the classifier reads.
    */
    const prompt = [
      "# Task",
      "",
      "## Plan Premises",
      "",
      `- ${FILE_ABSENT("packages/engine/src/spec-validation/plan-premise-shape.ts")}`,
      "",
      "## File Scope",
      "",
      "- `packages/engine/src/executor/execute-workflow-step.ts`",
      "",
      "## Steps",
      "",
      "### Step 1: add the detector",
      "",
      "1. write it",
      "",
      "**Artifacts:**",
      "- `packages/engine/src/spec-validation/index.ts` (modified)",
      "- `packages/engine/src/spec-validation/plan-premise-shape.ts` (new)",
      "",
    ].join("\n");
    const findings = detect(prompt);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "file-absent",
      declaredAsNewArtifact: true,
      writeScopeEntry: "packages/engine/src/spec-validation/plan-premise-shape.ts",
    });
  });

  it("does not refuse a present premise on a path this card rewrites", () => {
    /*
    The legal shape, and the reason the rule is limited to absence kinds: "the file I am about to edit still
    carries this fact" can survive the edit, and where it does not, the landed falsifier attribution already
    credits the card and releases it. Refusing this shape would refuse most plans.
    */
    expect(detect(spec([TEXT_PRESENT(DOOR), FILE_EXISTS(DOOR)], [DOOR]))).toEqual([]);
  });

  it("does not refuse a premise on a path outside the write scope or a substring neighbour of one", () => {
    expect(detect(spec([FILE_ABSENT("src/Other.ts")], [DOOR]))).toEqual([]);
    // Substring containment is deliberately NOT containment: a declared file must not swallow its neighbours.
    expect(detect(spec([FILE_ABSENT("src/App.helpers.ts")], ["src/App.tsx"]))).toEqual([]);
  });

  it("keeps every classifier exclusion intact so legitimate declarations never fire the gate", () => {
    /*
    The gate inherits its exclusions from `extractEffectiveWriteScopeFromPrompt` rather than re-implementing
    them, which is the only reason a conditional changeset bullet, a `.fusion/` artifact, a generated lock
    file and a read-only context are not write targets here. Written as raw scope lines so each exclusion is
    exercised in the shape the classifier actually keys on.
    */
    const cases: Array<{ label: string; scopeLines: string[] }> = [
      { label: "read-only-context", scopeLines: ["### Out of scope (read-only)", "- `src/Generated.ts`"] },
      { label: "fusion-metadata-evidence", scopeLines: ["- `.fusion/tasks/RUFU-698/PROMPT.md`"] },
      { label: "generated-lock", scopeLines: ["- `packages/engine/package.resolved`"] },
      { label: "conditional-changeset", scopeLines: ["- `.changeset/rufu-698-premise.md` — expected only if the published package changes"] },
      // A declared write target that is not the premise's path must not make anything self-consuming.
      { label: "unrelated-target", scopeLines: ["- `src/Unrelated.ts`"] },
    ];
    for (const testCase of cases) {
      const prompt = [
        "# Task", "", "## Plan Premises", "", `- ${FILE_ABSENT("src/Generated.ts")}`, "",
        "## File Scope", "", ...testCase.scopeLines, "", "## Steps", "", "1. do the thing", "",
      ].join("\n");
      expect(detect(prompt), testCase.label).toEqual([]);
    }
  });

  it("ignores File Scope entries and artifact lines inside fenced code blocks", () => {
    const prompt = [
      "# Task",
      "",
      "## Plan Premises",
      "",
      `- ${FILE_ABSENT("src/Generated.ts")}`,
      "",
      "## File Scope",
      "",
      "```markdown",
      "- `src/Generated.ts`",
      "```",
      "",
      "```markdown",
      "- `src/Generated.ts` (new)",
      "```",
      "",
      "## Steps",
      "",
      "1. do the thing",
      "",
    ].join("\n");
    expect(detect(prompt)).toEqual([]);
  });

  it("yields no findings for a spec with no File Scope or no Plan Premises", () => {
    expect(detect(spec([FILE_ABSENT("src/Generated.ts")], []))).toEqual([]);
    const noPremises = ["# Task", "", "## File Scope", "", "- `src/Generated.ts`", "", "## Steps", "", "1. do the thing", ""].join("\n");
    expect(detect(noPremises)).toEqual([]);
  });

  it("reports unreadable premises as no findings rather than refusing them", () => {
    // A prose line inside ## Plan Premises is `invalid-line` -> `invalid-contract` at the release door.
    // This gate has no authority to revise over a section it cannot parse.
    expect(detect(spec(["this section is prose, not premises"], [DOOR]))).toEqual([]);
  });

  it("canonicalizes path separators before comparing against File Scope", () => {
    // spec-lock.ts normalizes the section with `replace(/\\/g, "/")`: "File Scope is a cross-platform
    // boundary". A Windows-authored entry must not slip a premise past the gate.
    const control = spec([FILE_ABSENT("docs/new-page.md")], ["src/openapi/new-file.ts"]);
    const windowsEntries = [
      "# Task", "", "## Plan Premises", "", `- ${FILE_ABSENT("src/openapi/new-file.ts")}`, "",
      "## File Scope", "", "- `src\\openapi\\new-file.ts`", "", "## Steps", "", "1. do the thing", "",
    ].join("\n");
    expect(detect(control)).toEqual([]);
    const findings = detect(windowsEntries);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ path: "src/openapi/new-file.ts", writeScopeEntry: "src\\openapi\\new-file.ts" });
  });

  it("answers synchronously — no git, no filesystem, no model", () => {
    // The gate runs inside the Plan Review node before any dispatch; an await here would put an I/O bound
    // in front of every planned card. RUFU-212's slow-test rule applies to gates as much as to tests.
    expect(detect(spec([TEXT_ABSENT(DOOR)], [DOOR]))).not.toBeInstanceOf(Promise);
  });
});

describe("formatSelfConsumingPremiseDiagnostic", () => {
  it("names both sections, the remedy, and the fragile presence shape this gate cannot detect", () => {
    const findings = detect(spec([TEXT_ABSENT(DOOR)], [DOOR]));
    const diagnostic = formatSelfConsumingPremiseDiagnostic(findings);
    expect(diagnostic).toContain("self-consuming premise");
    expect(diagnostic).toContain(DOOR);
    expect(diagnostic).toContain("rotated-deferred");
    expect(diagnostic).toContain("## File Scope");
    expect(diagnostic).toContain("Fix it in the PLAN");
    expect(diagnostic).toContain("acceptance criteria");
    /*
    The RUFU-698 lesson has a half the deterministic rule cannot reach: its two `text-present` premises
    quoted source its own Steps refactored. Legal, untestable here, and it breaks the same way — so the
    diagnostic teaches it instead of refusing it.
    */
    expect(diagnostic).toMatch(/text-present/);
    expect(diagnostic).toMatch(/pre-work tree/);
  });

  it("names a (new) artifact as the contradicting declaration in its own words", () => {
    const prompt = [
      "# Task", "", "## Plan Premises", "", `- ${FILE_ABSENT("docs/new-page.md")}`, "",
      "## File Scope", "", "- `src/Unrelated.ts`", "",
      "## Steps", "", "### Step 1: write the page", "", "**Artifacts:**", "- `docs/new-page.md` (new)", "",
    ].join("\n");
    expect(formatSelfConsumingPremiseDiagnostic(detect(prompt))).toContain("as a (new) artifact this card creates");
  });
});
