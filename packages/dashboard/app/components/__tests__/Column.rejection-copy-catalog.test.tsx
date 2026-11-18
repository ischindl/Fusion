import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { translateRejection, translateRejectionKey } from "../Column";

/*
FNXC:BoardRejectionCopy 2026-11-18-07:25 (RUFU-726):
RUFU-718 shipped six reason-specific refusal sentences in this file and none of them ever reached a
catalog, so the copy a localized operator saw was decided by whichever fallback the code carried.
No existing test could see that: every dashboard test that touched these literals drove them with a
`t()` that answers from the code default, which is exactly what a missing key looks like in English.

These tests therefore drive `translateRejection`/`translateRejectionKey` with a `t()` that answers
ONLY from the catalog. Resolution that still returns the code default is the RUFU-718 state, so the
marker cases below are the regression pin the card's acceptance asks for ("real copy rather than keys
for all six reasons"), widened to every rejection key this component can be handed — the invariant,
not the single reported repro.
*/

/* Four levels up from this file's directory: __tests__ -> components -> app -> dashboard -> packages,
   which is where the catalogs live. Module-relative so a root-launched Vitest resolves them the same
   way a package-launched one does (see scripts/check-no-cwd-relative-dashboard-test-reads.mjs). */
const LOCALES_ROOT = resolve(__dirname, "../../../../", "i18n", "locales");

/** Every message key `Column.tsx` can hand to `t()`, with the transition code that carries it. */
const REJECTION_CASES: { code: string; key: string }[] = [
  { code: "guard-rejected", key: "board.rejection.guardRejected" },
  { code: "capacity-exhausted", key: "board.rejection.capacityExhausted" },
  { code: "unknown-column", key: "board.rejection.unknownColumn" },
  { code: "workflow-mismatch", key: "board.rejection.workflowMismatch" },
  { code: "merge-blocked", key: "board.rejection.mergeBlocked" },
  { code: "gate-evidence-missing", key: "board.rejection.gateEvidenceMissing" },
  { code: "stale-move-precondition", key: "board.rejection.staleMovePrecondition" },
  { code: "unplanned-for-execution", key: "board.rejection.unplannedForExecution" },
  { code: "unplanned-for-execution", key: "board.rejection.unplannedForExecutionPlanReviewPending" },
  { code: "unplanned-for-execution", key: "board.rejection.unplannedForExecutionHumanApprovalPending" },
  { code: "unplanned-for-execution", key: "board.rejection.unplannedForExecutionPlanningInFlight" },
  { code: "unplanned-for-execution", key: "board.rejection.unplannedForExecutionNeedsReplan" },
  { code: "unplanned-for-execution", key: "board.rejection.unplannedForExecutionDuplicateRedirect" },
  { code: "unplanned-for-execution", key: "board.rejection.unplannedForExecutionSeedPrompt" },
];

/** The six reason keys RUFU-718's `ExecutionAdmissionReason` enum emits (the generic key is excluded:
 *  it is the fallback these six are distinguished from). */
const REASON_KEYS = REJECTION_CASES.filter((entry) => entry.key !== "board.rejection.unplannedForExecution" && entry.code === "unplanned-for-execution").map(
  (entry) => entry.key,
);

function readAppCatalog(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(LOCALES_ROOT, locale, "app.json"), "utf8")) as Record<string, unknown>;
}

/** Resolve a dotted key the way i18next does for a surface bound with `useTranslation("app")`.
 *  An unresolvable key yields the fallback the call site passed — and the rejection call sites pass
 *  either an English default (RUFU-718's fix) or, on the bare pre-check default branch, the key. */
function catalogBackedT(catalog: Record<string, unknown>) {
  return (key: string, fallback: string): string => {
    const value = key
      .split(".")
      .reduce<unknown>(
        (node, segment) => (node && typeof node === "object" ? (node as Record<string, unknown>)[segment] : undefined),
        catalog,
      );
    return typeof value === "string" && value.length > 0 ? value : fallback;
  };
}

/** A `t()` whose catalog answers `MARKER:<key>` for exactly `keys`, and nothing else. Resolution that
 *  comes back as anything else came from the code default, not from the catalog. */
function markerT(keys: string[]): ReturnType<typeof catalogBackedT> {
  const catalog: Record<string, unknown> = { board: { rejection: {} } };
  const group = catalog.board as { rejection: Record<string, unknown> };
  for (const key of keys) group.rejection[key.split(".").pop() as string] = `MARKER:${key}`;
  return catalogBackedT(catalog);
}

const enCatalog = readAppCatalog("en");
const enT = catalogBackedT(enCatalog);

function rejection(code: string, messageKey: string) {
  return { code, messageKey, retryable: false };
}

describe("board rejection copy is read from the catalog, not from the code default", () => {
  it.each(REJECTION_CASES)("$key reaches the catalog from a transition code", ({ code, key }) => {
    expect(translateRejection(markerT([key]), rejection(code, key))).toBe(`MARKER:${key}`);
  });

  it.each(REJECTION_CASES)("$key resolves to the committed English copy, never to the key", ({ code, key }) => {
    const copy = translateRejection(enT, rejection(code, key));
    const committed = key
      .split(".")
      .reduce<unknown>((node, segment) => (node && typeof node === "object" ? (node as Record<string, unknown>)[segment] : undefined), enCatalog);
    expect(typeof committed).toBe("string");
    expect(copy).toBe(committed);
    expect(copy).not.toContain("board.rejection");
  });

  it.each(["board.rejection.unplannedForExecution", ...REASON_KEYS])(
    "the R17 drag pre-check says the same sentence as the 409 for %s",
    (key) => {
      const markers = markerT([key]);
      expect(translateRejectionKey(markers, key)).toBe(`MARKER:${key}`);
      expect(translateRejectionKey(markers, key)).toBe(
        translateRejection(markers, rejection("unplanned-for-execution", key)),
      );
      expect(translateRejectionKey(enT, key)).toBe(translateRejection(enT, rejection("unplanned-for-execution", key)));
    },
  );

  it("answers an unrecognised reason key with the generic sentence rather than a raw key", () => {
    const unknown = rejection("unplanned-for-execution", "board.rejection.unplannedForExecutionSomeNewReason");
    expect(translateRejection(enT, unknown)).toBe(
      translateRejection(enT, rejection("unplanned-for-execution", "board.rejection.unplannedForExecution")),
    );
    expect(translateRejection(enT, unknown)).not.toContain("SomeNewReason");
  });

  it("would have caught RUFU-718: with the catalog entry gone the copy stops coming from the catalog", () => {
    const marker = "MARKER:board.rejection.unplannedForExecutionNeedsReplan";
    const present = translateRejection(markerT([marker.slice(7)]), rejection("unplanned-for-execution", marker.slice(7)));
    const stripped = translateRejection(markerT([]), rejection("unplanned-for-execution", marker.slice(7)));

    expect(present).toBe(marker);
    // The stripped run is the state RUFU-718 shipped in: the call still renders, silently, off the
    // code default. A test that cannot tell these two apart is the test that let it through.
    expect(stripped).not.toBe(marker);
    expect(stripped).toContain("Replan");
  });
});
