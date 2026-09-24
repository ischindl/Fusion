import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectOverrideSpecifiers,
  main,
  scanLockfileImporters,
  validateLockfileImporters,
} from "../check-lockfile-importers.mjs";
import { readStaticGateChecks } from "../run-static-gate-checks.mjs";

/*
FNXC:LockfileDriftGate 2026-09-22-19:20:
RUFU-266. Fixtures mirror the pnpm lockfile v9 importer shape (`importers[<dir>][<block>][<name>] =
{ specifier, version }`) so the policy is exercised without mutating the repository. The recorded
specifier is what pnpm compares during `--frozen-lockfile`, so it is the field under test.
*/
const GLOBS = ["packages/*", "plugins/*"];

function importers(entriesByDirectory) {
  const result = {};
  for (const [directory, entries] of Object.entries(entriesByDirectory)) {
    const dependencies = {};
    const devDependencies = {};
    for (const [name, record] of Object.entries(entries)) {
      const target = typeof record === "string" ? { specifier: record } : record;
      (target.block === "devDependencies" ? devDependencies : dependencies)[name] = { specifier: target.specifier, version: target.version ?? "1.0.0" };
    }
    result[directory] = { dependencies, devDependencies };
  }
  return result;
}

function manifest(filePath, manifestObject, isRoot = false) {
  return { filePath, manifest: manifestObject, isRoot };
}

function validate({ workspaceGlobs = GLOBS, lockfileImporters = {}, manifests = [], overrideSpecifiers = new Map() }) {
  return validateLockfileImporters({ workspaceGlobs, lockfileImporters, manifests, overrideSpecifiers });
}

const fixtureFiles = {
  "pnpm-workspace.yaml": "packages:\n  - packages/*\noverrides:\n  '@types/node': ^25.5.2\n",
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      typescript:\n        specifier: ^5.7.0\n        version: 5.9.3\n  packages/engine:\n    dependencies: {}\n",
  "package.json": JSON.stringify({ name: "fusion-workspace", devDependencies: { typescript: "^5.7.0" } }),
  "packages/engine/package.json": JSON.stringify({ name: "@fusion/engine", dependencies: { undici: "8.9.0" } }),
};

const ROOT_MANIFEST = manifest("package.json", { name: "fusion-workspace", devDependencies: { typescript: "^5.7.0" } }, true);
const ENGINE_MANIFEST = manifest("packages/engine/package.json", { name: "@fusion/engine", dependencies: { undici: "8.9.0" } });

describe("check-lockfile-importers", () => {
  it("passes when every declared dependency is recorded with the same specifier", () => {
    const violations = validate({
      manifests: [ROOT_MANIFEST, ENGINE_MANIFEST],
      lockfileImporters: importers({
        ".": { typescript: "^5.7.0" },
        "packages/engine": { undici: "8.9.0" },
      }),
    });
    assert.deepEqual(violations, []);
  });

  it("flags a dependency that the lockfile never recorded, naming the importer and both specifiers", () => {
    // The RUFU-266 shape: ba1801507b declared undici and 0655a365a9 declared @fusion/core for three
    // runtime plugins, then merge 2c09516986 kept the manifests but not the lockfile records.
    const violations = validate({
      manifests: [ROOT_MANIFEST, ENGINE_MANIFEST, manifest("plugins/droid-runtime/package.json", { dependencies: { "@fusion/core": "workspace:*" } })],
      lockfileImporters: importers({
        ".": { typescript: "^5.7.0" },
        "packages/engine": {},
        "plugins/droid-runtime": {},
      }),
    });
    assert.equal(violations.length, 2);
    assert.match(violations[0], /packages\/engine/);
    assert.match(violations[0], /undici/);
    assert.match(violations[0], /8\.9\.0/);
    assert.match(violations[1], /plugins\/droid-runtime/);
    assert.match(violations[1], /@fusion\/core/);
    assert.match(violations[1], /workspace:\*/);
  });

  it("flags a lockfile record whose dependency the manifest stopped declaring", () => {
    const violations = validate({
      manifests: [ROOT_MANIFEST, manifest("packages/engine/package.json", { name: "@fusion/engine" })],
      lockfileImporters: importers({ ".": { typescript: "^5.7.0" }, "packages/engine": { undici: "8.9.0" } }),
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /packages\/engine/);
    assert.match(violations[0], /undici/);
    assert.match(violations[0], /no longer declares/);
  });

  it("flags a specifier that drifted from the declared range", () => {
    const violations = validate({
      manifests: [ROOT_MANIFEST, manifest("packages/engine/package.json", { devDependencies: { typescript: "^5.9.0" } })],
      lockfileImporters: importers({ ".": { typescript: "^5.7.0" }, "packages/engine": { typescript: { specifier: "^5.7.0", block: "devDependencies" } } }),
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /packages\/engine/);
    assert.match(violations[0], /typescript/);
    assert.match(violations[0], /\^5\.9\.0/);
    assert.match(violations[0], /\^5\.7\.0/);
  });

  it("accepts an overridden specifier instead of failing a synchronized lockfile", () => {
    // pnpm records the override value, not the manifest range: @types/node ^22.0.0 / ^25.5.0 both
    // record ^25.5.2 under the workspace override. Rejecting that would fire on 11 healthy importers.
    const overrideSpecifiers = collectOverrideSpecifiers({ overrides: [{ "@types/node": "^25.5.2" }] });
    const violations = validate({
      manifests: [ROOT_MANIFEST, manifest("packages/engine/package.json", { devDependencies: { "@types/node": "^22.0.0" } })],
      lockfileImporters: importers({ ".": { typescript: "^5.7.0" }, "packages/engine": { "@types/node": { specifier: "^25.5.2", block: "devDependencies" } } }),
      overrideSpecifiers,
    });
    assert.deepEqual(violations, []);
  });

  it("ignores peer declarations that pnpm leaves unrecorded, and never calls a resolved peer stale", () => {
    // packages/droid-cli declares the pi packages as "*" peers; pnpm records them in its
    // `dependencies` block with the resolved version as the specifier.
    const violations = validate({
      manifests: [ROOT_MANIFEST, manifest("packages/droid-cli/package.json", {
        dependencies: { "@fusion-plugin-examples/droid-runtime": "workspace:*" },
        peerDependencies: { "@earendil-works/pi-ai": "*" },
      })],
      lockfileImporters: importers({
        ".": { typescript: "^5.7.0" },
        "packages/droid-cli": { "@fusion-plugin-examples/droid-runtime": "workspace:*", "@earendil-works/pi-ai": "0.86.1" },
      }),
    });
    assert.deepEqual(violations, []);
  });

  it("flags a workspace package with no importer block at all", () => {
    const violations = validate({
      manifests: [ROOT_MANIFEST, ENGINE_MANIFEST],
      lockfileImporters: importers({ ".": { typescript: "^5.7.0" } }),
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /packages\/engine/);
    assert.match(violations[0], /no importer block/);
  });

  it("flags a lockfile importer that no glob-covered workspace package declares", () => {
    const violations = validate({
      manifests: [ROOT_MANIFEST],
      lockfileImporters: importers({ ".": { typescript: "^5.7.0" }, "plugins/removed-package": { "@fusion/core": "workspace:*" } }),
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /plugins\/removed-package/);
  });

  it("checks the root importer too", () => {
    const violations = validate({
      manifests: [ROOT_MANIFEST, ENGINE_MANIFEST],
      lockfileImporters: importers({ "packages/engine": { undici: "8.9.0" } }),
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /^\./);
  });

  it("collects scoped and nested override targets under their base package name", () => {
    const specifiers = collectOverrideSpecifiers({
      overrides: [{ "@types/node": "^25.5.2", "protobufjs@^7": "^7.5.8", "father>child": "1.2.3" }],
    });
    assert.equal(specifiers.get("@types/node").has("^25.5.2"), true);
    assert.equal(specifiers.get("protobufjs").has("^7.5.8"), true);
    assert.equal(specifiers.get("child").has("1.2.3"), true);
  });

  it("passes against the live repository", async () => {
    assert.deepEqual(await scanLockfileImporters(), []);
  });

  it("exits non-zero and prints the importer, the dependency, and both specifiers", async () => {
    const originalError = console.error;
    const originalLog = console.log;
    const printed = [];
    console.error = (message) => printed.push(String(message));
    console.log = (message) => printed.push(String(message));
    try {
      const code = await main({
        root: "/fixture",
        glob: () => ["package.json", "packages/engine/package.json"],
        readFile: (filePath) => fixtureFiles[filePath.replace("/fixture/", "")],
      });
      assert.equal(code, 1);
      const report = printed.join("\n");
      assert.match(report, /check-lockfile-importers/);
      assert.match(report, /packages\/engine: dependencies\.undici declares 8\.9\.0 but pnpm-lock\.yaml records no entry/);
      assert.match(report, /pnpm install/);
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }
  });

  it("is included in the blocking static gate inventory", () => {
    assert.equal(readStaticGateChecks().includes("scripts/check-lockfile-importers.mjs"), true);
  });
});
