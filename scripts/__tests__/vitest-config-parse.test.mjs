import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  extractTestExcludeEntries,
  extractTestProjectInclude,
  extractConcreteExcludes,
} from "../lib/vitest-config-parse.mjs";

/*
FNXC:MergeGatePolicy 2026-09-08-11:02 (RUFU-197):
These fixtures prove both directions of every new scanner branch so the derived merge-gate guard cannot
pass vacuously. extractTestExcludeEntries' whole point is to distinguish a TEST-level exclude (which hides a
gate canary) from a coverage.exclude (which does not) — so each shape that could fool a first-match reader is
exercised: coverage-only, inline test-level, exclusion ordered AFTER coverage, typed const referenced from the
test block, and an unreferenced typed const that must NOT count. extractTestProjectInclude is proven against a
two-project config so the named project's own include is selected, and against comment prose that merely
names a retired file so a comment can never masquerade as an entry.
*/

test("extractTestExcludeEntries ignores coverage.exclude entirely (coverage-only => none)", () => {
  const config = `
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
  coverage: { exclude: ["src/__tests__/hidden.test.ts", "src/**/dist.test.ts"] },
});`;
  assert.deepEqual(extractTestExcludeEntries(config), []);
});

test("extractTestExcludeEntries counts an inline test-level exclude", () => {
  const config = `
export default defineConfig({
  test: { exclude: ["src/__tests__/quarantined.test.ts", "**/*.slow.test.ts"] },
});`;
  const entries = extractTestExcludeEntries(config);
  assert.deepEqual(entries, ["src/__tests__/quarantined.test.ts"]); // glob-only filtered, concrete counted
});

test("extractTestExcludeEntries counts a test-level exclude that appears AFTER coverage", () => {
  // The false-pass defect: the old reader grabbed the FIRST `exclude:` (coverage's) and missed this one.
  const config = `
export default defineConfig({
  test: { coverage: { exclude: ["**/*.test.ts"] }, exclude: ["src/__tests__/late-hidden.test.ts"] },
});`;
  assert.deepEqual(extractTestExcludeEntries(config), ["src/__tests__/late-hidden.test.ts"]);
});

test("extractTestExcludeEntries counts a typed const referenced by the test-level exclude", () => {
  const config = `
const quarantinedCoreTests: string[] = ["src/__tests__/const-hidden.test.ts", "**/*.d.ts"];
export default defineConfig({
  test: { exclude: [...quarantinedCoreTests] },
});`;
  assert.deepEqual(extractTestExcludeEntries(config), ["src/__tests__/const-hidden.test.ts"]);
});

test("extractTestExcludeEntries ignores a typed const NOT referenced by any test-level exclude", () => {
  const config = `
const unrelated: string[] = ["src/__tests__/unrelated.test.ts"];
export default defineConfig({
  test: { exclude: [] },
});`;
  assert.deepEqual(extractTestExcludeEntries(config), []);
});

test("extractTestExcludeEntries counts a per-project test-level exclude (projects array)", () => {
  const config = `
export default defineConfig({
  test: { projects: [
    { name: "engine-default", test: { exclude: ["src/__tests__/flaky.test.ts", "node_modules/**"] } },
  ] },
});`;
  assert.deepEqual(extractTestExcludeEntries(config), ["src/__tests__/flaky.test.ts"]);
});

test("extractTestExcludeEntries never matches a const name that only appears inside a path literal", () => {
  // `q` is referenced only as text inside a path string, never as an identifier, so q's entries must not leak.
  const config = `
const q: string[] = ["src/__tests__/leak.test.ts"];
export default defineConfig({
  test: { exclude: ["src/__tests__/q.test.ts"] },
});`;
  assert.deepEqual(extractTestExcludeEntries(config), ["src/__tests__/q.test.ts"]);
});

test("extractTestProjectInclude selects the named project's own include, ignoring comment prose", () => {
  const config = `
export default defineConfig({
  test: { projects: [
    { name: "engine-default", test: { include: ["src/**/*.test.ts"] } },
    { name: "engine-core", test: {
      // retired: src/__tests__/deleted-in-a-prior-task.test.ts stays in prose only
      include: ["src/__tests__/a.test.ts", "src/__tests__/b.test.ts"],
    } },
  ] },
});`;
  assert.deepEqual(extractTestProjectInclude(config, "engine-core"), [
    "src/__tests__/a.test.ts",
    "src/__tests__/b.test.ts",
  ]);
});

test("extractTestProjectInclude returns [] for an unknown project", () => {
  const config = `export default defineConfig({ test: { projects: [{ name: "other", test: { include: ["x.test.ts"] } }] } });`;
  assert.deepEqual(extractTestProjectInclude(config, "engine-core"), []);
});

test("extractConcreteExcludes keeps the legacy superset behavior (moved verbatim, not narrowed)", () => {
  // The const-array superset must still resolve concrete entries regardless of the test-key scoping —
  // this is what check-quarantine-ledger relies on for its missing-exclude direction.
  const config = `
const quarantinedTests: string[] = ["src/__tests__/locked.test.ts"];
export default defineConfig({ test: { exclude: [...quarantinedTests] }, coverage: { exclude: ["src/__tests__/cov.test.ts"] } });`;
  assert.deepEqual(extractConcreteExcludes(config).sort(), [
    "src/__tests__/cov.test.ts",
    "src/__tests__/locked.test.ts",
  ]);
});

test("real core config exposes no test-level exclude after the 2026-09-06 ratchet (non-vacuous)", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const core = readFileSync(join(repoRoot, "packages/core/vitest.config.ts"), "utf8");
  const level = extractTestExcludeEntries(core);
  // If a canary were ever hidden again, this array would become non-empty — the guard's whole point.
  assert.ok(Array.isArray(level));
  assert.equal(level.length, 0);
});

test("real engine config yields a non-empty engine-core include with no comment-prose entries", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const engine = readFileSync(join(repoRoot, "packages/engine/vitest.config.ts"), "utf8");
  const members = extractTestProjectInclude(engine, "engine-core");
  assert.ok(members.length > 0);
  assert.equal(new Set(members).size, members.length);
  assert.ok(members.every((m) => m.startsWith("src/__tests__/") && m.endsWith(".test.ts")));
});
