import { beforeEach, describe, expect, it, vi } from "vitest";

/*
FNXC:KnowledgeGraph 2026-11-11-20:12 (RUFU-500):
This file used to stub `buildKnowledgeGraph`, which the consolidation lane no longer calls: since the
offload landed, `refreshGraph` goes through `runKnowledgeGraphBuild` (the forked child) and reads the
committed artifacts back with `loadArtifacts`. The stale stub is why the suite went red -- the real offloader
ran, refused the `.ts` worker of a source checkout, fell back to a real in-process build, and that build
tried to `mkdir /repo/.fusion-knowledge`. Fixing it at the shared mock rather than per assertion is the
point: the lane now has TWO build seams and one read-back seam, and every one of them is stubbed here.
`mocks.build` stays in the file as a probe: `expect(mocks.build).not.toHaveBeenCalled()` is what proves the
memory heartbeat never burns the dashboard process again.
*/
const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  offload: vi.fn(),
  inProcess: vi.fn(),
  load: vi.fn(),
  append: vi.fn(),
  merge: vi.fn(),
  resolve: vi.fn(),
  addInferred: vi.fn(),
  semantics: vi.fn(),
}));
vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    buildKnowledgeGraph: mocks.build,
    runKnowledgeGraphBuild: mocks.offload,
    runKnowledgeGraphBuildInProcess: mocks.inProcess,
    loadArtifacts: mocks.load,
    appendRecall: mocks.append,
    mergeRecallGraphNodeIds: mocks.merge,
    resolveKnowledgeGraphDir: mocks.resolve,
    addInferredEdges: mocks.addInferred,
  };
});
vi.mock("../memory/memory-semantics.js", () => ({ runMemorySemanticsPass: mocks.semantics }));
import { KnowledgeGraphBuildOffloadUnavailableError, type GraphNode } from "@fusion/core";
import { resolveMemoryConsolidationPorts } from "../memory/memory-consolidation-adapters.js";

const store = (over: Record<string, unknown> = {}) => ({ getAsyncLayer: () => ({ projectId: "project" }), getSettings: vi.fn(async () => ({})), ...over });

const rationaleNode = (id: string): GraphNode => ({
  id, kind: "rationale", name: "Memory", owner: "file", ownerPath: "src/a.ts",
  source: { path: "src/a.ts", line: 1, column: 1 }, attributes: {},
});
const artifacts = (nodes: GraphNode[]) => ({ ok: true as const, graph: { schemaVersion: 1, nodes, edges: [] }, manifest: {} as never });

/** One child-lane build summary, exactly as the forked worker reports it. */
const summary = (over: Record<string, unknown> = {}) => ({
  changed: true, nodes: 12, edges: 30,
  stats: { parsedFiles: 2, reusedFiles: 429, prunedFiles: 0, readFiles: 2, statOnlyFiles: 429, discoveredFiles: 431, cappedFiles: 0, recoveryReason: null },
  ...over,
});

describe("resolveMemoryConsolidationPorts", () => {
  beforeEach(() => {
    mocks.resolve.mockReset().mockReturnValue("/repo/.fusion-knowledge/graph");
    mocks.build.mockReset(); mocks.offload.mockReset(); mocks.inProcess.mockReset(); mocks.load.mockReset();
    mocks.append.mockReset(); mocks.merge.mockReset(); mocks.addInferred.mockReset(); mocks.semantics.mockReset();
  });
  it.each([
    ["no root", { taskStore: store(), rootDir: "", agentId: "memory" }, "no-root-dir"],
    ["no layer", { taskStore: {}, rootDir: "/repo", agentId: "memory" }, "no-data-layer"],
    ["null layer", { taskStore: store({ getAsyncLayer: () => null }), rootDir: "/repo", agentId: "memory" }, "no-data-layer"],
    ["no project", { taskStore: store({ getAsyncLayer: () => ({}) }), rootDir: "/repo", agentId: "memory" }, "no-project-id"],
  ] as const)("reports %s as an unavailable environment", async (_name, deps, reason) => {
    await expect(resolveMemoryConsolidationPorts(deps)).resolves.toEqual({ status: "unavailable", reason });
  });
  it("uses the supplied settings and forwards graph recovery reason", async () => {
    const taskStore = store();
    const resolved = await resolveMemoryConsolidationPorts({ taskStore, rootDir: "/repo", agentId: "memory", settings: { knowledgeGraphDir: ".graph" } as never });
    expect(resolved.status).toBe("ready"); if (resolved.status !== "ready") return;
    expect(taskStore.getSettings).not.toHaveBeenCalled();
    mocks.offload.mockResolvedValue(summary({ stats: { parsedFiles: 0, reusedFiles: 1, prunedFiles: 0, readFiles: 0, statOnlyFiles: 1, discoveredFiles: 1, cappedFiles: 0, recoveryReason: "inconsistent-artifact" } }));
    mocks.load.mockResolvedValue(artifacts([]));
    await expect(resolved.ports.refreshGraph()).resolves.toMatchObject({ recoveryReason: "inconsistent-artifact", nodeCount: 12 });
  });
  it("forwards distinct inferred-edge dedupe and unresolved counts to consolidation", async () => {
    const resolved = await resolveMemoryConsolidationPorts({ taskStore: store(), rootDir: "/repo", agentId: "memory" });
    expect(resolved.status).toBe("ready"); if (resolved.status !== "ready") return;
    mocks.offload.mockResolvedValue(summary());
    mocks.load.mockResolvedValue(artifacts([]));
    await resolved.ports.refreshGraph();
    mocks.addInferred.mockResolvedValue({ added: 1, deduped: 2, droppedUnresolved: 3 });
    mocks.semantics.mockImplementation(async (input: { write(proposals: unknown[]): Promise<unknown> }) => input.write([]));
    await expect(resolved.ports.runSemantics?.(true)).resolves.toEqual({ written: 1, deduped: 2, droppedUnresolved: 3 });
  });

  it("reports the read counters across the port, so a proportional pass is provable downstream", async () => {
    /*
    FNXC:KnowledgeGraph 2026-11-11-20:12 (RUFU-500):
    `reusedFiles / readFiles` is the ratio that answers "did the heartbeat pass re-read the repository?" --
    the operator-facing evidence for this whole change. A narrower port that dropped `readFiles` would keep
    the numbers true but unobtainable, so the assertion is on the value, not on its presence in a type.
    */
    const resolved = await resolveMemoryConsolidationPorts({ taskStore: store(), rootDir: "/repo", agentId: "memory" });
    expect(resolved.status).toBe("ready"); if (resolved.status !== "ready") return;
    mocks.offload.mockResolvedValue(summary());
    mocks.load.mockResolvedValue(artifacts([]));

    await expect(resolved.ports.refreshGraph()).resolves.toMatchObject({
      changed: true,
      stats: { parsedFiles: 2, reusedFiles: 429, prunedFiles: 0, readFiles: 2 },
    });
    // The lane must never reach the in-process builder on the happy path: that is the 84.8% frame returning.
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.inProcess).not.toHaveBeenCalled();
  });

  it("reads committed artifacts back for its rationale nodes rather than trusting the child's counts", async () => {
    /*
    FNXC:KnowledgeGraph 2026-11-11-20:12 (RUFU-500):
    The child answers with COUNTS only -- shipping a whole graph over IPC would move the memory pressure into
    the dashboard process instead of removing it. So `refreshGraph`'s nodes must come from `loadArtifacts`,
    and the counts from the child, which is exactly what this pair of assertions pins from opposite sides.
    */
    const resolved = await resolveMemoryConsolidationPorts({ taskStore: store(), rootDir: "/repo", agentId: "memory" });
    expect(resolved.status).toBe("ready"); if (resolved.status !== "ready") return;
    mocks.offload.mockResolvedValue(summary({ nodes: 12, edges: 30 }));
    mocks.load.mockResolvedValue(artifacts([rationaleNode("rationale:src/a.ts#Memory@x~0"), { ...rationaleNode("file:src/a.ts"), kind: "file" as const }]));

    const refreshed = await resolved.ports.refreshGraph();
    expect(refreshed.rationaleNodes.map((node) => node.id)).toEqual(["rationale:src/a.ts#Memory@x~0"]);
    expect(refreshed.nodeCount).toBe(12);
    expect(mocks.load).toHaveBeenCalledWith("/repo/.fusion-knowledge/graph");
  });

  it("clears the semantic graph when the artifacts cannot be read back, rather than reasoning over an older pass", async () => {
    /*
    FNXC:KnowledgeGraph 2026-11-11-20:12 (RUFU-500):
    A build that succeeded but whose artifacts are unreadable leaves the lane with NO trustworthy graph. The
    hazard is silence: `latestGraph` is module state that survives into the next call, so a stale reference
    would let `runSemantics` write inferred edges derived from a graph that predates the build that just
    failed. `graph-unavailable` is the honest answer.
    */
    const resolved = await resolveMemoryConsolidationPorts({ taskStore: store(), rootDir: "/repo", agentId: "memory" });
    expect(resolved.status).toBe("ready"); if (resolved.status !== "ready") return;
    mocks.offload.mockResolvedValue(summary());
    mocks.load.mockResolvedValueOnce(artifacts([rationaleNode("rationale:src/a.ts#Memory@x~0")]));
    await resolved.ports.refreshGraph();
    await expect(resolved.ports.runSemantics?.(true)).resolves.not.toEqual({ skipped: "graph-unavailable" });

    mocks.offload.mockResolvedValue(summary());
    mocks.load.mockResolvedValueOnce({ ok: false, recoveryReason: "invalid-artifact" });
    await expect(resolved.ports.refreshGraph()).resolves.toMatchObject({ rationaleNodes: [] });
    await expect(resolved.ports.runSemantics?.(true)).resolves.toEqual({ skipped: "graph-unavailable" });
  });

  it("falls back to the in-process build only when the child could not run at all", async () => {
    const resolved = await resolveMemoryConsolidationPorts({ taskStore: store(), rootDir: "/repo", agentId: "memory" });
    expect(resolved.status).toBe("ready"); if (resolved.status !== "ready") return;
    const request = { projectRoot: "/repo", graphDir: "/repo/.fusion-knowledge/graph", force: false };
    mocks.offload.mockRejectedValueOnce(new KnowledgeGraphBuildOffloadUnavailableError("worker unusable in a source checkout"));
    mocks.inProcess.mockResolvedValueOnce(summary({ nodes: 4, edges: 1 }));
    mocks.load.mockResolvedValue(artifacts([]));

    await expect(resolved.ports.refreshGraph()).resolves.toMatchObject({ nodeCount: 4, edgeCount: 1 });
    expect(mocks.inProcess).toHaveBeenCalledWith(request);

    // A genuine build error is not a placement problem: it must propagate, not quietly rebuild in-process.
    mocks.offload.mockRejectedValueOnce(new Error("graph manifest is inconsistent"));
    await expect(resolved.ports.refreshGraph()).rejects.toThrow(/manifest is inconsistent/);
    expect(mocks.inProcess).toHaveBeenCalledTimes(1);
  });

  it("rejects graph paths under .fusion", async () => {
    mocks.resolve.mockReturnValue("/repo/.fusion/graph");
    await expect(resolveMemoryConsolidationPorts({ taskStore: store(), rootDir: "/repo", agentId: "memory" })).resolves.toEqual({ status: "unavailable", reason: "knowledge-graph-dir-unresolved" });
  });
});
