/*
FNXC:RUFU-140 2026-08-21-04:25:
RUFU-140 made packages/dashboard/tsconfig.test-check.json (the repo's only
typecheck program that includes dashboard test files) green after ~2,012
pre-existing test-file errors. This ratchet proves the green was not achieved
by weakening the program: it pins the include coverage (no test exclusions),
the repo-root rootDir, the distinct incremental buildinfo, the paths aliases,
extends, and forbids strict/skipLibCheck/noImplicitAny relaxations. It also
pins the declaration:false scoping decision (documented in the config): the
app program excludes all test files and every dashboard program is noEmit, so
no file this program checks is ever declaration-emitted — with the base
config's declaration:true the checker emits spurious TS2742 portability
errors in exported-mock test harnesses once a repo-root .mjs declaration
(eslint.config.d.mts) joined the program. Fast text parse only — NO tsc
invocation, per the no-slow-tests rule.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

const configPath = new URL("../../packages/dashboard/tsconfig.test-check.json", import.meta.url);

// JSONC: strip block/line comments with a string-aware scan — a naive regex lets
// the "/*" inside the include glob "app/**/*" open a phantom comment that eats
// the rest of the glob (same pitfall check-quarantine-ledger.mjs documents for
// "node_modules/**"). Then parse.
function stripJsoncComments(source) {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (inString) {
      if (ch === "\\") { out += ch + (next ?? ""); i += 2; continue; }
      if (ch === '"') inString = false;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; i += 1; continue; }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      out += " ";
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function readConfig() {
  const source = readFileSync(configPath, "utf8");
  return JSON.parse(stripJsoncComments(source));
}

test("test-check program still covers the whole app tree with no test exclusions", () => {
  const config = readConfig();
  assert.deepEqual(config.include, ["app/**/*"]);
  // No exclude key at all is the strongest form; if one ever appears it must
  // not carve out test files (that would be a silent coverage shrink).
  if (config.exclude) {
    const offenders = config.exclude.filter((pattern) =>
      pattern.includes("__tests__") || pattern.includes(".test.") || pattern.includes("test-harness") || pattern.includes("test-helpers"),
    );
    assert.deepEqual(offenders, [], `test-check config excludes test files: ${JSON.stringify(offenders)}`);
  }
});

test("test-check rootDir stays at the repo root and buildinfo stays distinct", () => {
  const config = readConfig();
  // The program pulls packages/core/src and plugins/ into one graph; a
  // packages/-scoped rootDir (app.json's "..") cannot cover both.
  assert.equal(config.compilerOptions.rootDir, "../..");
  // Distinct from tsconfig.json/app.json's shared ${configDir}/dist/.tsbuildinfo
  // and app.json's .tsbuildinfo-app, so incremental state never clobbers.
  assert.equal(config.compilerOptions.tsBuildInfoFile, "${configDir}/dist/.tsbuildinfo-test-check");
});

test("test-check config does not relax compiler options", () => {
  const config = readConfig();
  assert.equal(config.extends, "../../tsconfig.base.json");
  const options = config.compilerOptions;
  assert.notEqual(options.strict, false, "strict:false weakens the test-check program");
  assert.notEqual(options.noImplicitAny, false, "noImplicitAny:false weakens the test-check program");
  assert.notEqual(options.skipLibCheck, true, "skipLibCheck:true must not be added here (base inheritance already covers it)");
  // noEmit is the program's purpose (check-only, never a build).
  assert.equal(options.noEmit, true);
  // Declaration emit stays off (see file header): test files are excluded from
  // tsconfig.app.json and no dashboard program emits, so declaration:true
  // only adds TS2742 portability noise. Flipping it back on is a known break,
  // not a repair.
  assert.equal(options.declaration, false, "declaration:true resurrects TS2742 portability errors in unemitted test harnesses");
  assert.equal(options.declarationMap, false);
});

test("test-check paths aliases are all still present", () => {
  const config = readConfig();
  const required = {
    "@fusion/test-utils": ["../core/src/__test-utils__/workspace.ts"],
    "node-pty": ["./src/types/node-pty/index.d.ts"],
    "@fusion/dashboard/app/components/TaskCard": ["./app/components/TaskCard.tsx"],
    "@fusion/dashboard/app/components/ViewHeader": ["./app/components/ViewHeader.tsx"],
    "@fusion/dashboard/app/api/tasks/task-content": ["./app/api/tasks/task-content.ts"],
    "@fusion/dashboard/app/plugins/types": ["./app/plugins/types.ts"],
    "@fusion/dashboard/app/utils/projectStorage": ["./app/utils/projectStorage.ts"],
  };
  for (const [alias, target] of Object.entries(required)) {
    assert.deepEqual(config.compilerOptions.paths?.[alias], target, `paths alias missing or changed: ${alias}`);
  }
});
