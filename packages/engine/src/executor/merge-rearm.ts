/**
 * Merge re-arm (RUFU-834) — the bounded re-entry owner for a review-lane card whose merge node died.
 *
 * FNXC:MergeNodeReArm 2026-11-21-10:35 (RUFU-834):
 * WHY THIS SEAM EXISTS. RUFU-308 established the rule this seam applies to the merge frontier: a
 * lifecycle MOVE changes a card's lane (or parks it) and stays governed by containment, while an
 * execution RE-ARM changes neither column nor status — it installs a claimable continuation at the node
 * that just died, so the graph re-enters the same node and containment has nothing to refuse. RUFU-308
 * shipped that authority for `step-execute` in the WIP lane only, and a card whose `merge` node died
 * terminally in a review lane falls in the gap between its two guards. Measured on RunFusion: RUFU-293
 * sat `in-review`, plan-review and code-review both approved, `mergeRetries = 0`, `error` empty, `status`
 * NULL, and its `merge` work item `failed` since 2026-10-16 — 14 days with zero `merge*` audit rows in a
 * two-hour sample — while 104 cards waited on its `file-scope:RUFU-293` reason (plus RUFU-281's 36 and
 * RUFU-369's 4, 144 `held` rows in total). One inert row became a board-wide planning freeze.
 *
 * WHY THE OLDERS CANNOT COVER IT (each is named so a future reader does not re-derive the gap):
 *  - the due-poll claims `runnable`/`retrying` only (`runtimes/in-process-runtime.ts` due pass);
 *  - `stranded-continuation-reclaim` refuses `failed` BY DESIGN, and widening it to terminal states would
 *    make it the terminal-row owner everywhere and erase the RUFU-272 capacity/pause discrimination;
 *  - `attemptExecutionRearm` refuses twice for this card — its WIP-lane guard and its `step-execute`
 *    node guard — and merging the two ladders would replace RUFU-308's "no step progress" ceiling with a
 *    coarser one;
 *  - the gate-node owners (FN-8492, FN-9243, FN-279) re-seed a GATE, never a merge.
 *
 * The action stays evidence-bound exactly where it must be: the work evidence for a merge re-entry is the
 * card's own unlanded delivery, so `hasStepWorkEvidence` (the shared per-repository checkout prover,
 * `occupied` as the only granting verdict) is REUSED rather than re-derived, and an `empty`/`unknown`
 * verdict refuses.
 */
import type { Task, TaskDetail, TaskStore } from "@fusion/core";
import {
  isPlanReviewSatisfied,
  MERGE_REARM_EPISODE_METADATA_KEY,
  resolveWorkflowIrForTaskWithProvenance,
  resolvePreMergeGateForTask,
  allowsAutoMergeProcessing,
  getTaskMergeBlocker,
  isMergeRegionNode,
  isWorkspaceTask,
  type WorkflowWorkItem,
} from "@fusion/core";
import type { CheckoutEmptinessProver } from "../worktree/checkout-emptiness.js";
import { hasStepWorkEvidence } from "./execution-rearm.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { generateSyntheticRunId, type EngineRunContext } from "../util/run-audit.js";
import { resolveInertMergeReentryCandidate } from "./merge-rearm-candidate.js";

/*
FNXC:MergeNodeReArm 2026-11-21-11:35 (RUFU-834):
The episode key is IMPORTED from `@fusion/core`, never re-spelled here. That is RUFU-1050's rule, and it is
what makes `buildManualRetryResetPatch` able to clear this ladder: the shared reset lives in core, core
cannot import the engine, and a second literal in this file would silently be a second key — a Retry that
nulls one while the sweep reads the other is precisely the "Retry stopped being an exit" shape RUFU-395 and
RUFU-1027 each measured once. `execution-rearm.ts` imports its sibling key the same way.

FNXC:MergeNodeReArm 2026-11-21-10:35 (RUFU-834):
The budget carrier is `sourceMetadata[MERGE_REARM_EPISODE_METADATA_KEY]`, written KEY-level through
`updateTaskAtomic.sourceMetadataPatch`, and it is NEVER `mergeDetails`. That is the load-bearing
constraint of this whole module: `cleanupMergeStateForReverification` legitimately writes
`mergeDetails: null` plus `mergeRetries: 0` on the stale-merge-state path, and RUFU-1027 measured the
result of putting a lifecycle bound there — 327 re-arms in 24 h, every one reporting `attempt: 1`,
because the writer of the counter and the writer that nulls it are not one transaction. A bound that a
cleanup can wipe is not a bound. The episode is cleared only by its declared owners: operator/agent
Retry (`buildManualRetryResetPatch`), a genuine forward move that changes the signature, or deletion.
*/

/*
Re-exported so engine-side callers (the sweep, tests) have one name to import, and that name is the core
constant above rather than a copy of it.
*/
export { MERGE_REARM_EPISODE_METADATA_KEY };

export interface MergeRarmMarker {
  /** Identity of the durable question being retried; see `mergeRarmSignature`. */
  signature: string;
  attempt: number;
  refusal: number;
  firstAt: string;
  at: string;
  /** Set when the ladder is held; cleared only by Retry or a changed signature. */
  heldAt: string | null;
  /**
   * The terminal park's own proof. Deliberately separate from `heldAt`: RUFU-1028 established that a
   * standing park must be proved from the DURABLE EPISODE and not from `status`/`error`, which belong to
   * every writer on the board — `cleanupMergeStateForReverification` alone nulls both. A park keyed on
   * the row columns released itself the moment an unrelated cleanup cleared the badge it was announced
   * in, which is how RUFU-583 looped 44 times after declaring exhaustion.
   */
  terminalAt?: string | null;
}

function isMergeRarmMarker(value: unknown): value is MergeRarmMarker {
  return !!value && typeof value === "object"
    && typeof (value as MergeRarmMarker).signature === "string";
}

/** Read this seam's ladder. A card that never hit this shape has no marker and starts at zero. */
export function readMergeRarmMarker(task: Pick<Task, "sourceMetadata"> | undefined): MergeRarmMarker | undefined {
  const episode = task?.sourceMetadata?.[MERGE_REARM_EPISODE_METADATA_KEY];
  return isMergeRarmMarker(episode) ? episode : undefined;
}

/** Key-level patch — replaces only this episode's key, so every other provenance key survives untouched. */
function mergeRarmPatch(marker: MergeRarmMarker): Record<string, unknown> {
  return { [MERGE_REARM_EPISODE_METADATA_KEY]: marker };
}

/*
FNXC:MergeNodeReArm 2026-11-21-11:05 (RUFU-834):
These two bounds are the SEVENTH merge-related counter in this codebase and every one of them answers a
different question, which is why none of them may be folded into another:
 - `mergeRetries` (and the `maxAutoMergeRetries` setting that caps it) counts merge ATTEMPTS inside one
   live run — `routeGraphMergeFailureToRetry` spends it while the graph is still driving the node. This
   ladder starts only after that run is gone, so the two never overlap in time and a shared counter would
   let in-run backoff consume the post-run re-entries (or the reverse).
 - `MAX_TRANSIENT_MERGE_RECOVERIES` (`healing/self-healing-constants.ts`) bounds re-queues of a card whose
   `status` is `failed` with a transient merge error. It claims OFF the status field; this seam's whole
   premise is a card with `status` NULL and no error at all, which that lane never selects.
 - RUFU-308's `MAX_EXECUTION_REARM_ATTEMPTS` bounds "the step made no progress" on a different node class
   and a different lane, and RUFU-834's key separation in core keeps the two ledgers apart.
Attempts are the grants that actually re-ran the merge; refusals are this sweep's own repetition on a card
with nothing to merge, bounded higher because a refusal is not a burn and the sweep runs every pass.
*/
/** Grants allowed for one unchanged question before the card is terminalized once. */
export const MAX_MERGE_REARM_ATTEMPTS = 4;
/**
 * Refusals tolerated on an unchanged question before the same single terminalization. Higher than the
 * grant budget because a refusal is not a burn — it is this sweep's own repetition, and the sweep runs on
 * every maintenance pass.
 */
export const MAX_MERGE_REARM_REFUSALS = 12;

/**
 * FNXC:MergeNodeReArm 2026-11-21-10:35 (RUFU-834):
 * How long a `failed` merge row must have been dead before this seam may touch it. The in-graph merge
 * failure path (`routeGraphMergeFailureToRetry`) owns the immediate retry and spends `mergeRetries`;
 * racing it would spend a second budget on the same failure and re-run a merge the graph is already
 * backing off from. The horizon is read off the FAILED ROW's own `updatedAt`, never `task.updatedAt`,
 * which every writer on the board bumps.
 */
export const MERGE_REARM_GRACE_MS = 5 * 60_000;

/** Prefix of the one-shot terminal park's error sentence — the operator-visible marker. */
export const MERGE_REARM_EXHAUSTED_PREFIX = "MERGE_REARM_EXHAUSTED";

/**
 * The closed refusal vocabulary. Every value names an owner, either in this module's comment or in the
 * candidate resolver's; no verdict is a dead end.
 */
export type MergeRarmVerdict =
  | "eligible"
  | "not-review-lane"
  | "active-work-exists"
  | "live-session"
  | "no-failed-merge-item"
  | "failure-belongs-to-gate"
  | "gate-not-approved"
  | "merge-blocker-present"
  | "human-merge-hold"
  | "auto-merge-withheld"
  | "already-landed"
  | "no-own-work"
  | "lease-held-by-other"
  | "workspace-owned-elsewhere"
  | "suppressed-paused"
  | "too-young"
  | "sentinel-already-parked";

export type MergeRarmOutcome =
  /** A claimable continuation was installed at the dead merge node. */
  | "rearmed"
  /** The store refused because an active row appeared between classification and write: no mutation. */
  | "raced"
  /** The bounded budget is spent; the card is terminalized and announced once. */
  | "parked"
  /** Refused before any write; `verdict` names why. */
  | "refused";

export interface MergeRarmDeps {
  store: TaskStore;
  getRunContextFor?: (taskId: string) => EngineRunContext | undefined;
  /** FN-8492's liveness triple (registry path, executing lock, executor-active) supplied by the caller. */
  hasLiveExecutionSurface?: (taskId: string) => boolean;
  /** Injectable so evidence behavior is testable without a real worktree. */
  emptinessProver?: CheckoutEmptinessProver;
  now?: () => number;
}

export interface MergeRarmResult {
  outcome: MergeRarmOutcome;
  verdict: MergeRarmVerdict;
  detail: string;
  nodeId?: string | null;
  attempt?: number;
}

function rowTimeMs(row: Pick<WorkflowWorkItem, "updatedAt" | "createdAt">): number {
  const updated = Date.parse(row.updatedAt ?? "");
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(row.createdAt ?? "");
  return Number.isFinite(created) ? created : 0;
}

/*
FNXC:MergeNodeReArm 2026-11-21-10:35 (RUFU-834):
The episode identity, and what may NOT sit in it. RUFU-1027's defect was a signature computed from fields
the bounded loop itself rewrites; RUFU-1028's was a park keyed on a token that flipped between polls. Both
classes are excluded here by construction:
  - NO work-item row id: `replaceActiveTaskWorkflowContinuation` deletes the colliding terminal row at the
    exact key and `upsertWorkflowWorkItem` mints `existing?.id ?? input.id ?? randomUUID()`, so a row id
    would make every re-entry a fresh episode.
  - NO branch tip SHA or worktree path: the merge itself moves both.
  - NOTHING from `mergeDetails`: the stale-merge-state cleanup nulls the whole object.
  - NO full `workflowStepResults` ledger. `preservePreExecutionWorkflowStepResults` keeps ONLY the
    `plan-review` row, so a code-review `passed` row disappears when that cleanup runs, and a stamp
    reading it would restart the ladder on every merge reset — RUFU-1028's own test caught exactly this.
The two ledger halves the cleanup cannot touch are `isPlanReviewSatisfied` (which it preserves and even
reconstructs) and the completed-step count from `task.steps` (which it never names), so those are the
ledger the identity reads. The gate APPROVAL state stays an admission check, not an identity.
*/
export function mergeRarmSignature(input: {
  taskId: string;
  workflowId: string | null;
  mergeFrontierNodeIds: readonly string[];
  nodeId: string;
  task: Pick<Task, "workflowStepResults" | "steps">;
}): string {
  const frontier = [...input.mergeFrontierNodeIds].sort().join("+");
  const planReviewSatisfied = (input.task.workflowStepResults ?? []).some((result) => isPlanReviewSatisfied(result));
  const completedSteps = (input.task.steps ?? []).filter((step) => step.status === "done").length;
  return [
    "merge-rearm",
    input.taskId,
    input.workflowId ?? "no-selection",
    frontier,
    input.nodeId,
    planReviewSatisfied ? "plan-review-satisfied" : "plan-review-none",
    String(completedSteps),
  ].join(":");
}

/**
 * Pure admission classifier over caller-resolved facts. Kept free of stores so every verdict is
 * unit-testable and so the sweep's coverage cannot drift from the predicate it applies.
 *
 * Order is fail-closed and meaningful: an operator hold is answered before anything is measured, then
 * the lane and row shape, then the merge-specific doors, then the delivery/liveness proofs.
 */
export function classifyInertMergeReentry(input: {
  task: TaskDetail;
  workItems: readonly WorkflowWorkItem[];
  irMergeNodeIds: ReadonlySet<string>;
  reviewColumns: ReadonlySet<string>;
  requiredPreMergeStepIds: ReadonlySet<string>;
  nowMs: number;
  graceMs?: number;
  /** A live session/executor already owns the card (FN-8492's triple, supplied by the caller). */
  hasLiveExecutionSurface?: boolean;
  /** Resolved merge-door blocker (`getTaskMergeBlocker`'s answer), or null when the door is clear. */
  mergeBlocker?: string | null;
  /** Resolved auto-merge authority (`allowsAutoMergeProcessing`). False is FN-5147's terminal-until-merged hold. */
  autoMergeAllowed?: boolean;
}): { verdict: MergeRarmVerdict; detail: string; nodeId: string | null } {
  const { task } = input;
  const refuse = (verdict: MergeRarmVerdict, detail: string) => ({ verdict, detail, nodeId: null });

  if (task.deletedAt) return refuse("suppressed-paused", "the card is soft-deleted");
  if (task.paused === true || task.userPaused === true) {
    return refuse("suppressed-paused", "a human holds the card");
  }
  /*
  The terminal park is idempotent: while `terminalAt` stands on the episode, a later pass writes no row,
  no History line, and no audit record. The proof is the durable episode and never `status`/`error`, per
  the RUFU-1028 rule stated on `MergeRarmMarker.terminalAt`.
  */
  if (readMergeRarmMarker(task)?.terminalAt) {
    return refuse("sentinel-already-parked", "the terminal merge re-arm park already stands on the card");
  }
  if (isWorkspaceTask(task)) {
    /*
    A workspace card's merge is not one transaction: it is the per-repository land (`landOneRepo` /
    `landSquash`) under the workspace-lease fences, and its teardown and partial-land recovery are owned
    by FN-9056 / RUFU-476 / FN-9058. Re-seeding a singular task continuation onto that card would drive
    the merge through the lane that cannot see the other repositories, so the boundary is drawn here and
    named, not left as a silent gap.
    */
    return refuse("workspace-owned-elsewhere", "a workspace card's per-repository land is owned by the workspace lane (FN-9056 / FN-9058), not by a singular merge re-entry");
  }

  const candidate = resolveInertMergeReentryCandidate({
    task,
    workItems: input.workItems,
    irMergeNodeIds: input.irMergeNodeIds,
    reviewColumns: input.reviewColumns,
  });
  if (!candidate.eligible) {
    const detail: Record<Exclude<typeof candidate.reason, "eligible">, string> = {
      "not-review-lane": `the card rests in '${task.column}', which its own workflow does not resolve as a review lane`,
      "active-work-exists": "an active continuation already owns this card",
      "live-session": "a running row or live session still owns the card",
      "no-failed-merge-item": "no failed work item exists at any node",
      "failure-belongs-to-gate": "the newest failed row belongs to a review gate or the step frontier, which has its own owner",
      "human-merge-hold": "a held row waits on an operator merge decision (`releaseHumanMergeApprovalHolds` owns it)",
      "lease-held-by-other": "a held row waits on another card's file-scope lease (`releaseFileScopeWaitingContinuations` owns it)",
    };
    const reason = candidate.reason as Exclude<typeof candidate.reason, "eligible">;
    return refuse(reason, detail[reason]);
  }
  if (input.hasLiveExecutionSurface) return refuse("live-session", "a live execution session still owns the card");

  const failedAt = rowTimeMs(candidate.failedRow!);
  const ageMs = input.nowMs - failedAt;
  if (ageMs < (input.graceMs ?? MERGE_REARM_GRACE_MS)) {
    return refuse("too-young", `the failed merge row is ${Math.max(0, Math.round(ageMs / 1000))}s old; the in-graph merge retry still owns it`);
  }

  /*
  The merge door is asked through the same authority the merger uses, so this seam can never disagree
  with the door it is trying to open. `reviewColumns` is passed so the blocker resolves against THIS
  card's own workflow lanes rather than a built-in literal.
  */
  const blocker = input.mergeBlocker ?? null;
  if (blocker) return refuse("merge-blocker-present", `the merge door is closed: ${blocker}`);
  if (input.autoMergeAllowed === false) {
    return refuse("auto-merge-withheld", "auto-merge is withheld for this card (FN-5147), so `in-review` is terminal until a human merges it");
  }

  const gateLedger = gateLedgerState(task, input.requiredPreMergeStepIds);
  if (gateLedger.unapproved.length > 0) {
    return refuse("gate-not-approved", `required pre-merge gates are not approved (${gateLedger.unapproved.join(",")}); the gate owners (FN-8492 / FN-9243 / FN-279) own that row`);
  }

  /*
  A delivery that is already on the base branch has no merge left to run: RUFU-396's
  `reconcileLandedReviewTask` is the owner of an already-landed card, and re-running its merge would
  re-author a land for content that is already published.
  */
  if (task.mergeDetails?.mergeConfirmed === true) {
    return refuse("already-landed", "the card's delivery is already confirmed landed; RUFU-396 owns its close-out");
  }
  return { verdict: "eligible", detail: "eligible for one bounded merge re-entry", nodeId: candidate.mergeNodeId };
}

/** Which required pre-merge gates are approved, expressed from the card's own ledger. */
export function gateLedgerState(
  task: Pick<Task, "workflowStepResults">,
  requiredPreMergeStepIds: ReadonlySet<string>,
): { unapproved: string[] } {
  const unapproved: string[] = [];
  for (const stepId of requiredPreMergeStepIds) {
    const latest = latestStepResult(task, stepId);
    const approved = latest?.status === "passed" || latest?.verdict === "APPROVE";
    const waived = typeof latest?.bypassedBy === "string" && latest.bypassedBy.length > 0;
    if (!approved && !waived) unapproved.push(`${stepId}:${latest?.status ?? "none"}`);
  }
  return { unapproved: unapproved.sort() };
}

/** The newest result row for one gate id — a gate may legitimately have several historical rows. */
function latestStepResult(task: Pick<Task, "workflowStepResults">, stepId: string) {
  const rows = (task.workflowStepResults ?? []).filter((result) => result.workflowStepId === stepId);
  if (rows.length === 0) return undefined;
  return rows.reduce((newest, row) => {
    const at = (candidate: { completedAt?: string; startedAt?: string }) =>
      Date.parse(candidate.completedAt ?? candidate.startedAt ?? "") || 0;
    return at(row) >= at(newest) ? row : newest;
  }, rows[0]!);
}

/** Resolve the facts the classifier needs. Every read falls back to a refusal-shaped default, never a guess. */
export async function resolveMergeRarmFacts(
  store: TaskStore,
  task: TaskDetail,
): Promise<{
  irMergeNodeIds: Set<string>;
  reviewColumns: Set<string>;
  requiredPreMergeStepIds: Set<string>;
  workflowId: string | null;
  mergeFrontierNodeIds: string[];
  mergeBlocker: string | null;
  autoMergeAllowed: boolean;
}> {
  // The provenance form is used rather than the bare IR reader because the episode identity names the
  // SELECTED workflow: an operator who re-points the card at a different workflow is asking a different
  // question and must earn a fresh ladder, while the same workflow re-read must not.
  const resolved = await resolveWorkflowIrForTaskWithProvenance(store, task.id).catch(() => undefined);
  const ir = resolved?.ir;
  const mergeFrontierNodeIds = ir && Array.isArray(ir.nodes)
    ? ir.nodes.filter((node) => isMergeRegionNode(node)).map((node) => node.id)
    : [];
  const gate = await resolvePreMergeGateForTask(store, task.id, task.enabledWorkflowSteps, task).catch(() => null);
  const settings = await store.getSettings?.().catch(() => undefined);
  return {
    irMergeNodeIds: new Set(mergeFrontierNodeIds),
    reviewColumns: new Set(gate?.reviewColumns ?? []),
    requiredPreMergeStepIds: new Set(gate?.requiredPreMergeStepIds ?? []),
    workflowId: resolved?.workflowId ?? null,
    mergeFrontierNodeIds,
    mergeBlocker: getTaskMergeBlocker(task, { reviewColumns: gate?.reviewColumns }) ?? null,
    autoMergeAllowed: settings ? allowsAutoMergeProcessing(task, settings) : true,
  };
}

/**
 * Atomically claim one grant or one refusal for an unchanged question, re-validating the live row under
 * the shared per-task advisory lock — the same fence shape `claimRearmSlot` (RUFU-308) uses, so a pause,
 * a lane change, or genuine step progress during the reads makes the claim, and therefore the seed, not
 * happen. The claim is confirmed by reading the written marker back.
 */
async function claimMergeRarmSlot(
  deps: MergeRarmDeps,
  input: { taskId: string; reviewColumn: string },
  signature: string,
  kind: "attempt" | "refusal",
): Promise<{ allowed: boolean; attempts: number; refusals: number; held: boolean; parked: boolean; liveChanged: boolean }> {
  const now = deps.now?.() ?? Date.now();
  const at = new Date(now).toISOString();
  const failed = { allowed: false, attempts: 0, refusals: 0, held: false, parked: false, liveChanged: false };
  let alreadyParked = false;
  try {
    const updated = await deps.store.updateTaskAtomic(input.taskId, (current) => {
      if (!current || current.deletedAt) return null;
      if (current.paused === true || current.userPaused === true) return null;
      if (current.column !== input.reviewColumn) return null;
      const prior = readMergeRarmMarker(current);
      if (prior?.terminalAt) {
        alreadyParked = true;
        return null;
      }
      const unchanged = prior?.signature === signature && prior.heldAt == null;
      const attempts = (unchanged ? prior?.attempt ?? 0 : 0) + (kind === "attempt" ? 1 : 0);
      const refusals = (unchanged ? prior?.refusal ?? 0 : 0) + (kind === "refusal" ? 1 : 0);
      const exhausted = attempts > MAX_MERGE_REARM_ATTEMPTS || refusals > MAX_MERGE_REARM_REFUSALS;
      return {
        sourceMetadataPatch: mergeRarmPatch({
          signature,
          attempt: attempts,
          refusal: refusals,
          firstAt: unchanged ? prior?.firstAt ?? at : at,
          at,
          heldAt: exhausted ? at : null,
          terminalAt: prior?.terminalAt ?? null,
        }),
      };
    }, deps.getRunContextFor?.(input.taskId));
    if (alreadyParked) return { allowed: false, attempts: 0, refusals: 0, held: true, parked: true, liveChanged: false };
    const marker = readMergeRarmMarker(updated);
    if (!marker || marker.at !== at) return { ...failed, liveChanged: true };
    if (marker.heldAt === at) {
      return { allowed: false, attempts: marker.attempt, refusals: marker.refusal, held: true, parked: false, liveChanged: false };
    }
    return { allowed: true, attempts: marker.attempt, refusals: marker.refusal, held: false, parked: false, liveChanged: false };
  } catch {
    // A failed claim is never permission: the caller leaves the card exactly as it found it.
    return failed;
  }
}

/*
FNXC:RunAudit 2026-11-21-10:35 (RUFU-834):
A merge re-arm writes no lifecycle row, so the audit row is the only durable record that the re-entry was
granted and on what evidence. Metadata stays ids/counts/fixed enums: the checkout verdict is the fixed
`empty|occupied|unknown` enum expressed as a boolean grant, never a path, a diff, a SHA, or error prose.
Emission goes through the FN-9175 bounded seam, so telemetry can never become the reason a merge did not
re-run.
*/
function emitMergeRearmAudit(
  deps: MergeRarmDeps,
  taskId: string,
  mutationType: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const runContext = deps.getRunContextFor?.(taskId);
  return emitBoundedRunAudit(deps.store, {
    taskId,
    agentId: runContext?.agentId ?? "self-healing",
    runId: runContext?.runId ?? generateSyntheticRunId("merge-rearm", taskId),
    domain: "database",
    mutationType,
    target: taskId,
    metadata: { taskId, ...metadata },
  });
}

/** The one-shot terminal park: `failed` plus a sentinel sentence, announced exactly once. */
async function terminalizeMergeRarmBudget(
  deps: MergeRarmDeps,
  task: TaskDetail,
  nodeId: string | null,
  detail: string,
  signature: string,
): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const at = new Date(now).toISOString();
  /*
  Re-read the LIVE row rather than trusting the snapshot this pass started with. The claim that decided
  exhaustion wrote the ladder a moment ago, so reading the stale snapshot would report the numbers from
  BEFORE the burning pass — an exhaustion row saying `refusal: 12` for a budget declared at 12, which is
  precisely the un attributable ceiling report RUFU-1027's investigation had to unwind.
  */
  const live = await deps.store.getTask(task.id).catch(() => task) ?? task;
  const prior = readMergeRarmMarker(live);
  const message = `Merge re-arm budget exhausted at node '${nodeId ?? "unknown"}' — ${detail}. Card left in '${live.column}' for operator action (Retry re-arms the same node; no further automatic re-arms).`;
  await deps.store.updateTask(task.id, {
    status: "failed",
    error: `${MERGE_REARM_EXHAUSTED_PREFIX}: ${detail}`,
    sourceMetadataPatch: mergeRarmPatch({
      signature: prior?.signature ?? signature,
      attempt: prior?.attempt ?? 0,
      refusal: prior?.refusal ?? 0,
      firstAt: prior?.firstAt ?? at,
      at,
      heldAt: at,
      terminalAt: at,
    }),
  }, deps.getRunContextFor?.(task.id)).catch(() => undefined);
  // `logEntryOnce` is the durable dedupe the History surface needs; an in-process set would restart the
  // notice on every engine restart, which is how a bounded loop silently becomes an unbounded one.
  await deps.store.logEntryOnce(task.id, {
    action: message,
    outcome: "merge-rearm-exhausted",
    dedupeKey: `merge-rearm-exhausted:${task.id}:${nodeId ?? "unknown"}`,
    windowMs: 6 * 60 * 60 * 1000,
  }).catch(() => undefined);
  await emitMergeRearmAudit(deps, task.id, "task:merge-rearm-exhausted", {
    nodeId: nodeId ?? "unknown",
    attempt: prior?.attempt ?? 0,
    refusal: prior?.refusal ?? 0,
    attemptLimit: MAX_MERGE_REARM_ATTEMPTS,
    refusalLimit: MAX_MERGE_REARM_REFUSALS,
    column: live.column,
    outcome: "exhausted",
  });
}

/**
 * Re-enter the dead merge node in place: no column move, no status write on the grant path, and exactly
 * one terminalization when the budget is spent.
 *
 * The installed state is `retrying` with a bounded `retryAfter`, which is the deliberate difference from
 * RUFU-308's plain `runnable`. Both are claimable — the drain filters `states:["runnable","retrying"]`
 * and `listDueWorkflowWorkItems` admits a row when `retryAfter IS NULL OR retryAfter <= now` — but a
 * merge that re-fails immediately (its blocker is usually still standing) would burn all four grants
 * inside one ~2 s drain tick, making the ceiling a bound on SPEED rather than on attempts. `retryAfter`
 * puts real, durable time between grants and survives a restart.
 *
 * The seed's `runId` is attempt-scoped on purpose: `replaceActiveTaskWorkflowContinuation` deletes the
 * colliding terminal row at the exact `(runId, taskId, nodeId, kind)` key, so reusing the failed row's
 * own run id would erase the evidence this seam exists to act on. A fresh key leaves the `failed` row in
 * place as history while the new row carries the re-entry.
 */
export async function attemptMergeRearm(
  deps: MergeRarmDeps,
  input: { taskId: string; graceMs?: number },
): Promise<MergeRarmResult> {
  const task = await deps.store.getTask(input.taskId);
  if (!task || task.deletedAt) {
    return { outcome: "refused", verdict: "suppressed-paused", detail: "the card is gone", nodeId: null };
  }
  const facts = await resolveMergeRarmFacts(deps.store, task);
  const reviewColumn = task.column;
  const verdict = classifyInertMergeReentry({
    task,
    workItems: typeof deps.store.listWorkflowWorkItemsForTask === "function"
      ? await deps.store.listWorkflowWorkItemsForTask(task.id, { kinds: ["task"] }).catch(() => [])
      : [],
    irMergeNodeIds: facts.irMergeNodeIds,
    reviewColumns: facts.reviewColumns,
    requiredPreMergeStepIds: facts.requiredPreMergeStepIds,
    nowMs: deps.now?.() ?? Date.now(),
    graceMs: input.graceMs,
    hasLiveExecutionSurface: deps.hasLiveExecutionSurface?.(task.id) === true,
    mergeBlocker: facts.mergeBlocker,
    autoMergeAllowed: facts.autoMergeAllowed,
  });
  if (verdict.verdict === "sentinel-already-parked") {
    // Idempotent: an existing park is honored verbatim — no second write, no second notice — so "exactly
    // one operator notice" survives an unbounded number of maintenance passes.
    return { outcome: "parked", verdict: verdict.verdict, detail: verdict.detail, nodeId: null };
  }

  const nodeId = verdict.nodeId;
  if (verdict.verdict !== "eligible") {
    /*
    Nothing is counted for a refusal that is not this seam's own repetition. RUFU-308 established the
    rule: eligibility answers return BEFORE the ladder is touched, because `too-young`,
    `active-work-exists`, and `live-session` are transient states of a card that is genuinely progressing,
    and a counter that burns on them terminalizes healthy work. Only this seam's own repeated refusal —
    "eligible, but the checkout shows no unlanded delivery to merge" — is bounded here.
    */
    return { outcome: "refused", verdict: verdict.verdict, detail: verdict.detail, nodeId };
  }

  const signature = mergeRarmSignature({
    taskId: task.id,
    workflowId: facts.workflowId,
    mergeFrontierNodeIds: facts.mergeFrontierNodeIds,
    nodeId: nodeId ?? "unknown",
    task,
  });

  /*
  The evidence gate: `occupied` is the granting verdict — a card with no unlanded delivery of its own has
  nothing for a merge to publish, and RUFU-396's landed sweep plus the zero-own-commit lanes own that
  shape. `empty` and `unknown` count as REFUSALS, which is the inverse polarity of every other prover
  consumer and the same one RUFU-308 documents: here `occupied` is the only verdict that grants, so a
  missing verdict can never author a re-entry.
  */
  const evidence = await hasStepWorkEvidence({ store: deps.store, emptinessProver: deps.emptinessProver, now: deps.now }, task);

  const claim = await claimMergeRarmSlot(
    deps,
    { taskId: task.id, reviewColumn },
    signature,
    evidence.hasEvidence ? "attempt" : "refusal",
  );
  if (!claim.allowed) {
    if (claim.parked) return { outcome: "parked", verdict: "sentinel-already-parked", detail: "the terminal merge re-arm park already stands on the card", nodeId };
    if (claim.liveChanged) return { outcome: "refused", verdict: "active-work-exists", detail: "the card changed under recovery", nodeId };
    if (claim.held) {
      await terminalizeMergeRarmBudget(
        deps, task, nodeId,
        evidence.hasEvidence
          ? `${MAX_MERGE_REARM_ATTEMPTS} merge re-arms delivered nothing`
          : `${MAX_MERGE_REARM_REFUSALS} passes found no unlanded delivery to merge`,
        signature,
      );
      return { outcome: "parked", verdict: "no-own-work", detail: "merge re-arm budget exhausted", nodeId, attempt: claim.attempts };
    }
    return { outcome: "refused", verdict: verdict.verdict, detail: "the merge re-arm claim could not be written", nodeId };
  }

  if (!evidence.hasEvidence) {
    return {
      outcome: "refused",
      verdict: "no-own-work",
      detail: `checkout proves no unlanded commit or in-progress diff (${evidence.verdicts}); refusal ${claim.refusals}/${MAX_MERGE_REARM_REFUSALS}`,
      nodeId,
    };
  }

  const now = deps.now?.() ?? Date.now();
  const retryAfter = new Date(now + MERGE_REARM_GRACE_MS).toISOString();
  try {
    await deps.store.replaceActiveTaskWorkflowContinuation({
      taskId: task.id,
      runId: `${task.id}:merge-rearm:${nodeId}:${claim.attempts}`,
      nodeId: nodeId!,
      kind: "task",
      // Claimable now: `retrying` is in the drain's state filter and `retryAfter` only gates WHEN.
      state: "retrying",
      attempt: 1,
      retryAfter,
      blockedReason: `merge-rearm:inert-failed-merge-node`,
      lastError: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      onlyIfNoActiveTaskContinuation: true,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "ActiveTaskContinuationError") {
      /*
      A concurrent owner installed an active continuation between classification and write. Nothing was
      mutated and nothing is terminalized — the re-entry is not owed to this seam, and the alternative
      (terminalizing "whatever it was that collided") is the destructive reflex `replaceActiveTaskWorkflowContinuation`
      exists to prevent.
      */
      return { outcome: "raced", verdict: "active-work-exists", detail: `an active continuation took '${nodeId}' first`, nodeId, attempt: claim.attempts };
    }
    return { outcome: "refused", verdict: "active-work-exists", detail: error instanceof Error ? error.message : String(error), nodeId };
  }

  /*
  Past the seed the card already has its re-entry, so a marker/status write that fails must not be
  reported as "not handled" — a caller that parked the card here would fail a card the scheduler is about
  to dispatch. This is the RUFU-308 boundary: the grant is the seed, and nothing downstream of it may
  retract the grant.

  FNXC:MergeNodeReArm 2026-11-21-11:05 (RUFU-834):
  This write clears the failure MARKER and sets nothing: no `column`, no `paused`, no `mergeRetries`,
  `mergeConfirmed`, `worktree`, `branch` or `mergeDetails`. It is the byte-for-byte sibling of RUFU-308's
  post-seed write (`execution-rearm.ts`, markersCleared), and it exists for the same reason — a card the
  scheduler is about to dispatch must not still wear the badge of the run that just died, because that
  badge is what makes every other recovery lane classify it as already terminalized.
  */
  let markersCleared = true;
  try {
    await deps.store.updateTask(task.id, { status: null, error: null }, deps.getRunContextFor?.(task.id));
  } catch {
    markersCleared = false;
  }
  const message = `Merge re-arm: re-entering node '${nodeId}' in place (attempt ${claim.attempts}/${MAX_MERGE_REARM_ATTEMPTS}) — unlanded delivery proven, same node and lane, no lifecycle move${markersCleared ? "" : "; the failure marker could not be cleared, so the card keeps its error text"}`;
  await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor?.(task.id)).catch(() => undefined);
  await emitMergeRearmAudit(deps, task.id, "task:merge-rearmed", {
    nodeId: nodeId!,
    reason: "inert-failed-merge-node",
    attempt: claim.attempts,
    attemptLimit: MAX_MERGE_REARM_ATTEMPTS,
    evidence: "occupied",
    outcome: "rearmed",
  });
  return { outcome: "rearmed", verdict: "eligible", detail: message, nodeId, attempt: claim.attempts };
}
