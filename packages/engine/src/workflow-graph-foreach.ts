import type { TaskDetail, TaskStep, WorkflowIrEdge, WorkflowIrNode } from "@fusion/core";
import { WorkflowIrError } from "@fusion/core";

import type { WorkflowNodeOutcome, WorkflowNodeResult } from "./workflow-graph-executor.js";
import {
  FOREACH_ACTIVE_CONTEXT_KEY,
  type ForeachActiveContext,
} from "./workflow-node-handlers.js";
import { schedulerLog } from "./logger.js";

/**
 * Foreach region expansion + instance sub-walk (step-inversion KTD-3/KTD-5, U3).
 *
 * When the sequential walker reaches a `foreach` node it does NOT recurse through
 * the main `walk` (whose `inStack` cycle detector intentionally throws on any
 * back-edge). Instead it hands control here, which:
 *
 *   - reads `Task.steps[]` and pins the count at expansion time;
 *   - for each step `i` in order, runs the inline template subgraph as an
 *     **iterative region sub-walk** (a `for(;;)` over `currentId`, modeled on
 *     `walkBranch` in workflow-graph-branches.ts), from the template entry to its
 *     exit, materializing deterministic instance node ids
 *     `<foreachId>#<i>:<templateNodeId>` purely as walk state (the IR/nodeMap are
 *     never mutated);
 *   - permits `kind: "rework"` edges as the only legal cycles — each traversal
 *     decrements a per-instance budget seeded from `config.maxReworkCycles`
 *     (default 3, defensively clamped to ≤10); exhaustion emits the
 *     `outcome:rework-exhausted` outcome from the foreach node;
 *   - threads the active instance under the reserved `foreach:active` context key
 *     so template handlers (step-execute now; step-review in U5) know which step
 *     they operate on, clearing it on instance exit;
 *   - honors the abort signal between nodes (existing posture).
 *
 * Only sequential + shared physics are implemented here (concurrency 1). The
 * scheduler is intentionally a runnable-set loop running one instance at a time
 * so U10 can extend it to parallel/worktree without restructuring. Parallel mode
 * is guarded to a clean failure (U10 replaces it).
 */

/** Default rework budget when the foreach config omits `maxReworkCycles`. */
const DEFAULT_MAX_REWORK_CYCLES = 3;
/** Defensive cap mirroring core's validation clamp (KTD-5). */
const MAX_REWORK_CYCLES_CAP = 10;

/** The foreach node's config shape this module reads (subset of WorkflowForeachConfig). */
interface ForeachConfig {
  source?: unknown;
  maxReworkCycles?: number;
  mode?: "sequential" | "parallel";
  concurrency?: number;
  isolation?: "shared" | "worktree";
  template?: { nodes: WorkflowIrNode[]; edges: WorkflowIrEdge[] };
}

/**
 * Narrow persistence hook for foreach instance run-state (KTD-6, U3 stub).
 *
 * The real SQLite-backed adapter lands in U4 (executor half); this interface is
 * shaped so that wiring is a pure additive change. All methods are optional and
 * default to no-ops — the sub-walk calls them at instance start / completion /
 * each rework pass, but a fully in-memory run (tests, flag-off, pre-U4 store)
 * needs none of them. Instance identity is deterministic
 * (`<foreachNodeId>#<stepIndex>`), so a future resume can seed the sub-walk
 * position directly from a loaded `currentNodeId` + `reworkCount` (KTD-6) —
 * this hook is the seam where that seeding will plug in.
 */
export interface WorkflowStepInstanceState {
  taskId: string;
  runId: string;
  foreachNodeId: string;
  stepIndex: number;
  pinnedStepCount: number;
  /** Template node id (NOT the materialized instance id) the instance is at. */
  currentNodeId: string;
  status: "in-progress" | "completed" | "failed";
  baselineSha?: string;
  checkpointId?: string;
  reworkCount: number;
  /** Latest authoritative step-review verdict (KTD-4/KTD-6, U5). */
  verdict?: "APPROVE" | "REVISE" | "RETHINK" | "UNAVAILABLE";
}

export interface WorkflowStepInstancePersistence {
  /** Idempotent upsert keyed by (taskId, runId, foreachNodeId, stepIndex). */
  saveInstanceState?(state: WorkflowStepInstanceState): void | Promise<void>;
  /** Load any persisted instance states for a run (used on resume — U4). */
  loadInstanceStates?(
    taskId: string,
    runId: string,
  ): WorkflowStepInstanceState[] | Promise<WorkflowStepInstanceState[]>;
  /** Prune stale instance rows for a task, keeping only `keepRunId` (U4). */
  clearStaleInstanceStates?(taskId: string, keepRunId: string): void | Promise<void>;
}

/**
 * Await a persistence call inside a guard so a Promise-returning impl cannot
 * escape as an unhandled rejection, and a persistence failure never kills
 * instance execution (log-and-continue). Mirrors `persistBranchState`.
 */
async function persistInstanceState(
  persistence: WorkflowStepInstancePersistence | undefined,
  state: WorkflowStepInstanceState,
): Promise<void> {
  try {
    await persistence?.saveInstanceState?.(state);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    schedulerLog.warn(
      `saveInstanceState failed for task ${state.taskId} run ${state.runId} foreach ${state.foreachNodeId} step ${state.stepIndex}: ${message}`,
    );
  }
}

export interface ForeachEnvironment {
  task: TaskDetail;
  runId: string;
  /** Fresh step list (KTD-3: read at expansion, count pinned). */
  steps: TaskStep[];
  /** The shared walk context; the active-instance key is threaded in/out of it. */
  context: Record<string, unknown>;
  /**
   * Runs one template node through the executor's executeNodeWithRetries (so
   * per-node maxRetries still applies inside the sub-walk). The node passed is
   * the ORIGINAL template node; the executor reads/writes the shared context,
   * which already carries `foreach:active` for the current instance.
   */
  runTemplateNode: (
    node: WorkflowIrNode,
    signal?: AbortSignal,
  ) => Promise<WorkflowNodeResult>;
  shouldTraverseEdge: (edge: WorkflowIrEdge, source: WorkflowNodeResult) => boolean;
  persistence?: WorkflowStepInstancePersistence;
  /**
   * RETHINK reset-on-rework hook (KTD-4, U5). Invoked BEFORE re-entering the
   * instance's step-execute node when the rework edge being traversed was
   * triggered by an `outcome:rethink` (the verdict that resets to baseline). The
   * production wiring (executor.ts) calls `resetStepToBaseline` with the
   * instance's persisted `baselineSha`/`checkpointId`; tests inject a fake. Other
   * rework outcomes (e.g. `revise`) do NOT call this — they revise in place
   * (today's REVISE semantics). Optional with a no-op default.
   */
  onReworkReset?: (
    active: ForeachActiveContext,
    reason: string,
  ) => void | Promise<void>;
  /** Honored between nodes (existing posture). */
  signal?: AbortSignal;
}

export interface ForeachRunResult {
  /** Foreach node outcome: success when all instances completed; otherwise the
   *  routed outcome value (e.g. "rework-exhausted") with a failure outcome unless
   *  the caller routes it. */
  outcome: WorkflowNodeOutcome;
  /** Outcome value for `outcome:` edge routing (e.g. "rework-exhausted"). */
  value?: string;
  /** Materialized instance node ids visited, for the executor's visited list. */
  visitedNodeIds: string[];
}

/** Materialize a deterministic instance node id (KTD-3) — pure, no IR mutation. */
export function instanceNodeId(foreachNodeId: string, stepIndex: number, templateNodeId: string): string {
  return `${foreachNodeId}#${stepIndex}:${templateNodeId}`;
}

/** Resolve the foreach config, validating the bits this module relies on. */
function resolveForeachConfig(node: WorkflowIrNode): {
  template: { nodes: WorkflowIrNode[]; edges: WorkflowIrEdge[] };
  maxReworkCycles: number;
  mode: "sequential" | "parallel";
} {
  const cfg = (node.config ?? {}) as ForeachConfig;
  const template = cfg.template;
  if (!template || !Array.isArray(template.nodes) || !Array.isArray(template.edges)) {
    throw new WorkflowIrError(`foreach node '${node.id}' has no template subgraph`);
  }
  const raw = typeof cfg.maxReworkCycles === "number" ? cfg.maxReworkCycles : DEFAULT_MAX_REWORK_CYCLES;
  const maxReworkCycles = Math.max(1, Math.min(MAX_REWORK_CYCLES_CAP, Math.floor(raw)));
  const mode = cfg.mode === "parallel" ? "parallel" : "sequential";
  return { template, maxReworkCycles, mode };
}

/** Find the single template entry node (no non-rework incoming edge). */
function findTemplateEntry(
  nodes: WorkflowIrNode[],
  edges: WorkflowIrEdge[],
  foreachId: string,
): WorkflowIrNode {
  const incoming = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind === "rework") continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }
  const entries = nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0);
  if (entries.length !== 1) {
    throw new WorkflowIrError(
      `foreach node '${foreachId}' template must have exactly one entry node (found ${entries.length})`,
    );
  }
  return entries[0];
}

/**
 * Expand a foreach node and run its instances sequentially in step order.
 * Returns the foreach node's aggregate outcome (KTD-3).
 */
export async function runForeach(
  foreachNode: WorkflowIrNode,
  env: ForeachEnvironment,
): Promise<ForeachRunResult> {
  const { template, maxReworkCycles, mode } = resolveForeachConfig(foreachNode);

  // U3 scope guard: parallel mode is U10. Fail cleanly with a routable outcome
  // rather than silently running it as sequential.
  if (mode === "parallel") {
    return {
      outcome: "failure",
      value: "parallel-not-wired",
      visitedNodeIds: [],
    };
  }

  // Pin the count at expansion (KTD-3). Zero steps → success edge (no instances).
  const pinnedStepCount = env.steps.length;
  const visitedNodeIds: string[] = [];
  if (pinnedStepCount === 0) {
    return { outcome: "success", visitedNodeIds };
  }

  const templateById = new Map(template.nodes.map((n) => [n.id, n]));
  const templateOutgoing = new Map<string, WorkflowIrEdge[]>();
  for (const edge of template.edges) {
    const list = templateOutgoing.get(edge.from) ?? [];
    list.push(edge);
    templateOutgoing.set(edge.from, list);
  }
  const entry = findTemplateEntry(template.nodes, template.edges, foreachNode.id);

  // Single-authority done-marking (U6/KTD-4): when the template contains a
  // step-review node, step-execute SUCCESS must leave the step in-progress and the
  // review's APPROVE marks it done. Computed once and threaded into each instance.
  const templateHasStepReview = template.nodes.some((n) => n.kind === "step-review");

  // Sequential + shared: a runnable-set loop with concurrency 1 (U10 extends this
  // to parallel/worktree). Instances run strictly in step order.
  for (let stepIndex = 0; stepIndex < pinnedStepCount; stepIndex++) {
    if (env.signal?.aborted) {
      return { outcome: "failure", value: "aborted", visitedNodeIds };
    }

    const instanceResult = await runInstance(
      foreachNode,
      stepIndex,
      pinnedStepCount,
      entry,
      templateById,
      templateOutgoing,
      maxReworkCycles,
      env,
      visitedNodeIds,
      templateHasStepReview,
    );

    if (instanceResult.outcome === "failure") {
      // Rework exhaustion routes a dedicated outcome; other failures propagate.
      return {
        outcome: "failure",
        value: instanceResult.value,
        visitedNodeIds,
      };
    }
  }

  // All instances completed → foreach success edge (KTD-3).
  return { outcome: "success", visitedNodeIds };
}

interface InstanceResult {
  outcome: WorkflowNodeOutcome;
  value?: string;
}

/**
 * Run one foreach instance (step `stepIndex`) as an iterative region sub-walk.
 * Threads `foreach:active` into the shared context on entry and clears it on
 * exit. Rework edges loop `currentId` back, bounded by the per-instance budget.
 */
async function runInstance(
  foreachNode: WorkflowIrNode,
  stepIndex: number,
  pinnedStepCount: number,
  entry: WorkflowIrNode,
  templateById: Map<string, WorkflowIrNode>,
  templateOutgoing: Map<string, WorkflowIrEdge[]>,
  maxReworkCycles: number,
  env: ForeachEnvironment,
  visitedNodeIds: string[],
  templateHasStepReview: boolean,
): Promise<InstanceResult> {
  // Per-instance rework budget (KTD-5) — NOT shared across instances.
  let reworkBudget = maxReworkCycles;
  let reworkCount = 0;

  // Active-instance context (KTD-3). baselineSha/checkpointId start undefined and
  // are captured by step-execute (U3) into this same object so later template
  // nodes (step-review/reset, U5) can read them. deferDoneToReview tells the
  // step-execute seam to leave the step in-progress when a review will decide
  // done-ness (U6/KTD-4).
  const active: ForeachActiveContext = {
    foreachNodeId: foreachNode.id,
    stepIndex,
    instanceId: `${foreachNode.id}#${stepIndex}`,
    deferDoneToReview: templateHasStepReview,
  };
  env.context[FOREACH_ACTIVE_CONTEXT_KEY] = active;

  await persistInstanceState(env.persistence, {
    taskId: env.task.id,
    runId: env.runId,
    foreachNodeId: foreachNode.id,
    stepIndex,
    pinnedStepCount,
    currentNodeId: entry.id,
    status: "in-progress",
    baselineSha: active.baselineSha,
    checkpointId: active.checkpointId,
    reworkCount,
    verdict: active.verdict,
  });

  try {
    let currentId = entry.id;
    let lastResult: WorkflowNodeResult = { outcome: "success" };

    for (;;) {
      if (env.signal?.aborted) {
        await persistInstanceState(env.persistence, {
          taskId: env.task.id,
          runId: env.runId,
          foreachNodeId: foreachNode.id,
          stepIndex,
          pinnedStepCount,
          currentNodeId: currentId,
          status: "failed",
          baselineSha: active.baselineSha,
          checkpointId: active.checkpointId,
          reworkCount,
          verdict: active.verdict,
        });
        return { outcome: "failure", value: "aborted" };
      }

      const node = templateById.get(currentId);
      if (!node) throw new WorkflowIrError(`Unknown foreach template node: ${currentId}`);

      visitedNodeIds.push(instanceNodeId(foreachNode.id, stepIndex, currentId));

      lastResult = await env.runTemplateNode(node, env.signal);
      // step-execute (and U5 nodes) write captured baseline/checkpoint into the
      // active context via their contextPatch; mirror them onto `active` so the
      // reserved key stays the single source of truth for later nodes.
      syncActiveFromContext(env.context, active);

      if (lastResult.outcome === "failure") {
        await persistInstanceState(env.persistence, {
          taskId: env.task.id,
          runId: env.runId,
          foreachNodeId: foreachNode.id,
          stepIndex,
          pinnedStepCount,
          currentNodeId: currentId,
          status: "failed",
          baselineSha: active.baselineSha,
          checkpointId: active.checkpointId,
          reworkCount,
          verdict: active.verdict,
        });
        return { outcome: "failure", value: lastResult.value };
      }

      // Pick the next edge. Rework edges are the only legal back-edges.
      const next = chooseNextEdge(currentId, templateOutgoing, lastResult, env.shouldTraverseEdge);
      if (!next) {
        // No outgoing edge matched → template exit reached. Instance complete.
        await persistInstanceState(env.persistence, {
          taskId: env.task.id,
          runId: env.runId,
          foreachNodeId: foreachNode.id,
          stepIndex,
          pinnedStepCount,
          currentNodeId: currentId,
          status: "completed",
          baselineSha: active.baselineSha,
          checkpointId: active.checkpointId,
          reworkCount,
          verdict: active.verdict,
        });
        return { outcome: "success" };
      }

      if (next.kind === "rework") {
        if (reworkBudget <= 0) {
          // Budget exhausted (KTD-5): emit rework-exhausted from the foreach node.
          await persistInstanceState(env.persistence, {
            taskId: env.task.id,
            runId: env.runId,
            foreachNodeId: foreachNode.id,
            stepIndex,
            pinnedStepCount,
            currentNodeId: currentId,
            status: "failed",
            baselineSha: active.baselineSha,
            checkpointId: active.checkpointId,
            reworkCount,
            verdict: active.verdict,
          });
          return { outcome: "failure", value: "rework-exhausted" };
        }
        reworkBudget -= 1;
        reworkCount += 1;

        // RETHINK reset-on-rework (KTD-4, U5): when the rework edge was triggered
        // by an `outcome:rethink` verdict, reset the step to its per-step baseline
        // (git reset + session rewind + step→pending) BEFORE re-entering the
        // step-execute node. REVISE-driven rework revises in place — no reset.
        if (lastResult.value === "rethink" && env.onReworkReset) {
          try {
            await env.onReworkReset(active, "rethink");
            // The reset may have rewound the session; re-sync captured state.
            syncActiveFromContext(env.context, active);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            schedulerLog.warn(
              `onReworkReset failed for task ${env.task.id} foreach ${foreachNode.id} step ${stepIndex}: ${message}`,
            );
          }
        }

        await persistInstanceState(env.persistence, {
          taskId: env.task.id,
          runId: env.runId,
          foreachNodeId: foreachNode.id,
          stepIndex,
          pinnedStepCount,
          currentNodeId: next.to,
          status: "in-progress",
          baselineSha: active.baselineSha,
          checkpointId: active.checkpointId,
          reworkCount,
          verdict: active.verdict,
        });
      }

      currentId = next.to;
    }
  } finally {
    // Clear the active-instance context on exit (KTD-3): absent outside instances.
    delete env.context[FOREACH_ACTIVE_CONTEXT_KEY];
  }
}

/** Sync baseline/checkpoint a handler wrote into the shared `foreach:active`
 *  context object back onto our local `active` snapshot. Handlers that patch the
 *  reserved key (step-execute) update the SAME object reference, but a handler
 *  could replace it via contextPatch — re-read defensively. */
function syncActiveFromContext(
  context: Record<string, unknown>,
  active: ForeachActiveContext,
): void {
  const fromContext = context[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext | undefined;
  if (fromContext && fromContext !== active) {
    active.baselineSha = fromContext.baselineSha ?? active.baselineSha;
    active.checkpointId = fromContext.checkpointId ?? active.checkpointId;
    active.verdict = fromContext.verdict ?? active.verdict;
    // Keep the canonical object reference stable for later nodes.
    context[FOREACH_ACTIVE_CONTEXT_KEY] = active;
  }
}

/**
 * Choose the single next edge from `nodeId`. A rework edge wins only when no
 * non-rework edge matches the outcome (rework is the explicit loop-back, not a
 * primary forward edge); among matching forward edges the lowest `to` id wins
 * (deterministic, mirrors walkBranch/traverseChildren ordering).
 */
function chooseNextEdge(
  nodeId: string,
  templateOutgoing: Map<string, WorkflowIrEdge[]>,
  source: WorkflowNodeResult,
  shouldTraverseEdge: (edge: WorkflowIrEdge, source: WorkflowNodeResult) => boolean,
): WorkflowIrEdge | undefined {
  const edges = (templateOutgoing.get(nodeId) ?? []).filter((e) => shouldTraverseEdge(e, source));
  if (edges.length === 0) return undefined;
  const forward = edges.filter((e) => e.kind !== "rework").sort((a, b) => a.to.localeCompare(b.to));
  if (forward.length > 0) return forward[0];
  const rework = edges.filter((e) => e.kind === "rework").sort((a, b) => a.to.localeCompare(b.to));
  return rework[0];
}
