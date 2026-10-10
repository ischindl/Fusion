import assert from "node:assert/strict";
import { describe, it } from "node:test";

/*
FNXC:OperatorLanguageIntegrity 2026-10-08-05:05 (RUFU-324):
Behavioral contract for the non-Latin script ratchet. The whole point of the validator is to
see model code-switch contamination — a Slovak/English word replaced MID-WORD by a
CJK/Cyrillic synonym — so these fixtures reconstruct that exact shape. Every non-Latin code
point here is written as a `\u` escape and the detection contract is documented in
scripts/check-nonlatin-tracked-text.mjs.

Self-clean rule: this file may never contain a raw non-Latin letter, because the validator
scans the tracked tree that includes it. The "validator and its own test scan clean" case
below enforces that rule as behavior rather than as an aspiration, so adding a real CJK
literal here fails pretest instead of silently needing an allowlist entry.

Both sides of the allowlist are pinned: a planted offender outside it is reported with path,
1-based line, and code point, and the identical character inside an allowlisted path is
ignored. A one-sided test could be satisfied by a scanner that flags nothing or by an
allowlist that exempts everything.
*/

import {
  ALLOWLIST,
  MAX_REPORTED_VIOLATIONS,
  formatFailureMessage,
  isAllowlisted,
  scanPaths,
  scriptName,
} from "../check-nonlatin-tracked-text.mjs";

/** Han letter used by the shipped-source trace (U+4E0D, "not"). */
const HAN_NOT = String.fromCodePoint(0x4e0d);
/** Second Han letter of the same contaminated sentence (U+542B, "contain"). */
const HAN_CONTAIN = String.fromCodePoint(0x542b);
/** Cyrillic small letter en — the RUFU-266 card-contamination class. */
const CYRILLIC_EN = String.fromCodePoint(0x043d);

/** Scan an in-memory fake tree; no child process, no real git, no disk writes. */
function scan(files) {
  return scanPaths(Object.keys(files), (filePath) => files[filePath]);
}

function planted(content) {
  return { "packages/engine/src/planted.ts": content };
}

describe("check-nonlatin-tracked-text", () => {
  it("reports a planted non-Latin letter with path, 1-based line, and code point", () => {
    const violations = scan(planted(["const heading = 'Summary';", "", `const label = 'netZero${HAN_NOT} check';`].join("\n")));

    assert.equal(violations.length, 1);
    assert.equal(violations[0].filePath, "packages/engine/src/planted.ts");
    assert.equal(violations[0].lineNumber, 3);
    assert.deepEqual(violations[0].hits.map((hit) => hit.codePointLabel), ["U+4E0D"]);
    assert.equal(violations[0].hits[0].script, "Han");
  });

  it("ignores the identical character inside an allowlisted path (glob and exact-path sides)", () => {
    const contaminated = `const label = 'netZero${HAN_NOT} check';`;

    assert.deepEqual(scan({ "README.zh-CN.md": contaminated }), []);
    assert.deepEqual(scan({ "packages/core/src/config/operator-language.ts": contaminated }), []);
    assert.equal(isAllowlisted("README.zh-CN.md")?.pattern, "README.*.md");
    assert.equal(isAllowlisted("packages/core/src/config/operator-language.ts")?.pattern, "packages/core/src/config/operator-language.ts");
  });

  it("exempts a whole directory subtree but never lets a wildcard cross a path separator", () => {
    const contaminated = `{ "title": "^\u4e0d" }`;

    assert.deepEqual(scan({ "packages/i18n/locales/zh-CN/app.json": contaminated }), []);
    assert.equal(isAllowlisted("packages/i18n/locales/zh-CN/app.json")?.pattern, "packages/i18n/locales/**");

    // `README.*.md` is a root-level entry: `*` must not reach into subdirectories, or a single
    // entry would silently exempt every README in the repository.
    assert.equal(isAllowlisted("packages/engine/README.zh-CN.md"), null);
    assert.equal(scan({ "packages/engine/README.zh-CN.md": contaminated }).length, 1);
  });

  it("flags the shipped-source trace line and accepts its repaired wording", () => {
    // The measured shipped-tree trace: the JSDoc of AgentApiKeyCreateResult.key in
    // packages/core/src/types/agents/agents.ts carried these two Han letters inside an
    // English sentence. Rebuilt from code points so this file stays self-clean.
    const contaminatedLine = `  /** The persisted key metadata (${HAN_NOT}${HAN_CONTAIN} plaintext token) */`;
    const repairedLine = "  /** The persisted key metadata - no plaintext token */";

    const violations = scan({ "packages/core/src/types/agents/agents.ts": [contaminatedLine, "  key: AgentApiKey;"].join("\n") });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].lineNumber, 1);
    assert.deepEqual(violations[0].hits.map((hit) => hit.codePointLabel), ["U+4E0D", "U+542B"]);
    assert.deepEqual([...new Set(violations[0].hits.map((hit) => hit.script))], ["Han"]);

    assert.deepEqual(scan({ "packages/core/src/types/agents/agents.ts": `${repairedLine}\n  key: AgentApiKey;` }), []);
  });

  it("flags Cyrillic and every other non-Latin script, not just Han", () => {
    // The detection contract is "letter outside the Latin script", so a Han-only ban would
    // miss the observed Cyrillic cards. Each sample is one letter of its own script.
    const samples = [
      ["Han", String.fromCodePoint(0x4e0d)],
      ["Hiragana", String.fromCodePoint(0x3042)],
      ["Katakana", String.fromCodePoint(0x30a2)],
      ["Hangul", String.fromCodePoint(0xd55c)],
      ["Cyrillic", CYRILLIC_EN],
      ["Greek", String.fromCodePoint(0x03a3)],
      ["Hebrew", String.fromCodePoint(0x05d0)],
      ["Arabic", String.fromCodePoint(0x0627)],
      ["Thai", String.fromCodePoint(0x0e01)],
      ["Devanagari", String.fromCodePoint(0x0905)],
      ["Georgian", String.fromCodePoint(0x10d0)],
      ["Armenian", String.fromCodePoint(0x0531)],
    ];

    for (const [script, letter] of samples) {
      const violations = scan(planted(`const label = 'mid${letter}word';`));
      assert.equal(violations.length, 1, `${script} letter must be flagged`);
      assert.equal(violations[0].hits[0].script, script);
      assert.equal(scriptName(violations[0].hits[0].codePoint), script);
    }
  });

  it("leaves Latin text, decorations, and script-less letterlike glyphs alone", () => {
    // Slovak/Czech/French/Vietnamese/Turkish diacritics are Latin; emoji, arrows, checkmarks,
    // ellipsis, and numero signs are not letters; informational/math-italic glyphs ARE letters
    // but carry Script=Common, which is why the contract carries a third clause. Without it,
    // documentation callouts and math notation in clean operator docs would be flagged, and the
    // tempting fix would be an allowlist entry that guts the protection where it matters.
    const clean = [
      "// Pr\u00edkaz pr\u00ed\u0161erne \u013d\u0111 \u0161\u010d\u0138 \u0159 \u016f \u00e4\u00f6\u00fc \u1ebf \u011f\u0131 \u015b\u0107",
      "// shipping \u2191 done \u2713 pending \u2026 12 \u2116 3 \u00d7 4 \u2019ok\u2019",
      "// \u{1f642} note \u2139 \u{1d400} \u2460",
    ].join("\n");

    assert.deepEqual(scan({ "packages/engine/src/clean.ts": clean }), []);
  });

  it("skips binary files and unreadable paths without failing the scan", () => {
    const cjkBytes = Buffer.from(`label \u4e0d`);
    const binary = Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), cjkBytes]);

    assert.deepEqual(scan({ "docs/assets/diagram.png": binary }), []);
    assert.deepEqual(
      scanPaths(["packages/core/missing.ts"], () => {
        throw new Error("ENOENT");
      }),
      [],
    );
  });

  it("names every violating line up to the cap and then reports the total", () => {
    const lines = Array.from({ length: MAX_REPORTED_VIOLATIONS + 3 }, (_, index) => `const v${index} = '${HAN_NOT}';`);
    const violations = scan(planted(lines.join("\n")));
    assert.equal(violations.length, lines.length);

    const message = formatFailureMessage(violations);
    // Report shape is the operator's only lead: path, 1-based line, the line itself, code point.
    assert.ok(
      message.includes(`packages/engine/src/planted.ts:1: const v0 = '${HAN_NOT}'; -> U+4E0D (Han)`),
      `report must name the first violating line with its code point:\n${message}`,
    );
    assert.ok(message.includes(`const v${MAX_REPORTED_VIOLATIONS - 1} = '`), "the cap boundary line is named");
    assert.ok(!message.includes(`const v${MAX_REPORTED_VIOLATIONS} = '`), "lines past the cap are not enumerated");
    assert.ok(
      message.includes(`and ${lines.length - MAX_REPORTED_VIOLATIONS} more violating line(s); ${lines.length} total.`),
      "the collapsed remainder must state the total",
    );
  });

  it("requires every allowlist entry to carry a pattern and a one-line reason", () => {
    // An entry exempts a file ENTIRELY, so an unreasoned entry is how the ratchet quietly rots.
    assert.ok(ALLOWLIST.length > 0);
    for (const entry of ALLOWLIST) {
      assert.equal(typeof entry.pattern, "string");
      assert.ok(entry.pattern.trim().length > 0, "allowlist entry needs a pattern");
      assert.equal(typeof entry.reason, "string");
      assert.ok(entry.reason.trim().length > 20, `${entry.pattern} needs a justification reason`);
      assert.ok(!entry.reason.includes("\n"), `${entry.pattern} reason must stay one line`);
    }
    assert.equal(new Set(ALLOWLIST.map((entry) => entry.pattern)).size, ALLOWLIST.length, "allowlist patterns must be unique");
  });

  it("the repaired shipped-source file scans clean in the real tree", () => {
    // Symptom verification for the contamination this ratchet was built to catch: the JSDoc on
    // AgentApiKeyCreateResult.key in packages/core/src/types/agents/agents.ts carried two Han
    // letters inside an English sentence. The repair replaced them with the operator's wording, so
    // the shipped file must now scan clean. Regression here means contamination re-entered shipped
    // source, which is what the pretest/gate invocation is meant to refuse.
    assert.deepEqual(scanPaths(["packages/core/src/types/agents/agents.ts"]), []);
  });

  it("scans its own validator and test file clean (self-clean rule)", () => {
    // Real files, real reader: if either file ever gains a raw non-Latin letter — including in
    // the FNXC block or an allowlist rationale — the validator it validates would fail pretest.
    const violations = scanPaths([
      "scripts/check-nonlatin-tracked-text.mjs",
      "scripts/__tests__/check-nonlatin-tracked-text.test.mjs",
    ]);
    assert.deepEqual(violations.map((v) => `${v.filePath}:${v.lineNumber}`), []);
    assert.equal(isAllowlisted("scripts/check-nonlatin-tracked-text.mjs"), null, "the validator must not need its own exemption");
  });
});
