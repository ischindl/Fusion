/**
 * Knowledge-graph build worker (RUFU-500).
 *
 * Built as a sibling entry next to the running bundle — see the FNXC:CliPackaging block in
 * `packages/cli/tsup.config.ts`, which already emits `child-process-worker.js` the same way for the
 * child-process runtime. The parent forks this file, sends one `build` request, and waits for one
 * `result`/`error` reply.
 *
 * Why a separate process at all: rebuilding the structure graph is CPU-bound work that was measured at
 * 84.8% of the whole dashboard process for minutes at a time (98,927 samples in a 26 s window), and the
 * dashboard, the engine, and the scheduler share that one event loop. In-process it is indistinguishable
 * from the board being broken: `/api/health` answered in 3.5 s while it ran. Nothing about the build is
 * wrong; it was just standing in the wrong process.
 */
import { buildKnowledgeGraph } from "./graph-builder.js";
import type { KnowledgeGraphBuildSummary } from "./build-offloader.js";

type BuildRequest = {
  kind: "build";
  projectRoot: string;
  graphDir: string;
  force: boolean;
};

/*
 * The reply carries the build summary verbatim rather than a hand-picked field list: the stats keys are
 * already all serializable (counts plus a `recoveryReason` string), and mirroring them by name here is how
 * a renamed stat silently becomes `undefined` on the parent side. The graph object itself is deliberately
 * NOT returned — see the offloader, which reads the committed artifacts back when a caller needs nodes.
 */
type BuildReply = ({ kind: "result" } & KnowledgeGraphBuildSummary) | { kind: "error"; message: string };

function reply(message: BuildReply): void {
  // `process.send` exists only when forked with an IPC channel. If it does not, this file was run by
  // hand; report on stdout instead of throwing so a manual run still tells the operator what happened.
  if (typeof process.send === "function") {
    process.send(message);
    return;
  }
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

process.on("message", async (message: unknown) => {
  const request = message as Partial<BuildRequest> | null;
  if (!request || request.kind !== "build") {
    reply({ kind: "error", message: `Unsupported knowledge-graph worker request: ${String(request?.kind)}` });
    return;
  }
  if (!request.projectRoot || !request.graphDir) {
    reply({ kind: "error", message: "knowledge-graph worker request is missing projectRoot or graphDir" });
    return;
  }
  try {
    const result = await buildKnowledgeGraph({
      projectRoot: request.projectRoot,
      graphDir: request.graphDir,
      force: Boolean(request.force),
    });
    reply({
      kind: "result",
      changed: result.changed,
      nodes: result.graph.nodes.length,
      edges: result.graph.edges.length,
      stats: result.stats,
    });
    // Exit deliberately. The build is a one-shot: keeping a parsed whole-repo graph alive in a resident
    // child would trade the event-loop starvation for a second multi-hundred-megabyte heap.
    process.exit(0);
  } catch (error) {
    reply({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
});
