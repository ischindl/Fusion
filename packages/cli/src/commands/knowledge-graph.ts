import {
  buildKnowledgeGraph,
  resolveKnowledgeGraphDir,
  type ProjectSettings,
} from "@fusion/core";
import {
  asLocalProjectContext,
  closeProjectStore,
  createLocalStore,
  resolveProject,
  type ProjectContext,
} from "../project-context.js";
import { retryOnLock } from "../lock-retry.js";

export interface KnowledgeGraphBuildOptions {
  projectName?: string;
  force?: boolean;
  dir?: string;
  json?: boolean;
}

/**
 * FNXC:CliBoardMutation 2026-08-10-11:28:
 * The graph command resolves a project store solely to read its configured artifact directory.
 * Always close that store before returning or propagating an error so the FN-7739 handle-leak
 * class cannot keep a one-shot CLI process alive after a settings retry or graph build failure.
 */
export async function runKnowledgeGraphBuild(
  options: KnowledgeGraphBuildOptions = {},
): Promise<void> {
  let context: ProjectContext | undefined;

  try {
    try {
      context = await resolveProject(options.projectName);
    } catch {
      const store = await createLocalStore(process.cwd());
      context = asLocalProjectContext(store);
    }

    const activeContext = context;
    if (!activeContext) throw new Error("Knowledge graph project context was not resolved");

    const settings = await retryOnLock(
      () => activeContext.store.getSettings(),
      { id: "knowledge-graph-settings", action: "read settings" },
    ) as ProjectSettings;
    const graphDir = resolveKnowledgeGraphDir(
      activeContext.projectPath,
      options.dir ?? settings.knowledgeGraphDir,
    );
    const result = await buildKnowledgeGraph({
      projectRoot: activeContext.projectPath,
      graphDir,
      force: options.force,
    });
    const output = {
      ...result.stats,
      changed: result.changed,
      nodes: result.graph.nodes.length,
      edges: result.graph.edges.length,
    };

    if (options.json) {
      console.log(JSON.stringify(output));
      return;
    }

    const recovery = output.recoveryReason ? `; recovery=${output.recoveryReason}` : "";
    /*
    FNXC:KnowledgeGraph 2026-11-11-20:12 (RUFU-500):
    The read counters are printed here because this command is the operator's only tool for answering "did that
    pass do proportional work, or did it re-read the tree?" -- `reused` alone cannot tell those apart, since a
    pass that read every file and a pass that read none both reuse everything. `capped` is surfaced only when
    non-zero: the discovery ceiling truncating a walk is a graph-completeness warning, and printing `capped 0`
    on every ordinary run would train the operator to ignore the one number that matters.
    */
    const capped = output.cappedFiles > 0 ? `; capped ${output.cappedFiles}` : "";
    console.log(
      `Knowledge graph: ${output.nodes} nodes, ${output.edges} edges; ` +
      `parsed ${output.parsedFiles}, reused ${output.reusedFiles}, pruned ${output.prunedFiles}; ` +
      `read ${output.readFiles}/${output.discoveredFiles} (stat-only ${output.statOnlyFiles}); ` +
      `synthesized imports ${output.synthesizedImportEdges}, derived modules ${output.derivedModuleCount}; ` +
      `changed=${output.changed}${recovery}${capped}`,
    );
  } finally {
    if (context) await closeProjectStore(context);
  }
}
