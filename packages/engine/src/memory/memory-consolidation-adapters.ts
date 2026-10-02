import {
  addInferredEdges,
  loadArtifacts,
  mergeRecallGraphNodeIds,
  appendRecall,
  resolveKnowledgeGraphDir,
  runKnowledgeGraphBuild,
  runKnowledgeGraphBuildInProcess,
  KnowledgeGraphBuildOffloadUnavailableError,
  type KnowledgeGraph,
  type Settings,
} from "@fusion/core";
import { relative, resolve, sep } from "node:path";
import type { MemoryConsolidationPorts } from "./memory-consolidation.js";
import { runMemorySemanticsPass } from "./memory-semantics.js";

export type MemoryConsolidationUnavailableReason = "no-data-layer" | "no-project-id" | "no-root-dir" | "knowledge-graph-dir-unresolved";
export type MemoryConsolidationPortsResolution = { status: "ready"; projectId: string; ports: MemoryConsolidationPorts } | { status: "unavailable"; reason: MemoryConsolidationUnavailableReason };
type Deps = { taskStore: { getAsyncLayer?: () => unknown; getSettings?: () => Promise<Settings> }; rootDir: string; agentId: string; settings?: Settings };

/* FNXC:MemoryAgent 2026-08-11-09:41: This is the only memory module binding graph I/O and project configuration. Missing collaborators are successful skips, not heartbeat failures; a blank graph directory uses FN-8921's default, while .fusion is rejected because graph artifacts are committable. */
export async function resolveMemoryConsolidationPorts(deps: Deps): Promise<MemoryConsolidationPortsResolution> {
  if (!deps.rootDir) return { status: "unavailable", reason: "no-root-dir" };
  if (typeof deps.taskStore.getAsyncLayer !== "function") return { status: "unavailable", reason: "no-data-layer" };
  const layer = deps.taskStore.getAsyncLayer() as { projectId?: string } | null | undefined;
  if (!layer) return { status: "unavailable", reason: "no-data-layer" };
  if (!layer.projectId) return { status: "unavailable", reason: "no-project-id" };
  let settings = deps.settings;
  if (!settings && typeof deps.taskStore.getSettings === "function") { try { settings = await deps.taskStore.getSettings(); } catch { /* default directory remains valid */ } }
  let graphDir: string;
  try { graphDir = resolveKnowledgeGraphDir(deps.rootDir, settings?.knowledgeGraphDir); } catch { return { status: "unavailable", reason: "knowledge-graph-dir-unresolved" }; }
  const fusionDir = resolve(deps.rootDir, ".fusion"); const rel = relative(fusionDir, graphDir);
  /* FNXC:MemoryAgent 2026-08-11-10:17: Graph artifacts are committable, so the exact .fusion directory is forbidden alongside all of its children. */
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.includes(`${sep}..${sep}`))) return { status: "unavailable", reason: "knowledge-graph-dir-unresolved" };
  let latestGraph: KnowledgeGraph | undefined;
  return { status: "ready", projectId: layer.projectId, ports: {
    refreshGraph: async () => {
      /*
      FNXC:KnowledgeGraph 2026-10-02-14:05:
      This is the call site that froze the dashboard. The Memory Keeper consolidation pass runs inside the same
      Node process as the dashboard server, and its `buildKnowledgeGraph` was measured at 84.8% of that
      process for minutes at a time (83,887 of 98,927 samples), with `/api/health` answering in 3.5 s while it
      ran. The build now happens in a forked child through the same seam the HTTP rebuild uses; only the
      committed artifacts are read back, because `runSemantics` needs nodes and shipping a whole graph over
      IPC would move the memory pressure into the parent instead of removing it.

      The in-process build remains as the fallback when the child cannot be spawned at all (source checkout,
      incomplete bundle) — a slower pass is acceptable, no graph is not. If the artifacts cannot be read back,
      `latestGraph` is cleared rather than left pointing at an earlier pass, so `runSemantics` reports
      `graph-unavailable` instead of reasoning over a graph that may predate this build.
      */
      const request = { projectRoot: deps.rootDir, graphDir, force: false };
      const built = await runKnowledgeGraphBuild(request).catch((error: unknown) => {
        if (error instanceof KnowledgeGraphBuildOffloadUnavailableError) return runKnowledgeGraphBuildInProcess(request);
        throw error;
      });
      const loaded = await loadArtifacts(graphDir);
      latestGraph = loaded.ok ? loaded.graph : undefined;
      return {
        rationaleNodes: loaded.ok ? loaded.graph.nodes.filter((node) => node.kind === "rationale") : [],
        nodeCount: built.nodes,
        edgeCount: built.edges,
        changed: built.changed,
        recoveryReason: built.stats.recoveryReason,
        stats: { parsedFiles: built.stats.parsedFiles, reusedFiles: built.stats.reusedFiles, prunedFiles: built.stats.prunedFiles },
      };
    },
    runSemantics: async (graphChanged) => {
      if (!latestGraph) return { skipped: "graph-unavailable" };
      const result = await runMemorySemanticsPass({ graph: latestGraph, graphChanged, taskStore: deps.taskStore as never, agentId: deps.agentId, rootDir: deps.rootDir, write: async (proposals) => {
        const written = await addInferredEdges(graphDir, proposals);
        return {
          written: written.added,
          deduped: written.deduped,
          droppedUnresolved: written.droppedUnresolved,
        };
      } });
      return result;
    },
    appendRecall: (input) => appendRecall(layer as never, input),
    mergeRecallGraphNodeIds: (id, ids) => mergeRecallGraphNodeIds(layer as never, id, ids),
    clock: Date.now,
  } };
}
