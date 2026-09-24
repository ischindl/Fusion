import test from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLASS_BOUNDED,
  CLASS_CENSUS_REGISTERED,
  CLASS_FIXED_KEY_SET,
  CLASS_UNCLASSIFIED,
  PENDING_ROOTS,
  classifyDeclaration,
  diffInventory,
  evaluateEntries,
  main,
  scanModuleScopeCollections,
} from "../check-retention-coverage.mjs";
import { RETENTION_INVENTORY } from "../lib/retention-inventory.mjs";

/*
FNXC:RetentionCensus 2026-09-23-10:40 (RUFU-257):
This is the ratchet's own regression test. RUFU-249's dashboard died of heap exhaustion and seven
crashes went unattributed; the census only prevents a recurrence while the validator that forces every
new module-scope `new Map`/`new Set` to name its bound keeps working. A validator can rot in two ways —
it stops matching the code (so it validates nothing), or it can be talked into a pass by prose — so the
tests here pin both the real-tree result AND the failure paths, including the floors that exist purely
to make a broken scanner loud.
*/

const repoRoot = join(import.meta.dirname, "..", "..");
const realScanRoot = join(repoRoot, "packages", "dashboard", "src");
const realDeclarations = () => scanModuleScopeCollections({ root: realScanRoot, pathPrefix: "packages/dashboard/src" });

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "retention-coverage-"));
  for (const [name, source] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source, "utf8");
  }
  return root;
}

/** Run `main` against a fixture tree, capturing its report so assertions name the violation. */
async function runMain(options) {
  const lines = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (message) => lines.push(String(message));
  console.log = (message) => lines.push(String(message));
  try {
    const code = await main(options);
    return { code, lines };
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
}

/** Classify a one-file fixture and return the single inventory entry for `name`. */
function classifyFixture(name, source) {
  const root = fixture({ "src/probe.ts": source });
  try {
    const declarations = scanModuleScopeCollections({ root });
    const entry = declarations.find((declaration) => declaration.name === name);
    assert.ok(entry, `scanner did not find the fixture declaration ${name}`);
    return classifyDeclaration(entry);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── the real tree ────────────────────────────────────────────────────────────

test("the dashboard server's module-scope collections are all classified", () => {
  const declarations = realDeclarations();
  const entries = declarations.map((declaration) => classifyDeclaration(declaration));
  const violations = evaluateEntries({ entries, scannedCount: declarations.length });

  assert.deepEqual(violations, []);
});

test("the committed inventory matches the code it claims to describe", () => {
  const entries = realDeclarations().map((declaration) => classifyDeclaration(declaration));
  const diff = diffInventory({ entries, inventory: RETENTION_INVENTORY });

  assert.deepEqual(diff, []);
});

/*
FNXC:RetentionCensus 2026-09-23-10:40 (RUFU-257):
RUFU-257's premise is a *set* of leaks, not one cache. If the scan silently stops matching declarations
(a rename, a moved directory, a scanner edit), the subject set shrinks toward zero and an empty check
passes forever. These floors are the numeric statement of that premise; the real-tree run above would
still pass at 3 declarations, so the counts are asserted here where a drop is a failing test.
*/
test("the subject set and census coverage stay above their floors", () => {
  const entries = realDeclarations().map((declaration) => classifyDeclaration(declaration));
  const registered = entries.filter((entry) => entry.classification === CLASS_CENSUS_REGISTERED);
  const expirySubjects = entries.filter((entry) => entry.expiryEvidence.length > 0);

  assert.ok(entries.length >= 60, `expected >= 60 module-scope declarations, found ${entries.length}`);
  assert.ok(registered.length >= 15, `expected >= 15 census-registered declarations, found ${registered.length}`);
  assert.ok(expirySubjects.length > 0, "expected at least one declaration carrying expiry evidence");
  assert.ok(
    registered.some((entry) => entry.sources.length > 0 && entry.ceilingConstant),
    "expected a census registration to name both a source id and a ceiling constant",
  );
});

// ── failure paths: what the ratchet refuses ─────────────────────────────────

test("a new module-scope cache with no owner is a finding, not a silent pass", () => {
  const entry = classifyFixture("nextLeak", "const nextLeak = new Map<string, string>();\nnextLeak.set('k', 'v');\n");

  assert.equal(entry.classification, CLASS_UNCLASSIFIED);
  assert.match(entry.reasons.join(" "), /no classification/);
});

test("an empty collection mutated through a helper cannot self-classify as a table", () => {
  // The shape RUFU-257 actually found in `view-chunk-manifest.ts`: a warn-once set that gains keys
  // through a function parameter, invisible to a `NAME.add(` scan. `new Set<string>()` is a registry
  // being built, never a fixed table.
  const entry = classifyFixture(
    "warned",
    "const warned = new Set<string>();\nfunction warnOnce(set: Set<string>, key: string) {\n  set.add(key);\n}\nwarnOnce(warned, 'k');\n",
  );

  assert.notEqual(entry.classification, CLASS_FIXED_KEY_SET);
  assert.equal(entry.classification, CLASS_UNCLASSIFIED);
});

test("a literal table that is never mutated is classified as a fixed-key table", () => {
  const entry = classifyFixture("MIME", 'const MIME = new Set(["text/plain", "text/html"]);\nconsole.log(MIME.has("text/plain"));\n');

  assert.equal(entry.classification, CLASS_FIXED_KEY_SET);
  assert.match(entry.justification, /2 fixed entries/);
});

test("a marker with no justification is refused", () => {
  const entry = classifyFixture("cache", "// retention-owner-deleted:\nconst cache = new Map<string, string>();\ncache.delete('k');\n");

  assert.equal(entry.classification, CLASS_UNCLASSIFIED);
  assert.match(entry.reasons.join(" "), /carries no justification/);
});

test("an owner-deleted claim without a deletion site is refused", () => {
  const entry = classifyFixture(
    "inFlight",
    "// retention-owner-deleted: claims a delete it never performs\nconst inFlight = new Map<string, Promise<void>>();\n",
  );

  assert.equal(entry.classification, CLASS_UNCLASSIFIED);
  assert.match(entry.reasons.join(" "), /no `delete` site/);
});

test("a bounded claim must name a declared ceiling that is actually read", () => {
  const undeclared = classifyFixture("jobs", "// retention-bounded: JOB_HISTORY_MAX\nconst jobs = new Map<string, string>();\n");
  assert.equal(undeclared.classification, CLASS_UNCLASSIFIED);
  assert.match(undeclared.reasons.join(" "), /no numeric constant of that name/);

  const neverRead = classifyFixture(
    "jobs",
    "// retention-bounded: JOB_HISTORY_MAX\nconst JOB_HISTORY_MAX = 5;\nconst jobs = new Map<string, string>();\n",
  );
  assert.equal(neverRead.classification, CLASS_UNCLASSIFIED);
  assert.match(neverRead.reasons.join(" "), /declared but never read/);

  const bounded = classifyFixture(
    "jobs",
    "// retention-bounded: JOB_HISTORY_MAX\nconst JOB_HISTORY_MAX = 5;\nconst jobs = new Map<string, string>();\nif (jobs.size > JOB_HISTORY_MAX) jobs.delete('oldest');\n",
  );
  assert.equal(bounded.classification, CLASS_BOUNDED);
  assert.equal(bounded.ceilingConstant, "JOB_HISTORY_MAX");
});

/*
FNXC:RetentionCensus 2026-09-23-11:05 (RUFU-257):
Every proof the ratchet accepts is a substring test, so the cheapest way to defeat it would be to write
the proof in a comment instead of the code. These fixtures are the negative controls for that: the same
text placed in comments must be refused, and only the code form is accepted.
*/
test("a commented-out registration does not count as census coverage", () => {
  const entry = classifyFixture(
    "cache",
    [
      "const cache = new Map<string, string>();",
      "// registerRetentionSource({",
      "//   id: 'imagined_source',",
      "//   map: cache,",
      "// });",
      "cache.set('k', 'v');",
      "",
    ].join("\n"),
  );

  assert.equal(entry.classification, CLASS_UNCLASSIFIED);
  assert.deepEqual(entry.sources, []);
});

test("a commented-out delete site does not prove an owner that deletes", () => {
  const entry = classifyFixture(
    "leases",
    [
      "// retention-owner-deleted: the comment promises the deletion",
      "const leases = new Map<string, string>();",
      "// leases.delete(key);",
      "leases.set('k', 'v');",
      "",
    ].join("\n"),
  );

  assert.equal(entry.classification, CLASS_UNCLASSIFIED);
  assert.match(entry.reasons.join(" "), /no `delete` site/);
});

test("prose mentioning a ceiling constant does not make a cache bounded", () => {
  const entry = classifyFixture(
    "notes",
    [
      "/*",
      " * FNXC:SomeStory:",
      " * NOTE_MEMORY_MAX caps this map once somebody implements it.",
      " */",
      "// retention-bounded: NOTE_MEMORY_MAX",
      "const notes = new Map<string, string>();",
      "notes.set('k', 'v');",
      "",
    ].join("\n"),
  );

  assert.equal(entry.classification, CLASS_UNCLASSIFIED);
  assert.match(entry.reasons.join(" "), /no numeric constant of that name/);
});

/*
FNXC:RetentionCensus 2026-09-23-10:40 (RUFU-257):
Rule (3) is the anti-laundering rule, and this is the test that proves it bites: the same allowlist
marker that legitimately exempts a MIME table must be refused for a value that carries `expiresAt`,
because "nothing accumulates here" is false for anything with a TTL. Without this, the escape hatch
would be the way the ratchet got defeated.
*/
test("expiry evidence bars the nothing-accumulates-here classes", () => {
  const root = fixture({
    "src/leaky.ts": [
      "// retention-allowlist: claims to be a table but stores TTLs",
      "const byToken = new Map<string, { token: string; expiresAt: number }>();",
      "byToken.set('t', { token: 't', expiresAt: Date.now() + 60_000 });",
      "",
    ].join("\n"),
  });
  try {
    const entries = scanModuleScopeCollections({ root }).map((declaration) => classifyDeclaration(declaration));

    assert.equal(entries[0].classification, CLASS_FIXED_KEY_SET, "the marker alone would classify it as a table");
    assert.ok(entries[0].expiryEvidence.length > 0, "the value type must register as expiry evidence");

    const violations = evaluateEntries({ entries, scannedCount: entries.length });
    assert.ok(
      violations.some((violation) => violation.includes("rule 3")),
      `expected a rule 3 violation, got ${JSON.stringify(violations)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an expiry-carrying cache registered in the census passes rule 3", () => {
  const entry = classifyFixture(
    "tokens",
    [
      "const TOKEN_TTL_MS = 60_000;",
      "const TOKEN_MAX = 512;",
      "const tokens = new Map<string, { token: string; expiresAt: number }>();",
      "registerBoundedWindowMap({",
      "  id: 'issued_tokens',",
      "  map: tokens,",
      "  ceiling: TOKEN_MAX,",
      "  ceilingConstant: 'TOKEN_MAX',",
      "  expiryOf: (entry) => entry.expiresAt,",
      "});",
      "",
    ].join("\n"),
  );

  assert.equal(entry.classification, CLASS_CENSUS_REGISTERED);
  assert.deepEqual(entry.sources, ["issued_tokens"]);
});

test("the non-vacuity floors fire when the subject set collapses", () => {
  const violations = evaluateEntries({ entries: [], scannedCount: 0 });

  assert.ok(violations.some((violation) => violation.includes("subject set collapsed")));
  assert.ok(violations.some((violation) => violation.includes("census coverage floor")));
  assert.ok(violations.some((violation) => violation.includes("rule (3) subject set is empty")));
});

// ── --write / check mode ────────────────────────────────────────────────────

/*
FNXC:RetentionCensus 2026-09-23-10:40 (RUFU-257):
The inventory must be un-narrowable by hand: `--write` regenerates it from the scan, so a PR that
deletes a line to make the check pass either re-adds it on the next run or shows up as a
"has no matching declaration" violation. Asserted against a fixture because the assertion is about the
generated file, not about the dashboard.
*/
test("--write regenerates the inventory and check mode finds it in sync", async () => {
  const root = fixture({ "src/a.ts": 'const TABLE_A = new Set(["a", "b"]);\nconsole.log(TABLE_A.size);\n' });
  const inventoryPath = join(root, "retention-inventory.mjs");
  try {
    const write = await runMain({ argv: ["--write"], scanRoot: root, inventoryPath });
    assert.equal(write.code, 0, write.lines.join("\n"));
    const generated = readFileSync(inventoryPath, "utf8");
    assert.match(generated, /GENERATED FILE — do not edit by hand/);
    assert.match(generated, /"name": "TABLE_A"/);

    // Hand-narrowing the generated set is the failure mode the design refuses to allow: the entry the
    // inventory claims must match a declaration, and the declaration the code has must be recorded.
    writeFileSync(inventoryPath, generated.replace(/"name": "TABLE_A"/, '"name": "TABLE_REMOVED"'), "utf8");
    const check = await runMain({ argv: [], scanRoot: root, inventoryPath });
    assert.equal(check.code, 1);
    assert.ok(
      check.lines.some((line) => line.includes("TABLE_REMOVED") && line.includes("no matching declaration")),
      `expected a stale-inventory violation, got ${JSON.stringify(check.lines)}`,
    );
    assert.ok(
      check.lines.some((line) => line.includes("TABLE_A") && line.includes("not in the inventory")),
      `expected a missing-entry violation, got ${JSON.stringify(check.lines)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check mode fails when a declaration has no inventory entry", async () => {
  const root = fixture({ "src/a.ts": 'const TABLE_A = new Set(["a", "b"]);\nconsole.log(TABLE_A.size);\n' });
  const inventoryPath = join(root, "retention-inventory.mjs");
  try {
    assert.equal((await runMain({ argv: ["--write"], scanRoot: root, inventoryPath })).code, 0);
    writeFileSync(join(root, "src", "b.ts"), "const latecomer = new Map<string, string>();\nlatecomer.set('k', 'v');\n", "utf8");

    const check = await runMain({ argv: [], scanRoot: root, inventoryPath });
    assert.equal(check.code, 1);
    assert.ok(
      check.lines.some((line) => line.includes("latecomer") && line.includes("no classification")),
      `expected an unclassified-declaration violation, got ${JSON.stringify(check.lines)}`,
    );
    assert.ok(
      check.lines.some((line) => line.includes("latecomer") && line.includes("not in the inventory")),
      `expected an inventory-membership violation, got ${JSON.stringify(check.lines)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real tree exits 0 through the same entry point the gate runs", async () => {
  assert.equal(await main({ argv: [] }), 0);
});

/*
FNXC:RetentionCensus 2026-09-23-18:35 (RUFU-257 Step 4):
The leak class is cross-package, so the ratchet has to be honest about where it stops. Three roots stay
out of the blocking set because their module-scope collections have never been measured — classifying them
in this step would mean writing justifications nobody verified, which is the laundering rule (3) refuses.
These tests keep that decision falsifiable from both sides: the scanner must find real declarations in
every pending root (so "pending" can never quietly mean "nothing left to check"), and the green run must
say the counts out loud in the gate's own output so the backlog is visible where the pass is recorded.
*/
test("the scanner reaches real declarations in every package root, gated or pending", () => {
  const roots = ["packages/dashboard/src", ...PENDING_ROOTS];
  assert.equal(PENDING_ROOTS.length, 3, "engine, core and cli are the known un-gated roots");
  assert.ok(!PENDING_ROOTS.includes("packages/dashboard/src"), "the gated root must not also sit in the backlog");
  for (const root of roots) {
    const scanned = scanModuleScopeCollections({ root: join(repoRoot, root), pathPrefix: root });
    assert.ok(scanned.length >= 10, `${root} yielded ${scanned.length} declarations — the scanner stopped seeing real code`);
  }
});

test("the green run reports the pending roots and their remaining work", async () => {
  const run = await runMain({
    argv: [],
    scanRoot: realScanRoot,
    inventoryPath: join(repoRoot, "scripts", "lib", "retention-inventory.mjs"),
  });
  assert.equal(run.code, 0);
  for (const root of PENDING_ROOTS) {
    const line = run.lines.find((entry) => entry.includes(`pending root ${root}`));
    assert.ok(line, `expected a pending-root line for ${root}, got ${JSON.stringify(run.lines)}`);
    const count = Number(/(\d+) module-scope declarations/.exec(line)?.[1]);
    assert.ok(count > 0, `${root} reported ${count} declarations — the pending backlog is not being counted`);
  }
});
