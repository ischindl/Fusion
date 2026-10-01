import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { evaluateEngineCoreGate, evaluatePgGate } from "../lib/engine-gate-policy.mjs";
import { extractTestProjectInclude, stripComments } from "../lib/vitest-config-parse.mjs";

/*
FNXC:MergeGatePolicy 2026-09-08-11:02 (RUFU-197):
Pure-evaluator fixtures: every violation kind gets a fabricated violation fixture AND the clean fixture is
re-asserted around it, so a check that stopped firing (the failure mode that left the old mirror guards red
for a fortnight) is caught in both directions. The final test is the forbidden-shape scan — acceptance
anchor 5 — which re-reads the rewritten gate-policy guard's own comment-free source and fails if the
hand-maintained mirror shapes (frozen engine-core allow-list, former-PG-member list, `removedFromGate`
length pin, validator mirror, exact script-string equality) ever reappear.
*/

const ALL_EXIST = () => true;
const kindsOf = (result) => result.violations.map((v) => v.kind);

test("engine-core: a clean allow-list yields no violations", () => {
  const result = evaluateEngineCoreGate({
    members: ["src/__tests__/a.test.ts", "src/__tests__/b.test.ts"],
    fileExists: ALL_EXIST,
    quarantinedFiles: [],
  });
  assert.deepEqual(result.violations, []);
  assert.equal(result.members.length, 2, "the evaluator must return the derived members for non-vacuous use");
});

test("engine-core: an empty allow-list is reported, not treated as clean", () => {
  assert.deepEqual(kindsOf(evaluateEngineCoreGate({ members: [], fileExists: ALL_EXIST })), ["empty-membership"]);
});

test("engine-core: a duplicate member is reported", () => {
  const result = evaluateEngineCoreGate({
    members: ["src/__tests__/a.test.ts", "src/__tests__/a.test.ts"],
    fileExists: ALL_EXIST,
  });
  assert.ok(kindsOf(result).includes("duplicate-member"));
});

test("engine-core: a member naming no file on disk is reported", () => {
  const result = evaluateEngineCoreGate({
    members: ["src/__tests__/a.test.ts", "src/__tests__/deleted.test.ts"],
    fileExists: (file) => file !== "src/__tests__/deleted.test.ts",
  });
  assert.deepEqual(kindsOf(result), ["member-file-missing"]);
});

test("engine-core: a ledger-quarantined member is reported", () => {
  const result = evaluateEngineCoreGate({
    members: ["src/__tests__/a.test.ts"],
    fileExists: ALL_EXIST,
    quarantinedFiles: ["src/__tests__/a.test.ts"],
  });
  assert.deepEqual(kindsOf(result), ["quarantined-member"]);
});

/*
FNXC:MergeGatePolicy 2026-09-08-11:27 (RUFU-197):
The A1 failure class: deletion-ratchet commit 82c635384d retired a file AND its declaration line together, which
is a complete, legitimate retirement. A guard that still expected the retired name could not tell retirement
from coverage loss and stayed red for two weeks. Retirement must therefore be invisible to the guard, and the
derived count must follow what is actually declared.
*/
test("engine-core: a retired member absent from both declaration and disk is not a violation", () => {
  const result = evaluateEngineCoreGate({
    members: ["src/__tests__/a.test.ts", "src/__tests__/b.test.ts"],
    fileExists: ALL_EXIST,
  });
  assert.deepEqual(result.violations, []);
  assert.equal(result.members.length, 2, "the derived count reflects only what is still declared");
});

/*
FNXC:MergeGatePolicy 2026-09-08-11:27 (RUFU-197):
Non-vacuous wiring proof for the real-tree guard: the shipped engine config is re-read with exactly one
allow-list line deleted in memory (the declaration file itself is never touched). If the include reader or the
filesystem resolution silently matched nothing, this fixture would report zero violations instead of naming the
removed entry, so a dead reader cannot pass the real-tree assertion.
*/
test("engine-core: deleting one allow-list line reddens the real reader wiring", () => {
  const configPath = join(dirname(fileURLToPath(import.meta.url)), "../../packages/engine/vitest.config.ts");
  const config = readFileSync(configPath, "utf8");
  const members = extractTestProjectInclude(config, "engine-core");
  assert.ok(members.length > 1, "fixture needs at least two allow-list entries to delete one");

  const removed = members[0];
  const edited = config.replace(`"${removed}"`, '"src/__tests__/placeholder-not-on-disk.test.ts"');
  assert.notEqual(edited, config, `fixture must be able to edit the ${removed} allow-list entry`);

  const editedMembers = extractTestProjectInclude(edited, "engine-core");
  assert.ok(!editedMembers.includes(removed), "the deleted entry must leave the parsed allow-list");

  const result = evaluateEngineCoreGate({
    members: editedMembers,
    fileExists: (file) => file !== "src/__tests__/placeholder-not-on-disk.test.ts",
  });
  assert.deepEqual(result.violations, [{ kind: "member-file-missing", file: "src/__tests__/placeholder-not-on-disk.test.ts" }]);
});

test("pg gate: the current narrow-canary shape yields no violations", () => {
  const result = evaluatePgGate({
    requiredCanaries: ["src/__tests__/postgres/a.pg.test.ts", "src/__tests__/postgres/b.pg.test.ts"],
    gateMembers: ["src/__tests__/postgres/a.pg.test.ts", "src/__tests__/postgres/b.pg.test.ts"],
    discoveredPgFiles: ["src/__tests__/postgres/a.pg.test.ts", "src/__tests__/postgres/b.pg.test.ts", "src/__tests__/postgres/c.pg.test.ts"],
    excludedPgFiles: [],
    quarantinedPgFiles: [],
  });
  assert.deepEqual(result.violations, []);
});

test("pg gate: dropping a required canary from the lane is reported", () => {
  const result = evaluatePgGate({
    requiredCanaries: ["src/__tests__/postgres/a.pg.test.ts"],
    gateMembers: [],
    discoveredPgFiles: ["src/__tests__/postgres/a.pg.test.ts", "src/__tests__/postgres/b.pg.test.ts"],
  });
  assert.ok(kindsOf(result).includes("required-canary-dropped"));
});

test("pg gate: a canary whose file is gone is reported", () => {
  const result = evaluatePgGate({
    requiredCanaries: [],
    gateMembers: ["src/__tests__/postgres/a.pg.test.ts"],
    discoveredPgFiles: ["src/__tests__/postgres/b.pg.test.ts"],
  });
  assert.ok(kindsOf(result).includes("canary-file-missing"));
});

test("pg gate: a canary hidden by a test-level exclude is reported", () => {
  const result = evaluatePgGate({
    requiredCanaries: [],
    gateMembers: ["src/__tests__/postgres/a.pg.test.ts"],
    discoveredPgFiles: ["src/__tests__/postgres/a.pg.test.ts", "src/__tests__/postgres/b.pg.test.ts"],
    excludedPgFiles: ["src/__tests__/postgres/a.pg.test.ts"],
  });
  assert.ok(kindsOf(result).includes("canary-excluded"));
});

test("pg gate: a canary that carries a quarantine ledger row is reported", () => {
  const result = evaluatePgGate({
    requiredCanaries: [],
    gateMembers: ["src/__tests__/postgres/a.pg.test.ts"],
    discoveredPgFiles: ["src/__tests__/postgres/a.pg.test.ts", "src/__tests__/postgres/b.pg.test.ts"],
    quarantinedPgFiles: ["src/__tests__/postgres/a.pg.test.ts"],
  });
  assert.ok(kindsOf(result).includes("canary-quarantined"));
});

test("pg gate: an exclude naming a deleted file is reported as stale", () => {
  const result = evaluatePgGate({
    requiredCanaries: [],
    gateMembers: ["src/__tests__/postgres/a.pg.test.ts"],
    discoveredPgFiles: ["src/__tests__/postgres/a.pg.test.ts", "src/__tests__/postgres/b.pg.test.ts"],
    excludedPgFiles: ["src/__tests__/postgres/gone.pg.test.ts"],
  });
  assert.ok(kindsOf(result).includes("stale-exclude"));
});

test("pg gate: an exclusion that silences a live file without a ledger row is reported", () => {
  const result = evaluatePgGate({
    requiredCanaries: [],
    gateMembers: ["src/__tests__/postgres/a.pg.test.ts"],
    discoveredPgFiles: ["src/__tests__/postgres/a.pg.test.ts", "src/__tests__/postgres/b.pg.test.ts"],
    excludedPgFiles: ["src/__tests__/postgres/b.pg.test.ts"],
    quarantinedPgFiles: [],
  });
  assert.deepEqual(kindsOf(result), ["unaccounted-exclusion"]);
});

test("pg gate: the same exclusion backed by a ledger row is a legitimate quarantine", () => {
  const result = evaluatePgGate({
    requiredCanaries: [],
    gateMembers: ["src/__tests__/postgres/a.pg.test.ts"],
    discoveredPgFiles: ["src/__tests__/postgres/a.pg.test.ts", "src/__tests__/postgres/b.pg.test.ts"],
    excludedPgFiles: ["src/__tests__/postgres/b.pg.test.ts"],
    quarantinedPgFiles: ["src/__tests__/postgres/b.pg.test.ts"],
  });
  assert.deepEqual(result.violations, []);
});

test("pg gate: an empty discovery lane is reported, not skipped", () => {
  const result = evaluatePgGate({
    requiredCanaries: ["src/__tests__/postgres/a.pg.test.ts"],
    gateMembers: ["src/__tests__/postgres/a.pg.test.ts"],
    discoveredPgFiles: [],
  });
  assert.ok(kindsOf(result).includes("empty-discovery"));
});

test("pg gate: an empty blocking lane is reported", () => {
  const result = evaluatePgGate({
    requiredCanaries: [],
    gateMembers: [],
    discoveredPgFiles: ["src/__tests__/postgres/a.pg.test.ts", "src/__tests__/postgres/b.pg.test.ts"],
  });
  assert.ok(kindsOf(result).includes("empty-gate"));
});

test("pg gate: a lane that swallows the whole discovered inventory is reported", () => {
  const result = evaluatePgGate({
    requiredCanaries: [],
    gateMembers: ["src/__tests__/postgres/a.pg.test.ts", "src/__tests__/postgres/b.pg.test.ts"],
    discoveredPgFiles: ["src/__tests__/postgres/a.pg.test.ts", "src/__tests__/postgres/b.pg.test.ts"],
  });
  assert.ok(kindsOf(result).includes("gate-not-narrow"));
});

/*
FNXC:MergeGatePolicy 2026-09-08-11:02 (RUFU-197):
This scan is deliberately NOT a prose assertion — it inspects code constructs in the rewritten guard so a
regression that quietly re-adds a hand-maintained mirror fails CI instead of failing review. Comments are
stripped first (via the shared scanner) so FNXC prose naming retired files can never trip the test-path
literal budget: only real string literals in executable code are counted.
*/
test("gate-policy guard contains no hand-maintained mirror shapes", () => {
  const target = join(dirname(fileURLToPath(import.meta.url)), "engine-vitest-gate-policy.test.mjs");
  const code = stripComments(readFileSync(target, "utf8"));

  for (const forbidden of [/expectedMembers\b/, /formerGateMembers\b/, /removedFromGate\b/, /gateValidators\b/]) {
    assert.doesNotMatch(code, forbidden, `the gate-policy guard must not reintroduce ${forbidden}`);
  }
  // A derived guard never asserts an exact length for a derived collection; minimum floors use `>=`.
  assert.doesNotMatch(code, /assert\.equal\([\s\S]{0,80}?\.length,\s*\d+/, "frozen count assertion");
  // Lane composition is matched by pattern, never by a full script-string equality mirror.
  assert.doesNotMatch(code, /assert\.equal\([\s\S]{0,60}?\.scripts/, "exact script-string mirror");
  // An ordered allow-list of concrete test paths is the single most expensive shape to keep alive.
  const testPathLiterals = [...code.matchAll(/["'`]src\/__tests__\/[^"'`]*\.test\.tsx?["'`]/g)];
  assert.ok(
    testPathLiterals.length <= 8,
    `gate-policy guard carries ${testPathLiterals.length} hardcoded test-path literals; derive membership from the declarations instead`,
  );
  // Non-vacuous: the scan must actually be looking at a real, sizable guard.
  assert.ok(code.includes("evaluateEngineCoreGate") && code.includes("evaluatePgGate"));
});
