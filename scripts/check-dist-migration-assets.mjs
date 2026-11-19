#!/usr/bin/env node
/*
FNXC:SchemaAssetPairing 2026-11-17-16:10 (RUFU-548):
Canonical static validator for the built-artifact half of the schema-ceiling contract.
The sibling guard packages/core/src/__tests__/migration-wiring-integrity.test.ts compares
SCHEMA_BASELINE_VERSION against the SRC migrations dir; that scan already caught the 0064
and 0065 startup breakages, but it structurally cannot see the emitted artifact. @fusion/core
builds with bare `tsc`, which emits only `.js`, so its dist carries the ceiling claim
(`dist/postgres/schema-applier.js` -> `SCHEMA_BASELINE_VERSION = "NNNN"`) while the `.sql`
assets that must honor it arrive only opportunistically (CLI tsup `onSuccess`, desktop
`stageCoreMigrations`, `scripts/lib/backend-db.mjs`). Measured 2026-10-04: two same-named
core dists declared ceilings (0089, 0087) their own built migration directories could not
honor, and the failure surfaced only at store boot as "This Fusion binary is older than the
database it opened" - because no lint / test / gate / CI lane read the emitted pair. This
validator makes the built artifact self-proving: an emitted ceiling claim and the SAME
package directory's emitted assets, evaluated together, exiting non-zero on drift.

Per-worktree AND per-package by construction: the migration registry is materialized per
build output, so the guard runs against `--root` (default: THIS script's own repo root) and
never substitutes a sibling worktree's or another package's assets for the artifact under
test. Every message names the package directory it evaluated; a pass in another tree is not
coverage (measured 2026-10-04: the served tree and the primary checkout disagreed).

Why this is NOT a pretest / pretest:full / test:gate:static validator: those lanes run
BEFORE any build, where `dist` is legitimately absent or pre-staging, so membership there
would turn `pnpm test` red in every fresh worktree while adding zero coverage of a real
artifact. It runs where artifacts exist instead: as a `pnpm verify:fast` step after the
builds (scripts/verify-fast.mjs) and via the built-artifact `describe` block that shells out
to this entry point inside the DB-free unit gate.
*/

import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluatePackageContract } from "./lib/dist-migration-assets.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Recursively collect emitted `.js` claim files, skipping non-claim directories. */
function walkJs(dir, skipDirs, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // Absent dist directory -> no claim files -> the `not-built` verdict.
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walkJs(full, skipDirs, out);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      // `.js.map` and `.d.ts` never end in `.js`, so the extension test alone excludes them.
      out.push(full);
    }
  }
  return out;
}

/** Top-level `.js` bundles only, so staged subdirectory closures are never misattributed. */
function topLevelJs(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile() && e.name.endsWith(".js")).map((e) => join(dir, e.name));
}

/*
FNXC:SchemaAssetPairing 2026-11-17-16:10 (RUFU-548): pair table, evaluated per tree.
- @fusion/core: every emitted `.js` under `dist` (recursive) may carry/re-export the ceiling; assets are the
  `dist/postgres/migrations` the compiled applier resolves via `join(__dirname, "migrations")`.
- @runfusion/fusion: TOP-LEVEL `dist/*.js` bundles only (a newly added top-level bundle is
  covered without editing this table; measured today three of them carry the literal), assets
  are `dist/migrations` staged beside the bundle by packages/cli/tsup.config.ts.
The standalone bun-compiled exe (packages/cli/build.ts -> `outDir/fn` + `join(outDir,
"migrations")`) is an explicit NON-GOAL: build.ts `rm`s and re-copies the whole migration
directory in the same function that compiles the binary, so its assets cannot drift from its
own build. Record any contrary finding as a separate task.
*/
const PACKAGE_CONTRACTS = [
  {
    name: "@fusion/core",
    distDir: "packages/core/dist",
    assetsDir: "packages/core/dist/postgres/migrations",
    selectClaims: (distDir) => walkJs(distDir, new Set(["node_modules", "migrations"])),
    remedy: "pnpm --filter @fusion/core build (its build stages src/postgres/migrations into dist)",
  },
  {
    name: "@runfusion/fusion",
    distDir: "packages/cli/dist",
    assetsDir: "packages/cli/dist/migrations",
    selectClaims: topLevelJs,
    remedy: "pnpm --filter @runfusion/fusion build",
  },
];

const USAGE =
  "Usage: node scripts/check-dist-migration-assets.mjs [--root=<dir> | --root <dir>] [--help]\n" +
  "Verifies each built package's emitted SCHEMA_BASELINE_VERSION is honored by that same package's emitted migration assets.\n";

function parseArgs(argv) {
  const opts = { root: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--root") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--root requires a directory argument");
      opts.root = value;
      i += 1;
    } else if (arg.startsWith("--root=")) opts.root = arg.slice("--root=".length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/** Root-relative, posix-style path so messages are stable across machines and worktrees. */
function toDisplayPath(rootDir, absolutePath) {
  return relative(rootDir, absolutePath).split(sep).join("/");
}

/**
 * Evaluate the pair table against one tree.
 *
 * @param {object} [options]
 * @param {string} [options.rootDir] tree to inspect (a checkout/worktree root)
 * @param {ReturnType<typeof evaluatePackageContract>[]} [options.verdicts] pre-computed (for callers that already enumerated)
 */
export function evaluateTree(rootDir = REPO_ROOT) {
  const verdicts = [];
  for (const contract of PACKAGE_CONTRACTS) {
    const distDir = resolve(rootDir, contract.distDir);
    const claimFiles = contract.selectClaims(distDir);
    const assetsDir = resolve(rootDir, contract.assetsDir);
    const verdict = evaluatePackageContract({ packageDir: contract.distDir, claimFiles, assetsDir });
    verdicts.push({ contract, verdict });
  }
  return verdicts;
}

/** Render one failing package's lines (FAIL header + a line per missing asset). */
function renderFailure(rootDir, { contract, verdict }) {
  const lines = [];
  const distRel = toDisplayPath(rootDir, resolve(rootDir, contract.distDir));
  const assetsRel = toDisplayPath(rootDir, resolve(rootDir, contract.assetsDir));
  if (verdict.status === "unreadable-claim") {
    const where = verdict.unreadableClaims.map((c) => toDisplayPath(rootDir, c.file)).join(", ");
    lines.push(
      `FAIL ${contract.name} - ${distRel} carries an unparseable SCHEMA_BASELINE_VERSION literal (${where}); cannot prove its emitted assets honor the ceiling`,
    );
    return lines;
  }
  const top = verdict.highestAsset ?? "(none present)";
  lines.push(
    `FAIL ${contract.name} - ${distRel} declares SCHEMA_BASELINE_VERSION ${verdict.ceiling ?? "?"} but ${assetsRel} tops out at ${top}`,
  );
  for (const entry of verdict.missing) {
    lines.push(`  missing ${entry.basename} (referenced by ${toDisplayPath(rootDir, entry.referencedBy)}) [${entry.kind}]`);
  }
  if (verdict.missing.length === 0) {
    lines.push(`  no emitted asset reaches the declared ceiling ${verdict.ceiling ?? "?"} in ${assetsRel}`);
  }
  lines.push(`  remedy: run ${contract.remedy}`);
  return lines;
}

/**
 * Production entry point.
 *
 * @param {string[]} argv
 * @param {object} [io]
 * @param {string} [io.rootDir] default tree (defaults to this script's own repo root)
 * @param {{write:(s:string)=>void}} [io.stdout]
 * @param {{write:(s:string)=>void}} [io.stderr]
 * @returns {number} process exit code (0 = honored/only-not-built; 1 = drift or unreadable claim)
 */
export function main(argv = process.argv.slice(2), { rootDir = REPO_ROOT, stdout = process.stdout, stderr = process.stderr } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n${USAGE}`);
    return 1;
  }
  if (opts.help) {
    stdout.write(USAGE);
    return 0;
  }

  const root = resolve(rootDir, opts.root ?? ".");
  const evaluated = { ok: 0, drift: 0, unreadable: 0, skipped: 0 };
  const failureLines = [];
  const skipLines = [];
  for (const item of evaluateTree(root)) {
    const { verdict } = item;
    if (verdict.status === "not-built") {
      evaluated.skipped += 1;
      skipLines.push(`SKIP ${item.contract.name} - no emitted claim files under ${item.contract.distDir}; nothing to check in this tree`);
      continue;
    }
    if (verdict.status === "ok") {
      evaluated.ok += 1;
      continue;
    }
    if (verdict.status === "unreadable-claim") evaluated.unreadable += 1;
    else evaluated.drift += 1;
    // Every line of a failing package's report belongs on stderr, including the indented
    // detail lines: the DB-free gate lane asserts the missing VERSIONS on stderr, and a
    // tool routing streams must not split one failure across two channels.
    failureLines.push(...renderFailure(root, item));
  }

  // Per-worktree attribution: name the tree that was inspected, so a healthy checkout can
  // never appear to vouch for a broken sibling one.
  stdout.write(`dist-migration-assets: root ${root}\n`);
  for (const line of skipLines) stdout.write(`${line}\n`);
  for (const line of failureLines) stderr.write(`${line}\n`);
  const evaluatedCount = evaluated.ok + evaluated.drift + evaluated.unreadable;
  const failed = evaluated.drift + evaluated.unreadable;
  stdout.write(
    `dist-migration-assets: evaluated=${evaluatedCount} ok=${evaluated.ok} drift=${evaluated.drift} unreadable=${evaluated.unreadable} skipped-not-built=${evaluated.skipped}\n`,
  );
  if (failed > 0) {
    stderr.write(`dist-migration-assets: FAILED (${failed} package(s) whose built migration assets do not honor their emitted ceiling claim)\n`);
    return 1;
  }
  if (evaluatedCount === 0) {
    // Checked nothing is not a pass: make the vacuous case visible on stdout (the summary
    // already printed) and still exit 0, because an unbuilt tree has no artifact to fail.
    stdout.write("dist-migration-assets: no package evaluated in this tree (nothing built) - this is NOT a pass of built artifacts.\n");
  }
  return 0;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) process.exitCode = main();
