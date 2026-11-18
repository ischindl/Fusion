import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const ptBrAppCatalogPath = join(packageRoot, "locales", "pt-BR", "app.json");

/*
FNXC:I18nLocaleList 2026-08-23-20:56:
LOCALES mirrors the `locales` array in i18next.config.ts (the seven catalogs
`i18n:sync` maintains). Keep it in sync manually — a divergence would silently
shrink the duplicate-key guard's coverage.
*/
const LOCALES = ["en", "zh-CN", "zh-TW", "fr", "es", "ko", "pt-BR"];

/*
FNXC:I18nDuplicateKeys 2026-11-18-06:45 (RUFU-726):
The guard used to read only each locale's `app.json` — 7 of the 28 catalog files — so a duplicated
object key in `common`, `cli`, or `errors` was invisible to it even though those files resolve through
the same last-wins `JSON.parse` that made RUFU-166's 429 duplicate paths unreachable at runtime.
NAMESPACES mirrors `namespaces.all` in packages/i18n/namespaces.json; measured at this commit, all 28
files carry zero intra-file duplicates, so widening costs nothing and closes the gap for good.
*/
const NAMESPACES = ["app", "common", "cli", "errors"];

/**
 * RUFU-166 regression scanner: text-level, indentation-aware walk that reports
 * every dotted object-key path occurring more than once in a catalog file.
 * `JSON.parse` resolves duplicate object keys last-wins, so duplicates are
 * invisible to parse-level gates (check-i18n-parity.mjs, parity.test.ts) and
 * resurface only as out-of-scope re-serialization churn on the next
 * `pnpm i18n:sync` run — this scanner is the seam that can see them.
 * Pure fs/JSON text walk: no i18next, no network, no CLI.
 */
function scanDuplicatedPaths(file: string): Array<[string, number, number]> {
  const lines = readFileSync(file, "utf8").split("\n");
  const stack: Array<{ indent: number; key: string }> = [];
  const first = new Map<string, number>(); // dotted path -> first 1-based line
  const dups: Array<[string, number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)"([^"]+)"\s*:\s*(\{|\[)?/);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[2];
    const opens = Boolean(m[3]);
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const path = stack.length > 0 ? [...stack.map((s) => s.key), key].join(".") : key;
    const firstLine = first.get(path);
    if (firstLine === undefined) first.set(path, i + 1);
    else dups.push([path, firstLine, i + 1]);
    if (opens) stack.push({ indent, key });
  }
  return dups;
}

function flatLeafKeys(locale: string, namespace: string): Set<string> {
  const catalog = JSON.parse(readFileSync(join(packageRoot, "locales", locale, `${namespace}.json`), "utf8")) as Record<
    string,
    unknown
  >;
  const out = new Set<string>();
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(node ?? {})) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === "object") walk(value as Record<string, unknown>, path);
      else out.add(path);
    }
  };
  walk(catalog, "");
  return out;
}

/*
FNXC:I18nNamespaceDuplication 2026-11-18-06:45 (RUFU-726):
A duplicated key inside one file makes the earlier copy unreachable. A key present in TWO namespaces
makes the copy the surface does not bind unreachable, and nothing in the toolchain notices: the parity
gate compares per namespace, and the intra-file scanner above compares within one file. That is how
`board.rejection` ended up in both `en/app.json` and `en/common.json` — where the `common` copies are
inert for `Column`, which binds `useTranslation("app")` — and RUFU-726's own measurement says this is
not an isolated case: 50 leaf paths per locale sit in both `app` and `common`, in 32 groups, and two of
them already disagree on content in `en` itself (`mailbox.replyingTo` is "Replying to" in `app` but
"Replying to {{preview}}" in `common`; `agents.onboarding.dialogLabel` is "AI Interview" versus empty).
The budget is a measured shrink-only ratchet, not an approval: deleting a duplicated group is the only
edit that may change it, and `board.rejection` stays named as the group this card landed copy next to.
*/
const CROSS_NAMESPACE_DUPLICATE_BUDGET = 50;
const KNOWN_CROSS_NAMESPACE_GROUPS = ["board.rejection"];

describe("i18n duplicate keys", () => {
  /*
   * FNXC:I18nDuplicateKeys 2026-08-23-08:34:
   * RUFU-166 regression guard. pt-BR/app.json carried a 451-line dead block in which
   * 22 settings sections (settings.reset … settings.globalGeneral) were each present
   * twice, 429 duplicated leaf paths. JSON last-wins made the first copy unreachable
   * at runtime, but every `pnpm i18n:sync` re-serialization re-deleted that block
   * out-of-scope (observed ~485-line churn in the RUFU-165 preflight), producing
   * recurring diffs in unrelated tasks. The i18n parity gate parses JSON and is blind
   * to duplicate object keys, so this text-level scan is the regression guard: any
   * duplicated dotted path in the pt-BR app catalog fails this test.
   *
   * FNXC:I18nDuplicateKeys 2026-08-23-20:56:
   * RUFU-168 landed 2026-08-23 (Path A: the 5 re-appended leaf duplicates per
   * zh-CN/zh-TW/fr/es/ko catalog were resolved by mainline i18n-sync commits in the
   * base advance), so — per RUFU-166's spec ("extend the assertion to all 7 locales
   * when RUFU-168 lands") — the guard now asserts zero duplicated dotted paths in
   * every locale's app catalog, not just pt-BR.
   */
  it("has zero duplicated dotted key paths in the pt-BR app catalog", () => {
    const dups = scanDuplicatedPaths(ptBrAppCatalogPath);
    const offenders = dups
      .slice(0, 5)
      .map(([path, firstLine, dupLine]) => `${path} (L${firstLine}/L${dupLine})`)
      .join("; ");
    expect(
      dups,
      `Duplicated dotted paths in pt-BR/app.json — ${dups.length} total, first offenders: ${offenders}`,
    ).toEqual([]);
  });

  it("has zero duplicated dotted key paths in every locale and namespace catalog", () => {
    const offenders = LOCALES.flatMap((locale) =>
      NAMESPACES.map((namespace) => [
        `${locale}/${namespace}.json`,
        scanDuplicatedPaths(join(packageRoot, "locales", locale, `${namespace}.json`)),
      ] as const),
    ).filter(([, dups]) => dups.length > 0);
    const detail = offenders
      .map(
        ([file, dups]) =>
          `${file}: ${dups.length} total, first: ${dups
            .slice(0, 5)
            .map(([p, a, b]) => `${p} (L${a}/L${b})`)
            .join("; ")}`,
      )
      .join(" | ");
    expect(
      offenders.map(([file]) => file),
      `Duplicated dotted paths across ${LOCALES.length * NAMESPACES.length} catalog files: ${detail}`,
    ).toEqual([]);
  });

  it("holds cross-namespace duplication at its measured shrink-only budget", () => {
    const findings = LOCALES.map((locale) => {
      const appKeys = flatLeafKeys(locale, "app");
      const other = new Set<string>();
      for (const namespace of NAMESPACES.filter((n) => n !== "app")) {
        for (const key of flatLeafKeys(locale, namespace)) other.add(key);
      }
      const duplicated = [...appKeys].filter((key) => other.has(key));
      return [locale, duplicated] as const;
    });
    const detail = findings
      .filter(([, keys]) => keys.length > 0)
      .map(([locale, keys]) => `${locale}: ${keys.length} (${keys.slice(0, 4).join(", ")}…)`)
      .join(" | ");
    for (const [locale, keys] of findings) {
      expect(keys.length, `${locale} duplicated leaf paths across namespaces — ${detail}`).toBeLessThanOrEqual(
        CROSS_NAMESPACE_DUPLICATE_BUDGET,
      );
    }
    // The recorded groups must still be the ones the budget describes; a new group needs naming here.
    const enDuplicated = findings.find(([locale]) => locale === "en")?.[1] ?? [];
    const enGroups = new Set(enDuplicated.map((key) => key.split(".").slice(0, 2).join(".")));
    for (const group of KNOWN_CROSS_NAMESPACE_GROUPS) {
      expect(enGroups.has(group), `${group} should still appear in the measured duplication`).toBe(true);
    }
  });

  it("keeps newly landed board.rejection reason keys in one namespace only", () => {
    // RUFU-726 landed six reason-specific rejection sentences; scattering them into both namespaces
    // would double the inert-copy count the budget above is pinned to instead of shrinking it.
    const reasonKeys = [
      "board.rejection.unplannedForExecutionPlanReviewPending",
      "board.rejection.unplannedForExecutionHumanApprovalPending",
      "board.rejection.unplannedForExecutionPlanningInFlight",
      "board.rejection.unplannedForExecutionNeedsReplan",
      "board.rejection.unplannedForExecutionDuplicateRedirect",
      "board.rejection.unplannedForExecutionSeedPrompt",
    ];
    for (const locale of LOCALES) {
      const commonKeys = flatLeafKeys(locale, "common");
      for (const key of reasonKeys) expect(commonKeys.has(key), `${locale} common carries ${key}`).toBe(false);
    }
  });
});
