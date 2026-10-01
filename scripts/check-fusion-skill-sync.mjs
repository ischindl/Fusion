#!/usr/bin/env node
/*
FNXC:SkillCatalogGenerationOwnership 2026-09-22-14:51:
RUFU-265. The generated skill catalog (`packages/cli/skill/fusion/**`) drifted at main tip — it
still advertised the retired `fn_task_archive` / `fn_task_unarchive` tools, repeated the whole tool
list in a stale second table, and carried a `igin/main` merge fragment — while
`node scripts/sync-fusion-skill-tools.mjs --check` exited 1 on a clean checkout, reddening every
`pnpm test` and CI shard for unrelated work.

Root cause of the *undetected* drift: `@runfusion/fusion`'s `prebuild` regenerated those tracked
files as a build side effect. CI's Gate job builds before it runs any check, so the file the check
measured had already been rewritten and the check could never fail on committed content; locally it
only left a dirty tree. `--check` was therefore structurally unable to do its job.

Decision recorded here: **generation is explicit authorship, the check is the enforcement point.**
  - regenerate after editing tool registrations: `pnpm sync:fusion-skill`
  - measure drift:                          `pnpm sync:fusion-skill:check`
  - blocking enforcement:                   this validator, appended to `test:gate:static`
Builds no longer write tracked files, so a stale committed catalog fails CI on a clean tree before
any build can overwrite it.

Deliberately NOT wired into `pretest`: the existing cache-gated call sites
(`scripts/test-changed.mjs`, `scripts/ci-test-shard.mjs`) already run the same check, and
`scripts/__tests__/verify-fast.test.mjs` pins the `pretest`↔docs validator list.
The `--check` passing-cache write stays as-is: it is gitignored and content-hash keyed over inputs
that include the generated docs themselves, so a stale catalog cannot produce a false cached pass.

This file is a thin spawn-and-propagate wrapper rather than a raw `pnpm sync:fusion-skill:check`
entry because `extractLeadingStaticGateChecks` in `scripts/run-static-gate-checks.mjs` only accepts
`node scripts/check-<name>.mjs` and breaks the contiguous validator chain on the first mismatch.
`--root <dir>` is forwarded so the same validator binary can be pointed at a fixture, which is how
the drift detector itself is proven to still detect.
*/
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

const SYNC_SCRIPT = fileURLToPath(new URL("./sync-fusion-skill-tools.mjs", import.meta.url));

/**
 * Build the child argv: always `--check` (this validator measures, it never writes), forwarding
 * only an optional `--root <dir>` so a fixture can be checked with the same binary.
 *
 * @param {string[]} argv arguments after node + script path
 * @returns {string[]}
 */
export function buildCheckArgs(argv) {
  const index = argv.indexOf("--root");
  if (index === -1) return ["--check"];
  const root = argv[index + 1];
  if (!root || root.startsWith("--")) {
    console.error("[check-fusion-skill-sync] --root requires a directory argument.");
    process.exit(2);
  }
  return ["--check", "--root", root];
}

export function main(argv = process.argv.slice(2)) {
  const result = spawnSync(process.execPath, [SYNC_SCRIPT, ...buildCheckArgs(argv)], {
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`[check-fusion-skill-sync] Failed to run the skill-doc drift check: ${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    console.error(`[check-fusion-skill-sync] Drift check was killed by signal ${result.signal}.`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
