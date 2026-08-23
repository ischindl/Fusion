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

  it("has zero duplicated dotted key paths in every locale app catalog", () => {
    const offenders = LOCALES.map((locale) => {
      const dups = scanDuplicatedPaths(join(packageRoot, "locales", locale, "app.json"));
      return [locale, dups] as const;
    }).filter(([, dups]) => dups.length > 0);
    const detail = offenders
      .map(
        ([locale, dups]) =>
          `${locale}/app.json: ${dups.length} total, first: ${dups
            .slice(0, 5)
            .map(([p, a, b]) => `${p} (L${a}/L${b})`)
            .join("; ")}`,
      )
      .join(" | ");
    expect(
      offenders.map(([locale]) => locale),
      `Duplicated dotted paths in locale app catalogs: ${detail}`,
    ).toEqual([]);
  });
});
