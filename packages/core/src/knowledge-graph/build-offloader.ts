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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildKnowledgeGraph, type BuildKnowledgeGraphOptions } from "./graph-builder.js";

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
  return findKnowledgeGraphWorkerPath(moduleUrl) ?? legacyWorkerCandidate(moduleUrl);
}

/**
 * Every plausible location for the compiled worker; first existing match wins.
 *
 * FNXC:KnowledgeGraph 2026-10-02-15:20 (RUFU-500):
 * One candidate path was not enough, and the reason is the shape of the shipped CLI: `bin.mjs` is a launcher
 * that imports `dist/bin.js`, so a module inlined into that bundle can attribute `import.meta.url` either to
 * the package directory or to `dist`. A single `join(dirname(import.meta.url), "knowledge-graph-worker.js")`
 * missed, the offloader reported the worker "unusable", and the caller silently rebuilt in-process — the exact
 * 84.8%-of-the-dashboard condition this module exists to remove, with no error anywhere. The sibling case
 * still wins when it is correct.
 */
export function findKnowledgeGraphWorkerPath(
  moduleUrl = import.meta.url,
  probe: (path: string) => boolean = existsSync,
): string | undefined {
  if (moduleUrl.endsWith(".ts")) {
    // Source checkout: the `.ts` sibling is never spawned (fork has no transpiler), so report the shape and
    // let the caller take the in-process path.
    return join(dirname(fileURLToPath(moduleUrl)), "build-worker.ts");
  }
  const dir = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    join(dir, "knowledge-graph-worker.js"),
    // `packages/cli/bin.mjs` importing `dist/bin.js`: the worker sits one level below the module directory.
    join(dir, "dist", "knowledge-graph-worker.js"),
    // Run-from-package-root (`node packages/cli/bin.mjs dashboard ...`), where the module dir can be the cwd.
    join(process.cwd(), "packages/cli/dist", "knowledge-graph-worker.js"),
  ];
  return candidates.find((candidate) => candidate.endsWith(".js") && probe(candidate));
}

function legacyWorkerCandidate(moduleUrl: string): string {
  const dir = dirname(fileURLToPath(moduleUrl));
  return join(dir, moduleUrl.endsWith(".ts") ? "build-worker.ts" : "knowledge-graph-worker.js");
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
 *
 * FNXC:KnowledgeGraph 2026-11-11-18:53 (RUFU-500):
 * Single-flight per resolved `graphDir`: this process holds at most ONE build child per graph directory.
 * Two dashboard triggers — the panel's "Rebuild graph", and the memory-consolidation lane re-entering the
 * builder from its own tick — used to each spawn a child against the SAME directory. That doubled both the
 * memory ceiling (every child carries its own heap limit, so two children ask for twice the RAM on the same
 * artifact triple) and the CPU burn the operator's profile measured at 84.8%, and the two children then raced
 * to write the same files. A caller arriving while a build is in flight joins it and receives that build's
 * result object instead of spawning.
 *
 * Two contracts fall out of this and both are load-bearing:
 *  - The lane is cleared on EVERY settle path — fulfilment, rejection, transport error, and the SIGKILL
 *    timeout alike. A stale entry would make every later build for that directory resolve with an
 *    already-settled promise, i.e. the graph would silently stop rebuilding forever, so the removal lives in
 *    a `finally` and compares identity before deleting (a successor lane may already own the key).
 *  - The registration is published before the entry point's first `await`, because two callers entering in
 *    the same tick is precisely the case being fixed; a map write after an `await` would let both spawn.
 *  - A `force` request never joins a build that was not itself forced — that build may already be reusing
 *    the stat cache, so handing its result back would silently ignore the operator's "rebuild everything".
 *    The forced build is not run CONCURRENTLY either, which would restore the double-write the lane exists
 *    to prevent; it is chained to start after the weaker lane settles, so one directory still has one child
 *    at a time.
 */
export async function runKnowledgeGraphBuild(
  options: RunKnowledgeGraphBuildOptions,
): Promise<KnowledgeGraphBuildSummary> {
  const key = resolve(options.graphDir);
  const existing = buildLanes.get(key);
  if (existing && !(options.force === true && !existing.force)) return existing.promise;

  // Chain rather than overlap: a forced build waiting for a weaker in-flight build still runs alone.
  const predecessor = existing ? existing.promise.then(() => undefined, () => undefined) : undefined;
  const lane: BuildLane = {
    force: options.force === true,
    promise: predecessor ? predecessor.then(() => startKnowledgeGraphBuild(options)) : startKnowledgeGraphBuild(options),
  };
  buildLanes.set(key, lane);
  try {
    return await lane.promise;
  } finally {
    // Compare-and-delete: never drop a successor lane that a later caller already installed.
    if (buildLanes.get(key) === lane) buildLanes.delete(key);
  }
}

interface BuildLane {
  readonly promise: Promise<KnowledgeGraphBuildSummary>;
  /** Whether this build was asked to ignore prior artifacts, so a later `force` caller knows it may not join. */
  readonly force: boolean;
}

/**
 * One in-flight build per resolved graph directory. A Map of lanes (not a Set of children) because a joiner
 * must await the same outcome, not merely avoid spawning: two callers of one directory get one answer and one
 * artifact write, which is also what makes the double-write race impossible.
 */
const buildLanes = new Map<string, BuildLane>();

async function startKnowledgeGraphBuild(
  options: RunKnowledgeGraphBuildOptions,
): Promise<KnowledgeGraphBuildSummary> {
  const { projectRoot, graphDir, force } = options;
  const allowChild = options.allowChild !== false;
  if (!allowChild) return summarize(await buildKnowledgeGraph({ projectRoot, graphDir, force }));

  const workerPath = options.workerPath ?? resolveKnowledgeGraphWorkerPath();
  const canUseWorker = options.canUseWorker ?? ((path: string) => path.endsWith(".js") && existsSync(path));
  if (!canUseWorker(workerPath)) {
    /*
    FNXC:KnowledgeGraph 2026-10-02-15:20 (RUFU-500):
    A refusal to spawn must be audible. On the deployed server the build kept running in-process while this
    module declared the worker unusable, and nothing said so — the only evidence was an absent child process,
    which looked like a broken probe. Naming the path turns an hour of investigation into one log line.
    */
    options.log?.(`[knowledge-graph] offload refused, building in-process (worker unusable at ${workerPath})`);
    throw new KnowledgeGraphBuildOffloadUnavailableError(`worker not usable at ${workerPath}`);
  }
  options.log?.(`[knowledge-graph] offloading graph build to child ${workerPath}`);

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

/**
 * Build tuning an in-process caller may add to a request. It is deliberately a SEPARATE parameter rather
 * extra fields on `KnowledgeGraphBuildRequest`.
 *
 * FNXC:KnowledgeGraph 2026-11-11-20:12 (RUFU-500):
 * `KnowledgeGraphBuildRequest` is the IPC payload (`child.send({kind:"build", projectRoot, graphDir, force})`),
 * so every field on it must survive JSON. `deps` and `extractFile` are functions: putting them on the request
 * would make the child path silently drop them and report a build that never used the caller's own seam. An
 * in-process-only capability therefore rides its own argument, which the fork path can never receive.
 *
 * Who needs it: `packages/dashboard/src/__tests__/knowledge-graph-loop-responsiveness.test.ts` must run the
 * SAME synchronous CPU burn through both lanes to prove the offload is what saves the board. The measured
 * alternatives were not usable as a ratchet: a real in-process build of a 1500-file fixture stalls a 10 ms tick
 * by at most 57 ms (measured 2026-11-11), which sits under any bound wide enough not to flake, so a
 * fixture-sized burn cannot reliably demonstrate the failure mode.
 */
export type KnowledgeGraphInProcessBuildTuning = Omit<BuildKnowledgeGraphOptions, "projectRoot" | "graphDir" | "force">;

/** In-process build plus the same summary shape, so both paths return one thing. */
export async function runKnowledgeGraphBuildInProcess(
  request: KnowledgeGraphBuildRequest,
  build?: KnowledgeGraphInProcessBuildTuning,
): Promise<KnowledgeGraphBuildSummary> {
  return summarize(await buildKnowledgeGraph({ ...request, ...build }));
}

function summarize(built: Awaited<ReturnType<typeof buildKnowledgeGraph>>): KnowledgeGraphBuildSummary {
  return {
    changed: built.changed,
    nodes: built.graph.nodes.length,
    edges: built.graph.edges.length,
    stats: built.stats,
  };
}
