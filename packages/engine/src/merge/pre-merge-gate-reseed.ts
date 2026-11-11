/*
FNXC:PreMergeApproval 2026-09-02-10:36:
FN-9243 repairs resultless enabled pre-merge gates by seeding the earliest missing gate, never by
inventing a verdict or moving a review-lane card backward. The idle seed lets the real gate inspect
current content and produce its own genuine result.

FNXC:LifecycleContainment 2026-09-02-22:41:
RUFU-178: the seeded continuation's targetColumn must be a column the card will ACTUALLY stand in.
A plan-review gate authored in the planning lane would otherwise make a review-lane card's
continuation name `todo` — a position the boundary refuses to move it to (backward review-gate
entries enter in place). Clamping through the shared `clampReviewGateEntry` keeps the seed honest:
when the node-column entry would be backward, the continuation names the card's current column.

FNXC:VerdictlessFailedGate 2026-09-14-13:32 (RUFU-217, AC2):
The seedable set widens from `missing` to `missing ∪ verdict-less-failed`. A required gate whose
latest row failed with NO authored verdict is a plumbing death (crashed session, FN-8492 orphan
rewrite, FN-279 stripped approval), not a reviewer REVISE; the merge door still refuses it — this
lane only guarantees it gets a fresh real run instead of terminalizing as a deadlock park. The
earliest seedable gate in IR order wins, so a genuinely-missing gate keeps precedence over a later
verdict-less one. Remaining guards (RUFU-391 widened exactly two of them): operator-held cards
excluded, idle-only seeding (an active continuation never gets doubled), and the RUFU-276 bounded-rerun
budget. Content kind and workspace membership are NO LONGER guards here — see
FNXC:NoVerdictWorkspaceSeed below for why this seed never needed them.
A verdict-less target consumes a per-(task, gate) rerun budget counted from fixed-marker task-log
entries (see `MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS`); a missing target stays idle-only and unbudgeted
exactly as FN-9243 shipped it, so that lane's behavior is byte-stable.

FNXC:VerdictlessRerunEpisode 2026-10-22-17:13:
That budget is scoped to one review EPISODE, not to the card's lifetime. The original wording said
"persistent", and persistent-without-a-boundary is what left 10 of 14 rtm3 `in-review` cards dead after
an operator Retry that had already reset a different budget. See
FNXC:VerdictlessRerunEpisode below for the marker, who may write it, and why the unattended bound is
unchanged.
*/
import {
  ACTIVE_WORKFLOW_WORK_ITEM_STATES,
  clampReviewGateEntry,
  computeWorkflowIrPin,
  PRE_MERGE_STEPS_NOT_RUN_BLOCKER,
  evaluatePreMergeApprovals,
  findUnrunRequiredPreMergeStepIds,
  IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
  isPreMergeStepsNotRunRefusal,
  isWorkspaceTask,
  resolveWorkflowIrForTask,
  type MergeContentDescriptor,
  type Task,
  type WorkflowStepResult,
  type TaskLogEntry,
  type TaskStore,
  type WorkflowWorkItem,
} from "@fusion/core";
import { AUTO_MERGE_RETRY_REJECTED_PREFIX } from "./stale-content-park.js";

/**
 * Error prefix the in-review stall-deadlock disposition stamps. Single-sourced here because both the
 * recovery lane below and `SelfHealingManager` must recognise the SAME parked shape: a park whose
 * `error` was overwritten by a later, unrelated failure is not this class and stays operator-owned.
 */
export const IN_REVIEW_STALL_DEADLOCK_ERROR_PREFIX = "In-review stall deadlock: ";

/**
 * True only for the park the engine authored for itself: the stall disposition's pause marker, its own
 * error sentence still on the row, and no operator hold. The pause marker alone is not enough — a park
 * whose `error` was later replaced by an unrelated failure is no longer this class, and lifting it
 * would discard a real failure the operator must see.
 *
 * FNXC:NoVerdictStallParkAdmission 2026-09-28-09:15 (RUFU-391): single-sourced because the recovery
 * sweep's candidate filter and the seed lane's own guard must admit the identical class — a card that
 * satisfies one and not the other would be re-seeded forever without ever lifting its park.
 */
export function isEngineAuthoredInReviewStallPark(
  task: Pick<Task, "paused" | "userPaused" | "pausedReason" | "error">,
): boolean {
  if (task.paused !== true || task.userPaused === true) return false;
  if (task.pausedReason !== IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON) return false;
  return !task.error || task.error.startsWith(IN_REVIEW_STALL_DEADLOCK_ERROR_PREFIX);
}

export type UnrunPreMergeGateRerouteReason =
  | "seeded"
  | "verdictless-seeded"
  | "rerun-budget-exhausted"
  | "active-continuation"
  /*
  FNXC:ContinuationHoldBudget 2026-11-11-10:33 (RUFU-490):
  The same standing holder as `active-continuation`, reached for the first time after its one strike was
  already recorded, so a consumer that treats a transient wait as nothing-to-see cannot swallow a refusal
  that has spent its budget. It is a sibling of `rerun-budget-exhausted`, never an alias: that names
  deaths of the gate itself, this names holders that never let the gate run, and no consumer maps one
  onto the other.
  */
  | "continuation-hold-budget-exhausted"
  | "no-unrun-gate"
  | "no-review-route"
  | "not-singular"
  | "operator-held"
  | "workflow-selection-changed";

/*
FNXC:UnrunGateParkWithheldNotice 2026-11-02-03:45 (RUFU-318):
The result is a DISCRIMINATED union, not `{ rerouted: boolean; reason: WholeEnum }`. The seed lane cannot
report `seeded` while `rerouted` is false, but the flat annotation said it could, so every consumer that
wanted "the refusal reason" had to re-exclude the two success values or cast — and the arm that records
`task:merge-unrun-gate-park-no-action` (whose whole metadata contract is a fixed refusal vocabulary) is exactly
where such a cast would smuggle a success value into a refusal row.
*/
/** Reasons the seed lane can report while NOT seeding. */
export type UnrunPreMergeGateRefusalReason = Exclude<UnrunPreMergeGateRerouteReason, "seeded" | "verdictless-seeded">;

export type UnrunPreMergeGateRerouteResult =
  | { rerouted: true; reason: "seeded" | "verdictless-seeded"; nodeId: string; workflowStepId: string }
  | { rerouted: false; reason: UnrunPreMergeGateRefusalReason; nodeId?: string; workflowStepId?: string };

/** Only the engine-owned unrun-gate park may be automatically released. */
export function isRecoverableUnrunGatePark(task: Task): boolean {
  return task.status === "failed"
    && !task.userPaused && !task.deletedAt && task.autoMerge !== false
    && (!task.paused || task.pausedReason === IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON)
    && typeof task.error === "string"
    && (task.error.endsWith(PRE_MERGE_STEPS_NOT_RUN_BLOCKER)
      || (!task.workflowIrPin && task.error.startsWith("Workflow drift park:")
        && task.error.includes("Stale IR pin cleared")));
}

/*
FNXC:VerdictlessFailedGate 2026-09-14-13:32 (RUFU-217, AC3):
Persistent cap on verdict-less gate re-runs per (task, gate). Three strikes mirrors the stall
park's three-strike threshold and every strike is a real gated AI run, so a gate that crashes the
same way four times stops reseeding and reaches the operator instead of burning model budget in a
loop. The counter is durable-by-log (not an in-memory map): a daemon restart must not hand a
looping gate a fresh budget, and no schema change is allowed. Entries are appended by this module
immediately after a successful verdict-less seed and counted by the fixed marker prefix below.
*/
export const MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS = 3;

/** Fixed per-gate marker prefix; the quoted gate id carries no apostrophes (gate ids cannot). */
export function verdictlessGateRerunLogMarker(gateId: string): string {
  return `[verdictless-gate-rerun] gate '${gateId}'`;
}

/*
FNXC:VerdictlessRerunEpisode 2026-10-22-17:13 (measured on rtm3 2026-10-22, kubernetes board):
The three-strike budget had no episode boundary, so it was a lifetime sentence rather than a bounded
retry window. Ten of that board's fourteen `in-review` cards sat with a verdict-less `code-review` row
and exactly 3 strikes. KUBE-190 is the decisive trace: 14:48:26 operator dashboard Retry discarded the
verdict-less row and armed the gate's own node, 14:48:29 wrote `Revision budget reset for
'code-review' by operator retry` (a DIFFERENT counter — the FN-1711 step-revision budget), 14:48:54 the
review node really ran, 14:49:13 it crashed verdict-less again, and from that moment no lane could ever
re-run the gate again, because `countVerdictlessGateRerunAttempts` still counted the three strikes the
*previous* episode had spent. The operator did the action the product offers and the card stayed dead.

The repair is an episode, not a bigger number: strikes are counted from the newest operator-opened
episode marker for that gate. This is the already-proven shape in
`packages/engine/src/executor/optional-step-revision.ts` (`OPTIONAL_STEP_REVISION_RESET_MARKER` +
`resetIndexFor`), which FN-1711 introduced for exactly the same append-only-log problem — "the card
could never converge" — and it is what makes the contract `project-engine.ts` already asserts ("an
operator click intentionally outranks the automatic budget") actually executed rather than merely
stated.

Only `restartTaskStage` writes this marker, and it has exactly one caller: the human
`POST /api/tasks/:id/retry` route. No automatic lane may open an episode, so unattended operation keeps
RUFU-449/RUFU-452's bound byte-for-byte — a gate that crashes with nobody watching is still stopped
after three real runs. Each deliberate operator restart buys at most `MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS`
further runs, then stops and reaches the operator again.

The prefix is deliberately NOT a prefix of `verdictlessGateRerunLogMarker` (a `-episode]` segment sits
where the strike marker's `]` is), so an episode line can never be counted as a strike by the
`startsWith`-based tally.
*/
export const VERDICTLESS_GATE_EPISODE_RESET_MARKER_PREFIX = "[verdictless-gate-episode] gate '";

/** Fixed per-gate episode marker; the quoted gate id carries no apostrophes (gate ids cannot). */
export function verdictlessGateEpisodeResetMarker(gateId: string): string {
  return `${VERDICTLESS_GATE_EPISODE_RESET_MARKER_PREFIX}${gateId}'`;
}

/**
 * Closes the verdict-less re-run episode of each named gate and opens a fresh one, by appending the
 * durable marker the strike tally resets on. Append-only by contract: the log is the budget's ledger
 * (RUFU-452), so an episode boundary is recorded, never rewritten.
 *
 * Callers are operator-initiated restarts only. Best-effort at the call site, matching the sibling
 * FN-1711 marker write — a refused log write leaves the previous episode's strikes standing, which is
 * today's behavior, not a new hazard.
 */
export async function openVerdictlessGateRerunEpisode(
  store: TaskStore,
  taskId: string,
  gateIds: Iterable<string>,
): Promise<string[]> {
  const opened: string[] = [];
  for (const gateId of gateIds) {
    await store.logEntry(
      taskId,
      `${verdictlessGateEpisodeResetMarker(gateId)} verdict-less re-run budget reopened — an explicit`
      + ` operator restart opened a new ${MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS}-attempt episode for this gate`,
    );
    opened.push(gateId);
  }
  return opened;
}

/* ---------------------------------------------------------------------------
 * FNXC:ContinuationHoldBudget 2026-11-11-09:52 (RUFU-490):
 * The SECOND hold ledger, sibling to the two above, for the refusal the two above can never reach.
 * RUFU-452 armed `verdictlessGateRerunLogMarker` and RUFU-431 armed the episode-reset marker, and
 * both bind ONLY when the latest row of the NAMED gate carries no authored verdict. The
 * `active-continuation` arm of every seed lane sits BEFORE that verdict check: the lane returns its
 * refusal once the optimistic-concurrency seed fence declined, having read no verdict at all. So the
 * most frequent review-gate non-convergence in production — a slot held by a continuation nobody is
 * serving — was invisible to both existing budgets, and its only bound was RUFU-655's per-process
 * notice dedupe, which lives in process memory and resets on every restart (measured prod-deploy @
 * a46ac76e21: 1,822 card lines on one card in six hours, ~2,370/hour, while that card's IR pin sat
 * at `code-review` and its only active work item was `runnable` with no lease, no wait reason, no
 * retry-after and no deferral anchor). This ledger is the durable per-(task, gate) cost that was
 * missing: it charges ONE card line per distinct abandoned holder, refuses the seed once
 * MAX_CONTINUATION_HOLD_GATE_RERUN_ATTEMPTS distinct holders have been charged, and re-arms only
 * when an operator retry discards the gate.
 *
 * RUFU-431's discovery is kept verbatim: the bound is an EPISODE, not a lifetime. The refusal
 * re-derives from the holder standing RIGHT NOW on every pass, so a replacement holder, a cleared
 * slot, or an idle seed all resume seeding with no reset action, and no card can be refused forever
 * by a decision an earlier pass made.
 * ------------------------------------------------------------------------- */

/** Distinct abandoned holders charged to one (task, gate) before the seed is refused outright. */
export const MAX_CONTINUATION_HOLD_GATE_RERUN_ATTEMPTS = 3;

/**
 * The freshness patience floor. A work item whose own clock moved inside this window is a LIVING
 * claim even when no lease or wait field proves it: `updatedAt` is bumped by the dispatcher, by the
 * executor's progress writes, and by the requeue paths, so a row touched moments ago is being served
 * by a lane whether or not its row says so. Measured GEDA-1112 at 2026-11-11T09:40Z: its only active
 * item was `runnable` with every ownership field NULL and an `updated_at` 40 seconds old while
 * `code-review` sat with zero rows — the healthy transient this floor exists to protect, and it must
 * keep costing nothing.
 */
export const CONTINUATION_HOLD_GATE_PATIENCE_MS = 30 * 60_000;

/** Strike line, one per distinct abandoned holder. Carries the holder key the tally reads back. */
export function continuationHoldGateRerunLogMarker(gateId: string): string {
  return `[continuation-hold-gate-rerun] gate '${gateId}'`;
}

/** The one exhaustion line per episode. Segments differ at the `]`, so no marker prefixes another. */
export const CONTINUATION_HOLD_GATE_PATIENCE_LOG_MARKER_PREFIX = "[continuation-hold-gate-patience] gate '";
export function continuationHoldGatePatienceLogMarker(gateId: string): string {
  return `${CONTINUATION_HOLD_GATE_PATIENCE_LOG_MARKER_PREFIX}${gateId}'`;
}

/** Operator-retry re-arm for the hold ledger, authored only by the restart-stage seam. */
export const CONTINUATION_HOLD_GATE_EPISODE_RESET_MARKER_PREFIX = "[continuation-hold-gate-episode] gate '";
export function continuationHoldGateEpisodeResetMarker(gateId: string): string {
  return `${CONTINUATION_HOLD_GATE_EPISODE_RESET_MARKER_PREFIX}${gateId}'`;
}

/** The ` holder '<key>'` segment every strike line carries; the only holder data the ledger stores. */
const CONTINUATION_HOLD_HOLDER_SEGMENT = / holder '([^']*)'/;

/**
 * One indexed durable read of the card's persisted History, shared by every ledger tallied in a
 * pass. It reads the hydrated `getTask` row and NOT the session-scoped in-memory log, and it
 * DELIBERATELY does not catch (see the FNXC note above): a rejected read must never be mistaken for
 * zero lines. For this ledger a false-empty read would re-charge holders already charged and, at the
 * cap, refuse a gate on nothing.
 */
async function readGateLogLedger(store: TaskStore, taskId: string): Promise<TaskLogEntry[]> {
  const live = await store.getTask(taskId);
  return Array.isArray(live?.log) ? live.log : [];
}

/** A reader memoised per pass: the verdictless budget and the hold ledger tally ONE durable read. */
type GateLogReader = () => Promise<TaskLogEntry[]>;
function createGateLogReader(store: TaskStore, taskId: string): GateLogReader {
  let pending: Promise<TaskLogEntry[]> | undefined;
  return () => (pending ??= readGateLogLedger(store, taskId));
}

/**
 * The shared episode-window scan, identical for all three ledgers: everything after the NEWEST
 * `episodeMarker` line, because an operator restart re-arms rather than clearing history — a card
 * whose gate was re-run by hand after a refused hold must not inherit its spent ledger into the next
 * episode and be refused again on its first abandoned holder. The marker line itself is never
 * counted, so a strike line can never satisfy its own episode boundary.
 */
function scanGateLogLines(log: TaskLogEntry[], marker: string, episodeMarker: string): string[] {
  let start = 0;
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const action = log[index]?.action;
    if (typeof action === "string" && action.startsWith(episodeMarker)) {
      start = index + 1;
      break;
    }
  }
  const lines: string[] = [];
  for (let index = start; index < log.length; index += 1) {
    const action = log[index]?.action;
    if (typeof action === "string" && action.startsWith(marker)) lines.push(action);
  }
  return lines;
}

/** What the hold ledger knows about one (task, gate): who has been charged, and whether it was announced. */
export type ContinuationHoldLedger = {
  /** DISTINCT holder keys already charged a strike line in this episode, in charge order. */
  struckHolderKeys: string[];
  /** Whether the exhaustion line was already written in this episode (0 or 1 by construction). */
  patienceLineCount: number;
};

/**
 * Hydrated hold-ledger tally for one (task, gate). Strikes collapse to DISTINCT holder keys because
 * the bound counts abandoned holders rather than passes: one holder standing across a hundred merge
 * cycles is one charge, which is what keeps the legitimate transient steady state silent forever —
 * the shape the filed incident's own logs were full of.
 */
export async function readContinuationHoldLedger(
  store: TaskStore,
  taskId: string,
  gateId: string,
  readLog?: GateLogReader,
): Promise<ContinuationHoldLedger> {
  const log = await (readLog ?? createGateLogReader(store, taskId))();
  const episodeMarker = continuationHoldGateEpisodeResetMarker(gateId);
  const struck = new Set<string>();
  for (const line of scanGateLogLines(log, continuationHoldGateRerunLogMarker(gateId), episodeMarker)) {
    const key = CONTINUATION_HOLD_HOLDER_SEGMENT.exec(line)?.[1];
    if (key) struck.add(key);
  }
  return {
    struckHolderKeys: [...struck],
    patienceLineCount: scanGateLogLines(log, continuationHoldGatePatienceLogMarker(gateId), episodeMarker).length,
  };
}

/** The fields the ownership predicate reads; a `WorkflowWorkItem` satisfies it structurally. */
export type ContinuationHolderShape = Pick<
  WorkflowWorkItem,
  "id" | "runId" | "nodeId" | "state" | "leaseOwner" | "leaseExpiresAt" | "waitReason" | "retryAfter" | "deferredSince" | "updatedAt" | "createdAt"
>;

export type ContinuationHoldOwnership = "owned" | "unowned";

/**
 * Pure predicate (no I/O, no clock): is some lane serving this holder, or has it been abandoned?
 *
 * Deliberately a WHITELIST of owned conditions, so an unreadable field falls to `owned`: an absent
 * clock is never read as infinitely stale, and an unclassifiable row never buys a strike or a
 * refusal. The reverse ordering is the failure RUFU-452 names — a default that is wrong on the first
 * read is wrong forever, and here it would be wrong in the direction that COSTS the card.
 *
 * FNXC note on `held`: the stranded-continuation sweep's own rule is that the scheduler due-poll
 * selects ONLY `runnable`/`retrying` because every other active state is owned by a named seam — a
 * `held` row is blockedReason-owned by hold-release / principal-routing. A `held` row is therefore
 * owned here too; this lane does not speak for it.
 */
export function classifyContinuationHolderOwnership(
  holder: ContinuationHolderShape,
  now: number,
  patienceMs: number = CONTINUATION_HOLD_GATE_PATIENCE_MS,
): ContinuationHoldOwnership {
  // Only `runnable`/`retrying` is a due-poll candidate; every other active state has a named owner
  // (`running` = a claimed attempt, `held` = blockedReason-owned).
  if (holder.state !== "runnable" && holder.state !== "retrying") return "owned";
  // A live lease is a claimed attempt (`acquireWorkflowWorkItemLease`); a past or unreadable expiry
  // is not a claim — it is the abandoned shape this ledger exists to charge.
  if (holder.leaseOwner && Date.parse(holder.leaseExpiresAt ?? "") > now) return "owned";
  // A named wait reason belongs to the capacity/admission seam (`WorkflowWorkItem["waitReason"]`).
  if (holder.waitReason) return "owned";
  // The deferral ladder's current rung, and the episode anchor that survives a failed transition.
  if (Date.parse(holder.retryAfter ?? "") > now) return "owned";
  if (holder.deferredSince) return "owned";
  // Freshness patience, measured on the row's OWN clock — never the shared task clock that any
  // writer bumps. Unparseable on both fields means abandonment is unprovable, so it is owned.
  const touchedAt = Date.parse(holder.updatedAt || "") || Date.parse(holder.createdAt || "");
  if (!Number.isFinite(touchedAt)) return "owned";
  if (now - touchedAt < patienceMs) return "owned";
  return "unowned";
}

/** The stable strike key: the row's own id, falling back to its run when the id is unusable. */
export function continuationHoldHolderKey(holder: Pick<ContinuationHolderShape, "id" | "runId">): string {
  return holder.id || holder.runId;
}

function holderClock(holder: Pick<ContinuationHolderShape, "updatedAt" | "createdAt">): number {
  const at = Date.parse(holder.updatedAt || "") || Date.parse(holder.createdAt || "");
  return Number.isFinite(at) && at > 0 ? at : Number.NEGATIVE_INFINITY;
}

/**
 * Which active item holds the gate's seed slot. The seed fence is TASK-wide — it refuses on any
 * active row, not on one naming the target node — and production confirmed the consequence:
 * GEDA-1112's refusal named `code-review` while its only active item sat on `step-execute`. A
 * node-restricted holder would be null on the dominant real shape and the class would stay
 * unbounded, so the target node wins when it has a live row and otherwise the newest clock on any
 * node is charged. Returns null when no active row exists: that refusal was a pure race, which is
 * transient and charges nothing.
 */
export function resolveContinuationHoldHolder(
  items: readonly ContinuationHolderShape[],
  targetNodeId: string,
): ContinuationHolderShape | null {
  const active = items.filter((item) => (ACTIVE_WORKFLOW_WORK_ITEM_STATES as readonly string[]).includes(item.state));
  if (active.length === 0) return null;
  const onTargetNode = active.filter((item) => item.nodeId === targetNodeId);
  const candidates = onTargetNode.length > 0 ? onTargetNode : active;
  let newest = candidates[0]!;
  let newestAt = holderClock(newest);
  for (const candidate of candidates.slice(1)) {
    const at = holderClock(candidate);
    if (at > newestAt) {
      newest = candidate;
      newestAt = at;
    }
  }
  return newest;
}

export type ContinuationHoldRecordOutcome =
  | "no-holder"
  | "holder-owned"
  | "holder-already-struck"
  | "struck"
  | "exhausted";

/**
 * Has THIS unowned holder already been refused once in the current episode?
 *
 * FNXC:ContinuationHoldBudget 2026-11-11-10:36 (RUFU-490):
 * The filed symptom was not only the repetition of the fact but the repetition of the WRITE: every
 * merge pass re-attempted an optimistic-concurrency seed that the same task-wide fence was certain to
 * refuse (2,370 attempts on one card in ~29h). Once that holder carries its one strike, the answer is
 * known, so the lane returns the same transient `active-continuation` it always returned WITHOUT the
 * doomed write. This is not a latch: the next pass re-derives the holder from live rows, and a holder
 * that becomes owned, is replaced, or clears restores the seed attempt immediately — only the
 * identical abandoned holder skips it.
 */
export function continuationHoldHolderAlreadyStruck(
  holder: ContinuationHolderShape,
  ledger: ContinuationHoldLedger,
): boolean {
  return ledger.struckHolderKeys.includes(continuationHoldHolderKey(holder));
}

/**
 * The ONLY writer this ledger has, and it can write exactly two kinds of line: one strike per
 * distinct abandoned holder, and one exhaustion line per episode. Every other path writes nothing,
 * which is the noise discipline RUFU-431 names — a line is a durable row on a card that may be
 * polled every ~1.5s, so an `active-continuation` hit by a legitimate transient must cost zero
 * lines, forever.
 */
export async function recordContinuationHoldRefusal(
  store: TaskStore,
  task: Task,
  gateId: string,
  holder: ContinuationHolderShape | null,
  ledger: ContinuationHoldLedger,
  now: number,
): Promise<ContinuationHoldRecordOutcome> {
  if (!holder) return "no-holder";
  if (classifyContinuationHolderOwnership(holder, now) === "owned") return "holder-owned";
  const holderKey = continuationHoldHolderKey(holder);
  if (ledger.struckHolderKeys.length >= MAX_CONTINUATION_HOLD_GATE_RERUN_ATTEMPTS) {
    if (ledger.patienceLineCount > 0) return "exhausted";
    await store.logEntry(
      task.id,
      `${continuationHoldGatePatienceLogMarker(gateId)} continuation-hold budget spent on ${ledger.struckHolderKeys.length} abandoned`
      + ` holders (${ledger.struckHolderKeys.join(", ")}); the re-seed is refused while a held slot has no owner —`
      + ` retry the card to re-arm this gate, or run the gate by hand`,
    );
    return "exhausted";
  }
  if (ledger.struckHolderKeys.includes(holderKey)) return "holder-already-struck";
  await store.logEntry(
    task.id,
    `${continuationHoldGateRerunLogMarker(gateId)} holder '${holderKey}' hold ${ledger.struckHolderKeys.length + 1} of`
    + ` ${MAX_CONTINUATION_HOLD_GATE_RERUN_ATTEMPTS}: an active continuation holds this gate's slot and no lane is serving it`,
  );
  return "struck";
}

/**
 * Author the hold-ledger episode-reset marker for every gate being re-armed. Mirrors
 * `openVerdictlessGateRerunEpisode` for the same reason: the marker is written only by the restart
 * seam that DISCARDS the gate's verdict rows, and an empty `gateIds` writes nothing.
 */
export async function openContinuationHoldRerunEpisode(
  store: TaskStore,
  taskId: string,
  gateIds: Iterable<string>,
): Promise<string[]> {
  const opened: string[] = [];
  for (const gateId of gateIds) {
    await store.logEntry(
      taskId,
      `${continuationHoldGateEpisodeResetMarker(gateId)} continuation-hold budget reopened — an explicit`
      + ` operator restart opened a new ${MAX_CONTINUATION_HOLD_GATE_RERUN_ATTEMPTS}-holder episode for this gate`,
    );
    opened.push(gateId);
  }
  return opened;
}

/**
 * The restart seam's scope filter: only gates whose hold ledger holds a line are re-armed. A card
 * with an untouched ledger gets no marker, so the one line a genuine re-arm costs is never
 * manufactured on the routine re-runs that pass through this route every day. A card whose durable
 * log cannot be read is left alone rather than re-armed on an invented boundary.
 */
export async function filterContinuationHoldLedgerGates(
  store: TaskStore,
  taskId: string,
  gateIds: string[],
): Promise<string[]> {
  if (gateIds.length === 0) return [];
  const readLog = createGateLogReader(store, taskId);
  const scoped: string[] = [];
  for (const gateId of gateIds) {
    try {
      const ledger = await readContinuationHoldLedger(store, taskId, gateId, readLog);
      if (ledger.struckHolderKeys.length > 0 || ledger.patienceLineCount > 0) scoped.push(gateId);
    } catch {
      continue;
    }
  }
  return scoped;
}

/*
FNXC:NoVerdictRerunBudget 2026-10-01-01:29 (RUFU-452):
The budget counts from the DURABLE row, never from the `task` projection the caller handed us. An
empty log is a PROJECTION, not an absence: every board read the recovery lanes run —
`listTasks({ slim: true })`, the modified-since prelude, and search — answers `log: []` for a card
whose durable log still holds every strike (`reads.ts` hydrates the activity log separately and
`slim` strips the entry, and a `logLimit: 0` read does the same to a full `getTask`). So the
original `Array.isArray(task.log) ? task.log : hydrate` arm was dead code on the engine's own hot
path: the array test passed, the store arm never ran, and the counter read zero strikes forever.
Measured 2026-09-30: RUFU-281 carried 11 markers, each written as `rerun 1 of 3` — a permanent
no-cap loop whose own log line claimed a cap, while the sibling RUFU-449 evidence (~72 failed
`code-review` items per card, 20-34 doomed continuations per hour for twelve hours) showed what an
uncapped verdict-less lane costs. `log: undefined` — the only shape the fallback was written for —
is not what production hands this lane, which is why the pre-fix test suite stayed green.

The read is one indexed durable read per seedable-gate evaluation on a cold recovery path, and it
is the same read the caller would have had to make to know the truth.

FNXC:NoVerdictRerunBudget 2026-10-01-01:52 (RUFU-452):
A REJECTED read is fail-closed: the error propagates instead of being swallowed to zero strikes,
so an unreadable durable row seeds nothing. Swallowing would be self-defeating here — the failure
mode this counter exists to bound is a lane that keeps re-seeding on false evidence of a fresh
budget, and a flaky read is exactly that false evidence. Every production caller already contains
the rejection: `project-engine.ts:3127` and the three self-healing park routes `.catch` the reroute
into a `no-unrun-gate` refusal, both `handle-graph-failure` routes catch it into an absent reroute,
and the no-verdict sweep wraps each card in its own try — so a throwing sink costs a skipped card
plus a warn line, never an unbounded seed and never a crashed sweep.

A MISSING row is a different fact, and its real-store shape is a THROW, not a `null`: the real
`getTask` raises `TaskNotFoundError` (and `TaskDeletedError` for a soft-deleted card), so an absent
card takes the rejection path above and seeds nothing — the safe direction for a card that no longer
exists. A `null` row is the fake/legacy-store shape and stays decision-neutral: it carries no
strikes, and the seed that follows has no card to seed, so it counts zero — the same value the
pre-fix `?.log ?? []` arm returned.

FNXC:NoVerdictRerunBudget 2026-10-02-09:10 (RUFU-452):
The durable source of truth is bounded, and the bound is stated rather than assumed. The task
activity log itself retains only its most recent `DEFAULT_TASK_ACTIVITY_LOG_ENTRY_LIMIT` (1,000)
entries — `logEntryImpl` splices the oldest entries off the front on every append
(`packages/core/src/task-store/audit-ops.ts`). This read deliberately passes no `activityLogLimit`
(that option exists for dashboard surfaces that page a capped log view and could only narrow what
the counter sees), so the count covers every strike still inside the retained window: a card whose
log churns past 1,000 entries after its strikes loses its oldest markers and can earn one further
re-run. That is a bounded degradation of the ceiling, not the failure this counter replaces — the
pre-fix projection read reset the count on EVERY pass (measured: 11 strikes all claiming
`rerun 1 of 3`), and a card that streams 1,000 log entries inside three passes is not the loop RUFU-452
was filed for. Closing the bound exactly needs a durable per-(task, gate) counter, i.e. new durable
state plus a migration, which the task's own "do not" list withholds; the operator's 2026-10-02
scope ruling on this card likewise keeps it to the verdictless class and routes the unbounded
`active-continuation` arm to RUFU-490.

`store.getTask` is safe here because it takes the NON-REENTRANT per-task advisory lock and no
caller of either reroute lane holds that lock — `withTaskLock` appears in the engine only in triage
and the agent-tool prompt writer.
*/
async function countVerdictlessGateRerunAttempts(
  store: TaskStore,
  task: Task,
  gateId: string,
  readLog?: GateLogReader,
): Promise<number> {
  // No `.catch`: a rejected read must not be mistaken for "no strikes" — see the FNXC note above.
  // The reader is memoised per pass, so the RUFU-490 hold ledger tallied later in the same lane
  // rides this SAME indexed durable read rather than adding a second one.
  const log: TaskLogEntry[] = await (readLog ?? createGateLogReader(store, task.id))();
  /*
  FNXC:VerdictlessRerunEpisode 2026-10-22-17:13: strikes are this episode's, not this card's lifetime.
  Scan backwards for the newest episode marker belonging to THIS gate and tally only what came after
  it; an episode opened for a different gate resets nothing here. The scan is shared with the
  continuation-hold ledger (`scanGateLogLines`) so all three markers cut their episode window the
  same way — two implementations of one boundary is how a budget starts disagreeing with itself.
  */
  return scanGateLogLines(
    log,
    verdictlessGateRerunLogMarker(gateId),
    verdictlessGateEpisodeResetMarker(gateId),
  ).length;
}

/*
FNXC:VerdictlessFailedGate 2026-09-14-14:47 (RUFU-217, Step 5 / AC1):
The stall-deadlock park is the ONLY pause this lane may seed under, and only when the caller
explicitly passes `allowDeadlockPark` (the parked-card recovery route). Step 5 recovery seeds FIRST
and clears the park only after the seed lands, so the seed must run while the card is still
`paused:true, pausedReason:"in-review-stall-deadlock"` — a pause this lane itself is undoing, not
an operator hold. The pause REASON must name the deadlock park: any other automation pause, and
all operator holds (`userPaused`, `deletedAt`, `autoMerge:false`), remain hard `operator-held`
refusals, so every existing caller's behavior is byte-identical.
*/
export async function rerouteUnrunPreMergeGateToReview(
  store: TaskStore,
  task: Task,
  options: {
    requiredPreMergeStepIds: ReadonlySet<string>;
    mergeContent: MergeContentDescriptor;
    allowDeadlockPark?: boolean;
    expectedWorkflowSelection?: { workflowId: string; stepIds: string[] } | null;
  },
): Promise<UnrunPreMergeGateRerouteResult> {
  const { mergeContent, requiredPreMergeStepIds, expectedWorkflowSelection } = options;
  if (mergeContent.kind !== "singular" || task.workspaceWorktrees !== undefined) return { rerouted: false, reason: "not-singular" };
  const deadlockParkAdmissible =
    options.allowDeadlockPark === true
    && task.paused === true
    && task.pausedReason === IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON;
  if (task.userPaused || task.deletedAt || task.autoMerge === false || (task.paused && !deadlockParkAdmissible)) {
    return { rerouted: false, reason: "operator-held" };
  }
  if (requiredPreMergeStepIds.size === 0) return { rerouted: false, reason: "no-unrun-gate" };

  /*
  FNXC:VerdictlessFailedGate 2026-09-14-13:32 (RUFU-217, AC2):
  Seedable = `missing` (FN-9243) ∪ `verdictLessFailed` (RUFU-217). The class of the EARLIEST
  seedable gate in IR order decides whether the persistent rerun budget applies: missing targets
  keep the unbudgeted idle-only semantics, verdict-less targets must leave room for the operator
  when a gate crashes identically forever.
  */
  const seedable = new Map<string, "missing" | "verdictless">();
  for (const approval of evaluatePreMergeApprovals(task, { requiredPreMergeStepIds, mergeContent })) {
    if (approval.state === "missing") seedable.set(approval.workflowStepId, "missing");
    else if (approval.verdictLessFailed === true) seedable.set(approval.workflowStepId, "verdictless");
  }
  if (seedable.size === 0) return { rerouted: false, reason: "no-unrun-gate" };

  const ir = await resolveWorkflowIrForTask(store, task.id);
  const node = ir.nodes.find((candidate) => requiredPreMergeStepIds.has(candidate.id) && seedable.has(candidate.id));
  if (!node) return { rerouted: false, reason: "no-review-route" };

  const targetClass = seedable.get(node.id)!;
  // One memoised durable read serves every ledger this pass tallies: RUFU-452's verdictless budget
  // and, on the blocked arm only, the RUFU-490 continuation-hold ledger.
  const readLog = createGateLogReader(store, task.id);
  const now = Date.now();
  const rerunAttempts = targetClass === "verdictless"
    ? await countVerdictlessGateRerunAttempts(store, task, node.id, readLog)
    : 0;
  if (targetClass === "verdictless" && rerunAttempts >= MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS) {
    return { rerouted: false, reason: "rerun-budget-exhausted", nodeId: node.id, workflowStepId: node.id };
  }

  const items = await store.listWorkflowWorkItemsForTask(task.id);
  /*
  FNXC:ContinuationHoldBudget 2026-11-11-09:52 (RUFU-490):
  The arm RUFU-452's own scope ruling routed here is charged only on a holder that is provably
  UNSERVED. An owned holder — the legitimate transient where the executor's own execute row is due and
  the task-wide idle check therefore refuses — returns `active-continuation` exactly as it always has
  and writes NOTHING, so the healthy steady state stays silent forever. Only an unowned holder
  consults the ledger, and once that ledger is spent the exhaustion refusal is returned BEFORE the
  fenced write: a fourth doomed optimistic-concurrency write is work the engine should not do. A
  ledger read that rejects propagates rather than defaulting to zero charges, because charging on a
  ledger the engine could not read is the same false-evidence failure RUFU-452 refuses to seed on.
  */
  const holder = resolveContinuationHoldHolder(items, node.id);
  const holdLedger = holder && classifyContinuationHolderOwnership(holder, now) === "unowned"
    ? await readContinuationHoldLedger(store, task.id, node.id, readLog)
    : null;
  if (holder && holdLedger && holdLedger.struckHolderKeys.length >= MAX_CONTINUATION_HOLD_GATE_RERUN_ATTEMPTS) {
    await recordContinuationHoldRefusal(store, task, node.id, holder, holdLedger, now);
    return { rerouted: false, reason: "continuation-hold-budget-exhausted", nodeId: node.id, workflowStepId: node.id };
  }
  /*
  FNXC:ContinuationHoldBudget 2026-11-11-10:36 (RUFU-490):
  The identical abandoned holder already holds its strike, so the seed is not attempted again this
  episode. The refusal the caller sees is the same transient `active-continuation` it always saw — this
  clause changes only that the doomed optimistic-concurrency write is skipped, which is the per-pass
  attempt the filed symptom measured.
  */
  if (holder && holdLedger && continuationHoldHolderAlreadyStruck(holder, holdLedger)) {
    return { rerouted: false, reason: "active-continuation", nodeId: node.id, workflowStepId: node.id };
  }
  const result = await store.seedWorkspaceCodeReviewContinuationIfIdle({
    taskId: task.id,
    nodeId: node.id,
    kind: "task",
    state: "runnable",
    runId: `${task.id}:unrun-pre-merge-gate-reseed:${node.id}:${items.length}`,
    stableWorkflowRunId: `${task.id}:${ir.name}`,
    continuationSequence: items.length,
    sourceColumn: task.column,
    targetColumn: clampReviewGateEntry(ir, node, task.column).toColumn ?? task.column,
    irHash: computeWorkflowIrPin(ir, node.id).irHash,
    expectedWorkflowSelection,
  });
  /*
  FNXC:PreMergeGateRecovery 2026-09-22-10:10 (#sync-0922 merge resolution, upstream FN-9353):
  Upstream fences this seed to the workflow selection that named the missing gate; a changed
  selection leaves the existing park in place for reclassification instead of seeding a node from an
  unrelated workflow. The fence is additive to FN-9243: the missing/verdict-less seedable set, the
  RUFU-217 rerun budget, and the deadlock-park admission flag all keep their own semantics.
  */
  if (!result.seeded) {
    if (result.reason === "workflow-selection-changed") {
      return { rerouted: false, reason: "workflow-selection-changed", nodeId: node.id, workflowStepId: node.id };
    }
    // A continuation appeared between the check and the seed; the next pass re-evaluates, and the
    // seed is still attempted every pass exactly as it was before this ledger existed. The recorder
    // writes at most one new strike line for a provably-abandoned holder, and nothing otherwise.
    if (holder && holdLedger) {
      await recordContinuationHoldRefusal(store, task, node.id, holder, holdLedger, now);
    }
    return {
      rerouted: false,
      reason: "active-continuation",
      nodeId: node.id,
      workflowStepId: node.id,
    };
  }
  if (targetClass === "verdictless") {
    // The marker is the durable budget counter; write it only AFTER the seed actually landed.
    await store.logEntry(
      task.id,
      `${verdictlessGateRerunLogMarker(node.id)} verdict-less failure, re-seeded in place for a fresh run`
        + ` (rerun ${rerunAttempts + 1} of ${MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS})`,
    );
    return { rerouted: true, reason: "verdictless-seeded", nodeId: node.id, workflowStepId: node.id };
  }
  return { rerouted: true, reason: "seeded", nodeId: node.id, workflowStepId: node.id };
}


/*
FNXC:SyncMerge0924 2026-09-24-06:40 (merge origin/main 67c7d80531 → main):
Upstream FN-9373 adds a human/queue-triggered no-verdict recovery alongside this line's RUFU-217
auto-reseed lane. Their refactor rewrote `rerouteUnrunPreMergeGateToReview` (which this line owns
with the verdict-less seedable union, persistent rerun budget, and deadlock-park admission), so the
line's version stays authoritative; upstream's distinct no-verdict exports are appended verbatim
because ProjectEngine.rerouteFailedNoVerdictPreMergeReview, the engine barrel, CLI mocks, and the
retry route call them.
*/
export type FailedNoVerdictPreMergeGateRerouteReason =
  | "seeded"
  | "active-continuation"
  // RUFU-490: see `UnrunPreMergeGateRerouteReason` — same holder, same re-derivation, same reason
  // for a distinct value.
  | "continuation-hold-budget-exhausted"
  | "rerun-budget-exhausted"
  | "no-failed-no-verdict-gate"
  | "no-review-route"
  | "not-singular"
  | "operator-held"
  | "workflow-selection-changed";

/** Only the engine-owned unrun-gate park may be automatically released. */

type ReseedOptions = {
  requiredPreMergeStepIds: ReadonlySet<string>;
  mergeContent: MergeContentDescriptor;
  expectedWorkflowSelection?: { workflowId: string; stepIds: string[] } | null;
};

type ReseedResult<Reason extends string> = {
  rerouted: boolean;
  reason: Reason;
  nodeId?: string;
  workflowStepId?: string;
};

async function seedPreMergeReviewIfIdle<Reason extends "no-unrun-gate" | "no-failed-no-verdict-gate">(
  store: TaskStore,
  task: Task,
  options: ReseedOptions,
  candidateStepIds: ReadonlySet<string>,
  noCandidateReason: Reason,
  runKind: "unrun-pre-merge-gate" | "failed-no-verdict-pre-merge-gate",
): Promise<ReseedResult<"seeded" | "active-continuation" | "continuation-hold-budget-exhausted" | "rerun-budget-exhausted" | Reason | "no-review-route" | "not-singular" | "operator-held" | "workflow-selection-changed">> {
  const { requiredPreMergeStepIds, expectedWorkflowSelection } = options;
  /*
  FNXC:NoVerdictWorkspaceSeed 2026-09-28-09:15 (RUFU-391):
  This seed is CONTENT-FREE — it reads `requiredPreMergeStepIds` and the card's own step results, and
  inserts an idle continuation on the review node. It never compares a fingerprint, so the singular
  content descriptor it used to demand was not evidence for anything it did; it only made every
  workspace card ineligible. Measured: the saneca board's 26 parked `in-review` cards each have a
  `code-review` row `failed` with NO verdict (a lost dispatch, not a rejection), and this one guard
  — plus the pause guard below — is what kept the producing lane from ever re-running that gate.
  Approving anything is still impossible from here: the workspace merge door requires
  `repositoryScope.reviewEvidence` per in-scope repository, so the re-run must actually produce
  current per-repo proof.
  */
  /*
  FNXC:NoVerdictStallParkAdmission 2026-09-28-09:15 (RUFU-391):
  The engine's OWN in-review stall-deadlock park is not an operator stop, and it is self-sustaining
  here: the stall classifier exempts paused cards, so the park can never lift itself, while the
  no-verdict recovery that would produce the missing verdict refused `task.paused` blanket. Same
  conjunction `recoverStallPark` (workspace partial land) already uses, and the same invariant
  RUFU-380 encodes for the dispatch sweep: the pause REASON must name the deadlock park, the error
  must still be the park's own sentence (a later unrelated failure is not this class), and
  `userPaused` / every other named pause stays a hard `operator-held` refusal.
  */
  const engineStallPark = isEngineAuthoredInReviewStallPark(task);
  if ((task.paused && !engineStallPark) || task.userPaused || task.deletedAt || task.autoMerge === false) {
    return { rerouted: false, reason: "operator-held" };
  }
  if (requiredPreMergeStepIds.size === 0 || candidateStepIds.size === 0) return { rerouted: false, reason: noCandidateReason };

  const ir = await resolveWorkflowIrForTask(store, task.id);
  const node = ir.nodes.find((candidate) => requiredPreMergeStepIds.has(candidate.id) && candidateStepIds.has(candidate.id));
  if (!node) return { rerouted: false, reason: "no-review-route" };

  /*
  FNXC:NoVerdictRerunBudget 2026-09-30-14:34 (RUFU-449):
  This lane had no attempt counter at all, while the unrun-gate lane above has enforced
  `MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS` since RUFU-217. Measured on saneca 2026-09-30: 19 `in-review`
  cards carried ~72 FAILED `code-review` items each, at 20-34 new doomed continuations per hour for
  twelve straight hours, because a seeded review that dies before session start leaves the gate exactly
  as it was — `failed` with no verdict — so the recovery re-seeded it forever. The `:${items.length}`
  suffix in the run id is an item count masquerading as an attempt count; it read 82 while the real cap
  was never consulted. The seed now consumes the SAME durable per-(task, gate) marker budget as the
  unrun lane, deliberately shared: total re-runs of one crashing gate are bounded across both lanes, not
  3 + 3. The counter accrues only when a seed actually lands, and the marker text names the lane, so the
  task log shows `rerun N of 3` instead of silence while the board shows an idle card.

  FNXC:VerdictlessRerunEpisode 2026-10-22-17:13:
  "Total" now means total within the current episode. Both lanes read the one counter, so an operator
  restart that opens a new episode re-arms BOTH of them together — the deliberate alternative to RUFU-452's
  own note routing this arm to a separate card, and the only shape that keeps `project-engine.ts`'s
  "an operator click intentionally outranks the automatic budget" true without letting any automatic
  lane open an episode for itself.
  */
  const readLog = createGateLogReader(store, task.id);
  const now = Date.now();
  const rerunAttempts = await countVerdictlessGateRerunAttempts(store, task, node.id, readLog);
  if (rerunAttempts >= MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS) {
    return { rerouted: false, reason: "rerun-budget-exhausted", nodeId: node.id, workflowStepId: node.id };
  }

  const items = await store.listWorkflowWorkItemsForTask(task.id);
  /*
  FNXC:ContinuationHoldBudget 2026-11-11-09:52 (RUFU-490):
  The shared-budget sibling lane gets the same bounded hold ledger for the same reason: this is the
  arm that re-seeds a gate whose previous run died before it ever authored a verdict, and a card can
  sit here with the review slot held by an abandoned continuation. An owned holder still returns
  `active-continuation` writing nothing; the budget below is RUFU-449's RE-RUN budget and stays
  independent of the hold ledger, which counts holders rather than runs.
  */
  const holder = resolveContinuationHoldHolder(items, node.id);
  const holdLedger = holder && classifyContinuationHolderOwnership(holder, now) === "unowned"
    ? await readContinuationHoldLedger(store, task.id, node.id, readLog)
    : null;
  if (holder && holdLedger && holdLedger.struckHolderKeys.length >= MAX_CONTINUATION_HOLD_GATE_RERUN_ATTEMPTS) {
    await recordContinuationHoldRefusal(store, task, node.id, holder, holdLedger, now);
    return { rerouted: false, reason: "continuation-hold-budget-exhausted", nodeId: node.id, workflowStepId: node.id };
  }
  // Same already-struck skip as the unrun lane: one doomed write per abandoned holder, not one per pass.
  if (holder && holdLedger && continuationHoldHolderAlreadyStruck(holder, holdLedger)) {
    return { rerouted: false, reason: "active-continuation", nodeId: node.id, workflowStepId: node.id };
  }
  const result = await store.seedWorkspaceCodeReviewContinuationIfIdle({
    taskId: task.id,
    nodeId: node.id,
    kind: "task",
    state: "runnable",
    runId: `${task.id}:${runKind}-reseed:${node.id}:${items.length}`,
    stableWorkflowRunId: `${task.id}:${ir.name}`,
    continuationSequence: items.length,
    sourceColumn: task.column,
    targetColumn: node.column ?? task.column,
    irHash: computeWorkflowIrPin(ir, node.id).irHash,
    expectedWorkflowSelection,
  });
  if (result.seeded) {
    // Durable budget marker, written only AFTER the seed landed, exactly as the unrun lane does.
    await store.logEntry(
      task.id,
      `${verdictlessGateRerunLogMarker(node.id)} ${runKind}, re-seeded in place for a fresh run`
        + ` (rerun ${rerunAttempts + 1} of ${MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS})`,
    );
    return { rerouted: true, reason: "seeded", nodeId: node.id, workflowStepId: node.id };
  }
  if (result.reason === "workflow-selection-changed") {
    return { rerouted: false, reason: "workflow-selection-changed", nodeId: node.id, workflowStepId: node.id };
  }
  // Same blocked-arm discipline as the unrun lane: one strike per distinct abandoned holder, never
  // two lines for one holder, and nothing at all for an owned one.
  if (holder && holdLedger) {
    await recordContinuationHoldRefusal(store, task, node.id, holder, holdLedger, now);
  }
  return {
    rerouted: false,
    reason: "active-continuation",
    nodeId: node.id,
    workflowStepId: node.id,
  };
}

export function isFailedNoVerdictPreMergeReviewResult(
  result: WorkflowStepResult,
  requiredPreMergeStepIds: ReadonlySet<string>,
): boolean {
  return (result.phase ?? "pre-merge") === "pre-merge"
    && result.status === "failed"
    && result.verdict === undefined
    && requiredPreMergeStepIds.has(result.workflowStepId);
}

/**
 * FNXC:NoVerdictReviewRecovery 2026-09-23-19:50:
 * A terminal pre-merge review failure without a verdict is a lost dispatch, not a rejection.
 * Re-seed only its exact required review node through the idle continuation fence; the failed
 * evidence remains current until the real replacement review result is recorded.
 */
export async function rerouteFailedNoVerdictPreMergeGateToReview(
  store: TaskStore,
  task: Task,
  options: ReseedOptions,
): Promise<ReseedResult<FailedNoVerdictPreMergeGateRerouteReason>> {
  const candidates = new Set((task.workflowStepResults ?? [])
    .filter((result) => isFailedNoVerdictPreMergeReviewResult(result, options.requiredPreMergeStepIds))
    .map((result) => result.workflowStepId));
  return seedPreMergeReviewIfIdle(store, task, options, candidates, "no-failed-no-verdict-gate", "failed-no-verdict-pre-merge-gate");
}

/*
FNXC:PreMergeApproval 2026-09-22-22:40 (RUFU-276, AC2):
A card can already stand terminalized over a never-ran gate, because before RUFU-276 the bounded
auto-merge retry seam terminalized this refusal class like any other: `status:"failed"` plus
`AUTO_MERGE_RETRY_REJECTED: Cannot merge <id>: task has enabled pre-merge workflow steps that never
ran`. That park is invisible to every existing owner: the visible recovery candidate requires
`status !== "failed"` and a retry budget below the cap, `classifyStaleContentPark` needs the
stale-content sentence, and `classifyVerdictlessGatePark` needs a gate-named refusal whose latest row
is verdict-less — a gate with ZERO rows is `missing`, not verdict-less. RUFU-225 sat 5.3 days that way.

Conjunction-heavy on purpose, mirroring `classifyStaleContentPark`'s purity: a failed status AND a
not-run refusal in the error (wrap-aware, so the queue prefix and the raw blocker both count) AND at
least one required gate that has produced NO row at all. A `pending` row is PRESENT (FN-8492 owns
it), a verdict-less or authored row belongs to RUFU-217 / the remediation lane, and a stale-content or
gate-approval wrap fails the not-run classifier outright. Paused, operator-held, deleted and workspace
cards are refused here rather than inside the seed, so an inadmissible card never spends a starvation
attempt. `autoMerge:false` / PR-based holds are refused by the caller's merge admission.
*/
/** Which terminal-park producer embedded the not-run refusal. */
export type UnrunGateParkShape = "retry-rejected" | "raw-blocker";

export function classifyUnrunGatePark(
  task: Task,
  requiredPreMergeStepIds: ReadonlySet<string>,
): { shape: UnrunGateParkShape; missingGateIds: string[] } | undefined {
  if (task.status !== "failed") return undefined;
  if (task.paused === true || task.userPaused === true || task.deletedAt) return undefined;
  if (isWorkspaceTask(task)) return undefined;
  const error = typeof task.error === "string" && task.error.length > 0 ? task.error : undefined;
  if (error === undefined || !isPreMergeStepsNotRunRefusal(error)) return undefined;
  const missingGateIds = findUnrunRequiredPreMergeStepIds(task, { requiredPreMergeStepIds });
  if (missingGateIds.length === 0) return undefined;
  return {
    shape: error.startsWith(AUTO_MERGE_RETRY_REJECTED_PREFIX) ? "retry-rejected" : "raw-blocker",
    missingGateIds,
  };
}
