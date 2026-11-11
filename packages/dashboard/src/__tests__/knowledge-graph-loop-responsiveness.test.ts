/*
FNXC:KnowledgeGraph 2026-11-11-20:12 (RUFU-500):
THE symptom-acceptance test for "a knowledge-graph rebuild must not starve the board".

The measured original symptom (2026-10-02, production dashboard process, one board tab open):
`buildKnowledgeGraph` held 84.8% of the process (83,887 of 98,927 samples) for minutes, while
`/api/health` answered in 3.54 s / 1.67 s / 0.97 s. The dashboard server and the engine are one Node
process, so a build that saturates that process IS the frozen board.

This file asserts the property in the units that matter to the board, without needing a live server: how far
the parent's 10 ms timer drifts while a build of the same size runs.

  * CHILD LANE (what ships in a published install): the build burns ~500 ms of CPU in a forked child, and the
    parent loop must stay responsive -- maximum tick gap under 150 ms.
  * IN-PROCESS LANE (the paired CONTROL): the identical burn through `runKnowledgeGraphBuildInProcess` must
    blow past that bound. That control is the ratchet. Without it, reverting the offload would keep this
    suite green while the board silently froze again.

Why the control injects its burn instead of building a bigger fixture: a real in-process no-op pass over a
1500-file fixture was measured (2026-11-11) to stall a 10 ms tick by at most 57 ms -- under any bound wide
enough to be non-flaky. A fixture-sized burn cannot demonstrate the failure mode, so the burn is injected
through the builder's own IO seam and the assertion measures the LOOP, not the fixture.

Stated bounds, deliberately wide and not tuned to a measured number: BURN_MS is roughly the shortest stretch
a real pass spends in one synchronous phase, and BOUND_MS (150 ms) sits 3x below it, so the child lane passes
with a wide margin and the control fails with a wide margin. If the child assertion ever proves flaky,
quarantine this file (`scripts/lib/test-quarantine.json` plus its vitest `exclude`) rather than widening
BOUND_MS or adding retries.
*/
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const BURN_MS = 500;
const TICK_MS = 10;
const BOUND_MS = 150;

/**
 * Filled in by `beforeAll`: a `vi.mock` factory runs during this file's import phase, before any module-level
 * `const` below has initialised, so everything the factory needs lives on this hoisted object instead.
 */
const seams = vi.hoisted(() => ({ workerPath: "", timeoutMs: 20_000 }));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    /*
    Only the worker LOCATION is redirected, to a test-owned script. The offloader itself, its fork, its IPC
    protocol and its timeout all run for real, because that machinery is what keeps the parent's loop free.
    A source checkout legitimately resolves a `.ts` worker sibling it must never fork, so the location has to
    be named here for the child lane to exist at all under vitest.
    */
    runKnowledgeGraphBuild: (options: object) =>
      actual.runKnowledgeGraphBuild({ ...options, workerPath: seams.workerPath, canUseWorker: () => true, timeoutMs: seams.timeoutMs }),
  };
});

import { runKnowledgeGraphBuildInProcess } from "@fusion/core";
import { __resetKnowledgeGraphCacheForTests, rebuildProjectKnowledgeGraph } from "../knowledge-graph-access.js";

/**
 * A stand-in for `build-worker.js` with a known synchronous cost. It obeys the real protocol -- answer the
 * `build` message once, then exit -- and reports back how long it actually burned, which is what makes the
 * child-side assertion above non-vacuous.
 */
function workerSource(): string {
  return [
    "process.on(\"message\", () => {",
    `  const started = Date.now();`,
    `  while (Date.now() - started < ${BURN_MS}) { /* synchronous CPU burn: what a real graph build is */ }`,
    "  const burned = Date.now() - started;",
    "  process.send({ kind: \"result\", changed: true, nodes: 1, edges: 0, stats: {",
    "    parsedFiles: 1, reusedFiles: 0, prunedFiles: 0, addedFiles: 1, deletedFiles: 0,",
    "    discoveredFiles: 1, readFiles: 1, statOnlyFiles: 0, cappedFiles: 0,",
    "    synthesizedImportEdges: 0, derivedModuleCount: 0, recoveryReason: null, burnMs: burned,",
    "  } });",
    "  process.exit(0);",
    "});",
    "",
  ].join("\n");
}

const roots: string[] = [];
let workerDir = "";

async function fixtureProject(name: string): Promise<{ projectRoot: string; graphDir: string }> {
  const projectRoot = await mkdtemp(join(tmpdir(), `kg-loop-${name}-`));
  roots.push(projectRoot);
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(projectRoot, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(projectRoot, "src", "b.ts"), "import { a } from './a';\nexport const b = a;\n");
  return { projectRoot, graphDir: join(projectRoot, ".fusion-knowledge/graph") };
}

/** Worst drift of a 10 ms parent timer while `run` is in flight, plus the value `run` produced. */
async function measureParentLoop<T>(run: () => Promise<T>): Promise<{ value: T; maxGapMs: number; ticks: number }> {
  const gaps: number[] = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
  }, TICK_MS);
  let value: T;
  try {
    value = await run();
    // Let the tick that closes a synchronous stretch actually fire before reading the samples.
    await new Promise((resolve) => setTimeout(resolve, TICK_MS * 3));
  } finally {
    clearInterval(timer);
  }
  return { value, maxGapMs: gaps.length ? Math.max(...gaps) : Number.POSITIVE_INFINITY, ticks: gaps.length };
}

beforeAll(async () => {
  workerDir = await mkdtemp(join(tmpdir(), "kg-loop-worker-"));
  seams.workerPath = join(workerDir, "knowledge-graph-worker.js");
  await writeFile(seams.workerPath, workerSource());
});

beforeEach(() => { __resetKnowledgeGraphCacheForTests(); });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  __resetKnowledgeGraphCacheForTests();
});

afterAll(async () => { if (workerDir) await rm(workerDir, { recursive: true, force: true }); });

describe("knowledge-graph rebuild loop responsiveness", () => {
  it("keeps the dashboard loop responsive while an offloaded build burns its CPU in a child", async () => {
    const { projectRoot, graphDir } = await fixtureProject("child");
    const store = { getRootDir: () => projectRoot, getSettings: async () => ({ knowledgeGraphDir: graphDir }) };

    const loop = await measureParentLoop(() => rebuildProjectKnowledgeGraph(store as never, {}));

    // ANTI-VACUITY: the burn has to be proven to have happened, or "the parent never blocked" is trivially
    // true -- a child that died instantly would leave the loop looking perfect.
    const burnMs = (loop.value.stats as unknown as { burnMs?: number }).burnMs ?? 0;
    expect(burnMs).toBeGreaterThanOrEqual(BURN_MS * 0.9);
    expect(loop.value.nodes).toBe(1);

    // ~50 ticks are due across a 500 ms wait; a starved parent would land far fewer and much further apart.
    expect(loop.ticks).toBeGreaterThan(10);
    expect(loop.maxGapMs).toBeLessThan(BOUND_MS);
  }, 30_000);

  it("CONTROL: starves the same loop when the identical burn runs in-process", async () => {
    // The lane the dashboard falls back to, and the lane a source checkout always takes. If the offload is
    // ever removed, this is the assertion that keeps the regression visible: same burn, same bound, starvation.
    const { projectRoot, graphDir } = await fixtureProject("control");
    let burnedMs = 0;
    let burnt = false;

    const burnOnceStat = async (path: string): Promise<{ size: number; mtimeMs: number }> => {
      const { stat } = await import("node:fs/promises");
      const info = await stat(path);
      if (!burnt) {
        burnt = true;
        const started = Date.now();
        while (Date.now() - started < BURN_MS) { /* synchronous CPU burn, same shape as the child's */ }
        burnedMs = Date.now() - started;
      }
      return { size: info.size, mtimeMs: info.mtimeMs };
    };

    const loop = await measureParentLoop(() => runKnowledgeGraphBuildInProcess(
      { projectRoot, graphDir, force: false },
      { discovery: { sourceRoots: ["src"], markdownRoots: [] }, deps: { stat: burnOnceStat } },
    ));

    // ANTI-VACUITY: the burn must have run, otherwise this says nothing about the in-process lane.
    expect(burnedMs).toBeGreaterThanOrEqual(BURN_MS * 0.9);
    expect(loop.ticks).toBeGreaterThan(0);
    // The paired assertion to the test above: `>` rather than `<`, same burn, same bound, opposite verdict.
    expect(loop.maxGapMs).toBeGreaterThan(BOUND_MS);
  }, 30_000);
});
