import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/*
FNXC:SkillCatalogGenerationOwnership 2026-09-22-14:51:
RUFU-265. The generated skill catalog drifted at main tip (retired `fn_task_archive` /
`fn_task_unarchive` rows, a duplicated legacy two-column tool table, and an `igin/main` merge
fragment) while `--check` reddened every clean checkout, because `@runfusion/fusion`'s `prebuild`
regenerated those tracked docs and CI's Gate job builds before checking — so the check could never
fail on committed content.

Generation is now explicit (`pnpm sync:fusion-skill`) and `scripts/check-fusion-skill-sync.mjs` is
the blocking enforcement point. That inversion only holds if the detector genuinely detects, which
a green real-tree check cannot prove on its own. These tests therefore exercise the real sync script
and the real validator against a tampered fixture root (`--root`), then assert the exact three-part
defect cannot return in the committed file.
*/

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const SYNC_SCRIPT = join(repoRoot, "scripts", "sync-fusion-skill-tools.mjs");
const VALIDATOR = join(repoRoot, "scripts", "check-fusion-skill-sync.mjs");
const CAPABILITIES_REL = "packages/cli/skill/fusion/references/fusion-capabilities.md";

/** Import the generator module for its exported input list (importing does not run the sync). */
const { SKILL_SYNC_INPUT_PATHS } = await import(SYNC_SCRIPT);

const TABLE_HEADER = "| Tool | Availability | Purpose |";
const LEGACY_HEADER = "| Tool | Purpose |";

function runNode(args) {
  return spawnSync(process.execPath, args, { encoding: "utf8", cwd: repoRoot });
}

/** Copy every declared sync input into a throwaway root that mirrors the repo layout. */
function createFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "fusion-skill-catalog-"));
  for (const relPath of SKILL_SYNC_INPUT_PATHS) {
    const target = join(root, relPath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repoRoot, relPath), target);
  }
  /*
  FNXC:SkillCatalogGenerationOwnership 2026-09-22-14:51:
  The passing-cache hash (scripts/lib/content-hash.mjs `computeContentHash`) reads index blob SHAs
  and working-tree status with `git -C <root>`, so the cache write only happens for a root that is a
  repository. Initialise one — with an empty template so no host hooks run — to exercise the
  root-scoped cache end to end rather than relying on its try/catch swallowing the failure.
  */
  const git = (args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${capturedOutput(result)}`);
  };
  git(["init", "-q", "--template=", "--initial-branch=main"]);
  git(["add", "-A"]);
  git(["-c", "user.name=skill-sync-fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--no-verify", "-m", "fixture"]);
  return root;
}

/** Cache file the passing-check optimisation writes, resolved under `root`. */
function skillSyncCacheFile(root) {
  return join(root, "node_modules", ".cache", "fusion", "skill-sync-cache.json");
}

/**
 * Corrupt exactly one generated row inside the BEGIN/END markers of the fixture's capabilities
 * table, simulating a tool description edited in the source of truth without regenerating docs.
 */
function tamperCapabilitiesTable(root, toolName = "fn_task_list") {
  const path = join(root, CAPABILITIES_REL);
  const lines = readFileSync(path, "utf8").split("\n");
  const index = lines.findIndex((line) => line.startsWith(`| \`${toolName}\` |`));
  assert.ok(index !== -1, `fixture capabilities table is missing the ${toolName} row to tamper with`);
  const before = lines.join("\n");
  lines[index] = `${lines[index]} TAMPERED-STALE-DESCRIPTION`;
  writeFileSync(path, lines.join("\n"));
  return { path, before };
}

function capturedOutput(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

test("a stale generated catalog fails the real --check and names the drifted artifact", () => {
  const root = createFixtureRoot();
  try {
    const { path, before } = tamperCapabilitiesTable(root);
    assert.notEqual(readFileSync(path, "utf8"), before, "fixture tampering must actually change the file");

    const check = runNode([SYNC_SCRIPT, "--check", "--root", root]);
    assert.notEqual(check.status, 0, "--check must fail on a stale committed catalog");
    assert.match(capturedOutput(check), /fusion-capabilities\.md tool table/);

    // The blocking gate entry point must surface the same cause, not a generic failure.
    const validator = runNode([VALIDATOR, "--root", root]);
    assert.notEqual(validator.status, 0, "the gate validator must propagate drift as a non-zero exit");
    assert.match(capturedOutput(validator), /fusion-capabilities\.md tool table/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit generation heals the fixture and is idempotent", () => {
  const root = createFixtureRoot();
  try {
    const { path } = tamperCapabilitiesTable(root);
    assert.notEqual(runNode([SYNC_SCRIPT, "--check", "--root", root]).status, 0);

    const generated = runNode([SYNC_SCRIPT, "--root", root]);
    assert.equal(generated.status, 0, capturedOutput(generated));
    assert.match(capturedOutput(generated), /Updated 1 file\(s\)/);

    // --check is silent on success; exit status is its only pass signal.
    const healed = runNode([SYNC_SCRIPT, "--check", "--root", root]);
    assert.equal(healed.status, 0, capturedOutput(healed));

    // Re-running generation must be a no-op: identical bytes and no claimed update.
    const bytesAfterFirstGeneration = readFileSync(path, "utf8");
    const regenerated = runNode([SYNC_SCRIPT, "--root", root]);
    assert.match(capturedOutput(regenerated), /up to date/);
    assert.equal(readFileSync(path, "utf8"), bytesAfterFirstGeneration, "generation must be idempotent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a --check pass is cached against the fixture root, never the real repository", () => {
  const realCache = skillSyncCacheFile(repoRoot);
  const readRealCache = () => (existsSync(realCache) ? readFileSync(realCache, "utf8") : null);
  const realCacheBefore = readRealCache();
  const root = createFixtureRoot();
  try {
    assert.equal(runNode([SYNC_SCRIPT, "--check", "--root", root]).status, 0);
    assert.ok(
      existsSync(skillSyncCacheFile(root)),
      "a fixture --check must record its passing cache inside the resolved --root, not the default root",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  assert.equal(readRealCache(), realCacheBefore, "a fixture run must not write a passing entry for the real repo root");
});

test("--check exits 0 against this repository's real tree", () => {
  const check = runNode([SYNC_SCRIPT, "--check"]);
  assert.equal(check.status, 0, `real-tree drift returned:\n${capturedOutput(check)}`);
});

/*
FNXC:SkillCatalogGenerationOwnership 2026-09-22-14:51:
RUFU-265 symptom assertion. Three concrete orphans were committed inside the generated block at the
base commit; pinning their absence — plus the single-header invariant — is what stops the exact
three-part defect (retired rows, duplicated legacy table, merge residue) from silently returning.
*/
test("the committed capabilities catalog is free of the three-part generated-block defect", () => {
  const content = readFileSync(join(repoRoot, CAPABILITIES_REL), "utf8");
  const begin = content.indexOf("<!-- BEGIN: fusion-capabilities-tool-table");
  const end = content.indexOf("<!-- END: fusion-capabilities-tool-table");
  assert.ok(begin !== -1 && end > begin, "capabilities tool table must keep its generated markers");
  const block = content.slice(begin, end);

  assert.equal(block.split("\n").filter((line) => line === TABLE_HEADER).length, 1);
  assert.ok(!block.includes(LEGACY_HEADER), "a second legacy two-column tool table must not come back");
  assert.ok(!block.includes("fn_task_archive"), "the retired archive tool must not be advertised");
  assert.ok(!block.includes("fn_task_unarchive"), "the retired unarchive tool must not be advertised");
  assert.ok(!block.includes("igin/main"), "merge-residue must not survive in the generated block");

  const rows = block.split("\n").filter((line) => line.startsWith("| `fn_"));
  assert.ok(rows.length > 50, `expected a populated tool table, saw ${rows.length} rows`);
});
