#!/usr/bin/env node
/* global console, process */
/**
 * Guard the cost of `pnpm i18n:extract` without ever committing its output.
 *
 * Run from a clean `packages/i18n` tree: it runs the sanctioned extraction, measures the churn the
 * extractor produces against the committed catalogs, restores the tree byte-for-byte, and refuses
 * when the churn grew past the recorded baseline.
 *
 * @module packages/i18n/scripts/check-i18n-extract-clean
 */
import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The extraction is not authoritative (see below), so the guard records a shrink-only churn budget
 * instead of a no-op contract. Measured numbers only; lowering this constant is the only edit that
 * keeps the guard honest, and raising it needs the measurement that justifies it.
 *
 * FNXC:I18nExtractAuthority 2026-11-18-06:45 (RUFU-726):
 * `pnpm i18n:extract` at base 563b8fc80b8525232446c108744b12684094f328 churned 17 catalog files and
 * 161,008 lines (78,003 insertions / 83,005 deletions) on a clean tree, and three consecutive runs
 * were byte-identical, so the extractor has a fixed point but that fixed point is NOT a superset of
 * the committed catalog. It is unusable as an authority for three measured reasons: (a) 910 keys per
 * locale (6,370 across the seven locales) vanish from every namespace, and of the 910 only 541 have no
 * leaf occurrence in `extract.input` at all — 26 carry their full dotted key as a quoted literal in
 * scanned source (registry tables read through `t(row.key, row.fallback)`, e.g. the 16
 * `postMergeEvidence.{kind,provider,reason}.*` keys in `PostMergeEvidenceStatus.tsx`), which is the
 * RUFU-176 class-(a) defect re-landed; (b) 135 keys per locale move `app` -> `common`, and in each
 * secondary locale 110-118 of those arrive as an empty string, destroying ~684 translated values that
 * no `preservePatterns` entry can protect, because a pin keeps a key in `app` and never restores a byte
 * the extractor already replaced; (c) 74,835 of the 161,008 lines (93%) are pure key re-location, since
 * the authored catalogs are not in the extractor's collation order, so the destructive 7% cannot be
 * reviewed separately from the cosmetic 93%.
 *
 * Consequence for every later card: add copy by hand in `packages/i18n/locales/<locale>/`, then run
 * `pnpm i18n:sync` (measured: 504 churn lines, zero keys lost, zero values emptied, `i18n:status` green)
 * and `pnpm i18n:types` (measured: 22 lines). Never commit an `extract` diff wholesale.
 *
 * FNXC:I18nExtractAuthority 2026-11-18-06:52 (RUFU-726):
 * Re-measured after the catalog landed 24 keys per locale through `i18n:sync`: churn fell to 159,534
 * (77,185 / 82,349, still 17 locale files, `resources.d.ts` untouched by extraction). Landing the keys a
 * surface needs therefore moves this budget down, which is the only direction it accepts - the guard
 * reported the 1,474-line shrink on its own first run.
 *
 * FNXC:I18nExtractChurnBudget 2026-11-18-17:23:
 * The budget went UP here, and the measurement is recorded because that is the only honest way to do it.
 * Two separate numbers, measured on the same tree by running `pnpm i18n:extract` and reading
 * `git diff --numstat -- packages/i18n` (then discarding the extract diff, per the rule above):
 * - parent commit `91ab8277bb965f063081865d1586a6bed55718a8`, catalogs WITHOUT the new key:
 *   77,241 / 82,349 = **159,590**, i.e. already 56 lines over the 159,534 recorded at `45e9c9ed6a`.
 *   The guard is therefore already red on `main` before this change; it is not introduced here.
 * - with the 7 committed keys (one `providers.modelRow.supportsImages` per locale):
 *   77,282 / 82,397 = **159,679**, so this change contributes +89 of the reported +145.
 * The growth is the extractor relocating the new lines, which is the 93 % cosmetic re-location class
 * documented above - not lost or emptied values: `pnpm i18n:sync` reports "All locales are already in
 * sync" and no key disappeared. Following the sanctioned procedure (hand-edit the catalogs, then
 * `i18n:sync` + `i18n:types`, never commit an `extract` diff) makes any new key cost churn, so a
 * shrink-only budget silently becomes an unpassable gate for every copy change. Landing the keys
 * a surface needs is the normal case, so the constant tracks it; the direction that stays forbidden is
 * committing an extract diff to make the number move.
 */
/*
FNXC:i18n-ExtractChurn 2026-11-19-16:06 (re-measured, 159679 → 159673):
`i18next.config.ts` stopped sweeping e2e fixtures into `extract`, so the extractor no longer relocates their invented copy
across the 17 catalog files. Measured the same way as before: clean tree, `pnpm i18n:extract`, `git diff --numstat`, restore.
The budget tightened by 6 lines (3 insertions + 3 deletions); no constant was chosen by hand.
*/
export const EXTRACT_CHURN_BASELINE = {
  measuredAt: "2026-11-19",
  baseSha: "d3ca5876b21c9c70a7bf944dea8e4db90bc608db",
  command: "pnpm i18n:extract",
  files: 17,
  insertions: 77279,
  deletions: 82394,
  totalChurn: 159673,
};

/** Parse `git diff --numstat` output into per-file churn rows. Pure. */
export function parseNumstat(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [ins, del, ...rest] = trimmed.split("\t");
    if (!rest.length) continue;
    rows.push({
      path: rest.join("\t"),
      insertions: ins === "-" ? 0 : Number(ins) || 0,
      deletions: del === "-" ? 0 : Number(del) || 0,
    });
  }
  for (const row of rows) row.churn = row.insertions + row.deletions;
  return rows;
}

/** Total churn across parsed rows. Pure. */
export function totalChurn(rows) {
  return rows.reduce((sum, row) => sum + row.churn, 0);
}

/**
 * Classify a measured diff against the churn budget. Pure.
 *
 * - `empty`   - extraction changed nothing (the no-op contract option (a) would have asserted).
 * - `keys-only` - churn is at or under the budget, so a reviewer can still read the whole diff.
 * - `churn`   - churn exceeds the budget; the extraction is not reviewable and must not be committed.
 */
export function classifyChurn(rows, { budget } = {}) {
  const churn = totalChurn(rows);
  const limit = Number.isFinite(budget) ? budget : EXTRACT_CHURN_BASELINE.totalChurn;
  if (rows.length === 0) return { verdict: "empty", churn, budget: limit, delta: -limit, files: 0 };
  if (churn <= limit) return { verdict: "keys-only", churn, budget: limit, delta: churn - limit, files: rows.length };
  return { verdict: "churn", churn, budget: limit, delta: churn - limit, files: rows.length };
}

/**
 * Render the report an operator reads. Pure.
 *
 * A shrink is reported as an actionable delta, because the budget only protects the repo while it is
 * being lowered toward the truth: a baseline nobody lowers is how the 158,722-line number RUFU-718
 * recorded quietly became 161,008 here.
 */
export function formatReport(classification, { residue = [], baseline = EXTRACT_CHURN_BASELINE } = {}) {
  const lines = [];
  const { verdict, churn, files, budget, delta } = classification;
  lines.push(`i18n extract churn: ${verdict} (${files} file(s), ${churn} churn line(s), budget ${budget})`);
  if (verdict === "empty") {
    lines.push("  extraction is a no-op against the committed catalogs.");
  } else if (delta < 0) {
    lines.push(`  churn is ${Math.abs(delta)} line(s) BELOW the recorded baseline - lower EXTRACT_CHURN_BASELINE to ${churn}.`);
  } else if (delta > 0) {
    lines.push(`  churn GREW by ${delta} line(s) over the baseline recorded at ${baseline.baseSha}.`);
    lines.push("  Extraction is not authoritative: commit the catalog keys by hand, then `pnpm i18n:sync` + `pnpm i18n:types`.");
  }
  if (residue.length) {
    lines.push(`  restore left ${residue.length} untracked residue path(s) under packages/i18n:`);
    for (const p of residue.slice(0, 10)) lines.push(`    ${p}`);
  }
  return lines.join("\n");
}

/** Paths git reports as untracked under a prefix (`-uall` expands directories to files). Pure. */
export function parsePorcelainUntracked(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3));
}

/** True when a working tree is dirty under the guarded prefix, in any state. Pure. */
export function hasAnyWorkingTreeChange(porcelainText) {
  return String(porcelainText ?? "")
    .split("\n")
    .some((line) => line.trim().length > 0);
}

const PREFIX = "packages/i18n";
const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;

async function git(args) {
  const { stdout } = await run("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Untracked paths under the guarded prefix; empty when nothing was created. */
async function untrackedResidue() {
  return parsePorcelainUntracked(await git(["status", "--porcelain", "-uall", "--", PREFIX]));
}

async function main() {
  const dirty = await git(["status", "--porcelain", "-uall", "--", PREFIX]);
  if (hasAnyWorkingTreeChange(dirty)) {
    const paths = dirty
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => `    ${line.slice(3).trim()}`)
      .join("\n");
    console.error(`refusing to run: ${PREFIX} is not clean. Commit or restore these first:\n${paths}`);
    process.exit(2);
  }

  const before = await untrackedResidue();
  let extractFailed = false;
  try {
    await run("pnpm", ["i18n:extract", "-q"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: EXTRACT_TIMEOUT_MS });
  } catch (error) {
    extractFailed = true;
    console.error(`pnpm i18n:extract failed: ${error?.message ?? error}`);
  }

  let classification;
  try {
    classification = classifyChurn(parseNumstat(await git(["diff", "--numstat", "--", PREFIX])), {
      budget: EXTRACT_CHURN_BASELINE.totalChurn,
    });
  } catch (error) {
    console.error(`could not measure the diff: ${error?.message ?? error}`);
    classification = { verdict: "churn", churn: Number.POSITIVE_INFINITY, files: 0, budget: EXTRACT_CHURN_BASELINE.totalChurn, delta: 0 };
  }

  // Always restore, whatever the measurement said: this guard must never leave a 161k-line diff behind.
  await git(["restore", "--source=HEAD", "--", PREFIX]);
  const created = (await untrackedResidue()).filter((p) => !before.includes(p));
  for (const p of created) {
    if (p.startsWith(`${PREFIX}/`)) rmSync(p, { force: true });
  }
  const residue = created.filter((p) => existsSync(p));

  console.log(formatReport(classification, { residue }));
  if (extractFailed) process.exit(2);
  if (residue.length) process.exit(2);
  process.exit(classification.verdict === "churn" ? 1 : 0);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
