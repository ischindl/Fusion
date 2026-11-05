/**
 * RUFU-480: the stale-binary schema warning is an operator-addressed, countable class.
 *
 * FNXC:StaleBinaryOperatorClass 2026-11-05-12:28:
 * A database newer than this binary is WARN-ONLY (the hard refusal was removed 2026-10-05), so this
 * single line is the ONLY thing every surface — CLI, dashboard, engine lanes, the pi extension —
 * reports in that state. These tests pin what the line must communicate: both version numbers, the
 * stable class token used to count affected cards, the operator-only remedy, and the clause that
 * stops a lane reading a healthy boot as a failed card.
 *
 * Why this file exists separately from schema-applier.test.ts: that file is a PostgreSQL
 * integration suite whose header force-skips on FUSION_PG_TEST_SKIP=1 and when no server is
 * reachable, so an assertion living there can silently stop running. The guard is a pure function
 * over a version list, so every assertion here is DB-free, needs no mocked world, and always runs.
 *
 * Version literals are never hardcoded: the newer version is DERIVED from SCHEMA_BASELINE_VERSION,
 * so this file stays true as the ceiling advances. Assertions are substring matchers because
 * `Logger.warn` prefixes the payload with a control-character severity marker and the
 * `[schema-applier]` tag (process/logger.ts).
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SCHEMA_BASELINE_VERSION,
  STALE_BINARY_SCHEMA_CLASS,
  assertBinaryNotOlderThanDatabase,
} from "../../postgres/schema-applier.js";

/** Guarded source, read for the stays-gone construct assertions. */
const applierSource = readFileSync(
  fileURLToPath(new URL("../../postgres/schema-applier.ts", import.meta.url)),
  "utf8",
);

/** The newest version a later Fusion could record, derived so this file never ages out. */
const futureVersion = String(Number(SCHEMA_BASELINE_VERSION) + 1).padStart(4, "0");

/**
 * Captures every `console.warn` payload emitted while `run` executes.
 *
 * The calls are mapped to strings BEFORE `mockRestore()`, because restoring also clears the call
 * history; the restore happens in `finally` because no `restoreMocks`/`clearMocks` is configured
 * for this package, so a spy left installed here keeps accumulating `mock.calls` into the NEXT
 * test — which made the "says nothing on a healthy database" case observe the previous case's
 * warning and fail on an emission it never caused.
 */
function captureWarnings(run: () => void): string[] {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    run();
    return spy.mock.calls.map((call) => call.map(String).join(" "));
  } finally {
    spy.mockRestore();
  }
}

describe("stale-binary schema warning — operator-addressed and countable (RUFU-480)", () => {
  it("still opens the store: a newer recorded migration does not throw", () => {
    expect(() => assertBinaryNotOlderThanDatabase([SCHEMA_BASELINE_VERSION, futureVersion])).not.toThrow();
  });

  it("emits exactly one warning naming both versions, the class token, the remedy and the attribution", () => {
    const warnings = captureWarnings(() =>
      assertBinaryNotOlderThanDatabase([SCHEMA_BASELINE_VERSION, futureVersion]),
    );
    expect(warnings).toHaveLength(1);
    const line = warnings[0];
    /*
    Each fragment is asserted independently so deleting any one clause turns this test red — that is
    the positive control the report asked for: a message carrying only one of the two numbers, or
    dropping the operator remedy, or dropping the not-a-card-failure clause, must not pass.
    */
    expect(line).toContain(STALE_BINARY_SCHEMA_CLASS);
    expect(line).toContain(futureVersion);
    expect(line).toContain(SCHEMA_BASELINE_VERSION);
    expect(line).toContain("Operator action");
    expect(line).toContain("not a card failure");
    expect(line).toContain("retry cannot change it");
    // One physical line, no stack-trace shape: an orchestrator reads this as a status, not a crash.
    expect(line).not.toContain("\n");
    // Loose length bound around the ~340-char authoring target (includes the logger's marker + tag).
    expect(line.length).toBeLessThan(400);
  });

  it("says nothing on a healthy database, so the token cannot inflate the count", () => {
    const healthy: Array<{ label: string; applied: string[] }> = [
      { label: "no applied versions at all", applied: [] },
      { label: "non-numeric markers only", applied: ["plugin-roadmap-001", "legacy-adoption-drained"] },
      { label: "the short numeric form, which is below the ceiling numerically", applied: ["9"] },
      { label: "a version below the ceiling", applied: ["0000", "0018"] },
      { label: "a list whose highest entry is the ceiling itself", applied: ["0042", SCHEMA_BASELINE_VERSION] },
    ];
    for (const { label, applied } of healthy) {
      const warnings = captureWarnings(() => assertBinaryNotOlderThanDatabase(applied));
      expect(warnings, label).toEqual([]);
    }
  });

  /*
  FNXC:StaleBinaryOperatorClass 2026-11-05-12:58 (RUFU-480):
  Stays-gone guard for the retired hard refusal. The quoted operator sentence — "Refusing to open
  ... Upgrade Fusion (e.g. `brew upgrade fusion`) and retry" — asserts the exact opposite of the
  shipped warn-only policy, which is how a healthy store open got mis-read as a card failure. The
  tombstone ratchet in packages/engine/src/__tests__/legacy-tombstones.test.ts covers the SYMBOL
  across four production roots but strips comments; this one covers the shipped SENTENCES at the
  throw site itself, so the misleading operator instruction cannot return even as a rephrased throw.
  These are code-construct assertions on shipped strings, never an assertion that a comment exists.

  The class name is assembled from a constant rather than written into the asserted literals: the
  card's own removal gate greps `packages/core/src` for `class <Name>` / `new <Name>` / a bare
  name-list export, and a guard that trips its own gate would have to ship as a gate exception — a
  ratchet needing an allowance list is a ratchet nobody trusts. The asserted strings are unchanged.
  */
  it("constructs no refusal and quotes no brew-upgrade retry advice at the throw site", () => {
    const retired = "StaleBinary" + "SchemaError";
    expect(applierSource).not.toContain(`new ${retired}`);
    expect(applierSource).not.toContain(`class ${retired}`);
    expect(applierSource).not.toContain("brew upgrade fusion");
    expect(applierSource).not.toContain("Refusing to open");
  });

  it("re-exports the refusal class from no barrel", () => {
    const retired = "StaleBinary" + "SchemaError";
    // Any surviving export of the retired name is a re-export shell; comments may still name it as history.
    const bareNameListEntry = new RegExp(`^\\s*${retired},\\s*$`, "m");
    const exportClause = new RegExp(`export\\s*\\{[^}]*${retired}`);
    const barrels = [
      "../../postgres/index.ts",
      "../../index.ts",
      "../../index.gate.ts",
    ];
    for (const barrel of barrels) {
      const source = readFileSync(fileURLToPath(new URL(barrel, import.meta.url)), "utf8");
      expect(source, barrel).not.toMatch(bareNameListEntry);
      expect(source, barrel).not.toMatch(exportClause);
    }
  });
});
