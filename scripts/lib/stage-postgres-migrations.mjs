#!/usr/bin/env node
/*
FNXC:SchemaAssetPairing 2026-11-17-16:23 (RUFU-548):
Single shared staging helper for PostgreSQL migration assets. Rationale for ONE helper:
three writers already copy `packages/core/src/postgres/migrations` into a built artifact —
`packages/cli/tsup.config.ts` `onSuccess`, `packages/desktop/scripts/workspace-tools.ts`
`stageCoreMigrations()` (its own rm-then-cp, left intact for the deploy closure), and
`scripts/lib/backend-db.mjs` `ensureMigrationsStaged()` (previously ADDITIVE, which could
never purge a stale basename left behind when a migration file is renamed). The new
`@fusion/core` build step made the RUFU-548 shape loud enough to be a gate: an emitted
`SCHEMA_BASELINE_VERSION` is a claim about assets that must physically sit next to the
emitted applier, so staging must produce an EXACT mirror, not a best-effort union.

Contract:
- remove-before-copy: the destination is deleted whole and re-copied, so the built asset
  directory equals the source directory (stale basenames cannot survive a rebuild);
- paths resolve against the REPO ROOT derived from this file's own location, never the
  caller's cwd — the core build invokes it as `node ../../scripts/lib/...` from
  `packages/core`, so a cwd-relative `--dest` would silently stage into the wrong tree;
- a missing source directory is an explicit skip result, never a silent success: the
  CLI/build entry turns it into a non-zero exit, because a build that stages zero assets
  while emitting a ceiling claim is exactly the drift class this card removes.
*/

import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_SRC_REL = "packages/core/src/postgres/migrations";

/**
 * Mirror `packages/core/src/postgres/migrations` (all files: versioned `NNNN_*.sql`,
 * `local_repair_*.sql`, and the `meta/` catalog — the runtime reads all of them) into
 * `destDir`, deleting `destDir` first.
 *
 * @param {{ repoRoot?: string, srcDir?: string, destDir: string }} opts
 * @returns {{ staged: number, skipped: null | "src-missing" }} `staged` counts the
 *   top-level entries copied; `skipped: "src-missing"` means nothing was touched because
 *   the source directory does not exist under `repoRoot`.
 */
export function stagePostgresMigrations({ repoRoot = REPO_ROOT, srcDir, destDir }) {
  const src = srcDir ?? resolve(repoRoot, DEFAULT_SRC_REL);
  if (!existsSync(src)) return { staged: 0, skipped: "src-missing" };
  rmSync(destDir, { recursive: true, force: true });
  cpSync(src, destDir, { recursive: true });
  return { staged: readdirSync(destDir).length, skipped: null };
}

/*
Build-entry CLI: `node scripts/lib/stage-postgres-migrations.mjs --dest=<path>`.
`--dest` is repo-root relative (or absolute), NOT cwd-relative — see the FNXC header.
Exits non-zero on a missing source so `tsc && node ...` fails the core build loudly.
*/
function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const destArg = argv.find((a) => a.startsWith("--dest="));
  if (!destArg) {
    stderr.write("usage: node scripts/lib/stage-postgres-migrations.mjs --dest=<repo-root-relative dir>\n");
    return 2;
  }
  const destDir = resolve(REPO_ROOT, destArg.slice("--dest=".length));
  const result = stagePostgresMigrations({ destDir });
  if (result.skipped === "src-missing") {
    stderr.write(
      `stage-postgres-migrations: source ${resolve(REPO_ROOT, DEFAULT_SRC_REL)} does not exist; ` +
        `refusing to present a built tree with no migration assets (run from a full checkout).\n`,
    );
    return 1;
  }
  stdout.write(`stage-postgres-migrations: mirrored ${result.staged} entries into ${destDir}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}

/* Exported for tests of the parse path without spawning. */
export { main, REPO_ROOT };
