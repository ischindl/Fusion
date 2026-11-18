import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_LOCALES } from "@fusion/core";
import { describe, expect, it } from "vitest";
import {
  classifyChurn,
  EXTRACT_CHURN_BASELINE,
  formatReport,
  hasAnyWorkingTreeChange,
  parseNumstat,
  parsePorcelainUntracked,
  totalChurn,
} from "../../scripts/check-i18n-extract-clean.mjs";

/*
FNXC:I18nExtractAuthority 2026-11-18-06:45 (RUFU-726):
`pnpm i18n:extract` is not an authority over the committed catalogs (the measured reasons are written
into `check-i18n-extract-clean.mjs`), so what protects the repo from it is a recorded, shrink-only
churn budget. Pure helpers carry the classification so the contract is unit-testable without a 40-second
extraction, a git working tree, or a restore that could itself leave residue.
*/

describe("i18n extract churn guard", () => {
  it("parses git numstat output into per-file churn rows", () => {
    const rows = parseNumstat(
      ["7\t1\tpackages/i18n/locales/en/app.json", "59\t33\tpackages/i18n/locales/fr/app.json", "-\t-\tbinary/blob", "", "   "].join("\n"),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ path: "packages/i18n/locales/en/app.json", insertions: 7, deletions: 1, churn: 8 });
    // A binary row reports `-` for both counts; it counts as no churn rather than NaN.
    expect(rows[2]).toEqual({ path: "binary/blob", insertions: 0, deletions: 0, churn: 0 });
    expect(totalChurn(rows)).toBe(100);
    expect(totalChurn([])).toBe(0);
  });

  it("classifies a diff that changed nothing as the no-op verdict", () => {
    expect(classifyChurn([], { budget: 161008 })).toEqual({ verdict: "empty", churn: 0, budget: 161008, delta: -161008, files: 0 });
  });

  it("classifies churn at or under the budget as reviewable and reports the shrink", () => {
    const rows = parseNumstat("10\t10\tlocales/en/app.json");
    const at = classifyChurn(rows, { budget: 20 });
    expect(at.verdict).toBe("keys-only");
    expect(at.delta).toBe(0);
    const under = classifyChurn(rows, { budget: 500 });
    expect(under.verdict).toBe("keys-only");
    expect(under.delta).toBe(-480);
    expect(formatReport(under, { baseline: EXTRACT_CHURN_BASELINE })).toContain("480 line(s) BELOW");
  });

  it("classifies churn over the budget as unreviewable and names the sanctioned path", () => {
    const rows = parseNumstat("100000\t100000\tlocales/en/app.json");
    const over = classifyChurn(rows, { budget: 161008 });
    expect(over.verdict).toBe("churn");
    expect(over.churn).toBe(200000);
    expect(over.delta).toBe(38992);
    const report = formatReport(over, { baseline: EXTRACT_CHURN_BASELINE });
    expect(report).toContain("GREW by 38992");
    expect(report).toContain("i18n:sync");
  });

  it("reports untracked residue the restore could not remove", () => {
    const rows = parseNumstat("1\t1\tlocales/en/app.json");
    const report = formatReport(classifyChurn(rows, { budget: 10 }), { residue: ["packages/i18n/locales/en/extra.json"] });
    expect(report).toContain("1 untracked residue path");
    expect(report).toContain("packages/i18n/locales/en/extra.json");
  });

  it("reads untracked paths and dirt from git porcelain output", () => {
    expect(parsePorcelainUntracked("?? packages/i18n/locales/en/new.json\n M packages/i18n/locales/en/app.json\n")).toEqual([
      "packages/i18n/locales/en/new.json",
    ]);
    expect(parsePorcelainUntracked("")).toEqual([]);
    expect(hasAnyWorkingTreeChange("")).toBe(false);
    expect(hasAnyWorkingTreeChange("\n")).toBe(false);
    expect(hasAnyWorkingTreeChange(" M packages/i18n/locales/en/app.json")).toBe(true);
  });

  /*
   * The budget is a measurement, not a preference: its parts have to agree with each other or the
   * recorded number has been edited by hand rather than re-measured.
   */
  it("records a self-consistent measured baseline", () => {
    expect(EXTRACT_CHURN_BASELINE.insertions + EXTRACT_CHURN_BASELINE.deletions).toBe(EXTRACT_CHURN_BASELINE.totalChurn);
    expect(EXTRACT_CHURN_BASELINE.command).toBe("pnpm i18n:extract");
    expect(EXTRACT_CHURN_BASELINE.baseSha).toMatch(/^[0-9a-f]{40}$/);
    // The guard exists because extraction is destructive; a zero or no-op baseline would mean the
    // budget was lowered to a number the extractor can actually meet, which would be a claim to verify.
    expect(EXTRACT_CHURN_BASELINE.totalChurn).toBeGreaterThan(1000);
  });

  it("is registered as a standalone check and kept out of the blocking gates", () => {
    const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts["check:i18n-extract-clean"]).toBe("node packages/i18n/scripts/check-i18n-extract-clean.mjs");
    // Extraction costs ~40s and is destructive, so it runs on request, not on every test or gate pass.
    expect(pkg.scripts.pretest).not.toContain("check-i18n-extract-clean");
    expect(pkg.scripts["test:gate:static"]).not.toContain("check-i18n-extract-clean");
    expect(pkg.scripts["test:gate"]).not.toContain("check-i18n-extract-clean");
  });
});

describe("supported locale list", () => {
  it("covers every locale the guard's catalogs ship", () => {
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const configText = readFileSync(join(packageRoot, "..", "..", "i18next.config.ts"), "utf8");
    const locales = [...configText.match(/locales:\s*\[([^\]]+)\]/m)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(locales).toEqual([...SUPPORTED_LOCALES]);
  });
});
