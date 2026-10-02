/**
 * Runs a knowledge-graph build in a forked child instead of the calling process (RUFU-500).
 *
 * FNXC:KnowledgeGraph 2026-10-02-14:05:
 * Rebuilding the structure graph is CPU-bound and was measured at **84.8% of the whole dashboard process
 * for minutes at a time** (83,887 of 98,927 samples in a 26 s profile of the live production server with a
 * single board tab open). The dashboard, the engine, the scheduler and the Memory Keeper all share that one
 * Node process, so a rebuild was indistinguishable from a broken board: `/api/health` answered in 3.5 s,
 * 1.7 s, 1.0 s during it, and every board read queued behind the same CPU. A profile three minutes later
 * showed the frame gone — this is a burst, which is exactly why steady-state metrics never caught it.
 *
 * The build itself is not wasteful, so the fix is placement rather than throttling: the child gets the CPU,
 * the parent keeps its event loop. `graph-builder.ts` already awaits IO per file, so cooperative yields were
 * measured to be the wrong lever — the parent's requests were competing for CPU, not waiting on a stalled
 * loop. The child is capped below the parent's heap (`--max-old-space-size`) so an offloaded build cannot
 * create the out-of-memory class this host already fought once.
 */
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildKnowledgeGraph } from "./graph-builder.js";

/** Serializable result of one build: what `buildKnowledgeGraph` reports, minus the graph object. */
export type KnowledgeGraphBuildSummary = {
  changed: boolean;
  nodes: number;
  edges: number;
  stats: Awaited<ReturnType<typeof buildKnowledgeGraph>>["stats"];
};

export type KnowledgeGraphBuildRequest = {
  projectRoot: string;
  graphDir: string;
  /**
   * Optional for the same reason it is optional on `buildKnowledgeGraph`: every caller today wants an
   * incremental pass. The child receives `Boolean(force)`, so an omitted flag is a cold-safe incremental
   * build rather than an absent one.
   */
  force?: boolean;
};

/** Raised when the child could not be used at all, so the caller should build in-process instead. */
export class KnowledgeGraphBuildOffloadUnavailableError extends Error {
  constructor(reason: string) {
    super(`knowledge-graph build offload unavailable: ${reason}`);
    this.name = "KnowledgeGraphBuildOffloadUnavailableError";
  }
}

/** Default ceiling on one offloaded build. A whole-repo cold pass is slow; a hang must not be. */
export const KNOWLEDGE_GRAPH_BUILD_TIMEOUT_MS = 15 * 60_000;

/** Heap ceiling for the build child, deliberately below the parent's so offloading cannot cause an OOM. */
export const KNOWLEDGE_GRAPH_BUILD_CHILD_HEAP_MB = 4096;

/**
 * Resolve the worker beside the running module, the same rule the child-process runtime uses for
 * `child-process-worker.js`: compiled builds look for the sibling `.js` emitted by the CLI bundler, source
 * builds look for the `.ts` next to this file. Only the `.js` is ever spawned — see the fallback note below.
 */
export function resolveKnowledgeGraphWorkerPath(moduleUrl = import.meta.url): string {
  const dir = dirname(fileURLToPath(moduleUrl));
  const isCompiled = !moduleUrl.endsWith(".ts");
  return join(dir, isCompiled ? "knowledge-graph-worker.js" : "build-worker.ts");
}

export type RunKnowledgeGraphBuildOptions = KnowledgeGraphBuildRequest & {
  /** Test seam. Defaults to `node:child_process.fork`. */
  spawnFn?: typeof fork;
  /** Injectable clock, so the timeout is testable without waiting 15 minutes. */
  now?: () => number;
  timeoutMs?: number;
  /** Set false in tests / exotic hosts to force the in-process path. */
  allowChild?: boolean;
  /**
   * Test seam for the "can this worker actually be spawned" decision, which in production is
   * `path.endsWith(".js") && existsSync(path)`. A source checkout resolves a `.ts` sibling, so suites inject
   * a probe instead of monkey-patching the filesystem — the same refusal is what makes the in-process
   * fallback correct on a developer machine.
   */
  canUseWorker?: (workerPath: string) => boolean;
  /**
   * Override for the sibling resolution, used by tests to name a worker that does not exist on disk. A wrong
   * path is not dangerous: the spawn error or early exit is reported as `Unavailable`, and the caller then
   * builds in-process.
   */
  workerPath?: string;
  log?: (message: string) => void;
};

/**
 * Build the graph, preferring a forked child. Falls back to an in-process build whenever the child cannot be
 * used — a source checkout (the worker is `.ts` there), a missing sibling from an incomplete bundle, or a
 * spawn that fails outright. The fallback is deliberate: an operator must never lose the graph because an
 * optimisation could not run, and a build that blocks the loop for a while is still better than no artifact.
 */
export async function runKnowledgeGraphBuild(
  options: RunKnowledgeGraphBuildOptions,
): Promise<KnowledgeGraphBuildSummary> {
  const { projectRoot, graphDir, force } = options;
  const allowChild = options.allowChild !== false;
  if (!allowChild) return summarize(await buildKnowledgeGraph({ projectRoot, graphDir, force }));

  const workerPath = options.workerPath ?? resolveKnowledgeGraphWorkerPath();
  const canUseWorker = options.canUseWorker ?? ((path: string) => path.endsWith(".js") && existsSync(path));
  if (!canUseWorker(workerPath)) {
    throw new KnowledgeGraphBuildOffloadUnavailableError(`worker not usable at ${workerPath}`);
  }

  const spawn = options.spawnFn ?? fork;
  const timeoutMs = options.timeoutMs ?? KNOWLEDGE_GRAPH_BUILD_TIMEOUT_MS;
  return await new Promise<KnowledgeGraphBuildSummary>((resolve, reject) => {
    let child: ReturnType<typeof fork>;
    try {
      child = spawn(workerPath, [], {
        silent: true,
        // Do not inherit the parent's execArgv: the parent runs with a large --max-old-space-size because it
        // is the server. The build child gets its own, smaller, ceiling.
        execArgv: [`--max-old-space-size=${KNOWLEDGE_GRAPH_BUILD_CHILD_HEAP_MB}`],
      });
    } catch (error) {
      reject(new KnowledgeGraphBuildOffloadUnavailableError(error instanceof Error ? error.message : String(error)));
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`knowledge-graph build exceeded ${timeoutMs}ms and was terminated`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.on("message", (message: unknown) => {
      const reply = message as { kind?: string; message?: string } & Partial<KnowledgeGraphBuildSummary> | null;
      if (!reply || typeof reply !== "object") return;
      if (reply.kind === "result") {
        finish(() =>
          resolve({
            changed: Boolean(reply.changed),
            nodes: Number(reply.nodes ?? 0),
            edges: Number(reply.edges ?? 0),
            stats: reply.stats as KnowledgeGraphBuildSummary["stats"],
          }),
        );
        return;
      }
      if (reply.kind === "error") {
        finish(() => reject(new Error(reply.message || "knowledge-graph worker reported a failure")));
      }
    });

    child.on("error", (error) => {
      finish(() => reject(new KnowledgeGraphBuildOffloadUnavailableError(error.message)));
    });

    child.on("exit", (code, signal) => {
      finish(() =>
        reject(
          new KnowledgeGraphBuildOffloadUnavailableError(
            `worker exited before answering (code=${String(code)} signal=${String(signal)})`,
          ),
        ),
      );
    });

    try {
      child.send({ kind: "build", projectRoot, graphDir, force: Boolean(force) });
    } catch (error) {
      finish(() =>
        reject(new KnowledgeGraphBuildOffloadUnavailableError(error instanceof Error ? error.message : String(error))),
      );
    }
  });
}

/** In-process build plus the same summary shape, so both paths return one thing. */
export async function runKnowledgeGraphBuildInProcess(
  request: KnowledgeGraphBuildRequest,
): Promise<KnowledgeGraphBuildSummary> {
  return summarize(await buildKnowledgeGraph(request));
}

function summarize(built: Awaited<ReturnType<typeof buildKnowledgeGraph>>): KnowledgeGraphBuildSummary {
  return {
    changed: built.changed,
    nodes: built.graph.nodes.length,
    edges: built.graph.edges.length,
    stats: built.stats,
  };
}
