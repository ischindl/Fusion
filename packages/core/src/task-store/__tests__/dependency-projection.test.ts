/*
 * Fixture table for the `## Dependencies` projection decision (RUFU-750).
 *
 * FNXC:DependencyProjection 2026-11-13-19:11:
 * The RUFU-747 trio is the reproduction data for the reported symptom, typed directly into this file:
 * `.fusion/tasks/RUFU-747/PROMPT.md` is gitignored, so the real bullets are never copied into the
 * repository, and an id-only fixture would not pin the part that actually broke — a long, heavily
 * qualified POSITIVE bullet that shares the section with two denials. Before the guard all three ids
 * became dependency edges; each new edge re-seeded the card for re-specification.
 */
import { describe, expect, it } from "vitest";
import { projectDependencyBindingsFromPromptText } from "../dependency-projection.js";

function promptWith(dependenciesBody: string, trailing = ""): string {
  return [
    "# Task: RUFU-750 - projection fixture",
    "",
    "## What This Delivers",
    "",
    "- Some prose that must not be read as a dependency.",
    "",
    "## Dependencies",
    "",
    dependenciesBody.trimEnd(),
    "",
    trailing.trim() ? trailing.trimEnd() : "## Context to Read First",
    "",
    "- Read this first.",
    "",
  ].join("\n");
}

/** The three real RUFU-747 bullets: one long positive parent, two explicit denials. */
const RUFU_747_BODY = [
  "- **Task:** RUFU-293 (parent, `in-review`; source of the commits on its branch). Its PROMPT.md exists",
  "  and was read during planning. Its Code Review gate is already `APPROVE_WITH_NOTES` with a",
  "  `reviewInputFingerprint`, so this card carries that verdict and does not re-resolve any of it.",
  "- **Task:** RUFU-294 - already implemented; its work reaches this card only as commits inside the",
  "  parent range and must keep its `Fusion-Task-Id` trailers. Not a blocker to start.",
  "- **Task:** RUFU-281 - **not a dependency**, despite the board listing. Same defect class, different",
  "  exemplar; the operator keeps it untouched. Do not discard, retry, unpause, re-cut, or move it.",
].join("\n");

describe("projectDependencyBindingsFromPromptText", () => {
  it("projects only the waited-for id of the real RUFU-747 bullet trio", () => {
    const projection = projectDependencyBindingsFromPromptText(promptWith(RUFU_747_BODY));

    expect(projection.projected).toEqual(["RUFU-293"]);
    expect(projection.negated).toEqual(["RUFU-294", "RUFU-281"]);
  });

  it("treats `- **None**` as an empty projection on both sides", () => {
    const projection = projectDependencyBindingsFromPromptText(promptWith("- **None**"));

    expect(projection).toEqual({ projected: [], negated: [] });
  });

  it("returns an empty projection when the document has no Dependencies section", () => {
    expect(projectDependencyBindingsFromPromptText("# Task\n\n## Steps\n\n- **Task:** RUFU-001\n"))
      .toEqual({ projected: [], negated: [] });
  });

  it("dedupes a repeated id in document order", () => {
    const projection = projectDependencyBindingsFromPromptText(promptWith([
      "- **Task:** RUFU-001 (blocked by its landing)",
      "- **Task:** RUFU-002 - not a dependency",
      "- **Task:** RUFU-001 (blocked by its landing)",
      "- **Task:** RUFU-002 - not a dependency",
    ].join("\n")));

    expect(projection.projected).toEqual(["RUFU-001"]);
    expect(projection.negated).toEqual(["RUFU-002"]);
  });

  it("reads a denial that sits only on an indented continuation line", () => {
    const projection = projectDependencyBindingsFromPromptText(promptWith([
      "- **Task:** RUFU-003 - mentioned because it documents the same defect class.",
      "  It is **not a dependency** and the operator keeps it untouched.",
    ].join("\n")));

    expect(projection.projected).toEqual([]);
    expect(projection.negated).toEqual(["RUFU-003"]);
  });

  it("ignores an id that sits outside the Dependencies section", () => {
    const projection = projectDependencyBindingsFromPromptText([
      "# Task",
      "",
      "## Dependencies",
      "",
      "- **None**",
      "",
      "## Steps",
      "",
      "### Step 0: Preflight",
      "",
      "- **Task:** RUFU-009 is only named here, never waited for.",
      "",
    ].join("\n"));

    expect(projection).toEqual({ projected: [], negated: [] });
  });

  it("projects a real wait that follows a denial, because position is not the test", () => {
    const projection = projectDependencyBindingsFromPromptText(promptWith(
      "- **Task:** RUFU-010 - not blocking, but blocked by its landing.",
    ));

    expect(projection.projected).toEqual(["RUFU-010"]);
    expect(projection.negated).toEqual([]);
  });

  it("denies a positive clause that is itself negated", () => {
    const projection = projectDependencyBindingsFromPromptText(promptWith(
      "- **Task:** RUFU-011 - not blocked by it; its branch is already on main.",
    ));

    expect(projection.projected).toEqual([]);
    expect(projection.negated).toEqual(["RUFU-011"]);
  });

  it("lets an un-negated positive clause win over a later denial", () => {
    const projection = projectDependencyBindingsFromPromptText(promptWith(
      "- **Task:** FN-042 (blocked by landing) so the migration slot is free; this card does not wait for anything else.",
    ));

    expect(projection.projected).toEqual(["FN-042"]);
    expect(projection.negated).toEqual([]);
  });

  it("does not mistake an unrelated negation for a denial", () => {
    const projection = projectDependencyBindingsFromPromptText(promptWith(
      "- **Task:** RUFU-012 (parent). This card carries its verdict and does not re-resolve it.",
    ));

    expect(projection.projected).toEqual(["RUFU-012"]);
    expect(projection.negated).toEqual([]);
  });

  it("keeps a bullet with no clause hit projected, which is the pre-existing behaviour", () => {
    const projection = projectDependencyBindingsFromPromptText(promptWith(
      "- **Task:** RUFU-013 (Prerequisite task description)",
    ));

    expect(projection.projected).toEqual(["RUFU-013"]);
    expect(projection.negated).toEqual([]);
  });

  it("prefers the wait when the same id appears both denied and positive", () => {
    const projection = projectDependencyBindingsFromPromptText(promptWith([
      "- **Task:** RUFU-014 - **not a dependency** in the review notes.",
      "- **Task:** RUFU-014 (blocked by its landing; the release cannot ship before it).",
    ].join("\n")));

    expect(projection.projected).toEqual(["RUFU-014"]);
    expect(projection.negated).toEqual([]);
  });

  it("recognises the contracted `- **Task:** <ID> (why)` shape and denies a reference-only bullet", () => {
    const projection = projectDependencyBindingsFromPromptText(promptWith([
      "- **Task:** FN-040 (Prerequisite task description)",
      "  Informational only, kept for traceability.",
      "- **Task:** FN-041 - reference only.",
    ].join("\n")));

    expect(projection.projected).toEqual(["FN-040"]);
    expect(projection.negated).toEqual(["FN-041"]);
  });

  it("does not fold unindented section prose into the preceding bullet", () => {
    const projection = projectDependencyBindingsFromPromptText(promptWith([
      "- **Task:** RUFU-015 (blocked by its landing).",
      "",
      "RUFU-015 is not a dependency for the release lane.",
    ].join("\n")));

    expect(projection.projected).toEqual(["RUFU-015"]);
    expect(projection.negated).toEqual([]);
  });
});
