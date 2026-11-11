import { beforeEach, describe, expect, it, vi } from "vitest";

const build = vi.hoisted(() => vi.fn().mockResolvedValue({
  graph: { nodes: [], edges: [] },
  changed: false,
  // RUFU-500: the build stats gained required read counters; this fixture states them rather than omitting them.
  stats: {
    parsedFiles: 1,
    reusedFiles: 0,
    prunedFiles: 0,
    addedFiles: 1,
    deletedFiles: 0,
    discoveredFiles: 1,
    readFiles: 1,
    statOnlyFiles: 0,
    cappedFiles: 0,
    synthesizedImportEdges: 2,
    derivedModuleCount: 0,
    recoveryReason: null,
  },
}));
const close = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const settings = vi.hoisted(() => vi.fn().mockResolvedValue({ knowledgeGraphDir: ".graph" }));
const resolveProject = vi.hoisted(() => vi.fn().mockResolvedValue({
  projectPath: "/project",
  store: { getSettings: settings },
}));

class TestLockRetryExhaustedError extends Error {}

vi.mock("@fusion/core", () => ({
  buildKnowledgeGraph: build,
  resolveKnowledgeGraphDir: (root: string, dir?: string) =>
    `${root}/${dir ?? ".fusion-knowledge/graph"}`,
}));
vi.mock("../project-context.js", () => ({
  resolveProject,
  closeProjectStore: close,
  createLocalStore: vi.fn(),
  asLocalProjectContext: vi.fn(),
}));
vi.mock("../lock-retry.js", () => ({
  retryOnLock: (run: () => unknown) => run(),
  LockRetryExhaustedError: TestLockRetryExhaustedError,
}));

const { runKnowledgeGraphBuild } = await import("../commands/knowledge-graph.js");

describe("knowledge graph CLI command", () => {
  beforeEach(() => {
    build.mockReset().mockResolvedValue({
      graph: { nodes: [], edges: [] },
      changed: false,
      stats: {
        parsedFiles: 1,
        reusedFiles: 0,
        prunedFiles: 0,
        addedFiles: 1,
        deletedFiles: 0,
        discoveredFiles: 1,
        readFiles: 1,
        statOnlyFiles: 0,
        cappedFiles: 0,
        synthesizedImportEdges: 2,
        derivedModuleCount: 0,
        recoveryReason: null,
      },
    });
    close.mockClear();
    settings.mockReset().mockResolvedValue({ knowledgeGraphDir: ".graph" });
    resolveProject.mockClear();
  });

  it("uses an explicit directory over settings and emits complete JSON", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runKnowledgeGraphBuild({ dir: ".custom", json: true });

    expect(build).toHaveBeenCalledWith(expect.objectContaining({ graphDir: "/project/.custom" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({
      recoveryReason: null,
      synthesizedImportEdges: 2,
      changed: false,
    });
    output.mockRestore();
  });

  it("uses the setting before the default directory", async () => {
    await runKnowledgeGraphBuild();
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ graphDir: "/project/.graph" }));
  });

  it("reports all operator-facing build counters in human output", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    build.mockResolvedValueOnce({
      graph: { nodes: [{}, {}], edges: [{}] },
      changed: true,
      stats: { parsedFiles: 2, reusedFiles: 3, prunedFiles: 4, addedFiles: 2, deletedFiles: 4, discoveredFiles: 431, readFiles: 2, statOnlyFiles: 429, cappedFiles: 0, synthesizedImportEdges: 5, derivedModuleCount: 6, recoveryReason: "forced" },
    });

    await runKnowledgeGraphBuild();

    expect(output).toHaveBeenCalledWith(expect.stringContaining("pruned 4"));
    expect(output).toHaveBeenCalledWith(expect.stringContaining("synthesized imports 5"));
    expect(output).toHaveBeenCalledWith(expect.stringContaining("derived modules 6"));
    expect(output).toHaveBeenCalledWith(expect.stringContaining("recovery=forced"));
    /*
    FNXC:KnowledgeGraph 2026-11-11-20:12 (RUFU-500):
    The read ratio is the operator-visible proof that an incremental pass was proportional. `reused 3` alone
    could not distinguish a 2-read pass from a 431-read pass, which is exactly the ambiguity that let the
    whole-tree re-read survive unnoticed.
    */
    expect(output).toHaveBeenCalledWith(expect.stringContaining("read 2/431 (stat-only 429)"));
    // An ordinary pass reports nothing about the ceiling: a permanent `capped 0` would dilute the warning.
    expect(output.mock.calls[0]![0]).not.toContain("capped");
    output.mockRestore();
  });

  it("warns in human output when the discovery ceiling truncated the walk", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    build.mockResolvedValueOnce({
      graph: { nodes: [{}], edges: [] },
      changed: true,
      stats: { parsedFiles: 1, reusedFiles: 0, prunedFiles: 0, addedFiles: 1, deletedFiles: 0, discoveredFiles: 25000, readFiles: 1, statOnlyFiles: 0, cappedFiles: 913, synthesizedImportEdges: 0, derivedModuleCount: 0, recoveryReason: null },
    });

    await runKnowledgeGraphBuild();

    // A truncated walk is a graph-completeness warning, so it must be named, not silently dropped.
    expect(output).toHaveBeenCalledWith(expect.stringContaining("capped 913"));
    output.mockRestore();
  });

  it("closes the store when the settings retry is exhausted", async () => {
    settings.mockRejectedValueOnce(new TestLockRetryExhaustedError("locked"));

    await expect(runKnowledgeGraphBuild()).rejects.toThrow("locked");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the store when building fails", async () => {
    build.mockRejectedValueOnce(new Error("failed"));

    await expect(runKnowledgeGraphBuild()).rejects.toThrow("failed");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
