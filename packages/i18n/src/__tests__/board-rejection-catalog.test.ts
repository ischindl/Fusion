import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_LOCALES } from "@fusion/core";
import { describe, expect, it } from "vitest";

/*
FNXC:ExecutionAdmissionReason 2026-11-18-06:45 (RUFU-726):
RUFU-718 shipped six reason-specific `board.rejection.unplannedForExecution*` sentences in
`Column.tsx` and none of them ever reached a catalog, so the board printed the raw key at operators —
the shipped-copy regression RUFU-718 was itself created to eliminate, recurring one card later because
no gate checked that a literal call site has a catalog entry. `Column` binds `useTranslation("app")`,
so the copy only resolves out of `app.json`: these assertions pin the keys to the namespace the surface
actually binds, in every locale, and pin `en` to the exact bytes of the code default so a future edit to
one side cannot drift from the other. `common` is asserted absent because a key parked only in the
default namespace does not resolve for an `app`-bound call site (RUFU-176's class-(b) shape).
*/

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = join(packageRoot, "..", "..");
const REASON_KEYS = [
  "unplannedForExecutionPlanReviewPending",
  "unplannedForExecutionHumanApprovalPending",
  "unplannedForExecutionPlanningInFlight",
  "unplannedForExecutionNeedsReplan",
  "unplannedForExecutionDuplicateRedirect",
  "unplannedForExecutionSeedPrompt",
] as const;

function readCatalog(locale: string, namespace: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(packageRoot, "locales", locale, `${namespace}.json`), "utf8"));
}

function readPath(catalog: Record<string, unknown>, dotted: string): string | undefined {
  let current: unknown = catalog;
  for (const part of dotted.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

/** Pull the English default of each `t("board.rejection.<key>", "<default>")` literal out of Column.tsx. */
function readSourceDefaults(): Map<string, string> {
  const source = readFileSync(join(repoRoot, "packages/dashboard/app/components/Column.tsx"), "utf8");
  const out = new Map<string, string>();
  for (const key of REASON_KEYS) {
    const match = source.match(new RegExp(`"board\\.rejection\\.${key}",\\s*\\n?\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (!match) throw new Error(`Column.tsx carries no literal default for ${key}`);
    out.set(key, JSON.parse(`"${match[1]}"`));
  }
  return out;
}

describe("board.rejection unplanned-for-execution catalog copy", () => {
  /*
   * Presence is asserted as "a string is there", not "the string is non-empty": `pnpm i18n:sync` lands a
   * propagated key as an empty value and an empty secondary-locale value is the documented
   * untranslated-falls-back-to-en convention (`parity.ts` tolerates it deliberately). Asserting a
   * non-empty value here would demand invented translations, which this card does not do.
   */
  it("ships all six reason keys in the app namespace of every supported locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const app = readCatalog(locale, "app");
      for (const key of REASON_KEYS) {
        expect(readPath(app, `board.rejection.${key}`), `${locale}/app.json board.rejection.${key}`).not.toBeUndefined();
      }
    }
  });

  it("keeps en values byte-equal to the Column.tsx code defaults", () => {
    const defaults = readSourceDefaults();
    expect(defaults.size).toBe(REASON_KEYS.length);
    const app = readCatalog("en", "app");
    for (const key of REASON_KEYS) {
      expect(readPath(app, `board.rejection.${key}`), `en app board.rejection.${key}`).toBe(defaults.get(key));
    }
  });

  it("keeps the six keys out of the common namespace, where an app-bound call site cannot see them", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const common = readCatalog(locale, "common");
      for (const key of REASON_KEYS) {
        expect(readPath(common, `board.rejection.${key}`), `${locale}/common.json must not carry board.rejection.${key}`).toBeUndefined();
      }
    }
  });

  it("keeps the six sentences distinct so one generic label cannot stand in for all six states", () => {
    const app = readCatalog("en", "app");
    const values = REASON_KEYS.map((key) => readPath(app, `board.rejection.${key}`));
    expect(new Set(values).size).toBe(values.length);
    const generic = readPath(app, "board.rejection.unplannedForExecution");
    for (const value of values) expect(value).not.toBe(generic);
  });
});
