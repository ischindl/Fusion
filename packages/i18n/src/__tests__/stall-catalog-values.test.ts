import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
FNXC:StallReason 2026-09-02-18:40:
RUFU-177 made the server-derived `stallReason` the authority the dashboard renders, and its copy
groups live under `stall.*` in every locale catalog. The key-parity gate (parity.ts) deliberately
TOLERATES empty secondary-locale values — that is the documented untranslated-fallback-to-en
convention — so parity can never catch an untranslated stall surface. This test closes that gap:
every leaf under `stall` must carry a non-empty value in all seven catalogs, and each translated
value must keep exactly the interpolation placeholders of its `en` source (`{{taskId}}` on the
dependency/overlap headlines names the blocking card — dropping it would silently delete the card
name from the stall affordance).
*/

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = join(packageRoot, "..", "..");
const localesRoot = join(packageRoot, "locales");

type CatalogValue = string | { [key: string]: CatalogValue };

function listSupportedLocales(): string[] {
  const configText = readFileSync(join(repoRoot, "i18next.config.ts"), "utf8");
  const localesMatch = configText.match(/locales:\s*\[([^\]]+)\]/m);
  if (!localesMatch) {
    throw new Error("Unable to read locales from i18next.config.ts");
  }
  return [...localesMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function readStallGroup(locale: string): Record<string, CatalogValue> {
  const catalog = JSON.parse(readFileSync(join(localesRoot, locale, "app.json"), "utf8")) as {
    stall?: Record<string, CatalogValue>;
  };
  return catalog.stall ?? {};
}

function flattenLeaves(prefix: string, group: Record<string, CatalogValue>, out: Map<string, string>): void {
  for (const [key, value] of Object.entries(group)) {
    const path = `${prefix}.${key}`;
    if (typeof value === "string") {
      out.set(path, value);
    } else {
      flattenLeaves(path, value, out);
    }
  }
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{[A-Za-z]+\}\}/g)].map((match) => match[0]).sort();
}

describe("stall catalog values are filled in every locale", () => {
  const locales = listSupportedLocales();
  const enLeaves = new Map<string, string>();
  flattenLeaves("stall", readStallGroup("en"), enLeaves);

  it("has a non-empty en stall group to guard against", () => {
    expect(enLeaves.size).toBeGreaterThan(0);
    for (const [key, value] of enLeaves) {
      expect(value.trim(), `en leaf ${key} must never be empty`).not.toBe("");
    }
  });

  for (const locale of locales) {
    it(`${locale}: every stall.* leaf is filled and keeps en's interpolation placeholders`, () => {
      const leaves = new Map<string, string>();
      flattenLeaves("stall", readStallGroup(locale), leaves);

      expect(leaves.size, `${locale} must carry the same stall leaf count as en`).toBe(enLeaves.size);

      const empty: string[] = [];
      const placeholderDrift: string[] = [];
      for (const [key, value] of leaves) {
        if (value.trim() === "") empty.push(key);
        const source = enLeaves.get(key);
        if (source === undefined) {
          placeholderDrift.push(`${key} (missing in en)`);
          continue;
        }
        const want = placeholders(source);
        const got = placeholders(value);
        if (want.join(",") !== got.join(",")) placeholderDrift.push(`${key} (locale ${JSON.stringify(got)} vs en ${JSON.stringify(want)})`);
      }

      expect(empty, `${locale}: empty stall.* leaves (parity gate tolerates these — RUFU-177 does not)`).toEqual([]);
      expect(placeholderDrift, `${locale}: stall.* values whose {{interpolation}} set diverges from en`).toEqual([]);
    });
  }

  it("names the blocking card: dependency and overlap headlines interpolate {{taskId}} in every locale", () => {
    for (const locale of locales) {
      for (const key of ["stall.dependency-block.headline", "stall.overlap-block.headline"]) {
        const value = leavesOf(locale).get(key);
        expect(value, `${locale}.${key} must exist`).toBeDefined();
        expect(placeholders(value as string), `${locale}.${key} must interpolate {{taskId}}`).toContain("{{taskId}}");
      }
    }
  });
});

const leavesCache = new Map<string, Map<string, string>>();
function leavesOf(locale: string): Map<string, string> {
  const cached = leavesCache.get(locale);
  if (cached) return cached;
  const leaves = new Map<string, string>();
  flattenLeaves("stall", readStallGroup(locale), leaves);
  leavesCache.set(locale, leaves);
  return leaves;
}
