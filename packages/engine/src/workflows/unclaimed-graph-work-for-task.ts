/*
FNXC:UnclaimedGraphWork 2026-11-17-01:05 (RUFU-1050):
The read side of the decision seam. `evaluateUnclaimedGraphWork` is pure and must stay that way, so
this module is the ONLY place that turns a live card into a `UnclaimedGraphWorkInput`: it resolves the
lane roles from the card's own IR, asks the drain's own due filter whether the row is reachable, and
reads the pump's progress mark.

WHY IT IS A SEPARATE MODULE AND NOT A METHOD ON EITHER CONSUMER. Two surfaces must answer the same
question — the hold/release refusal (`execution/hold-release.ts`) has to stop promising a run for a row
nothing will dispatch, and the owning self-healing pass has to decide whether to repair. If each
gathered its own facts, the two could disagree about whether the same card is starved, which is the
exact defect this task exists to close. One reader, one decision, two consumers.

It lives under `workflows/` and imports only `@fusion/core` plus the drain-sizing leaf, never a runtime
or the scheduler: `execution/hold-release.ts` sits below the scheduler in the import graph, so any
heavier dependency here would be a cycle.
*/
import {
  findWorkflowNodeInstance,
  resolveColumnFlags,
  resolveEffectiveAutoMerge,
  type Task,
  type TaskStore,
  type WorkflowIr,
  type WorkflowWorkItemState,
} from "@fusion/core";
import { DUE_PLANNING_CONTINUATION_BATCH_LIMIT } from "./continuation-drain-constants.js";
import { planningContinuationDrainProgressAgeMs } from "./continuation-drain-progress.js";
import {
  evaluateUnclaimedGraphWork,
  type UnclaimedGraphWorkDecision,
  type UnclaimedGraphWorkEpisode,
  type UnclaimedGraphWorkInput,
} from "./unclaimed-graph-work.js";

/** The episode key read back off the card. Never fabricated here. */
export const UNCLAIMED_GRAPH_WORK_EPISODE_KEY = "unclaimedGraphWork";

/** The drain's due poll reads exactly these states, so reachability must be asked of exactly them. */
const DUE_POLL_STATES: WorkflowWorkItemState[] = ["runnable", "retrying"];

export interface UnclaimedWorkFacts {
  /** Lanes the card's own IR resolves as pre-execution planning lanes. Never a literal column id. */
  planningColumns: Set<string>;
  /** Lanes the card's own IR resolves as WIP. */
  wipColumns: Set<string>;
  /** False when the IR is missing or names no columns at all — the seam then refuses to decide. */
  lanesReadable: boolean;
}

/**
 * Resolve lane ROLES, never lane names. A WF-004-style workflow may call its ready lane `building`
 * and its review lane `qa`; the seam must still classify it, so what a lane IS comes from its traits.
 *
 * A planning lane is one the card rests in BEFORE execution: it carries the `hold` trait (any release
 * kind) or the `intake` trait, and does not count toward WIP. A review lane carries neither, which is
 * what keeps this pass out of `in-review`.
 */
export function resolveUnclaimedWorkLanes(ir: WorkflowIr | undefined): UnclaimedWorkFacts {
  const planningColumns = new Set<string>();
  const wipColumns = new Set<string>();
  const columns = (ir as { columns?: Array<{ id: string; traits?: unknown[] }> } | undefined)?.columns ?? [];
  for (const column of columns) {
    if (typeof column?.id !== "string" || column.id.length === 0) continue;
    const flags = resolveColumnFlags(column as never);
    if (flags.countsTowardWip === true) wipColumns.add(column.id);
    const traits = new Set((column.traits ?? []).map((trait) => typeof trait === "string" ? trait : (trait as { trait?: string })?.trait ?? ""));
    if (flags.countsTowardWip !== true && (traits.has("hold") || traits.has("intake"))) planningColumns.add(column.id);
  }
  return { planningColumns, wipColumns, lanesReadable: columns.length > 0 };
}

/**
 * The seam of a node (`config.seam`) falling back to its node id — what the re-arm gate tests against.
 *
 * FNXC:UnclaimedGraphWork 2026-11-17-01:05 (RUFU-1050):
 * The instantiated id wins over the container id. A foreach row carries `nodeId: "steps"` (the container,
 * whose seam is `foreach`) and `nodeInstanceId: "steps#1:step-execute"` (the template owner, whose seam is
 * `step-execute`), and `attemptExecutionRearm` validates the OWNER seam. Reading the container here would
 * answer "foreach" for the exact shape the re-arm exists to serve, so every shape-C card would be named
 * instead of repaired.
 */
function resolveNodeSeam(ir: WorkflowIr | undefined, nodeInstanceId: string | undefined, nodeId: string | undefined): string | undefined {
  const probe = nodeInstanceId ?? nodeId;
  if (!probe) return undefined;
  const node = findWorkflowNodeInstance(ir, probe);
  if (!node) return probe;
  const seam = (node.config as { seam?: string } | undefined)?.seam;
  return seam ?? probe;
}

export interface UnclaimedWorkReadOptions {
  /** Injected clock; the seam is only testable because no `Date.now()` sits inside the decision. */
  now?: number;
  /** The card's rows when the caller already holds them (the hold/release pass memoizes this read). */
  items?: UnclaimedGraphWorkInput["items"];
  /** Whether a durable specification exists; a caller holding the PROMPT.md memo passes the honest answer. */
  hasDurableSpec?: boolean;
  /** Liveness verdict from the shared planning/execution liveness predicate. */
  liveness?: "live" | "idle";
  /** The FN-8592 verdict for the same card, carried into the record so both owners' answers appear. */
  holdRelease?: { candidate: boolean; reason: string };
  /** A previously persisted episode, for the redrive bound. */
  episode?: UnclaimedGraphWorkEpisode | null;
  /** Whether a durable terminal record already announces this card's failure (`task:graph-failed`). */
  terminalRecordExists?: boolean;
  /** Skip the due-window probe (a caller that already knows, or a card whose row is terminal). */
  skipDueWindowProbe?: boolean;
  /**
   * The caller's own answer about the FIFO due page. A sweep reads the page ONCE for the whole pass and
   * passes the result down; leaving each card to re-issue the page read would cost one query per
   * candidate for a fact the pass already holds.
   */
  reachedByDueWindow?: boolean;
}

/**
 * Build the decision for one live card. Read-only: every store touch here is a list/read, and no
 * caller may treat a returned decision as a mutation — the authority that acts stays with
 * `attemptExecutionRearm`, the graph's replan seam, and the drain.
 */
export async function classifyUnclaimedWorkForTask(
  store: TaskStore,
  task: Task,
  ir: WorkflowIr | undefined,
  options: UnclaimedWorkReadOptions = {},
): Promise<UnclaimedGraphWorkDecision> {
  const now = options.now ?? Date.now();
  const lanes = resolveUnclaimedWorkLanes(ir);
  const items = options.items ?? await readItems(store, task.id);
  const deciding = pickDecidingCandidate(items, task.column);

  // Only an active runnable/retrying row can be "reachable", because those are the only states the
  // due poll lists. Asking the drain about a terminal row would answer "no" for the wrong reason.
  let reachedByDueWindow = true;
  if (typeof options.reachedByDueWindow === "boolean") {
    reachedByDueWindow = options.reachedByDueWindow;
  } else if (!options.skipDueWindowProbe && deciding && DUE_POLL_STATES.includes(deciding.state as WorkflowWorkItemState)) {
    reachedByDueWindow = await dueWindowReaches(store, deciding.id, now);
  }

  const settings = await store.getSettings?.().catch(() => undefined);
  return evaluateUnclaimedGraphWork({
    task: {
      id: task.id,
      column: task.column,
      status: (task.status ?? null) ?? undefined,
      error: (task.error ?? null) ?? undefined,
      paused: task.paused === true,
      userPaused: task.userPaused === true,
      updatedAt: task.updatedAt ?? task.columnMovedAt ?? new Date(now).toISOString(),
      sourceMetadata: task.sourceMetadata as UnclaimedGraphWorkInput["task"]["sourceMetadata"],
      autoMerge: settings ? resolveEffectiveAutoMerge(task, settings) : undefined,
      hasDurableSpec: options.hasDurableSpec,
    },
    items,
    planningColumns: lanes.planningColumns,
    wipColumns: lanes.wipColumns,
    lanesReadable: lanes.lanesReadable,
    liveness: options.liveness ?? "idle",
    holdRelease: options.holdRelease,
    drain: {
      windowLimit: DUE_PLANNING_CONTINUATION_BATCH_LIMIT,
      reachedByDueWindow,
      drainProgressAgeMs: planningContinuationDrainProgressAgeMs(now),
    },
    nodeSeam: resolveNodeSeam(ir, deciding?.nodeInstanceId ?? undefined, deciding?.nodeId),
    terminalRecordExists: options.terminalRecordExists,
    now,
    episode: options.episode ?? readEpisode(task),
  });
}

/** The episode this pass already persisted for the card, if any. Key-level read, never synthesized. */
export function readEpisode(task: Task): UnclaimedGraphWorkEpisode | null {
  const source = task.sourceMetadata as Record<string, unknown> | null | undefined;
  const raw = source && typeof source === "object" ? source[UNCLAIMED_GRAPH_WORK_EPISODE_KEY] : undefined;
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<UnclaimedGraphWorkEpisode>;
  if (typeof candidate.signature !== "string" || typeof candidate.code !== "string") return null;
  return {
    code: candidate.code as UnclaimedGraphWorkEpisode["code"],
    firstAt: typeof candidate.firstAt === "string" ? candidate.firstAt : "",
    signature: candidate.signature,
    redriveCount: typeof candidate.redriveCount === "number" && Number.isFinite(candidate.redriveCount) ? candidate.redriveCount : 0,
    /*
    FNXC:UnclaimedGraphWork 2026-11-17-02:47 (RUFU-1050 code-review remediation, P1-2):
    Parsed, not passed through blindly: this reader is the ONLY way the pass learns what it already
    reported, and a field it drops is a bound that never engages — the announcement would re-fire every
    pass while the stored episode looked unchanged. Absent on an episode written before this pair existed,
    which the reporter reads as "never announced" rather than as silence.
    */
    lastAction: candidate.lastAction === "redrive" || candidate.lastAction === "rearm" || candidate.lastAction === "replan"
      || candidate.lastAction === "name-terminal" || candidate.lastAction === "none" ? candidate.lastAction : undefined,
    lastReportedAt: typeof candidate.lastReportedAt === "string" ? candidate.lastReportedAt : undefined,
  };
}

async function readItems(store: TaskStore, taskId: string): Promise<UnclaimedGraphWorkInput["items"]> {
  if (typeof store.listWorkflowWorkItemsForTask !== "function") return [];
  return (await store.listWorkflowWorkItemsForTask.call(store, taskId).catch(() => null)) ?? [];
}

/** Same preference the pure seam applies, needed here only to decide whether to probe the drain. */
function pickDecidingCandidate(
  items: UnclaimedGraphWorkInput["items"],
  column: string,
): UnclaimedGraphWorkInput["items"][number] | undefined {
  const active = items.filter((item) => ["runnable", "running", "held", "retrying"].includes(item.state));
  const planning = active.find((item) => item.waitReason === "planning" && item.sourceColumn === column)
    ?? active.find((item) => item.waitReason === "planning");
  if (planning) return planning;
  if (active.length > 0) return active.find((item) => item.sourceColumn === column) ?? active[0];
  const terminal = items.filter((item) => item.state === "failed" || item.state === "cancelled");
  return [...terminal].sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0))[0];
}

/**
 * Ask the drain's OWN filter whether this row is inside its FIFO page. Using the same store reader and
 * the same limit is the point: a release sentence about reachability must be decided by the measurement
 * the consumer actually applies, not by a second guess at what that consumer would see.
 */
async function dueWindowReaches(store: TaskStore, itemId: string, now: number): Promise<boolean> {
  const reader = (store as { listDueWorkflowWorkItems?: unknown }).listDueWorkflowWorkItems;
  if (typeof reader !== "function") return true;
  try {
    const page = await (reader as (filter: Record<string, unknown>) => Promise<Array<{ id: string }>>).call(store, {
      kinds: ["task"],
      states: DUE_POLL_STATES,
      limit: DUE_PLANNING_CONTINUATION_BATCH_LIMIT,
      now: new Date(now).toISOString(),
    });
    if (!Array.isArray(page)) return true;
    // A page shorter than the limit held every due row, so nothing can be behind it.
    if (page.length < DUE_PLANNING_CONTINUATION_BATCH_LIMIT) return true;
    return page.some((row) => row?.id === itemId);
  } catch {
    // An unreadable due window is not proof of starvation: answer "reachable" and let the decision
    // fall to the legs that do not depend on the drain's page.
    return true;
  }
}
