// @vitest-environment node

/*
FNXC:RetentionCensus 2026-09-23-11:30 (RUFU-257):
This is the recurrence lock for the surfaces RUFU-257 already guarded. The leak was not unfixable, it was
unattributable — seven OOM deaths of the dashboard server with nothing able to say which structure held
the heap — and every one of the bounded caches would have been un-bounded again by the next refactor that
dropped its registration without anyone noticing.

Two claims have to stay true at once, and neither one is visible from inside the other:
  - the generated inventory (`scripts/lib/retention-inventory.mjs`) says a structure is bounded, and
  - the running census (`lib/retention-census.ts`) actually holds a probe with a named ceiling for it.
The static ratchet in `scripts/check-retention-coverage.mjs` proves the first against the source; this
file proves the second against the first, so an id that was renamed, a registration that was deleted, or
a ceiling that was dropped fails here rather than at 03:12 in the crash log.

These cases read the generated inventory and the structural scanner from `scripts/` on purpose: the
dashboard must not keep a second hand-written list of what is bounded. The list of bounded things is the
code, and the only honest way to check a claim about it is to re-derive it.
*/

import { describe, expect, it, vi } from "vitest";
import path from "node:path";

import { listRetentionSourceIds, retentionCensusSnapshot } from "../lib/retention-census.js";

/*
FNXC:RetentionCensus 2026-09-23-11:45 (RUFU-257):
The picker caches import their discovery probes from `runtime-provider-probes.js`, which re-exports the
runtime plugins (`@fusion-plugin-examples/*-runtime`). Those plugin dists are not built in every lane, so
importing the real module fails here for a reason that has nothing to do with retention. Mocking the
probes is the pattern `cursor-model-cache.test.ts` already uses, and it is sound for this test: it reads
the census registrations the cache modules make at load time, never their discovery behavior.
*/
vi.mock("../runtime-provider-probes.js", () => ({
  discoverAntigravityCliModels: vi.fn(async () => ({ models: [] })),
  discoverClaudeCliModels: vi.fn(async () => ({ models: [] })),
  discoverCursorCliModels: vi.fn(async () => ({ models: [] })),
  discoverGrokCliModels: vi.fn(async () => ({ models: [] })),
  discoverOmpCliModels: vi.fn(async () => ({ models: [] })),
  listHermesProviderProfiles: vi.fn(async () => []),
}));

const repoRoot = path.resolve(__dirname, "../../../..");

interface InventoryEntry {
  file: string;
  line: number;
  name: string;
  kind: "Map" | "Set";
  classification: string;
  sources: string[];
  ceilingConstant: string | null;
  justification: string | null;
  expiryEvidence: string[];
}

interface RetentionChecker {
  scanModuleScopeCollections: (options: { root: string; pathPrefix?: string }) => Array<{
    file: string;
    line: number;
    name: string;
    kind: "Map" | "Set";
    source: string;
  }>;
  classifyDeclaration: (declaration: unknown) => InventoryEntry;
  diffInventory: (input: { entries: InventoryEntry[]; inventory: InventoryEntry[] }) => string[];
  CLASS_CENSUS_REGISTERED: string;
}

interface RetentionInventoryModule {
  RETENTION_INVENTORY: InventoryEntry[];
}

// The checker and its generated inventory live in `scripts/` and are plain ESM; importing them keeps the
// dashboard from holding a second, hand-maintained copy of the same list.
const loadChecker = (): Promise<RetentionChecker> =>
  import("../../../../scripts/check-retention-coverage.mjs") as unknown as Promise<RetentionChecker>;
const loadInventory = (): Promise<RetentionInventoryModule> =>
  import("../../../../scripts/lib/retention-inventory.mjs") as unknown as Promise<RetentionInventoryModule>;

/*
FNXC:RetentionCensus 2026-09-23-12:05 (RUFU-257):
Loading an owning module is what registers its census rows, so this import block is the fixture for the
runtime half of the lock. It is written out rather than derived at runtime because a derived dynamic-load
loop pushes every module through the transform pipeline inside one `beforeAll` and blows the hook budget;
static imports are transformed once, in parallel, and stay inside the file's own budget.

The cost of a written-out list is that it can go stale, so `EXPECTED_INVENTORY_OWNERS` below pins the
inventory's owner set against it: a module that starts registering a bounded structure without appearing
here fails this file with the owning path, which is the intended friction of a recurrence lock.
*/
import "../agent-generation.js";
import "../agent-onboarding.js";
import "../ai-refine.js";
import "../ai-task-search.js";
import "../ai-translate.js";
import "../antigravity-model-cache.js";
import "../chat.js";
import "../claude-model-cache.js";
import "../cursor-model-cache.js";
import "../grok-model-cache.js";
import "../hermes-model-cache.js";
import "../knowledge-graph-access.js";
import "../lib/codebase-metrics.js";
import "../milestone-slice-interview.js";
import "../mission-interview.js";
import "../omp-model-cache.js";
import "../planning.js";
import "../remote-auth.js";
import "../report-pipeline.js";
import "../routes/register-git-github.js";
import "../routes/register-session-diff-routes.js";
import "../routes/register-voice-routes.js";
import "../routes/register-workflow-routes.js";
import "../terminal-service.js";
import "../view-chunk-manifest.js";

/** Every module the generated inventory says owns a census-registered structure. */
const EXPECTED_INVENTORY_OWNERS = [
  "packages/dashboard/src/agent-generation.ts",
  "packages/dashboard/src/agent-onboarding.ts",
  "packages/dashboard/src/ai-refine.ts",
  "packages/dashboard/src/ai-task-search.ts",
  "packages/dashboard/src/ai-translate.ts",
  "packages/dashboard/src/antigravity-model-cache.ts",
  "packages/dashboard/src/chat.ts",
  "packages/dashboard/src/claude-model-cache.ts",
  "packages/dashboard/src/cursor-model-cache.ts",
  "packages/dashboard/src/grok-model-cache.ts",
  "packages/dashboard/src/hermes-model-cache.ts",
  "packages/dashboard/src/knowledge-graph-access.ts",
  "packages/dashboard/src/lib/codebase-metrics.ts",
  "packages/dashboard/src/milestone-slice-interview.ts",
  "packages/dashboard/src/mission-interview.ts",
  "packages/dashboard/src/omp-model-cache.ts",
  "packages/dashboard/src/planning.ts",
  "packages/dashboard/src/remote-auth.ts",
  "packages/dashboard/src/report-pipeline.ts",
  "packages/dashboard/src/routes/register-git-github.ts",
  "packages/dashboard/src/routes/register-session-diff-routes.ts",
  "packages/dashboard/src/routes/register-voice-routes.ts",
  "packages/dashboard/src/routes/register-workflow-routes.ts",
  "packages/dashboard/src/terminal-service.ts",
  "packages/dashboard/src/view-chunk-manifest.ts",
].sort();

describe("retention coverage ratchet", () => {
  it("matches a fresh structural scan of the dashboard server", async () => {
    const checker = await loadChecker();
    const { RETENTION_INVENTORY: inventory } = await loadInventory();

    const declarations = checker.scanModuleScopeCollections({
      root: path.join(repoRoot, "packages", "dashboard", "src"),
      pathPrefix: "packages/dashboard/src",
    });
    const entries = declarations.map((declaration) => checker.classifyDeclaration(declaration));
    const drift = checker.diffInventory({ entries, inventory });

    expect(drift).toEqual([]);
  });

  it("claims coverage for a subject set the ratchet can still see", async () => {
    const { RETENTION_INVENTORY: inventory } = await loadInventory();
    const censusRegistered = inventory.filter((entry) => entry.classification === "census-registered");

    expect(inventory.length).toBeGreaterThanOrEqual(60);
    expect(censusRegistered.length).toBeGreaterThanOrEqual(15);
    expect(inventory.filter((entry) => entry.classification === "unclassified")).toEqual([]);
  });

  it("names an owner module here for every module the inventory says registers something", async () => {
    const { RETENTION_INVENTORY: inventory } = await loadInventory();
    const owners = [...new Set(inventory.filter((entry) => entry.classification === "census-registered").map((entry) => entry.file))].sort();

    expect(owners).toEqual(EXPECTED_INVENTORY_OWNERS);
  });

  it("keeps every census-registered claim resolvable in the running census", async () => {
    const { RETENTION_INVENTORY: inventory } = await loadInventory();
    const liveIds = new Set(listRetentionSourceIds());
    const claimed = inventory.filter((entry) => entry.classification === "census-registered");

    expect(claimed.length).toBeGreaterThan(0);
    for (const entry of claimed) {
      expect(entry.sources, `${entry.file} ${entry.name} claims census coverage with no id`).toHaveLength(1);
      expect(
        liveIds.has(entry.sources[0]!),
        `${entry.file} ${entry.name} is registered as "${entry.sources[0]}" but that id is not in the running census`,
      ).toBe(true);
    }
  });

  it("reports a live ceiling for every ceiling the inventory names", async () => {
    const { RETENTION_INVENTORY: inventory } = await loadInventory();
    const rows = new Map(retentionCensusSnapshot().sources.map((row) => [row.id, row]));

    for (const entry of inventory.filter((candidate) => candidate.classification === "census-registered")) {
      const row = rows.get(entry.sources[0]!);
      expect(row, `census row for "${entry.sources[0]}" is missing`).toBeDefined();
      expect(row!.ceilingConstant, `${entry.file} ${entry.name} names no ceiling at runtime`).toBe(entry.ceilingConstant);
      expect(row!.ceiling).toBeGreaterThan(0);
    }
  });
});
