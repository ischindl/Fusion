import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { codeWithoutComments, scanSource } from "../../../../scripts/check-retention-coverage.mjs";

/*
FNXC:RetentionCensus 2026-09-23-18:22 (RUFU-257 Step 4):
Recurrence lock for the ONE cache in this task that was already right. The resolver's in-flight reads are
keyed by WeakMap on the caller-owned per-pass cache object, so the coalescing window cannot outlive the
pass that created it — the RUFU-114 incident (2026-09-16, ~2 GB/h) was a strong `Map` cache with a
process-lifetime key. A behavioral test cannot see the difference: both shapes serve the same reads, and
the strong one only fails hours later under OOM. So this guard asserts the CONSTRUCT — it reads the
resolver's module scope and fails if any strong `new Map`/`new Set` appears there, while requiring the two
`WeakMap` in-flight tables to stay present. It asserts code the compiler sees, never a comment.

The same scanner the blocking CI ratchet uses (`scanSource` + `codeWithoutComments`) is imported rather
than re-implemented here, so the lock and the ratchet cannot drift in what "module scope" means.
*/

const RESOLVER_PATH = resolve(__dirname, "../workflows/workflow-ir-resolver.ts");
const resolverCode = codeWithoutComments(readFileSync(RESOLVER_PATH, "utf8"));

/** Column-0 `const <name> = new WeakMap` declarations — the shape the lock requires. */
function weakMapDeclarations(code: string): string[] {
  return code.split("\n").flatMap((line) => /(?:^export\s+)?(?:const|let|var)\s+(\w+)\s*[:=][^=]*\bnew\s+WeakMap\b/.exec(line)?.slice(1) ?? []);
}

describe("workflow-ir-resolver in-flight cache shape", () => {
  it("keeps both in-flight coalescing tables WeakMap-keyed on the caller-owned pass cache", () => {
    const weak = weakMapDeclarations(resolverCode);
    expect(weak).toEqual(expect.arrayContaining(["inflightSelectionReads", "inflightIrReads"]));
  });

  it("keeps the module scope free of any strong Map/Set — a pass-scoped cache must not outlive its pass", () => {
    // The ratchet's own scanner, run against this file: an empty result IS the assertion.
    expect(scanSource(resolverCode)).toEqual([]);
  });

  it("proves the guard is not vacuous: the same scanner reports a strong module-scope cache when one exists", () => {
    // Without this control the previous test passes for the wrong reason — a scanner that stopped
    // matching declarations would report [] here and the leak would be locked in as "clean".
    const reintroduced = `
const inflightIrReads = new WeakMap<object, Map<string, string>>();
const irCache = new Map<string, string>();
function usesIt() { return irCache.set("k", "v"); }
`;
    const found = scanSource(codeWithoutComments(reintroduced));
    expect(found.map((declaration) => declaration.name)).toEqual(["irCache"]);
  });
});
