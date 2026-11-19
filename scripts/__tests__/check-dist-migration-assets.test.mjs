/*
FNXC:SchemaAssetPairing 2026-11-17-16:10 (RUFU-548):
Production-entry-point tests for the built-artifact schema-ceiling validator. These drive the
real `main(argv, { rootDir, stdout, stderr })` (the house entry-point idiom from
check-quarantine-ledger.mjs) over synthetic package trees in os.tmpdir(), so every fixture
state the invariant cares about is exercised deterministically with NO database, NO network,
NO timers, and no dependency on any particular ceiling number (SCHEMA_BASELINE_VERSION
advances on every migration landing; a hardcoded ceiling would rot the moment it does).

Non-vacuity rule honored here: a passing check must prove it evaluated something, so each
positive test asserts the per-package `evaluated=`/`ok=` counts it expected, never a bare
exit-0 (a run that evaluated nothing because the tree was empty is NOT a pass).
*/

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { main } from "../check-dist-migration-assets.mjs";
import { listAssetVersions, readEmittedCeilings, readEmittedRegistryVersions } from "../lib/dist-migration-assets.mjs";
import { stagePostgresMigrations } from "../lib/stage-postgres-migrations.mjs";

function captureStream() {
  let text = "";
  return { stream: { write(chunk) { text += chunk; } }, get text() { return text; } };
}

function runMain(argv, rootDir) {
  const stdout = captureStream();
  const stderr = captureStream();
  const code = main(argv, { rootDir, stdout: stdout.stream, stderr: stderr.stream });
  return { code, out: stdout.text, err: stderr.text };
}

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "fusion-dist-migration-assets-"));
}

function writeFile(root, rel, content = "") {
  const target = path.join(root, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

/*
Two emitted declaration shapes must both parse (the real tsc mirror and the esbuild bundle
emit different prefixes for the same constant); the literal-tolerant ceiling pattern claims
to match both, and these fixtures are where that claim is held.
*/
function applierSource({ ceiling, registry, style = "tsc" }) {
  const decl =
    style === "tsc"
      ? `export const SCHEMA_BASELINE_VERSION = "${ceiling}";`
      : style === "esbuild"
        ? `SCHEMA_BASELINE_VERSION = "${ceiling}";`
        : style === "bad"
          ? `const SCHEMA_BASELINE_VERSION = ${ceiling};` // assignment-shaped but the RHS is not a quoted 4-digit literal
          : `const SCHEMA_BASELINE_VERSION = "${ceiling}";`;
  const registryLines = registry.map((b, i) => `const MIG_${i}_PATH = join(MIGRATIONS_DIR, "${b}");`).join("\n");
  return `// emitted artifact\n${decl}\n${registryLines}\n`;
}

// A re-export module mirrors `export { SCHEMA_BASELINE_VERSION, ... }` with no `=`: it must
// be recognized as a claim file that carries no ceiling and must never look unreadable.
const REEXPORT_JS = `export { applySchemaBaseline, SCHEMA_BASELINE_VERSION, assertBinaryNotOlderThanDatabase };\n`;

function buildCore(root, { ceiling = "0002", registry, assets, style = "tsc", omitReexport = false, assetsDirAbsent = false } = {}) {
  writeFile(root, "packages/core/dist/postgres/schema-applier.js", applierSource({ ceiling, registry, style }));
  if (!omitReexport) writeFile(root, "packages/core/dist/index.js", REEXPORT_JS);
  if (!assetsDirAbsent) for (const a of assets) writeFile(root, `packages/core/dist/postgres/migrations/${a}`, "-- sql\n");
}

function buildCli(root, { ceiling = "0002", registry, assets, style = "esbuild" } = {}) {
  writeFile(root, "packages/cli/dist/bin.js", applierSource({ ceiling, registry, style }));
  for (const a of assets) writeFile(root, `packages/cli/dist/migrations/${a}`, "-- sql\n");
}

const R3 = ["0000_initial.sql", "0001_alpha.sql", "0002_beta.sql"];

test("readEmittedCeilings parses both the tsc and the esbuild emitted declaration shapes", () => {
  const root = tempRoot();
  try {
    const tsc = path.join(root, "tsc.js");
    writeFile(root, "tsc.js", applierSource({ ceiling: "0097", registry: R3, style: "tsc" }));
    const bundle = path.join(root, "bundle.js");
    writeFile(root, "bundle.js", applierSource({ ceiling: "0097", registry: R3, style: "esbuild" }));
    assert.deepEqual(readEmittedCeilings([tsc]), ["0097"]);
    assert.deepEqual(readEmittedCeilings([bundle]), ["0097"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("readEmittedRegistryVersions reads the referenced versions, not a numeric range", () => {
  const root = tempRoot();
  try {
    const file = path.join(root, "a.js");
    writeFile(root, "a.js", applierSource({ ceiling: "0006", registry: ["0001_one.sql", "0006_six.sql"], style: "esbuild" }));
    assert.deepEqual(readEmittedRegistryVersions([file]), ["0001", "0006"]); // 0002..0005 never referenced -> never reported
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("listAssetVersions reports an absent directory as a distinguishable empty result", () => {
  const root = tempRoot();
  try {
    const missing = listAssetVersions(path.join(root, "nope"));
    assert.equal(missing.exists, false);
    assert.deepEqual(missing.versions, []);
    writeFile(root, "m/0003_x.sql");
    const present = listAssetVersions(path.join(root, "m"));
    assert.equal(present.exists, true);
    assert.deepEqual(present.versions, ["0003"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("correct build exits 0 and reports the package as evaluated+ok", () => {
  const root = tempRoot();
  try {
    buildCore(root, { registry: R3, assets: R3 });
    buildCli(root, { registry: R3, assets: R3 });
    const { code, out } = runMain([], root);
    assert.equal(code, 0);
    assert.match(out, /dist-migration-assets: root /);
    assert.match(out, /evaluated=2 ok=2 drift=0 unreadable=0 skipped-not-built=0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("drift (ceiling above the highest present asset) exits non-zero naming package + missing version", () => {
  const root = tempRoot();
  try {
    buildCore(root, { ceiling: "0002", registry: R3, assets: ["0000_initial.sql", "0001_alpha.sql"] });
    buildCli(root, { registry: R3, assets: R3 });
    const { code, err } = runMain([], root);
    assert.equal(code, 1);
    assert.match(err, /FAIL @fusion\/core/);
    assert.match(err, /packages\/core\/dist declares SCHEMA_BASELINE_VERSION 0002/);
    assert.match(err, /missing 0002_beta\.sql/);
    assert.match(err, /referenced by packages\/core\/dist\/postgres\/schema-applier\.js/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("per-version gap: a middle referenced version missing while the highest matches still fails", () => {
  const root = tempRoot();
  try {
    // Highest asset (0002) equals the ceiling, but the referenced 0001 is absent: the
    // per-version half of the invariant, which a highest-vs-ceiling comparison alone misses.
    buildCore(root, { ceiling: "0002", registry: R3, assets: ["0000_initial.sql", "0002_beta.sql"] });
    buildCli(root, { registry: R3, assets: R3 });
    const { code, err } = runMain([], root);
    assert.equal(code, 1);
    assert.match(err, /missing 0001_alpha\.sql/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stale basename: same version present under a different basename fails as stale-basename", () => {
  const root = tempRoot();
  try {
    // dist carries 0001 under an OLD basename; the registry references the NEW one. The
    // runtime's exact-basename readFile ENOENTs exactly like an absent version, so the
    // version-matches-but-name-does-not shape must be refused, not waved through.
    buildCore(root, { ceiling: "0002", registry: R3, assets: ["0000_initial.sql", "0001_old_name.sql", "0002_beta.sql"] });
    buildCli(root, { registry: R3, assets: R3 });
    const { code, err } = runMain([], root);
    assert.equal(code, 1);
    assert.match(err, /missing 0001_alpha\.sql/);
    assert.match(err, /\[stale-basename\]/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("assets-dir absent exits non-zero with an actionable remedy", () => {
  const root = tempRoot();
  try {
    buildCore(root, { registry: R3, assets: [], assetsDirAbsent: true });
    buildCli(root, { registry: R3, assets: R3 });
    const { code, err } = runMain([], root);
    assert.equal(code, 1);
    assert.match(err, /tops out at \(none present\)/);
    assert.match(err, /remedy: run pnpm --filter @fusion\/core build/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("assets above the ceiling (extra future .sql) exit 0", () => {
  const root = tempRoot();
  try {
    buildCore(root, { ceiling: "0002", registry: R3, assets: [...R3, "0003_future.sql", "0004_next.sql"] });
    buildCli(root, { registry: R3, assets: R3 });
    const { code, out } = runMain([], root);
    assert.equal(code, 0);
    assert.match(out, /evaluated=2 ok=2/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unparseable literal in an existing claim file exits non-zero as unreadable-claim", () => {
  const root = tempRoot();
  try {
    buildCore(root, { ceiling: "0002", registry: R3, assets: R3, style: "bad" });
    buildCli(root, { registry: R3, assets: R3 });
    const { code, out, err } = runMain([], root);
    assert.equal(code, 1);
    assert.match(err, /unreadable SCHEMA_BASELINE_VERSION|carries an unparseable SCHEMA_BASELINE_VERSION/);
    assert.match(out, /unreadable=1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a re-export claim module (no `=`) is never mistaken for an unreadable claim", () => {
  const root = tempRoot();
  try {
    buildCore(root, { registry: R3, assets: R3 }); // index.js carries `export { ... SCHEMA_BASELINE_VERSION ... }`
    buildCli(root, { registry: R3, assets: R3 });
    const { code, out } = runMain([], root);
    assert.equal(code, 0);
    assert.match(out, /unreadable=0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("nothing emitted exits 0 with a skip note and a not-built count (never a silent pass)", () => {
  const root = tempRoot();
  try {
    const { code, out } = runMain([], root); // empty tree
    assert.equal(code, 0);
    assert.match(out, /SKIP @fusion\/core/);
    assert.match(out, /SKIP @runfusion\/fusion/);
    assert.match(out, /evaluated=0 ok=0 drift=0 unreadable=0 skipped-not-built=2/);
    assert.match(out, /this is NOT a pass of built artifacts/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("one sick + one healthy package: the failure names only the sick one", () => {
  const root = tempRoot();
  try {
    buildCore(root, { ceiling: "0002", registry: R3, assets: ["0000_initial.sql", "0001_alpha.sql"] }); // drift
    buildCli(root, { registry: R3, assets: R3 }); // healthy
    const { code, err, out } = runMain([], root);
    assert.equal(code, 1);
    assert.match(err, /FAIL @fusion\/core/);
    assert.doesNotMatch(err, /@runfusion\/fusion/); // the healthy package is not named in any failure
    assert.match(out, /evaluated=2 ok=1 drift=1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI claim enumeration is top-level only: a broken nested bundle is not attributed to CLI", () => {
  const root = tempRoot();
  try {
    buildCore(root, { registry: R3, assets: R3 });
    buildCli(root, { registry: R3, assets: R3 });
    // A poisoned file in a subdirectory would trip unreadable if the top-level-only rule
    // were ignored; correct enumeration never scans it, so CLI stays ok.
    writeFile(root, "packages/cli/dist/client/helper.js", applierSource({ ceiling: "0002", registry: R3, style: "bad" }));
    const { code, out } = runMain([], root);
    assert.equal(code, 0);
    assert.match(out, /evaluated=2 ok=2 drift=0 unreadable=0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the check never reads src: a drifted dist is not rescued by a complete src tree, and a bogus src does not sink a healthy dist", () => {
  const healthySrc = tempRoot();
  try {
    // Healthy dist + a deliberately disagreeing src tree (extra future asset): verdict unchanged.
    buildCore(healthySrc, { registry: R3, assets: R3 });
    buildCli(healthySrc, { registry: R3, assets: R3 });
    writeFile(healthySrc, "packages/core/src/postgres/migrations/9999_fake.sql", "-- src decoy\n");
    assert.equal(runMain([], healthySrc).code, 0);
  } finally { rmSync(healthySrc, { recursive: true, force: true }); }

  const sickDist = tempRoot();
  try {
    // Drifted dist with a COMPLETE src migrations tree present: src must not substitute for
    // the artifact under test. This is the exact vacuity RUFU-548 exists to remove.
    buildCore(sickDist, { ceiling: "0002", registry: R3, assets: ["0000_initial.sql", "0001_alpha.sql"] });
    buildCli(sickDist, { registry: R3, assets: R3 });
    for (const a of R3) writeFile(sickDist, `packages/core/src/postgres/migrations/${a}`, "-- src asset\n");
    const { code, err } = runMain([], sickDist);
    assert.equal(code, 1);
    assert.match(err, /missing 0002_beta\.sql/);
    assert.doesNotMatch(err, /packages\/core\/src/); // never points at src as coverage
  } finally { rmSync(sickDist, { recursive: true, force: true }); }
});

test("a referenced version sequence that skips a slot number passes (the check is not a numeric range)", () => {
  const root = tempRoot();
  try {
    // Registry references 0001 then 0006 (0002..0005 are abandoned slots that exist nowhere in
    // this repo by design); a numeric 0000..0006 sweep would report four false failures, so a
    // green verdict here proves the missing set is exactly the referenced versions.
    buildCore(root, { ceiling: "0006", registry: ["0001_one.sql", "0006_six.sql"], assets: ["0001_one.sql", "0006_six.sql"] });
    buildCli(root, { registry: R3, assets: R3 });
    const { code, out } = runMain([], root);
    assert.equal(code, 0);
    assert.match(out, /evaluated=2 ok=2/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("staging helper mirrors the source directory: purges stale basenames, restores deletions", () => {
  const root = tempRoot();
  try {
    const src = path.join(root, "src-migrations");
    const dest = path.join(root, "dist-migrations");
    writeFile(root, "src-migrations/0001_one.sql", "-- one\n");
    writeFile(root, "src-migrations/0002_two.sql", "-- two\n");
    writeFile(root, "src-migrations/meta/catalog.json", "{}\n"); // non-.sql payload must travel too
    writeFile(root, "dist-migrations/0001_one.sql", "-- one\n");
    writeFile(root, "dist-migrations/9999_stale_basename.sql", "-- orphan of a renamed migration\n");

    const result = stagePostgresMigrations({ srcDir: src, destDir: dest });
    assert.equal(result.skipped, null);
    assert.ok(result.staged >= 2);
    const listed = readdirSync(dest, { recursive: true, encoding: "utf8" });
    assert.ok(listed.includes("0002_two.sql")); // restored what a warm cache lost
    assert.ok(!listed.includes("9999_stale_basename.sql")); // purged what additive copy could never purge
    assert.ok(listed.some((f) => String(f).startsWith("meta"))); // meta/ catalog mirrors too
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("staging helper reports a missing source as an explicit skip, never a silent success", () => {
  const root = tempRoot();
  try {
    const result = stagePostgresMigrations({ srcDir: path.join(root, "absent"), destDir: path.join(root, "dest") });
    assert.equal(result.skipped, "src-missing");
    assert.equal(result.staged, 0);
    assert.equal(existsSync(path.join(root, "dest")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a second --root reports the tree it was pointed at (per-worktree attribution)", () => {
  const healthy = tempRoot();
  const sick = tempRoot();
  try {
    buildCore(healthy, { registry: R3, assets: R3 });
    buildCli(healthy, { registry: R3, assets: R3 });
    buildCore(sick, { ceiling: "0002", registry: R3, assets: ["0000_initial.sql", "0001_alpha.sql"] });
    buildCli(sick, { registry: R3, assets: R3 });

    // Pointing at the healthy tree passes even though a sibling drifted tree sits on disk:
    // a pass in one tree is not coverage for another.
    const healthyRun = runMain(["--root", healthy], sick);
    assert.equal(healthyRun.code, 0);
    assert.ok(healthyRun.out.includes(`root ${healthy}`), `root line must name the tree inspected: ${healthyRun.out}`);

    // Pointing at the sick tree from the healthy tree's own root still refuses, naming the
    // sick tree.
    const sickRun = runMain(["--root", sick], healthy);
    assert.equal(sickRun.code, 1);
    assert.ok(sickRun.out.includes(`root ${sick}`), `root line must name the tree inspected: ${sickRun.out}`);
    assert.match(sickRun.err, /missing 0002_beta\.sql/);
  } finally {
    rmSync(healthy, { recursive: true, force: true });
    rmSync(sick, { recursive: true, force: true });
  }
});
