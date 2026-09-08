import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractTestProjectInclude, extractTestExcludeEntries } from "../lib/vitest-config-parse.mjs";
import { evaluateEngineCoreGate, evaluatePgGate } from "../lib/engine-gate-policy.mjs";
import { readLedger } from "../check-quarantine-ledger.mjs";
import { readStaticGateChecks } from "../run-static-gate-checks.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

/*
FNXC:MergeGatePolicy 2026-09-08-11:27 (RUFU-197):
These are POLICY names, not membership mirrors. A required canary is named because of the invariant it encodes
(a transactional review handoff and the task lifecycle end-to-end), and a required unit-gate invariant is named
because its own file justifies blocking a merge on it. Both are checked as subsets of the parsed declaration, so
adding a member never reddens this guard; only silently dropping one of these does. That is the difference
between a policy statement and the frozen lists RUFU-197 deleted.
*/
const PG_REQUIRED_CANARIES = [
  "src/__tests__/postgres/handoff-to-review-atomicity.pg.test.ts",
  "src/__tests__/postgres/task-lifecycle-e2e.pg.test.ts",
];
const UNIT_GATE_INTEGRITY_INVARIANTS = [
  "task-merge.test.ts",
  "legacy-adoption.test.ts",
  "no-hardcoded-lifecycle-columns.test.ts",
  "sync-workflow-ir-callsite-allowlist.test.ts",
  "migration-wiring-integrity.test.ts",
];

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

/*
FNXC:MergeGatePolicy 2026-09-08-11:02 (RUFU-197):
The old guard mirrored production membership inside this test: an ordered 21-file engine-core allow-list, a
23-name former-PG-member list with `removedFromGate.length === 22`, a 16-entry validator list, and exact
script-string equality for `test:core`/`test:unit-gate`. Each mirror had to be edited in lockstep with the
declaration it mirrored, and the two lanes that drift most went red on unrelated days — a red policy test
hides the next real drift, so the mirrors are gone. The PG-canary exclusion check additionally read the
FIRST `exclude:` in the core config; after the 2026-09-06 deletion ratchet left only `coverage.exclude`, that
made the canary-hidden assertion pass vacuously, which the key-aware `extractTestExcludeEntries` now fixes.

What each guard checks instead: membership and lane composition are derived from the authoritative sources
(config include, package scripts, the quarantine ledger, the filesystem) and run through the pure evaluators
in `../lib/engine-gate-policy.mjs`, with non-empty floors standing in for frozen counts. `scripts/__tests__/
engine-gate-policy.test.mjs` scans this file so the mirror shapes cannot creep back.
*/

test("engine-core gate keeps a Node 24/macOS-safe Vitest pool without changing broad engine lanes", () => {
  const config = read("packages/engine/vitest.config.ts");
  const projectsIndex = config.indexOf("projects:");
  const rootTestConfig = projectsIndex === -1 ? config : config.slice(0, projectsIndex);
  const engineCoreBlock = config.match(/name:\s*"engine-core"[\s\S]*?include:\s*\[/)?.[0] ?? "";
  const engineDefaultBlock = config.match(/name:\s*"engine-default"[\s\S]*?include:\s*\[/)?.[0] ?? "";

  assert.match(
    engineCoreBlock,
    /pool:\s*"forks"/,
    "engine-core must use fork workers; thread workers abort with Node 24/macOS libuv kqueue",
  );
  assert.doesNotMatch(
    rootTestConfig,
    /pool:\s*"forks"/,
    "fork workers must not be configured at root scope because that slows the broad engine-default lane",
  );
  assert.match(
    rootTestConfig,
    /pool:\s*"threads"/,
    "root engine config must explicitly keep broad lanes on threads because Vitest 4 defaults to forks",
  );
  assert.doesNotMatch(
    engineDefaultBlock,
    /pool:\s*"forks"/,
    "engine-default must keep inheriting Vitest's default thread pool for broad src/**/*.test.ts runs",
  );
  assert.doesNotMatch(
    config,
    /NODE_NO_WARNINGS/,
    "the gate must not hide unmanaged-fd warnings by suppressing Node warnings",
  );
  assert.match(config, /maxWorkers,/, "worker budgeting must still flow through computeMaxWorkers");
  assert.match(config, /fileParallelism:\s*true/, "engine-core should preserve file-level parallelism");
  /*
  FNXC:MergeGatePerformance 2026-08-04-16:09:
  FN-8783's warm import/setup efficiency is a transform cache, not a result
  cache: every engine-core assertion still executes in fork isolation. Pin its
  project-local path so a later config edit cannot silently widen this cache to
  the broad engine lanes or replace it with stale hand-maintained artifacts.
  */
  assert.match(engineCoreBlock, /experimental:\s*\{[\s\S]*?fsModuleCache:\s*true/,
    "engine-core must retain Vitest's filesystem transform cache");
  assert.match(engineCoreBlock, /fsModuleCachePath:\s*resolve\(__dirname, "node_modules\/.engine-core-fs-module-cache"\)/,
    "engine-core transform cache must stay isolated from broad engine lanes");

  /*
  FNXC:MergeGatePolicy 2026-09-08-11:27 (RUFU-197):
  This config's own FN-8783 note instructs the guard to keep "pool, worker budgeting, file parallelism, and this
  alias intact", but the guard only covered three of those four. The @fusion/core alias is FN-7669's pre-bundled
  gate bundle — the measured lever for the lane's dominant import-phase cost — and repointing it at the ~430-file
  barrel silently multiplies gate wall time and re-breaks vi.mock interception. The alias lives in the project's
  `resolve` block above `test.name`, i.e. outside the `engineCoreBlock` slice, so it is asserted against the
  config text, where this exact alias construct occurs once. Pinned as a structural code construct (a single
  fixed alias target), never as a membership list.
  */
  assert.match(config, /alias:\s*\{\s*"@fusion\/core":\s*resolve\(__dirname, "\.\.\/core\/\.gate-bundle\/core\.mjs"\)/,
    "engine-core must keep its @fusion/core alias pointed at the pre-bundled gate bundle");
});

test("engine-core is a live allow-list: every member exists and none is quarantined", () => {
  const members = extractTestProjectInclude(read("packages/engine/vitest.config.ts"), "engine-core");
  const enginePackageRoot = path.join(repoRoot, "packages/engine");
  // Quarantine rows are repo-relative; the allow-list is engine-package-relative, so rebase before comparing.
  const quarantinedEngineFiles = ledgerQuarantined("packages/engine/");

  const { violations } = evaluateEngineCoreGate({
    members,
    fileExists: (file) => existsSync(path.join(enginePackageRoot, file)),
    quarantinedFiles: quarantinedEngineFiles,
  });
  assert.deepEqual(violations, [], "engine-core membership drifted from config + ledger + filesystem");

  // Non-vacuous floor: a reader that silently matched nothing would let the checks above pass on zero work.
  assert.ok(members.length >= 6, `engine-core lane collapsed to ${members.length} members`);
});

test("root and package gate scripts still propagate real Vitest failures", () => {
  const root = readJson("package.json");
  const engine = readJson("packages/engine/package.json");
  const core = readJson("packages/core/package.json");
  const gate = root.scripts?.["test:gate"] ?? "";

  /*
  FNXC:MergeGatePolicy 2026-09-08-11:27 (RUFU-197):
  The engine gate lane used to be pinned by exact string equality, so any deliberate flag change (a new
  reporter, a different worker budget) reddened this guard and got repaired by copying the new string in — the
  mirror added no protection and cost a repair cycle every time. The lane's MEANING is what matters: it runs
  Vitest once, pins the gate project, and stays quiet so a red gate is legible.
  */
  const engineTestCore = engine.scripts?.["test:core"] ?? "";
  assert.match(engineTestCore, /^vitest run\b/, "the engine gate lane must execute Vitest");
  assert.match(engineTestCore, /--project=engine-core\b/, "the engine lane must pin the gate project");
  assert.match(engineTestCore, /--reporter=dot\b/, "the engine gate lane must keep the compact dot reporter");
  assert.match(engineTestCore, /--silent\b/, "the engine gate lane must stay quiet on passing tests");

  // The validator inventory is derived from its own composition, so this file never re-pins membership.
  const validators = readStaticGateChecks();
  assert.ok(validators.length >= 10, `static blocking composition collapsed to ${validators.length} validators`);
  assert.equal(new Set(validators).size, validators.length, "the static validator composition must be duplicate-free");
  for (const validator of validators) {
    // The blocking chain is read-only policy checks; a lane script here would change what the gate executes.
    assert.match(validator, /^scripts\/check-[\w.-]+\.mjs$/, `static validator ${validator} breaks the read-only check-script convention`);
    assert.ok(existsSync(path.join(repoRoot, validator)), `static validator ${validator} does not exist`);
  }

  assert.match(gate, /^node scripts\/run-static-gate-checks\.mjs/);
  assert.match(gate, /pnpm --filter @fusion\/engine test:core/);
  assert.match(gate, /pnpm --filter @fusion\/core test:pg-gate/);
  assert.match(gate, /pnpm --filter @fusion\/core test:unit-gate/);
  assert.match(gate, /&& pnpm --filter @runfusion\/fusion test:ci-shape$/);

  // The blocking lanes must run in parallel and still propagate each lane's own exit status.
  for (const lane of ["engine_pid", "pg_pid", "unit_pid"]) {
    assert.match(gate, new RegExp(`wait \\$${lane} \\|\\| status=1`));
  }

  // Lane composition is a pattern, not a frozen command string; lane membership is asserted from files.
  const unitGateScript = core.scripts?.["test:unit-gate"] ?? "";
  assert.match(unitGateScript, /^vitest run\b/);
  assertGateFilesExist(unitGateScript, "packages/core");
  /*
  FNXC:MergeGatePolicy 2026-09-08-11:27 (RUFU-197):
  RUFU-148 had to repair this guard because it pinned `test:unit-gate` as one exact string: the next deliberate
  admission reddened it. These five files are each individually justified integrity invariants (merge semantics,
  the legacy-adoption census, hardcoded-lifecycle-column literals, the sync-workflow-IR call-site allow-list, and
  migration wiring), so they are required as a SUBSET: a future admission leaves this guard green, while silently
  dropping one of these invariants from the blocking lane still fails it.
  */
  const unitGateArguments = gateFileArguments(unitGateScript);
  for (const integrityInvariant of UNIT_GATE_INTEGRITY_INVARIANTS) {
    assert.ok(
      unitGateArguments.some((file) => file.endsWith(integrityInvariant)),
      `core unit gate must keep the individually justified ${integrityInvariant} invariant`,
    );
  }

  assert.doesNotMatch(gate, /NODE_NO_WARNINGS/);
  assert.doesNotMatch(root.scripts?.["test"] ?? "", /NODE_NO_WARNINGS/);
});

/*
FNXC:MergeGatePerformance 2026-07-22-15:35:
FN-8497 keeps only lifecycle and transactional-handoff PostgreSQL canaries in `test:pg-gate`: each PG file
creates or copies a real database, so putting the whole integration inventory on every PR made the sequential
merge gate take 26–45 seconds. The two names below are required because they encode the invariants the gate
exists to protect — a transactional review handoff and the task lifecycle end-to-end — not to mirror the
lane. Everything else the old guard encoded as a frozen 23-file list (and a `length === 22` count pin) is now
derived from the live postgres directory, the package script, the ledger, and the key-aware exclude reader.
*/
test("pg gate stays a narrow explicit canary lane that nothing can hide", () => {
  const core = readJson("packages/core/package.json");
  const coreConfig = read("packages/core/vitest.config.ts");
  const pgDirectory = path.join(repoRoot, "packages/core/src/__tests__/postgres");

    const requiredCanaries = PG_REQUIRED_CANARIES;
  const pgGateScript = core.scripts?.["test:pg-gate"] ?? "";
  // Parse every file argument first, then require that ALL of them are postgres PG tests. Filtering the
  // postgres-shaped ones straight out would let a non-PG file ride the PG lane unnoticed.
  const pgGateArguments = gateFileArguments(pgGateScript);
  const gateMembers = pgGateArguments.filter(
    (file) => file.startsWith("src/__tests__/postgres/") && file.endsWith(".pg.test.ts"),
  );
  assert.equal(gateMembers.length, pgGateArguments.length, "test:pg-gate may only run src/__tests__/postgres/*.pg.test.ts files");
  const discoveredPgFiles = existsSync(pgDirectory)
    ? readdirSync(pgDirectory).filter((file) => file.endsWith(".pg.test.ts")).map((file) => `src/__tests__/postgres/${file}`)
    : [];

  const { violations } = evaluatePgGate({
    requiredCanaries,
    gateMembers,
    discoveredPgFiles,
    // Key-aware on purpose: only a TEST-level exclude (or a typed const it references) can hide a canary.
    excludedPgFiles: extractTestExcludeEntries(coreConfig).filter((entry) => entry.includes("/postgres/")),
    quarantinedPgFiles: ledgerQuarantined("packages/core/").filter((entry) => entry.includes("/postgres/")),
  });
  assert.deepEqual(violations, [], "PG canary lane drifted from package script + config + ledger + filesystem");

  // Non-vacuous floors replacing the frozen count: the lane is real, and it stays narrower than discovery.
  assert.ok(gateMembers.length >= 1, "test:pg-gate selected no canary");
  assert.ok(discoveredPgFiles.length > gateMembers.length, "the PG blocking lane no longer excludes any discovered PG test");

  assert.match(core.scripts?.test ?? "", /^vitest run\b/, "the non-blocking core lane must execute Vitest");
  assert.doesNotMatch(core.scripts?.test ?? "", /\s(?:--exclude|--include)\b/, "the non-blocking core lane must not narrow discovery");
  assert.match(coreConfig, /include:\s*\["src\/\*\*\/\*.test\.ts"\]/, "the default core config must discover PG tests");
});

/** Concrete test-file arguments a vitest `run <files...>` lane script names. */
function gateFileArguments(script) {
  return script.match(/(?:^|\s)(src\/\S+\.test\.tsx?)(?=\s|$)/g)?.map((entry) => entry.trim()) ?? [];
}

/** Every test file a lane names must exist on disk, and the lane must name at least one. */
function assertGateFilesExist(script, packageDir) {
  const files = gateFileArguments(script);
  assert.ok(files.length >= 1, `gate lane named no test file: ${script.slice(0, 60)}...`);
  for (const file of files) {
    assert.ok(existsSync(path.join(repoRoot, packageDir, file)), `gate lane names a missing file: ${packageDir}/${file}`);
  }
}

/** Quarantine ledger rows for one package, rebased to that package's config-relative paths. */
function ledgerQuarantined(packagePrefix) {
  const ledger = readLedger(path.join(repoRoot, "scripts/lib/test-quarantine.json"));
  return (Array.isArray(ledger?.entries) ? ledger.entries : [])
    .map((entry) => String(entry?.file ?? ""))
    .filter((file) => file.startsWith(packagePrefix))
    .map((file) => file.slice(packagePrefix.length));
}
