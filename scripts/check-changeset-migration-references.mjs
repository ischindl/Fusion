#!/usr/bin/env node
// Scans changesets for migration filenames and fails when a named migration does not exist.
//
/*
FNXC:MigrationRenumber 2026-10-06-01:47:
A changeset named `0079_stas_205_review_lane_ledger.sql` while that file does not exist on this line: our merge contract keeps `origin/main` an ancestor of our line, so incoming upstream migrations
keep their slots and ours move to a free later one — upstream took 0079 (FN-393) and the ledger landed as 0088.
Nothing caught it because the number lives in changeset prose, not in a code construct: `check:changesets` validates the labelled field format, and `schema-applier` reads real files, so a wrong name in
documentation is invisible to both.
A dangling migration name is not cosmetic — an operator debugging a schema drift follows that name to a missing file, and after a renumber the wrong name points at a *different, real* migration
owned by someone else, which is worse than no name at all.
Roots are overridable so the check can be proven against fixtures in both directions without touching real changesets.
*/
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.env.FUSION_CHANGESET_CHECK_ROOT ?? process.cwd();
const migrationsDir =
  process.env.FUSION_MIGRATIONS_DIR ??
  join(root, "packages/core/src/postgres/migrations");

// Migration tokens look like `0088_stas_205_review_lane_ledger` with an optional `.sql`.
const MIGRATION_TOKEN = /\b(0\d{3}_[a-z0-9][a-z0-9_]*)\b/g;

function changesetFiles() {
  const overrides = process.env.FUSION_CHANGESET_FILES;
  if (overrides) return overrides.split("\u0000").filter(Boolean);
  const result = spawnSync("git", ["ls-files", "--", ".changeset/*.md"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || "git ls-files failed");
  }
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function migrationFileExists(token) {
  if (!existsSync(migrationsDir)) {
    throw new Error(`migrations directory not found: ${migrationsDir}`);
  }
  const entries = readdirSync(migrationsDir);
  return entries.some((name) => name === `${token}.sql` || name.startsWith(`${token}_`));
}

const failures = [];
const checked = [];
for (const file of changesetFiles()) {
  if (file.includes("/examples/")) continue;
  // Fixture overrides hand over absolute paths; git ls-files hands over repo-relative ones.
  const text = readFileSync(isAbsolute(file) ? file : join(root, file), "utf8");
  for (const token of new Set(text.match(MIGRATION_TOKEN) ?? [])) {
    checked.push(`${file} -> ${token}`);
    if (!migrationFileExists(token)) failures.push(`${file}: names ${token}, no such migration file`);
  }
}

if (failures.length > 0) {
  console.error(
    `${failures.length} changeset migration reference(s) do not resolve. A migration number in a changeset is prose, so no other check sees it: after a renumber the wrong number can point at a different, real migration owned by another card.`,
  );
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(`  Fix: rename the reference to the file actually present in packages/core/src/postgres/migrations/.`);
  process.exit(1);
}

console.log(`changeset migration references: ${checked.length} reference(s) resolve against ${migrationsDir}`);
