import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/*
FNXC:SyncMissionStoreDeprecated 2026-08-27-04:09:
RUFU-141 DEPRECATION RATCHET — "the sync MissionStore is dead in production, and provably stays dead".

Step 1 of RUFU-141 (the operator gate) re-verified at the current main tip: no production path
instantiates or calls the sync `MissionStore` (packages/core/src/missions/mission-store.ts).
`getMissionStoreImpl` (task-store/workflow-definitions.ts) constructs only the AsyncDataLayer-backed
AsyncMissionStore for the PostgreSQL backend, and the only production `instanceof MissionStore`
site is the dashboard CLI's deliberate PG-degrade guard (cli/src/commands/dashboard.ts). The RUFU-134
unlink contract (a not-linked feature must fail with "Feature <id> is not linked to any task" and
emit nothing) is therefore owned by the async store alone, and the sync class is deprecated in its
JSDoc rather than patched.

This test is the ratchet. It is deliberately cheap (grep-level, no store boot — FN-5048: do not add
slow tests):
  1. No non-test source file constructs `new MissionStore(`.
  2. The only construction matches in the whole tree are the known test-only sites — the three files
     below, which exercise the sync loop/state-transition contract.
  3. The only production `instanceof MissionStore` reference is the known dashboard PG-degrade
     guard; a new one is the shape of a production path creeping back.

Comments are stripped first, so the deprecation JSDoc (which names both patterns) and explanatory
notes are not read as live references. This file is excluded from its own scan because it names the
patterns in strings and comments.

Deliberately NOT pinned (tolerated until the deletion follow-up): type-level union references
(`MissionStore | AsyncMissionStore` in store.ts / workflow-definitions.ts / engine options) and the
public re-exports (index.ts / index.gate.ts) — those are API-surface typing, not a construction or
call path. Test-side `instanceof MissionStore` mirrors are tolerated (the dashboard backend-guard
test replicates the guard without booting the CLI). Scan scope is .ts/.tsx for parity with
legacy-tombstones.test.ts. Per AGENTS.md this test asserts structure only — it must never assert the
JSDoc/@deprecated prose itself.
*/

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

/** The ratchet's own file — excluded from its own scan (it names the patterns literally). */
const RATCHET_SELF = join(REPO_ROOT, "packages/core/src/__tests__/mission-store-sync-deprecated.test.ts");

/**
 * Construction sites tolerated because they are test-only (RUFU-141 Step 1 census). They stay green
 * against the deprecated class precisely because Step 2 changed no behavior; the next intentional
 * change to this tolerated surface (including the deletion follow-up) updates this list.
 */
const KNOWN_TEST_CONSTRUCTIONS = [
  "packages/core/src/__tests__/mission-status-recompute-guard.test.ts",
  "packages/core/src/__tests__/mission-store.sync-loop-transition.test.ts",
  "packages/dashboard/src/__tests__/mission-assertion-id-validation.test.ts",
];

/** The single production `instanceof MissionStore` reference: the deliberate PG-degrade guard. */
const KNOWN_INSTANCEOF_SITE = "packages/cli/src/commands/dashboard.ts";

/** Construction pattern; `new AsyncMissionStore(` cannot match (Async prefix sits between `new` and the name). */
const CONSTRUCTION = /new\s+MissionStore\s*\(/;
/** `instanceof AsyncMissionStore` cannot match: no whitespace separates `Async` from `MissionStore`. */
const INSTANCEOF = /instanceof\s+MissionStore\b/;

/** Strip block and line comments so a deprecation note naming a pattern is not read as a live reference. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

interface SourceFile {
  abs: string;
  rel: string;
  inTests: boolean;
}

/** Every package `src` root (dynamic: a new package is covered automatically). */
function packageSrcRoots(): string[] {
  const packagesDir = join(REPO_ROOT, "packages");
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir)
    .map((name) => join(packagesDir, name, "src"))
    .filter((root) => existsSync(root) && statSync(root).isDirectory());
}

function collectSourceFiles(dir: string, out: SourceFile[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    if (full === RATCHET_SELF) continue;
    const rel = relative(REPO_ROOT, full).split(sep).join("/");
    out.push({ abs: full, rel, inTests: rel.includes("/__tests__/") });
  }
}

describe("RUFU-141 sync MissionStore deprecation ratchet — no production construction or call path", () => {
  const files: SourceFile[] = [];
  for (const root of packageSrcRoots()) collectSourceFiles(root, files);
  const production = files.filter((f) => !f.inTests);
  const stripped = files.map((f) => ({ ...f, code: stripComments(readFileSync(f.abs, "utf8")) }));

  it("scans a non-trivial production source set (guards against a silently empty sweep)", () => {
    expect(production.length).toBeGreaterThan(200);
    // If the core root vanished from the sweep, the ratchet would pass silently — pin the file
    // that is itself the deprecated surface.
    expect(production.some((f) => f.rel === "packages/core/src/missions/mission-store.ts")).toBe(true);
  });

  it("no non-test source file constructs the sync MissionStore", () => {
    const violations = stripped
      .filter((f) => !f.inTests && CONSTRUCTION.test(f.code))
      .map((f) => `new MissionStore( in production source: ${f.rel}`);
    expect(violations).toEqual([]);
  });

  it("the known test-only constructions are the ONLY construction matches", () => {
    const matchedFiles = stripped.filter((f) => CONSTRUCTION.test(f.code)).map((f) => f.rel);
    const unexpected = matchedFiles.filter((rel) => !KNOWN_TEST_CONSTRUCTIONS.includes(rel));
    expect(unexpected).toEqual([]);
    // "Remain" — the tolerated sites must still be at the places the list names, so the
    // tolerance cannot rot into a silent no-op if a site moves or is deleted.
    for (const rel of KNOWN_TEST_CONSTRUCTIONS) {
      const f = stripped.find((x) => x.rel === rel);
      expect(f, `tolerated construction file missing from the sweep: ${rel}`).toBeDefined();
      expect(CONSTRUCTION.test(f!.code), `tolerated construction no longer present: ${rel}`).toBe(true);
    }
  });

  it("the only production instanceof-MissionStore reference is the known dashboard PG-degrade guard", () => {
    const matches = stripped.filter((f) => !f.inTests && INSTANCEOF.test(f.code)).map((f) => f.rel);
    expect(matches).toEqual([KNOWN_INSTANCEOF_SITE]);
  });
});
