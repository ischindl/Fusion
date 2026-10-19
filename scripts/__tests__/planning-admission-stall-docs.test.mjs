import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
FNXC:PlanningAdmissionStall 2026-10-19-10:26 (RUFU-354):
RUFU-350 changed two observable facts about the planning-admission stall audit surface, and the prose written
around that repair kept asserting the opposite: (a) a retraction row now carries the `ageMs` it measured BEFORE
clearing the episode, and (b) the foreign-episode ownership floor does NOT apply to the one retract pass whose
evidence is the card's own lane placement (`left-planning-lane`). `agents-md-invariants.test.mjs` only checks
anchors, merging rules and doc links, and `self-healing-docs.test.mjs` pins two unrelated sentences, so neither
could see either contradiction — a green doc suite is not evidence that a doc sentence is true.

This ratchet therefore checks the DOC against a CODE CONSTRUCT, never against prose or an `FNXC:` stamp:
- it first proves the engine still behaves the way the corrected sentences claim (otherwise the doc invariant
  would be vacuously true over a changed implementation), and
- then refuses any doc line that states the ownership floor without naming its exempt pass, plus the specific
  refuted wording class about the retraction row's age.
The three doc surfaces are scanned together because `AGENTS.md` points readers at `docs/architecture.md` for
run-audit internals and `docs/task-management.md` restates the sweep's contract: fixing one and leaving the
others is how the same defect came back twice (RUFU-325 corrected the age sentence in only two of the three).
*/

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoPath = (...parts) => path.resolve(__dirname, "../..", ...parts);
const read = (...parts) => readFileSync(repoPath(...parts), "utf8");

const selfHealingSource = read("packages", "engine", "src", "self-healing.ts");
const admissionSource = read("packages", "engine", "src", "planning-admission-stall.ts");

/** Every doc surface that carries a claim about this sweep's metadata contract. */
const DOCS = {
  "AGENTS.md": read("AGENTS.md"),
  "docs/architecture.md": read("docs", "architecture.md"),
  "docs/task-management.md": read("docs", "task-management.md"),
};

/** The retract choke point, isolated so ordering assertions cannot be satisfied from elsewhere in 15k lines. */
function retractBody(source) {
  const start = source.indexOf("private async retractPlanningAdmissionStallEpisodes(");
  assert.notEqual(
    start,
    -1,
    "self-healing.ts no longer declares retractPlanningAdmissionStallEpisodes — if the sweep was restructured, "
    + "re-derive the retract call sites and outcome vocabulary, then update the doc sentences this test guards.",
  );
  const nextMember = source.indexOf("\n  private async ", start + 10);
  return source.slice(start, nextMember === -1 ? source.length : nextMember);
}

const normalize = (text) => text.replace(/\s+/g, " ").trim();

test("engine keeps exactly one exempt retract pass, so the doc invariant is not vacuous", () => {
  const body = normalize(retractBody(selfHealingSource));
  assert.match(
    body,
    /if \(outcome !== "left-planning-lane" && !isSweepOwnedPlanningAdmissionEpisode\(stored\)\)/,
    'the ownership floor must stay guarded by `outcome !== "left-planning-lane"` — the three doc sentences this '
    + "test guards state that the `left-planning-lane` clear is NOT withheld by the floor.",
  );

  // 1 declaration + 3 call sites. A 4th pass means a new retract door nobody documented.
  const callSiteCount = (selfHealingSource.match(/retractPlanningAdmissionStallEpisodes\(/g) ?? []).length;
  assert.equal(
    callSiteCount,
    4,
    "expected exactly the declaration plus the whole-board, `left-planning-lane` and `no-longer-aged` retract "
    + `calls; found ${callSiteCount}. Name any new pass in the docs before relaxing this count.`,
  );
  for (const outcome of ["no-longer-a-candidate", "left-planning-lane", "no-longer-aged"]) {
    assert.match(
      selfHealingSource,
      new RegExp(`retractPlanningAdmissionStallEpisodes\\([\\s\\S]{0,400}?"${outcome}",`),
      `retract outcome \`${outcome}\` disappeared from its call site — the doc outcome vocabulary is now stale.`,
    );
  }
});

test("engine measures the retraction row's age BEFORE it writes the clear", () => {
  const body = retractBody(selfHealingSource);
  const measureAt = body.indexOf("const ageMsAtDecision = planningAdmissionEffectiveAgeMs(");
  const clearAt = body.indexOf("[PLAN_ADMISSION_STALL_METADATA_KEY]: null");
  assert.notEqual(measureAt, -1, "the retract path no longer takes its age measurement — the corrected doc sentence is now false.");
  assert.notEqual(clearAt, -1, "the retract path no longer clears the episode at key level.");
  assert.ok(
    measureAt < clearAt,
    "the age must be measured before the clear: `updateTask` bumps `updatedAt` for every writer, so a "
    + "post-write measurement reports the row the write just touched (~0 s or negative).",
  );
  assert.match(body, /ageMs: ageMsAtDecision/, "the retraction emit must carry the age it measured.");
  assert.match(
    body,
    /outcome: "triage-owned",\s+ageMs: planningAdmissionEffectiveAgeMs\(task, stored, now\)/,
    "the ownership-withheld row must carry its age too — that is the measurement the withholding decision rests on.",
  );

  // The docs state the floor as 60 min; that number is only true while the bound stays four refresh floors.
  assert.match(
    admissionSource,
    /export const PLANNING_ADMISSION_STALL_TRIAGE_OWNERSHIP_MS = PLAN_ADMISSION_STALL_REFRESH_FLOOR_MS \* 4;/,
    "the ownership floor is no longer four refresh floors (60 min) — restate the bound in AGENTS.md, "
    + "docs/architecture.md and docs/task-management.md.",
  );
});

test("no doc claims a retraction row lacks its age measurement", () => {
  /*
  Each pattern is a shape the false sentence took. They are matched over the whole file rather than one line
  because the sentence lives inside a single very long bullet: line-scoping would only add blind spots.
  The refuted wording is not "the docs mention `ageMs`-less episodes" — that is the LEGACY episode shape and
  stays legitimately documented — it is a claim that the retract/withheld emit itself omits the field.
  */
  const refuted = [
    { pattern: /never on retraction/i, why: "the retract emit measures and records the age" },
    { pattern: /\b(?:carr(?:y|ies|ying))\s+no\s+`?ageMs`?/i, why: "retraction rows do carry `ageMs`" },
    { pattern: /no retraction (?:outcome|row)[^\n]{0,80}`?ageMs`?/i, why: "every retraction outcome carries it" },
    { pattern: /`?ageMs`?[^\n]{0,80}\bimplied from\b/i, why: "the age is measured, never implied from a row clock" },
    { pattern: /\bimplied from\b[^\n]{0,80}`?ageMs`?/i, why: "the age is measured, never implied from a row clock" },
  ];
  for (const [file, text] of Object.entries(DOCS)) {
    for (const { pattern, why } of refuted) {
      const hit = text.match(pattern)?.[0] ?? null;
      assert.equal(
        hit,
        null,
        `${file} refutes the engine's own audit surface: "${hit}" — ${why}. `
        + "Authority: retractPlanningAdmissionStallEpisodes() emits `ageMs: ageMsAtDecision` measured before the "
        + "clear, pinned by self-healing-planning-admission-stall.test.ts.",
      );
    }
  }
});

test("every doc claim about the foreign-episode ownership floor names its exempt pass", () => {
  /*
  The invariant, not the repro: any sentence that states the floor must also state the one pass it does not
  cover. A partial fix (AGENTS.md only) leaves the same false claim standing in the doc AGENTS.md points to,
  which is why this scans all three surfaces and why each must contribute a claim of its own.
  */
  const floorClaim = /ownership floor|PLANNING_ADMISSION_STALL_TRIAGE_OWNERSHIP_MS|withheld from retraction until its own writer goes quiet/i;
  // The two spellings the unconditional-floor claim took, kept as literals so the exact wording cannot return.
  const refutedFloorWordings = [
    { pattern: /at\s+both\s+retract\s+passes/i, why: "there are three retract passes and one is exempt" },
    { pattern: /never erased by the sweep while triage is still polling/i, why: "the `left-planning-lane` clear erases a foreign episode even while triage polls it" },
  ];
  for (const [file, text] of Object.entries(DOCS)) {
    for (const { pattern, why } of refutedFloorWordings) {
      const hit = text.match(pattern)?.[0] ?? null;
      assert.equal(
        hit,
        null,
        `${file} states the ownership floor unconditionally: "${hit}" — ${why}. Authority: self-healing.ts guards the floor with outcome !== "left-planning-lane" at its retract choke point.`,
      );
    }
  }
  for (const [file, text] of Object.entries(DOCS)) {
    const mentions = text
      .split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => floorClaim.test(line));
    assert.ok(
      mentions.length > 0,
      `${file} no longer documents the foreign-episode ownership floor at all — if the sweep dropped the floor, `
      + "delete its claim here too; if it kept it, this scan has gone blind.",
    );
    const unqualified = mentions.filter(({ line }) => !line.includes("left-planning-lane"));
    assert.deepEqual(
      unqualified.map(({ number, line }) => `${file}:${number} ${line.slice(0, 160)}`),
      [],
      "these lines state the ownership floor without naming the exempt `left-planning-lane` clear, which "
      + "self-healing.ts guards with `outcome !== \"left-planning-lane\"`: a live triage episode IS retracted there.",
    );
  }
});
