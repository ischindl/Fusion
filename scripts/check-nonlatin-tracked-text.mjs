#!/usr/bin/env node
// Runtime: plain Node (node scripts/*.mjs), the invocation contract for every gate validator.
// Imported by scripts/__tests__/check-nonlatin-tracked-text.test.mjs, so it must stay importable
// without executing main().
/*
FNXC:OperatorLanguageIntegrity 2026-10-08-04:55 (RUFU-324):
Models occasionally replace a Slovak or English word with a Chinese/Japanese/Korean/Cyrillic
synonym MID-WORD (a code-switch, not an encoding accident). That text then lives in stored
cards, in PROMPT.md contracts, and — measured 2026-09-26 — once in shipped source: a JSDoc in
packages/core/src/types/agents/agents.ts carried U+4E0D and U+542B inside an English sentence.
Nothing in the repository could see it: four active and four historical cards were contaminated
and no check existed. This validator is the repository's first script-level control.

Detection contract: a violation is a code point that is a letter (\p{L}), is NOT in
Script_Extensions=Latin, and is NOT Script=Common. The third clause is deliberate: V8's Unicode
data classifies decorative letterlike glyphs such as U+2139 (information-source) and the
mathematical alphanumeric block (e.g. U+1D400) as letters, so a two-clause rule would flag
emoji-style documentation callouts and math notation in perfectly clean operator docs — and the
tempting "fix" would be allowlisting those docs, gutting the protection where it matters. A real
code-switch letter always carries its own script (Han, Hiragana, Katakana, Hangul, Cyrillic,
Greek, Arabic, Hebrew, Thai, Devanagari, Georgian, Armenian, ...); script-less decorative
symbols carry none. Non-letters (emoji, arrows, checkmarks, ellipsis, digits) are never
violations, which keeps thousands of legitimately decorated files clean. Slovak, Czech, French,
Vietnamese, Turkish etc. are Latin and stay clean.

NO GLOBAL CJK BAN. Translated READMEs, the language picker's native names, translation catalogs,
and the i18n tests that deliberately feed non-Latin fixtures are legitimate non-Latin content —
i18n owns it. Legitimacy is expressed ONLY through the centralized ALLOWLIST below (each entry
carries a one-line reason; the behavioral test pins that), never through scattered per-file
suppressions. This validator must NEVER ban non-Latin scripts outright.

Self-clean rule: this file and its test contain zero raw non-Latin letters (offenders are
documented as U+XXXX escapes only), so the validator scans its own home.

Membership: appended to root pretest, pretest:full, and the blocking test:gate:static chain, so
every pnpm test entrypoint, verify:fast, and the CI Gate fail on a violation with path, line,
and code point. See docs/testing.md.
*/

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, "..");

/**
 * The violation class: a true letter whose Script_Extensions exclude Latin and which carries a
 * real script (not Script=Common decorative letterlike/math glyphs). See the FNXC block above —
 * this three-clause set IS the contract; do not widen it to non-letters or narrow it to Han-only.
 */
export const NON_LATIN_LETTER = /[\p{L}&&\P{Script_Extensions=Latin}&&\P{Script=Common}]/v;

/** How many violating lines a single failure report names before collapsing to the total. */
export const MAX_REPORTED_VIOLATIONS = 50;

/*
Centralized allowlist (ratchet): every legitimate non-Latin file in the repository. Entries are
matched by isAllowlisted(): an exact repo-relative path, a `dir/**` directory prefix, or a
pattern with `*` wildcards (`*` matches any run of characters except `/`). An entry exempts the
file from scanning ENTIRELY, so it must carry a one-line reason — the behavioral test fails if any
entry lacks one. New legitimate i18n/notation content gets an entry here; accidental code-switch
text gets rewritten, never allowlisted.
*/
export const ALLOWLIST = [
  // Root READMEs: the language switcher line renders every locale's endonym (e.g. the
  // simplified-Chinese, traditional-Chinese, and Korean native names) by design.
  { pattern: "README.md", reason: "English README carries the language-switcher endonym line" },
  { pattern: "README.*.md", reason: "translated READMEs are native-language content by design" },

  // Translation catalogs: the shipped target-language content itself.
  { pattern: "packages/i18n/locales/**", reason: "zh-CN/zh-TW/ko translation catalogs and their status doc are translated content by design" },

  // Shipped i18n label/template sources: native-language names and language-detection samples.
  { pattern: "packages/core/src/config/operator-language.ts", reason: "operator-language roster lists each language's native name" },
  { pattern: "packages/core/src/i18n/detect-content-language.ts", reason: "language detection ships native-language sample tables" },
  { pattern: "packages/dashboard/app/components/LanguageSelector.tsx", reason: "language picker renders each language in its own script" },
  { pattern: "packages/dashboard/app/components/settings/sections/GlobalGeneralSection.tsx", reason: "language settings section renders native language names" },
  { pattern: "packages/dashboard/src/ai-translate.ts", reason: "translation prompts name each target locale by its endonym" },
  { pattern: "packages/dashboard/src/planning.ts", reason: "planning lane ships CJK sample sentences for language detection" },
  { pattern: "packages/engine/src/workflows/workflow-completion-summary.ts", reason: "completion-summary prompt template ships multilingual sample sentences" },

  // Intentional-Unicode test fixtures: i18n/detection/round-trip tests must feed real non-Latin
  // content to prove their logic; each file is a deliberate fixture corpus.
  { pattern: "packages/core/src/__tests__/ai-summarize.test.ts", reason: "summarizer tests feed CJK chat-content fixtures" },
  { pattern: "packages/core/src/__tests__/chat-snippets.test.ts", reason: "snippet tests feed Cyrillic and CJK fixture text" },
  { pattern: "packages/core/src/__tests__/human-plan-approval.test.ts", reason: "plan-approval tests feed CJK marker text fixtures" },
  { pattern: "packages/core/src/__tests__/memory-backend.test.ts", reason: "memory backend tests feed Japanese project-name fixtures" },
  { pattern: "packages/core/src/__tests__/memory-recall-instructions.test.ts", reason: "recall tests feed CJK content fixtures" },
  { pattern: "packages/core/src/__tests__/operator-language.test.ts", reason: "operator-language tests assert native-language names" },
  { pattern: "packages/core/src/__tests__/secrets-crypto.test.ts", reason: "crypto round-trip tests feed Japanese/CJK payload fixtures" },
  { pattern: "packages/cli/src/commands/dashboard-tui/__tests__/terminal-attach.test.ts", reason: "terminal TUI tests feed native-language label fixtures" },
  { pattern: "packages/cli/src/i18n/__tests__/i18n.test.tsx", reason: "CLI i18n tests assert translated label fixtures" },
  { pattern: "packages/dashboard/app/components/__tests__/chat-enter-newline-mobile.test.tsx", reason: "IME-composition test feeds CJK candidate-text fixtures" },
  { pattern: "packages/dashboard/app/components/__tests__/LanguageSelector.test.tsx", reason: "language selector tests assert native-language labels" },
  { pattern: "packages/dashboard/app/i18n/__tests__/labels.test.ts", reason: "dashboard label tests assert translated fixtures" },
  { pattern: "packages/dashboard/app/utils/__tests__/detectContentLanguage.test.ts", reason: "language detection test feeds a per-script corpus fixture" },
  { pattern: "packages/dashboard/src/__tests__/diff-counts.test.ts", reason: "diff-count tests feed CJK UI-copy fixtures" },
  { pattern: "packages/dashboard/src/__tests__/import-translate-service.test.ts", reason: "translation-service import test feeds Korean corpus fixtures" },
  { pattern: "packages/engine/src/__tests__/agent-instructions.test.ts", reason: "instructions tests feed a CJK sample fixture" },
  { pattern: "packages/engine/src/__tests__/chat-context-guard.test.ts", reason: "context-guard test feeds a CJK sample fixture" },
  { pattern: "packages/engine/src/__tests__/mission-execution-loop.test.ts", reason: "execution-loop test feeds Greek-letter and CJK content fixtures" },
  { pattern: "packages/engine/src/__tests__/triage.test.ts", reason: "triage tests feed a Korean description corpus fixture" },
  { pattern: "plugins/fusion-plugin-reports/src/render/__tests__/escape.test.ts", reason: "reports escape test feeds Japanese HTML fixtures" },

  // Technical notation: Greek letters used as math/statistics notation, and spinner glyphs.
  { pattern: "docs/plans/2026-06-03-001-feat-ui-localization-i18n-plan.md", reason: "i18n plan document cites locale endonym examples throughout" },
  { pattern: "docs/solutions/test-failures/postgres-loaded-lane-unrelated-failure-population.md", reason: "statistics notation uses Greek sigma/delta letters" },
  { pattern: "docs/test-speed-baseline-2026-06-03.md", reason: "statistics notation uses Greek sigma summation letter" },
  { pattern: "packages/engine/src/cli-agent/adapters/generic.ts", reason: "PROMPT_GLYPHS spinner uses the Greek lambda letter" },
];

/** Script-name table for the report only; detection never consults it. Ranges are code points. */
const SCRIPT_RANGES = [
  [0x0370, 0x03ff, "Greek"],
  [0x0400, 0x052f, "Cyrillic"],
  [0x0530, 0x058f, "Armenian"],
  [0x0590, 0x05ff, "Hebrew"],
  [0x0600, 0x06ff, "Arabic"],
  [0x0900, 0x097f, "Devanagari"],
  [0x0e00, 0x0e7f, "Thai"],
  [0x10a0, 0x10ff, "Georgian"],
  [0x1100, 0x11ff, "Hangul"],
  [0x3005, 0x3007, "Han"],
  [0x3040, 0x309f, "Hiragana"],
  [0x30a0, 0x30ff, "Katakana"],
  [0x3130, 0x318f, "Hangul"],
  [0x3400, 0x4dbf, "Han"],
  [0x4e00, 0x9fff, "Han"],
  [0xa960, 0xa97f, "Hangul"],
  [0xac00, 0xd7af, "Hangul"],
  [0xf900, 0xfaff, "Han"],
  [0x20000, 0x2fa1f, "Han"],
];

/** Human-readable script name for a violating code point (report text only). */
export function scriptName(codePoint) {
  for (const [lo, hi, name] of SCRIPT_RANGES) {
    if (codePoint >= lo && codePoint <= hi) return name;
  }
  return "non-Latin script";
}

function globToRegExp(pattern) {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`, "u");
}

/**
 * Return the ALLOWLIST entry exempting `filePath`, or null. Directory entries (`dir/**`)
 * exempt their whole subtree; `*` wildcards never cross `/`.
 */
export function isAllowlisted(filePath) {
  for (const entry of ALLOWLIST) {
    if (!entry.pattern.includes("*")) {
      if (filePath === entry.pattern) return entry;
      continue;
    }
    if (entry.pattern.endsWith("/**")) {
      const prefix = entry.pattern.slice(0, -"/**".length);
      if (filePath === prefix || filePath.startsWith(`${prefix}/`)) return entry;
      continue;
    }
    if (globToRegExp(entry.pattern).test(filePath)) return entry;
  }
  return null;
}

/** NUL-safe tracked-file enumeration from the repository root (worktree-safe, quotePath off). */
export function listTrackedTextFiles() {
  const result = spawnSync("git", ["-c", "core.quotePath=false", "ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || "git ls-files failed");
  }
  return result.stdout.split("\0").filter(Boolean);
}

/**
 * Scan `files` (repo-relative paths) for non-Latin letters. `readFileImpl` returns a Buffer (or
 * string) for a repo-relative path and may throw for unreadable paths, which are skipped — the
 * behavioral test injects an in-memory map instead of touching disk. Files whose content contains
 * a NUL byte are binary (docs/assets images, PDFs, recordings) and are never scanned.
 *
 * Returns one entry per violating line: { filePath, lineNumber, line, hits: [{ codePoint, script }] }.
 */
export function scanPaths(files, readFileImpl = (filePath) => readFileSync(resolve(REPO_ROOT, filePath))) {
  const violations = [];
  for (const filePath of files) {
    if (isAllowlisted(filePath)) continue;
    let buffer;
    try {
      buffer = readFileImpl(filePath);
    } catch {
      continue;
    }
    if (typeof buffer === "string") buffer = Buffer.from(buffer, "utf8");
    if (!Buffer.isBuffer(buffer) || buffer.includes(0)) continue;
    const text = buffer.toString("utf8");
    if (!NON_LATIN_LETTER.test(text)) continue; // fast path: files without any candidate character
    const scanner = new RegExp(NON_LATIN_LETTER.source, "gv");
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const hits = [];
      for (const match of lines[index].matchAll(scanner)) {
        const codePoint = match[0].codePointAt(0);
        hits.push({ codePoint, codePointLabel: `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`, script: scriptName(codePoint) });
      }
      if (hits.length > 0) {
        violations.push({ filePath, lineNumber: index + 1, line: lines[index], hits });
      }
    }
  }
  return violations;
}

export function formatFailureMessage(violations) {
  const shown = violations.slice(0, MAX_REPORTED_VIOLATIONS);
  const header = [
    "[check-nonlatin-tracked-text] tracked text contains letters outside the Latin script.",
    "This is the RUFU-324 ratchet: model code-switching (a Slovak/English word replaced mid-word by",
    "CJK/Cyrillic synonyms) must never reach stored cards, PROMPT.md contracts, docs, or shipped source.",
    "If the text is legitimate i18n/notation content, add a reasoned entry to the centralized ALLOWLIST in",
    "scripts/check-nonlatin-tracked-text.mjs; if it is accidental contamination, rewrite the wording in",
    "the operator's language. Never weaken the detection rule itself.",
  ];
  const body = shown.map(({ filePath, lineNumber, line, hits }) => {
    const labels = [...new Set(hits.map((hit) => `${hit.codePointLabel} (${hit.script})`))].join(", ");
    return `${filePath}:${lineNumber}: ${line.trim().slice(0, 120)} -> ${labels}`;
  });
  const overflow = violations.length > shown.length
    ? [`...and ${violations.length - shown.length} more violating line(s); ${violations.length} total.`]
    : [];
  return [...header, ...body, ...overflow].join("\n");
}

export function main() {
  const violations = scanPaths(listTrackedTextFiles());
  if (violations.length === 0) return 0;
  console.error(formatFailureMessage(violations));
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
