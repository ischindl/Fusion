/*
FNXC:UnclaimedGraphWork 2026-11-17-01:05 (RUFU-1050):
Pure decision seam for graph work that every owner refuses. It performs NO I/O: the caller supplies
the card snapshot, ALL of the card's `kind: "task"` work items UNORDERED, the lane roles resolved
from the card's own IR, the liveness verdict, the drain facts, and the episode counters. Keeping the
decision pure is what lets the release seam, the owning sweep, and the tests read ONE answer instead
of each re-deriving it — the `FNXC:WorkflowLifecycleColumns` defect class this repo has now measured
four times.

WHY THE ITEM LIST IS UNORDERED AND INCLUDES TERMINAL ROWS. Every existing reader of a card's work
items filters on the ACTIVE states (`ACTIVE_WORKFLOW_WORK_ITEM_STATES` = runnable/running/held/
retrying) or on a DUE filter (`listDueWorkflowWorkItems` drops rows whose `retryAfter` or
`leaseExpiresAt` is in the future). A terminalized row is invisible to the first and a deferred row
is invisible to the second, so a classifier fed either feed could never see shape B or shape C at
all — it would answer "nothing here" about a card whose work is dead.

FNXC:UnclaimedGraphWork 2026-11-17-01:05 (RUFU-1050) — an absent terminal record is NOT health:
RUFU-1044 sat ~7.5 h and RUFU-243 sat a full working day with a `failed` item, `attempt = 0`,
`waitReason` NULL, an EMPTY `task.error`, and no `task:graph-failed` row anywhere. Every health
check that asks "is there an unhandled failure?" reads `task.error` or the audit row, and both were
silent, so a dead card scored exactly like an idle one. Therefore `terminal-node-orphan` is a
FINDING in this seam, never a skipped candidate, and a pass that classifies one and writes nothing
is a defect, not a quiet pass.

WHY `reconcileStrandedWorkflowContinuations` CANNOT SERVE THESE ROWS. That sweep is the owner of
stranded `running`/`held` rows and it deliberately REFUSES `runnable` and `retrying` — see
`packages/engine/src/workflows/stranded-continuation-reclaim.ts`, whose comment states those states
are "the dispatcher's own queue". So a `runnable` planning row is refused there by design and
consumed here by the drain; a `failed` row is refused by both, because it is not active and not
due. That is the hole: the drain only reads runnable/retrying, the reclaim sweep only reads
held/running, and the terminal row belongs to neither. The new pass may serve only waits no other
layer owns (see the ownership table in `docs/architecture.md`).

WHY ONLY `attemptExecutionRearm` MAY INSTALL A RE-ENTRY. A re-arm claims a bounded budget, proves
worktree occupancy through the shared emptiness prover, installs the successor through
`replaceActiveTaskWorkflowContinuation` under the task advisory lock, and emits the audit pair —
all inside `packages/engine/src/executor/execution-rearm.ts`. A second writer that "just seeds a
runnable row" would bound nothing, prove nothing, and produce a second, disagreeing budget. So this
seam PRE-ROUTES (`action: "rearm"`) and the caller invokes the authority with an existing member of
`EXECUTION_REARM_RECOVERY_REASONS`; the authority still decides eligibility, and `not-eligible` or
`no-work-evidence` is a real outcome this seam must not hide.
*/
/*
FNXC:HoldReleaseArmedPriority 2026-11-21-08:15 (RUFU-807 Step 4):
The nomination predicate and age reader are imported rather than restated so the release refusal and the
board badge decide to speak on one measurement. Restating either threshold here would create a second
authority over when a starvation is loud enough to mention — the failure RUFU-273 names for the episode
clock itself.
*/
import {
  UNCLAIMED_GRAPH_WORK_EPISODE_METADATA_KEY,
  holdReleaseStarvationAgeMs,
  holdReleaseStarvationIsNominating,
  type Task,
  type TaskHoldReleaseStarvationEpisode,
} from "@fusion/core";

/*
FNXC:UnclaimedGraphWork 2026-11-17-01:05 (RUFU-1050):
The item shape this seam reads is STRUCTURAL, not `WorkflowWorkItem`. The release seam and the owning
pass both reach a card's rows through `store.listWorkflowWorkItemsForTask`, whose row type widens
`state`/`waitReason` to `string`; a classifier typed on the narrow domain type would force every
caller to cast, and a cast is exactly where a re-derivation of the decision hides. Both the domain
type and the row type satisfy this interface, so there is one decision input and no adapter to drift.
*/
export interface UnclaimedGraphWorkItem {
  id: string;
  state: string;
  attempt: number;
  retryAfter: string | null;
  /** Deferral episode anchor; NULL means this row has never been deferred by the stranded sweep. */
  deferredSince: string | null;
  leaseExpiresAt: string | null;
  nodeId?: string;
  /**
   * The instantiated template owner (`steps#1:step-execute`) when the row came from a foreach template.
   * Carried because it, not `nodeId` (the CONTAINER), is what names the seam an execution re-arm accepts.
   */
  nodeInstanceId?: string | null;
  waitReason: string | null;
  sourceColumn: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Episode key in `sourceMetadata`. Key-level `sourceMetadataPatch` writes only this key.
 *
 * FNXC:UnclaimedGraphWork 2026-11-17-01:05 (RUFU-1050): the constant is DECLARED in core
 * (`types/task/task-core.ts`) and re-exported here, because the operator's Retry must clear this register
 * through `buildManualRetryResetPatch`, and core cannot import the engine. A key declared engine-side is a
 * key the shared retry reset cannot name, which is how a Retry stops being an exit (RUFU-395).
 */
export { UNCLAIMED_GRAPH_WORK_EPISODE_METADATA_KEY };

/**
 * Nothing is a finding until the card has been untouched this long. Sized against the drain's own
 * cadence, not against human latency: the continuation poll runs every ~2 s
 * (`CONTINUATION_POLL_INTERVAL_MS`), so a due planning row that is genuinely owned has been
 * dispatched or deferred many times inside five minutes. Anything younger is a normal handoff and
 * naming it would announce healthy work — the RUFU-372 mistake.
 */
export const UNCLAIMED_GRAPH_WORK_STALENESS_MS = 5 * 60_000;

/**
 * How stale the drain's own last progress mark may be before "the drain will take it" stops being a
 * true sentence. One healthy pass marks progress, and passes run every `WORKFLOW_CONTINUATION_POLL_MS`
 * (~2 s), so a POSITIVE mark older than a minute means the pump is not consuming this card's row —
 * precisely the difference between the release seam's run promise being honest and being the lie this
 * task removes. A NULL age is not a stale age: no observation is not evidence of a stall.
 */
export const UNCLAIMED_GRAPH_WORK_DRAIN_PROGRESS_GRACE_MS = 60_000;

/**
 * A row whose `leaseExpiresAt` is still in the future is normally a live claim, and stealing a live
 * claim is worse than leaving a row deferred. This bound only bites a lease that has been re-stamped
 * across the whole window without the row being touched at all: the row's own `updatedAt` is older
 * than this while its lease keeps extending, i.e. nobody has ever finished with it. Sized well past
 * any legitimate review-gate lease heartbeat.
 */
export const UNCLAIMED_GRAPH_WORK_LEASE_UNTOUCHED_MS = 30 * 60_000;

/**
 * A deferral is a bounded wait owned by whoever stamped it (`PARKED_CONTINUATION_DEFER_MS` 60 s,
 * `PLANNER_LIVE_CONTINUATION_DEFER_MS` 15 s, `CAPACITY_REFUSAL_DEFER_MS` 45 s — none of them changed
 * here). Past this horizon the anchor says the wait has been re-stamped over and over and the row
 * still has not run, which is a repeating deferral rather than a wait.
 */
export const UNCLAIMED_GRAPH_WORK_DEFERRAL_REPEAT_MS = 10 * 60_000;

/** Redrive budget per unchanged episode signature. Past it the pass names the terminal outcome. */
export const UNCLAIMED_GRAPH_WORK_MAX_REDRIVES = 3;

/** History-line dedupe window. Carries no counter, so a sustained stall stays countable, not loud. */
export const UNCLAIMED_GRAPH_WORK_HISTORY_WINDOW_MS = 6 * 60 * 60_000;

/** The closed decision set. Every row names exactly one action and one owner. */
export type UnclaimedGraphWorkCode =
  /** Aged, due, reachable, and the drain has demonstrably not taken it. */
  | "due-unclaimed"
  /** Deferred past its own horizon repeatedly, so the deferral is no longer a wait. */
  | "deferred-repeating"
  /** Carries a future `leaseExpiresAt` on a row nothing has touched for a whole lease window. */
  | "lease-held"
  /** A valid row ranked past `DUE_PLANNING_CONTINUATION_BATCH_LIMIT`; the drain window owns it. */
  | "behind-drain-window"
  /** Another active row already owns the card's one continuation slot. */
  | "slot-held"
  /** Terminal row, `attempt = 0`, `waitReason` NULL, zero active rows, and NO durable recovery record. */
  | "terminal-node-orphan"
  /** Terminal row that a durable record already announces — an owner exists. */
  | "terminal-recorded"
  /** The card stands in a lane that neither plans nor executes (review, complete, merge). */
  | "not-planning-lane"
  /** The card's IR cannot answer which lanes plan and which execute. */
  | "lane-vocabulary-unreadable"
  /** A live planning/execution session owns the card. */
  | "live-session"
  /** A human or engine pause owns the card. */
  | "operator-held"
  /** Project auto-merge is off, so every automatic repair defers to the operator. */
  | "auto-merge-off"
  /** The inputs could not be read into a decision. */
  | "unreadable"
  /** Younger than {@link UNCLAIMED_GRAPH_WORK_STALENESS_MS}. */
  | "not-aged"
  /** A named layer owns this wait and may act on it; this pass writes nothing. */
  | "owned-elsewhere";

/** What the caller may do. `none` is a real answer, not a failure. */
export type UnclaimedGraphWorkAction = "redrive" | "rearm" | "replan" | "name-terminal" | "none";

/** Who may move the card. Fixed tokens so an audit row, a History line, and the release sentence quote one word. */
export type UnclaimedGraphWorkOwner =
  | "drain-window"
  | "planning-continuation-drain"
  | "hold-release-sweep"
  | "stranded-continuation-reclaim"
  | "wake-seams"
  | "lease-holder"
  | "execution-rearm"
  | "triage"
  | "operator"
  | "live-session"
  | "workflow-ir"
  | "this-pass";

export interface UnclaimedGraphWorkDecision {
  action: UnclaimedGraphWorkAction;
  code: UnclaimedGraphWorkCode;
  owner: UnclaimedGraphWorkOwner;
  /** 0 when the caller must not re-probe on a timer (an operator or another lane owns it). */
  retryAfterMs: number;
  /** The row the decision rests on, when one exists. Never invented. */
  itemId?: string;
  itemState?: string;
  nodeSeam?: string;
  /** Age measurement the decision rests on, taken from the row, never from a post-write clock. */
  stalenessMs: number;
  /** Why the FN-8592 predicate refused the same card, carried verbatim so both answers survive in one record. */
  holdReleaseReason?: string;
  /**
   * The decision's OWN identity, computed by the seam that made it. The pass persists this exact string as
   * its episode key rather than re-deriving one: the redrive budget is matched against this same value, so
   * a pass that rebuilt it from a different field set would silently never spend its budget — the
   * RUFU-1027 failure shape, where a bound keyed on the wrong fields is not a bound.
   */
  signature: string;
}

/** The episode shape this pass persists at key level. Diagnostic only — never a lifecycle field. */
export interface UnclaimedGraphWorkEpisode {
  code: UnclaimedGraphWorkCode;
  firstAt: string;
  /** Decision identity WITHOUT any growing counter (RUFU-442's bound-with-a-changing-key defect). */
  signature: string;
  redriveCount: number;
  /**
   * FNXC:UnclaimedGraphWork 2026-11-17-02:47 (RUFU-1050 code-review remediation, P1-2):
   * What the LAST pass decided and when it last told anyone. A withheld verdict writes no repair, so
   * without these two keys the pass has no durable dedupe key for its own announcements and a card resting
   * unowned for 28 days would either announce itself every 2-minute pass or every restart, depending on
   * which in-process memory the bound sat in (RUFU-318's in-process Set is lost on restart, so it bounds
   * the record to one per boot rather than one per window). The DEDUPED SURFACE is the withheld row; the
   * episode itself is still written on every pass that examined the card, so the per-card tally survives
   * restarts even when no new announcement is due.
   */
  lastAction?: UnclaimedGraphWorkAction;
  lastReportedAt?: string;
}

export interface UnclaimedGraphWorkInput {
  task: Pick<Task, "id" | "column" | "status" | "error" | "paused" | "userPaused" | "updatedAt" | "sourceMetadata"> & {
    /** Resolved effective auto-merge, not the raw project setting. */
    autoMerge?: boolean;
    /** Whether a durable specification exists for this card. */
    hasDurableSpec?: boolean;
  };
  /** ALL `kind: "task"` rows, unordered, terminalized ones included. See the module note. */
  items: UnclaimedGraphWorkItem[];
  /** Lanes the card's own IR resolves as pre-execution planning lanes (hold/intake). Never a literal id. */
  planningColumns: ReadonlySet<string>;
  /** Lanes the card's own IR resolves as WIP. A WF-004 board may resolve a lane that is not `in-progress`. */
  wipColumns: ReadonlySet<string>;
  /** Whether either question could be answered at all. */
  lanesReadable: boolean;
  liveness: "live" | "idle";
  /** The FN-8592 verdict for the same card, carried so both owners' answers appear in one record. */
  holdRelease?: { candidate: boolean; reason: string };
  drain: {
    /** `DUE_PLANNING_CONTINUATION_BATCH_LIMIT`, passed in rather than imported so the seam stays pure. */
    windowLimit: number;
    /** Whether this row appeared in the due page the drain actually read. */
    reachedByDueWindow: boolean;
    /** Age of the drain's own last progress mark; null when the caller cannot observe it. */
    drainProgressAgeMs: number | null;
  };
  /** The seam of the deciding node, resolved by the caller from the IR. Never guessed here. */
  nodeSeam?: string;
  /** Whether a durable terminal record already announces this card's failure. */
  terminalRecordExists?: boolean;
  now: number;
  /** The persisted episode, when one stands. */
  episode?: UnclaimedGraphWorkEpisode | null;
}

const TASK_ITEM_STATES_AFFECTING_OWNERSHIP = new Set<string>([
  "runnable",
  "running",
  "held",
  "retrying",
]);

const TERMINAL_STATES_WITHOUT_AN_OWNER = new Set<string>(["failed", "cancelled"]);

/** Statuses whose owning layer must be allowed to finish before any pass touches the card. */
const OTHER_OWNER_STATUSES: ReadonlyMap<string, UnclaimedGraphWorkOwner> = new Map<string, UnclaimedGraphWorkOwner>([
  ["planning", "live-session"],
  ["needs-replan", "triage"],
  ["failed", "operator"],
  ["stuck-killed", "operator"],
  ["awaiting-approval", "wake-seams"],
  ["queued", "hold-release-sweep"],
]);

function parseInstant(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The row this decision is about. A card can carry several rows through `continuationSequence`, so
 * the choice is ordered and never "the last one": an active planning-wait row outranks a terminal
 * orphan (the card is not idle while a row is live), and among active rows the row bound to the
 * lane the card actually stands in outranks a stranded sibling from an earlier lane.
 */
function selectDecidingItem(input: UnclaimedGraphWorkInput): UnclaimedGraphWorkItem | undefined {
  const active = input.items.filter((item) => TASK_ITEM_STATES_AFFECTING_OWNERSHIP.has(item.state));
  const boundHere = active.filter((item) => item.sourceColumn === input.task.column);
  const planningWait = [...boundHere, ...active].find((item) => item.waitReason === "planning");
  if (planningWait) return planningWait;
  if (active.length > 0) return boundHere[0] ?? active[0];
  const terminal = input.items.filter((item) => TERMINAL_STATES_WITHOUT_AN_OWNER.has(item.state));
  // Newest terminal row is the one that ended this card's run; ordering by two instants keeps the
  // choice stable when a back-dated migration stamped them identically.
  return [...terminal].sort((left, right) => {
    const leftAt = parseInstant(left.updatedAt) ?? parseInstant(left.createdAt) ?? 0;
    const rightAt = parseInstant(right.updatedAt) ?? parseInstant(right.createdAt) ?? 0;
    if (leftAt !== rightAt) return rightAt - leftAt;
    return right.id.localeCompare(left.id);
  })[0];
}

/*
FNXC:UnclaimedGraphWork 2026-11-17-02:47 (RUFU-1050 code-review remediation, P1-1):
Which `sourceMetadata` episodes count as a durable record about THIS dead row. The answer is the two
episodes that are themselves PARKS WITH A BUDGET AND A NAMED EXIT, and only those:
- `executionRearmEpisode` (RUFU-308/1028) — the re-entry authority's own exhaustion about this card's
  step-execute row. Its presence IS the record of a terminal re-arm decision.
- `branchConflictRecoveryEpisode` (RUFU-395) — the card's own checkout park, whose declared sole exit is
  an operator Retry. Re-planning under it would fight a standing operator hold.

The admission-stall episodes are NOT in this set, and that omission is the fix. `planAdmissionStall`
(RUFU-273) and `wipAdmissionStall` (RUFU-393) are diagnostics about ADMISSION, written by lanes that are
NOT looking at the graph row at all — RUFU-393 states its own episode "is a state record that refuses
nothing", and RUFU-273's sweep writes it with no lifecycle move. Counting them here let a sweep that was
blocked from *planning* a card veto the repair of that card's *dead execution row*, i.e. two sweeps each
waiting on the other's verdict with nothing able to act: the deadlock this classifier exists to end.
*/
const UNCLAIMED_GRAPH_WORK_RECORD_EPISODE_KEYS = ["executionRearmEpisode", "branchConflictRecoveryEpisode"] as const;

/** Does any durable record already announce this failure? Absence is NOT health — see the module note. */
function hasDurableRecoveryRecord(input: UnclaimedGraphWorkInput): boolean {
  if (input.terminalRecordExists === true) return true;
  const source = input.task.sourceMetadata as Record<string, unknown> | null | undefined;
  if (source && typeof source === "object") {
    for (const key of UNCLAIMED_GRAPH_WORK_RECORD_EPISODE_KEYS) {
      const value = source[key];
      if (value && typeof value === "object") return true;
    }
  }
  const error = typeof input.task.error === "string" ? input.task.error : "";
  return error.includes("EXECUTION_REARM_EXHAUSTED")
    || error.includes("PLANNING_RESEED_CYCLE_EXHAUSTED")
    || error.includes("PLANNING_FENCE_UNAVAILABLE")
    || error.includes("PLANNING_FAILED_EXHAUSTED")
    || error.includes("DETERMINISTIC_SPEC_VALIDATION_EXHAUSTED")
    || error.includes("MERGE_BOUNDARY_UNPROVEN")
    || error.includes("EXECUTION_DISPATCH_LOOP_EXHAUSTED");
}

/** The redrive budget is spent when the unchanged signature has already been re-driven too often. */
function redriveBudgetSpent(input: UnclaimedGraphWorkInput, signature: string): boolean {
  const episode = input.episode;
  if (!episode || episode.signature !== signature) return false;
  return (episode.redriveCount ?? 0) >= UNCLAIMED_GRAPH_WORK_MAX_REDRIVES;
}

/**
 * Decision identity: the code, the deciding row, its state, and the seam. Deliberately NO counter and
 * NO `task.status`/`task.error` — those two columns are written by the very repairs this seam routes,
 * and a bound keyed on fields the bounded loop rewrites is not a bound (RUFU-1027's measured defect).
 *
 * FNXC:UnclaimedGraphWork 2026-11-17-01:05 (RUFU-1050): every real verdict is stamped onto the decision
 * itself (`signature`), because the pass that persists the episode must persist THE SAME string the budget
 * test compares against. Two spellings of one key is how a redrive budget becomes unlimited.
 */
export function unclaimedGraphWorkSignature(code: UnclaimedGraphWorkCode, item: UnclaimedGraphWorkItem | undefined, seam: string | undefined): string {
  return `unclaimed-graph-work|${code}|${item?.id ?? "none"}|${item?.state ?? "none"}|${seam ?? "none"}`;
}

function decide(code: UnclaimedGraphWorkCode, extra: Partial<UnclaimedGraphWorkDecision>): UnclaimedGraphWorkDecision {
  const identity = extra.itemId
    ? { id: extra.itemId, state: extra.itemState } as UnclaimedGraphWorkItem
    : undefined;
  return {
    action: "none",
    code,
    owner: "this-pass",
    retryAfterMs: 0,
    stalenessMs: 0,
    ...extra,
    // Stamped LAST so it always names the code actually decided, never the placeholder above.
    signature: unclaimedGraphWorkSignature(code, identity, extra.nodeSeam),
  };
}

/**
 * Classify one card's unclaimed graph work. Ordered ladder: every early refusal is a NAMED owner,
 * and no leg may return a WIP release or a lane change — this seam has no authority over either.
 */
export function evaluateUnclaimedGraphWork(input: UnclaimedGraphWorkInput): UnclaimedGraphWorkDecision {
  const item = selectDecidingItem(input);
  const itemAt = parseInstant(item?.updatedAt) ?? parseInstant(item?.createdAt);
  const taskAt = parseInstant(input.task.updatedAt);
  // Measured from the NEWEST of the two writes, so a card whose row was just touched by its owner is
  // never announced mid-handoff. Never `Date.now()` — `now` is injected, so the seam is testable.
  const newest = Math.max(itemAt ?? 0, taskAt ?? 0);
  const stalenessMs = newest > 0 ? Math.max(0, input.now - newest) : input.now;

  const base: Partial<UnclaimedGraphWorkDecision> = {
    itemId: item?.id,
    itemState: item?.state,
    nodeSeam: input.nodeSeam,
    stalenessMs,
    holdReleaseReason: input.holdRelease?.reason,
  };

  if (!input.lanesReadable) {
    return decide("lane-vocabulary-unreadable", { ...base, owner: "workflow-ir", retryAfterMs: UNCLAIMED_GRAPH_WORK_STALENESS_MS });
  }
  if (input.task.paused === true || input.task.userPaused === true) {
    return decide("operator-held", { ...base, owner: "operator" });
  }
  if (input.liveness === "live") {
    return decide("live-session", { ...base, owner: "live-session", retryAfterMs: UNCLAIMED_GRAPH_WORK_STALENESS_MS });
  }
  const statusOwner = input.task.status ? OTHER_OWNER_STATUSES.get(input.task.status) : undefined;
  if (statusOwner) {
    return decide("owned-elsewhere", { ...base, owner: statusOwner, retryAfterMs: UNCLAIMED_GRAPH_WORK_STALENESS_MS });
  }
  const inPlanningLane = input.planningColumns.has(input.task.column);
  const inWipLane = input.wipColumns.has(input.task.column);
  if (!inPlanningLane && !inWipLane) {
    return decide("not-planning-lane", { ...base, owner: "hold-release-sweep" });
  }
  if (!item) {
    // A card with no work item at all is not this class — e.g. an operator Boost creates no row.
    return decide("owned-elsewhere", { ...base, owner: "planning-continuation-drain" });
  }
  if (stalenessMs < UNCLAIMED_GRAPH_WORK_STALENESS_MS) {
    return decide("not-aged", { ...base, owner: "planning-continuation-drain", retryAfterMs: UNCLAIMED_GRAPH_WORK_STALENESS_MS - stalenessMs });
  }
  if (input.task.autoMerge === false) {
    return decide("auto-merge-off", { ...base, owner: "operator" });
  }

  const budgetSpentFor = (code: UnclaimedGraphWorkCode): boolean =>
    redriveBudgetSpent(input, unclaimedGraphWorkSignature(code, item, input.nodeSeam));

  /* ------------------------------------------------------------------ */
  /* Shape B/C — a terminalized row that no dispatcher can ever read.    */
  /* ------------------------------------------------------------------ */
  if (TERMINAL_STATES_WITHOUT_AN_OWNER.has(item.state)) {
    if (item.attempt > 0 || item.waitReason !== null) {
      // `attempt > 0` is the graph's own retry ladder, and a terminal row that stopped WITHIN it is
      // already inside a bound. Only attempt 0 — a row terminalized before its first dispatch — is
      // the shape no ladder ever claimed.
      return decide("owned-elsewhere", { ...base, owner: "stranded-continuation-reclaim", retryAfterMs: UNCLAIMED_GRAPH_WORK_STALENESS_MS });
    }
    if (hasDurableRecoveryRecord(input)) {
      return decide("terminal-recorded", { ...base, owner: "operator", retryAfterMs: UNCLAIMED_GRAPH_WORK_STALENESS_MS });
    }
    /*
    The split is ONLY by what an existing authority can serve. `rearm` restates `attemptExecutionRearm`'s
    own gates (a `step-execute` seam node, the card still in its WIP lane, no live session) so a
    card-row reset and a work-item re-arm can never be confused — the pass may not write `status`,
    `error`, or a pause at all. `replan` needs no re-arm rule at all: returning a stranded card to
    planning is triage's own admission signal, which is what makes RUFU-1044's `execute`-seam case
    actionable instead of merely nameable.
    */
    if (inWipLane && input.nodeSeam === "step-execute") {
      return decide("terminal-node-orphan", { ...base, action: "rearm", owner: "execution-rearm" });
    }
    if (inPlanningLane && input.task.hasDurableSpec !== false) {
      return decide("terminal-node-orphan", { ...base, action: "replan", owner: "triage" });
    }
    return decide("terminal-node-orphan", { ...base, action: "name-terminal", owner: "operator" });
  }

  /* ------------------------------------------------------------------ */
  /* Shape A — an armed planning wait that no consumer will take.        */
  /* ------------------------------------------------------------------ */
  if (item.waitReason !== "planning") {
    // A `capacity` wait is the legitimate camera: `readyAtCapacityBoundary` reads exactly this row
    // and the hold/release sweep releases across it. Anything with no wait reason and no seam this
    // pass understands belongs to the reclaim sweep's stranded `held`/`running` table.
    const owner: UnclaimedGraphWorkOwner = item.waitReason === "capacity" ? "hold-release-sweep" : "stranded-continuation-reclaim";
    return decide("owned-elsewhere", { ...base, owner, retryAfterMs: UNCLAIMED_GRAPH_WORK_STALENESS_MS });
  }
  const otherActiveOwners = input.items.filter((candidate) =>
    candidate.id !== item.id
    && TASK_ITEM_STATES_AFFECTING_OWNERSHIP.has(candidate.state)
    && (candidate.state === "running" || candidate.state === "held" || candidate.waitReason === "planning"));
  if (otherActiveOwners.length > 0) {
    // One card, one active continuation slot. Whatever holds it owns the card's next dispatch.
    return decide("slot-held", { ...base, owner: "planning-continuation-drain", retryAfterMs: UNCLAIMED_GRAPH_WORK_STALENESS_MS });
  }

  const leaseExpiresAt = parseInstant(item.leaseExpiresAt);
  if (leaseExpiresAt !== null && leaseExpiresAt > input.now) {
    const untouchedMs = itemAt === null ? input.now : Math.max(0, input.now - itemAt);
    if (untouchedMs >= UNCLAIMED_GRAPH_WORK_LEASE_UNTOUCHED_MS && !budgetSpentFor("lease-held")) {
      // A lease that keeps being extended over a row nobody has ever finished with: the CAS seam
      // clears the lease without touching `state`, so no live claim is stolen and no row is resurrected.
      return decide("lease-held", { ...base, action: "redrive", owner: "this-pass", retryAfterMs: UNCLAIMED_GRAPH_WORK_STALENESS_MS });
    }
    return decide("lease-held", { ...base, owner: "lease-holder", retryAfterMs: Math.max(UNCLAIMED_GRAPH_WORK_STALENESS_MS, leaseExpiresAt - input.now) });
  }

  const retryAfter = parseInstant(item.retryAfter);
  if (retryAfter !== null && retryAfter > input.now) {
    const anchored = parseInstant(item.deferredSince);
    const deferredFor = anchored === null ? 0 : Math.max(0, input.now - anchored);
    if (deferredFor >= UNCLAIMED_GRAPH_WORK_DEFERRAL_REPEAT_MS && !budgetSpentFor("deferred-repeating")) {
      return decide("deferred-repeating", { ...base, action: "redrive", owner: "this-pass", retryAfterMs: UNCLAIMED_GRAPH_WORK_STALENESS_MS });
    }
    // A young deferral is a bounded wait with a named owner: the two wake seams lift it the moment
    // the cause disappears, and the horizon itself is shorter than the poll that would re-read it.
    return decide("owned-elsewhere", { ...base, owner: "wake-seams", retryAfterMs: Math.max(1_000, retryAfter - input.now) });
  }

  if (!input.drain.reachedByDueWindow) {
    /*
    The row is due, unleased, un-deferred — and still not read, because the due poll is a FIFO batch of
    `windowLimit` rows ordered by queue rank. This is the measured 136-card shape, and the owner is the
    WINDOW, not this pass: a repair that "releases a planning wait" fixes nothing for a card past row
    20, and re-driving it every pass would add load without changing reach. RUFU-826/RUFU-862 own it.
    */
    return decide("behind-drain-window", {
      ...base,
      owner: "drain-window",
      retryAfterMs: UNCLAIMED_GRAPH_WORK_STALENESS_MS,
    });
  }

  const progressAge = input.drain.drainProgressAgeMs;
  if (progressAge !== null && progressAge > UNCLAIMED_GRAPH_WORK_DRAIN_PROGRESS_GRACE_MS) {
    if (budgetSpentFor("due-unclaimed")) {
      // The redrive budget is spent and the pump still has not taken the row: name the outcome
      // instead of re-driving forever.
      return decide("due-unclaimed", { ...base, action: "name-terminal", owner: "operator" });
    }
    return decide("due-unclaimed", { ...base, action: "redrive", owner: "this-pass", retryAfterMs: UNCLAIMED_GRAPH_WORK_STALENESS_MS });
  }

  /*
  Due, reachable, and either the pump demonstrably ran or THIS PROCESS HAS NEVER OBSERVED IT AT ALL.
  A null progress age means "no evidence either way" — a CLI one-shot and a narrow test harness never
  run the drain, and reading that silence as starvation would rewrite the release sentence in every
  process that has never had a pump. Unobserved is therefore the pre-existing answer: the drain owns
  the row. Only a POSITIVE measurement that the pump is behind licenses `due-unclaimed`, which is the
  ONE shape where the release seam's run promise is an honest sentence and must survive byte-for-byte.
  */
  return decide("owned-elsewhere", { ...base, owner: "planning-continuation-drain", retryAfterMs: UNCLAIMED_GRAPH_WORK_DRAIN_PROGRESS_GRACE_MS });
}

/*
FNXC:UnclaimedGraphWork 2026-11-17-02:47 (RUFU-1050 code-review remediation, P1-1):
The audit events that constitute a durable TERMINAL record for a graph row, read from the store rather
than proxied by "`task.error` is non-empty". The set is closed and every name is an event some lane
actually emits when it terminalizes a card whose row is now dead:
- `task:execution-rearm-exhausted` — the re-entry authority spent its budget (RUFU-308).
- `task:execution-dispatch-loop-terminalized` — the execute self-requeue loop hit its cycle bound (FN-7863).
- `task:execution-escalation-exhausted` / `task:execution-tool-failure-retry-exhausted` — the model-lane
  retry ladder parked the card terminally (FN-7996/7998).
- `task:merge-boundary-unproven-parked` — a terminal merge-boundary park (FN-9168).
- `task:graph-failure-after-handoff-honored` — a graph failure recorded after a handoff was honored.

`task:graph-failed` is deliberately NOT in the set: no lane emits that name. The PROMPT and the module
note above both measure the RUFU-1044/RUFU-243 population by its ABSENCE ("no `task:graph-failed` row
anywhere"), which is the finding, not the health signal — so a card whose audit tail names none of these
is a card nobody recorded, and "we could not read the tail" degrades to the same answer. That polarity is
load-bearing and deliberate: every action this pass then takes is re-checked by its own authority (the
re-arm proves checkout evidence and spends a budget; `needs-replan` re-reads the live row), so an
unproven record can cost an attempt but never a lifecycle move.
*/
export const UNCLAIMED_GRAPH_WORK_TERMINAL_AUDIT_EVENTS = [
  "task:execution-rearm-exhausted",
  "task:execution-dispatch-loop-terminalized",
  "task:execution-escalation-exhausted",
  "task:execution-tool-failure-retry-exhausted",
  "task:merge-boundary-unproven-parked",
  "task:graph-failure-after-handoff-honored",
] as const;

/** How many of the card's newest audit rows the terminal-record probe reads before answering "none". */
export const UNCLAIMED_GRAPH_WORK_TERMINAL_RECORD_SCAN_LIMIT = 50;

/**
 * Read the card's own audit tail for a recorded graph-terminal event. `true` only when a row NAMES one;
 * an absent store reader, a throwing reader, and an empty tail all answer `false`, which the classifier
 * reads as the finding it is. See {@link UNCLAIMED_GRAPH_WORK_TERMINAL_AUDIT_EVENTS} for why the
 * unproven direction is safe and the proxy (`task.error` non-empty) was not.
 */
export async function unclaimedGraphWorkTerminalRecordExists(store: unknown, taskId: string): Promise<boolean> {
  const candidate = store as { getRunAuditEventsAsync?: (filter: Record<string, unknown>) => Promise<Array<{ mutationType?: unknown }>> } | null;
  const read = candidate?.getRunAuditEventsAsync;
  if (typeof read !== "function") return false;
  try {
    const rows = await read.call(candidate, { taskId, limit: UNCLAIMED_GRAPH_WORK_TERMINAL_RECORD_SCAN_LIMIT });
    if (!Array.isArray(rows)) return false;
    const terminal = new Set<string>(UNCLAIMED_GRAPH_WORK_TERMINAL_AUDIT_EVENTS);
    return rows.some((row) => typeof row?.mutationType === "string" && terminal.has(row.mutationType));
  } catch {
    return false;
  }
}

/*
FNXC:UnclaimedGraphWork 2026-11-17-02:47 (RUFU-1050 code-review remediation, P1-2):
Which WITHHELD verdicts are worth a durable `-no-action` record, and which are healthy work that must
stay silent. Naming healthy work is the measured mistake (RUFU-273/RUFU-372 both had to walk it back),
so the exclusions are a NAMED list and a new code defaults to reported:
- `not-aged` — under the five-minute floor. This is a normal handoff; on a busy board it is every card
  that was triaged in the last five minutes.
- `not-planning-lane` / `live-session` — a session or the next node owns the card right now.
- `operator-held` / `auto-merge-off` — a human decision, not a stall. The operator is the reader of this
  record and already knows; re-announcing their own choice every window is noise that hides the stalls.
Everything else (`behind-drain-window`, `owned-elsewhere`, `lease-held`, `slot-held`, `terminal-recorded`,
`deferred-repeating`, `lane-vocabulary-unreadable`, `unreadable`) names a card resting on a row this pass
can see and no repair could take — the population the card was opened to make queryable.
*/
const UNCLAIMED_GRAPH_WORK_SILENT_WITHHELD_CODES = new Set<UnclaimedGraphWorkCode>([
  "not-aged",
  "not-planning-lane",
  "live-session",
  "operator-held",
  "auto-merge-off",
]);

/** Whether a withheld verdict earns the paired `-no-action` record. See the list above for why. */
export function unclaimedGraphWorkWithholdingIsReportable(code: UnclaimedGraphWorkCode): boolean {
  return !UNCLAIMED_GRAPH_WORK_SILENT_WITHHELD_CODES.has(code);
}

/** Whether a decision means "no consumer will take this row", i.e. a run promise about it is a lie. */
/**
 * FNXC:HoldReleaseArmedPriority 2026-11-21-08:15 (RUFU-807 Step 4):
 * The honest release-refusal wording for a card the hold/release sweep is OBSERVED to defer, or `null`
 * when the card carries no such observation. This is RUFU-1050's seam widened by one cause, and it exists
 * because RUFU-1050's vocabulary could not name RUFU-805's shape at all: every code in that family blames
 * the continuation ROW (`due-unclaimed`, `lease-held`, `behind-drain-window`), while RUFU-805's row was
 * healthy and due — what never happened was the release sweep reaching the CARD to look at it.
 *
 * So the two seams are kept apart deliberately. This function decides no `UnclaimedGraphWorkCode` and
 * claims nothing about the row, because a code here would say "no consumer will take this row" — false.
 * It reads only the card's own persisted starvation episode, written by the one observer that measured the
 * deferral, and shares core's nomination predicate with the board badge so the badge and this sentence can
 * never disagree about whether the state is strong enough to speak. The wording asserts what will NOT
 * happen instead of promising what will: the sweep re-attempts every pass and has deferred this card past
 * its budget N times in a row.
 *
 * FNXC:HonestAbsence 2026-11-21-05:40 (RUFU-807 code review, P2):
 * The sentence may claim only what the observing pass actually measured. An earlier draft ended "Nothing is
 * running this card yet and no slot is full" — but a pass that truncated BEFORE reaching this card never
 * consulted a capacity pool, so that half asserted a negative it had not observed, which is exactly the
 * shape RUFU-372's honest-absence rule forbids (an absent measurement is not a zero measurement). What the
 * truncation DOES prove is that no gate refused the card, because a gate is only reached by evaluating it,
 * so the sentence says that and stops. Dropping the slot claim also removes an accidental promise: "no slot
 * is full" reads as "a slot is free for you", which a starved pass cannot know either.
 *
 * Kept here rather than inline at the call site because the whole claim of the RUFU-718 seam is that this
 * file pair is the ONLY place release-admission wording lives — the board move route, promote, the CLI and
 * `fn_task_promote` must not each invent their own story about a card that will not move.
 */
export function releaseSweepStarvedWaitDetail(
  episode: TaskHoldReleaseStarvationEpisode | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (!holdReleaseStarvationIsNominating(episode, nowMs)) return null;
  const deferred = episode?.stallCount ?? 0;
  const unevaluated = episode?.unevaluatedCount;
  const ageMs = episode ? holdReleaseStarvationAgeMs(episode, nowMs) : 0;
  const age = formatStarvationAge(ageMs);
  return (
    ` Plan Review is queued for this card, but the hold/release sweep has deferred it ${deferred} `
    + `time${deferred === 1 ? "" : "s"} without reaching it`
    + `${unevaluated !== undefined ? ` (${unevaluated} cards were left unevaluated behind its per-pass budget)` : ""}`
    + ` — it has been waiting ${age}. No gate has refused this card: the sweep never reached it to ask; the `
    + "next actor is the hold/release sweep, which re-attempts every pass and has run out of budget before this card every time."
  );
}

/** Age in operator words. A starvation measured in hours must not be printed as a millisecond count. */
function formatStarvationAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return "less than a minute";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.floor(hours / 24)} days`;
}

export function unclaimedWorkMeansStarved(decision: UnclaimedGraphWorkDecision): boolean {
  switch (decision.code) {
    case "due-unclaimed":
    case "deferred-repeating":
    case "lease-held":
    case "behind-drain-window":
    case "terminal-node-orphan":
    case "terminal-recorded":
      return true;
    default:
      return false;
  }
}
