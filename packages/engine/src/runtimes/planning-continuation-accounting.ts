/*
FNXC:PlanningContinuationDispatch 2026-11-16-15:55 (RUFU-1069):
This module owns the ACCOUNTING half of the planning-continuation dispatch pass: the discriminated
outcome vocabulary, the rule table that turns an outcome into a deferral bound, the per-pass counters,
the one bounded audit row per stalled window, and the per-card History line.

WHY IT IS A SEPARATE MODULE. The defect this card removes is that `admitPlanningContinuation` could
answer `true` for an arm that dispatched nothing, and `drainDuePlanningContinuations` only recorded a
deferral for the `false` (shared-capacity) arm. Measured on the saneca board: five operator-boosted
cards sat `state=runnable, retryAfter=NULL, lease_owner=NULL` for six minutes while eight unboosted
cards were claimed, and nothing was written anywhere a human could read. A `boolean` cannot express
"examined but not dispatched, and here is why", so the contract became discriminated. Putting the
vocabulary, the bounds, and the record in one module is what stops the pass from being able to both
count an outcome and skip writing it: the only route to a History line or an audit row is through
here, so the drain cannot half-apply it.

DEPENDENCY DIRECTION IS ONE-WAY. This module never imports `in-process-runtime.ts`. The pre-existing
horizons (`CAPACITY_REFUSAL_DEFER_MS`, `PLANNER_LIVE_CONTINUATION_DEFER_MS`,
`PARKED_CONTINUATION_DEFER_MS`) stay where the FNXC text that relates them to
`WORKFLOW_CONTINUATION_POLL_MS` lives, and arrive here as the explicit `horizons` argument of
`planningAdmissionDeferralMs`. Their relative correctness is pinned by
`planning-window-outcome-accounting.test.ts`, which imports both sides.
*/

/** How long a refused or thrown examination parks its own row. */
/*
FNXC:PlanningContinuationDispatch 2026-11-16-15:55 (RUFU-1069):
The horizon for an examination that REFUSED (a lost running-claim CAS, a claim transition that
answered with no row, a planner that armed itself between the drain's check and the point of use) or
THREW (the planning-lifecycle advisory-lock grant timeout is the known candidate, RUFU-708/RUFU-550).

It is sized against `WORKFLOW_CONTINUATION_POLL_MS`, exactly like `CAPACITY_REFUSAL_DEFER_MS`, but in
the opposite direction. A shared-capacity refusal is TRUE for every later row in the window, so it
must outlast a whole window rotation (45 s) or the head re-enters before the tail is ever read. A
refusal is a property of ONE row, so the same 45 s would be a pure penalty: the row is not consuming
capacity and the next poll could use it. 15 s is eight polls — long enough that a persistently
refusing row stops re-filling a 20-wide due window every two seconds (the starvation mechanism
RUFU-812 named), short enough that a transient lock timeout costs one poll cycle times eight rather
than a rotation. It matches `PLANNER_LIVE_CONTINUATION_DEFER_MS` deliberately: both are transient
process conditions rather than a human wait (`PARKED_CONTINUATION_DEFER_MS`) or a full board.
*/
export const CLAIM_REFUSAL_DEFER_MS = 15_000;

/**
 * The one result of examining one due planning continuation.
 *
 * FNXC:PlanningContinuationDispatch 2026-11-16-15:55 (RUFU-1069):
 * This replaces two `Promise<boolean>` contracts (`admitPlanningContinuation` and
 * `dispatchPlanningContinuationIfCurrent`) whose `true` meant at least five different things, of
 * which four dispatched nothing. The rule for a new arm is: if the row can leave the pass due AND
 * silent, it is not a valid arm — every non-`dispatched` arm below has a bound in
 * `planningAdmissionDeferralMs` and a counter in `PlanningWindowOutcome`.
 *
 * `deferred-*`  = a wait that is expected to clear on its own, bounded by its own horizon.
 * `refused-*`   = this row could not be claimed right now; it is bounded, and it must NOT latch the
 *                window, because the reason belongs to the row and not to the board.
 * `skipped-*`   = the card is not this pass's work at all (terminal/orphan, operator park).
 * `errored`     = the examination threw. Bounded like a refusal so one broken row cannot end the pass.
 */
export type PlanningContinuationAdmission =
  | "dispatched"
  | "deferred-capacity"
  | "deferred-planner-live"
  | "deferred-in-flight-leak"
  | "refused-claim"
  | "refused-superseded"
  | "refused-not-planable"
  | "skipped-paused"
  | "skipped-approval-required"
  | "skipped-orphan"
  | "errored";

/** Every arm above. Exported so the ratchet test can assert no arm is unhandled. */
export const PLANNING_CONTINUATION_ADMISSIONS: readonly PlanningContinuationAdmission[] = [
  "dispatched",
  "deferred-capacity",
  "deferred-planner-live",
  "deferred-in-flight-leak",
  "refused-claim",
  "refused-superseded",
  "refused-not-planable",
  "skipped-paused",
  "skipped-approval-required",
  "skipped-orphan",
  "errored",
];

/** The horizons this table defers to, supplied by the caller that owns them. */
export interface PlanningAdmissionHorizons {
  capacityMs: number;
  plannerLiveMs: number;
  parkedMs: number;
}

/**
 * The drain's rule table: what bound does this outcome owe its own row.
 *
 * `null` means "write no deferral", which is legal for exactly two outcomes: `dispatched`, and the
 * two skip arms whose deferral the drain already wrote through `resolveParkedContinuationDeferral`
 * before asking. Returning a bound for those would be a second stamp over a row this pass already
 * armed, and `settlePlanningContinuationDispatch` writes `retryAfter: null` for a finished run — a
 * stamp there would fight the settlement in the same pass.
 */
export function planningAdmissionDeferralMs(
  outcome: PlanningContinuationAdmission,
  horizons: PlanningAdmissionHorizons,
): number | null {
  switch (outcome) {
    case "dispatched":
    case "skipped-paused":
    case "skipped-approval-required":
    case "skipped-orphan":
      return null;
    case "deferred-capacity":
      return horizons.capacityMs;
    case "deferred-planner-live":
      return horizons.plannerLiveMs;
    // A leaked in-memory run key and a refusal are both per-row transient conditions, so they share
    // the short horizon. They are still separate outcomes because the operator needs to know which:
    // `deferred-in-flight-leak` behind a DUE (unleased) row means process state leaked, and no
    // amount of waiting for capacity explains it.
    case "deferred-in-flight-leak":
    case "refused-claim":
    case "refused-superseded":
    case "refused-not-planable":
    case "errored":
      return CLAIM_REFUSAL_DEFER_MS;
  }
}

/** True when a refusal is a property of the whole window rather than of one row. */
export function planningAdmissionLatchesWindow(outcome: PlanningContinuationAdmission): boolean {
  return outcome === "deferred-capacity";
}

/**
 * The closed metadata shape of one window account. `task:planning-window-outcome` carries exactly
 * these keys: ids, counts, and booleans, never prose, error text, paths, or branch names.
 */
export interface PlanningWindowOutcome {
  limit: number;
  examinedCount: number;
  dispatchedCount: number;
  capacityDeferredCount: number;
  plannerLiveDeferredCount: number;
  claimRefusedCount: number;
  supersededCount: number;
  inFlightLeakCount: number;
  pausedSkipCount: number;
  approvalSkipCount: number;
  orphanCount: number;
  throwCount: number;
  windowHeadTaskId: string | null;
  windowHeadItemId: string | null;
  dueSetTruncated: boolean;
  examinedTaskIds: string[];
}

/** How many examined ids one account may name. */
export const PLANNING_WINDOW_EXAMINED_ID_CAP = 20;

/**
 * How often ONE accounting instance (one runtime/project) may re-report a zero-dispatch pass.
 *
 * FNXC:PlanningContinuationDispatch 2026-11-16-15:55 (RUFU-1069):
 * The continuation drain runs every `WORKFLOW_CONTINUATION_POLL_MS` (2 s), so an unbounded emitter is
 * ~43 200 rows/day for one permanently stalled window. This follows the RUFU-393 / RUFU-273 bound
 * precedent: the emission is gated on a floor that deliberately excludes the counters, because a key
 * that grows each cycle would make every pass a new wait and restore the row flood (RUFU-442's
 * measured failure).
 *
 * FNXC:PlanningContinuationDispatch 2026-11-16-20:52 (RUFU-1069 code review P0):
 * The floor is keyed on the CLASS of wait - one stalled window - and never on the window head. The
 * first cut deduped on `windowHeadItemId`, and that is not a bound: the drain now arms EVERY examined
 * non-dispatch row, so the armed head leaves the due set and the next pass reads a different
 * `items[0]`. In the exact scenario this card was filed for (219 due rows, whole window refusing at
 * the 45 s capacity horizon) a head-keyed floor emits roughly one row per 20 rows examined - about 880
 * rows/hour - which is RUFU-442's defect restated: a bound whose key changes every cycle. Head ids are
 * metadata describing one pass, never part of the wait identity.
 */
export const WINDOW_OUTCOME_REFRESH_FLOOR_MS = 15 * 60_000;

/** How often the SAME card may re-report the same reason on its own History line. */
export const PLANNING_WINDOW_HISTORY_WINDOW_MS = WINDOW_OUTCOME_REFRESH_FLOOR_MS;

/** The sink surface the accounting writes through. Both are optional and neither may fail the pass. */
export interface PlanningContinuationAccountingSinks {
  /** Store `logEntryOnce`, passed duck-typed so a partial store or a missing seam is simply unwritten. */
  logEntryOnce?: (
    taskId: string,
    input: { action: string; outcome?: string; dedupeKey: string; windowMs: number },
  ) => Promise<unknown> | unknown;
  /** Run-audit emit, expected to already be the bounded seam (`emitBoundedRunAudit`). */
  emitAudit?: (event: {
    mutationType: string;
    agentId: string;
    runId: string;
    domain: string;
    target: string;
    taskId?: string;
    metadata: PlanningWindowOutcome;
  }) => Promise<unknown> | unknown;
}

export interface PlanningContinuationAccountingDeps extends PlanningContinuationAccountingSinks {
  nowMs: () => number;
  /** Overrides the emission floor; tests pass a small value to prove the bound itself. */
  refreshFloorMs?: number;
  historyWindowMs?: number;
  examinedIdCap?: number;
  /**
   * Bound on any single sink write, so a hanging sink cannot stall the drain. It also bounds the
   * aggregate History flush at the end of a pass: the per-card writes are dispatched detached while
   * the loop runs (see `observe`) and only drained here, so one contended store seam costs the pass
   * one deadline rather than one deadline per examined row (RUFU-453's lesson - best-effort telemetry
   * must not sit on the owning lane's critical path).
   */
  sinkTimeoutMs?: number;
}

/** What the pass knows about its own window once the loop is over. */
export interface PlanningWindowSummary {
  limit: number;
  dueSetTruncated: boolean;
  windowHeadTaskId: string | null;
  windowHeadItemId: string | null;
}

export interface PlanningContinuationAccounting {
  /** Count one examination and, for a non-dispatch, name it on that card. Never throws. */
  observe(itemId: string, taskId: string, outcome: PlanningContinuationAdmission): Promise<void>;
  /** Close the pass: emit the bounded window account if it stalled, then reset for the next pass. */
  finish(summary: PlanningWindowSummary): Promise<PlanningWindowOutcome | undefined>;
  /** The counters so far; exposed for diagnostics and for the bound test. */
  snapshot(summary?: PlanningWindowSummary): PlanningWindowOutcome;
}

const EMPTY_COUNTS = {
  examinedCount: 0,
  dispatchedCount: 0,
  capacityDeferredCount: 0,
  plannerLiveDeferredCount: 0,
  claimRefusedCount: 0,
  supersededCount: 0,
  inFlightLeakCount: 0,
  pausedSkipCount: 0,
  approvalSkipCount: 0,
  orphanCount: 0,
  throwCount: 0,
} as const;

const COUNT_KEY_BY_OUTCOME: Record<PlanningContinuationAdmission, keyof typeof EMPTY_COUNTS | null> = {
  dispatched: "dispatchedCount",
  "deferred-capacity": "capacityDeferredCount",
  "deferred-planner-live": "plannerLiveDeferredCount",
  "deferred-in-flight-leak": "inFlightLeakCount",
  "refused-claim": "claimRefusedCount",
  "refused-superseded": "supersededCount",
  "refused-not-planable": "claimRefusedCount",
  "skipped-paused": "pausedSkipCount",
  "skipped-approval-required": "approvalSkipCount",
  "skipped-orphan": "orphanCount",
  errored: "throwCount",
};

/** One short, deterministic sentence per (card, reason). No wall clock: the dedupe key is the pair,
 *  and a body that changed every pass would read as a new event to a human scanning the History. */
const HISTORY_COPY: Record<Exclude<PlanningContinuationAdmission, "dispatched">, string> = {
  "deferred-capacity": "Planning dispatch skipped: the project capacity gate is full. Retry is armed for the capacity horizon.",
  "deferred-planner-live": "Planning dispatch skipped: a planner turn is already live for this card. Retry is armed shortly.",
  "deferred-in-flight-leak": "Planning dispatch skipped: this card already holds an in-memory run while its row is due, which means the run bookkeeping leaked. Retry is armed shortly.",
  "refused-claim": "Planning dispatch refused: another lane holds the running claim for this continuation. Retry is armed shortly.",
  "refused-superseded": "Planning dispatch refused: the continuation row changed under this pass. Retry is armed shortly.",
  "refused-not-planable": "Planning dispatch refused: the card is not dispatchable for planning right now. Retry is armed shortly.",
  "skipped-paused": "Planning dispatch skipped: the card is paused.",
  "skipped-approval-required": "Planning dispatch skipped: the card is waiting on an operator approval.",
  "skipped-orphan": "Planning dispatch cancelled: the continuation has no live card to run.",
  errored: "Planning dispatch failed: examining this continuation threw. Retry is armed shortly.",
};

/**
 * Resolve a sink write with a bound, swallowing every failure mode.
 *
 * FNXC:RunAudit 2026-11-16-15:55 (RUFU-1069): the RUFU-9175 rule is that telemetry must never become
 * a lifecycle dependency. The audit sink arrives already bounded by `emitBoundedRunAudit`; the
 * History write is a real store call, so the bound lives HERE. A sink that is absent, throws,
 * rejects, or never settles must leave the examination counted and the pass moving.
 */
async function settleSinkSafely(write: (() => Promise<unknown> | unknown) | undefined): Promise<void> {
  if (typeof write !== "function") return;
  try {
    await write();
  } catch {
    // A refused record is a lost record, never a lost dispatch.
  }
}

/** Race a sink write against a deadline so a hanging store call cannot stall the drain. */
function withDeadline<T>(work: () => Promise<T> | T, timeoutMs: number, nowMs: () => number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    // `nowMs` is read so a test driving stepped time also drives the deadline clock; the timer is
    // the real guard against a hanging sink.
    void nowMs();
    void (async () => {
      try {
        await work();
      } catch {
        // swallowed by contract
      } finally {
        clearTimeout(timer);
        finish();
      }
    })();
  });
}

/**
 * Build the per-runtime accounting object the drain reports through.
 *
 * The instance is long-lived (one per runtime, not one per pass) because its dedupe memory — the
 * stalled-window emission floor — must survive across passes or the 2 s poll would re-emit every pass.
 * The counters are per-pass and `finish` resets them.
 */
export function createPlanningContinuationAccounting(
  deps: PlanningContinuationAccountingDeps,
): PlanningContinuationAccounting {
  const refreshFloorMs = deps.refreshFloorMs ?? WINDOW_OUTCOME_REFRESH_FLOOR_MS;
  const historyWindowMs = deps.historyWindowMs ?? PLANNING_WINDOW_HISTORY_WINDOW_MS;
  const examinedIdCap = deps.examinedIdCap ?? PLANNING_WINDOW_EXAMINED_ID_CAP;
  const sinkTimeoutMs = deps.sinkTimeoutMs ?? 2_000;
  /** One gate for the whole stalled-window class; see `WINDOW_OUTCOME_REFRESH_FLOOR_MS`. */
  let lastStalledWindowEmissionAt: number | null = null;
  /** History writes started this pass and not yet flushed. Detached so a slow store seam cannot
   *  delay dispatching the rows still behind it; awaited once, under one deadline, in `finish`. */
  let pendingHistoryWrites: Promise<void>[] = [];
  const examinedTaskIds: string[] = [];
  const examinedTaskIdSet = new Set<string>();
  let counts = { ...EMPTY_COUNTS };
  let examinedCount = 0;

  const snapshot = (summary?: PlanningWindowSummary): PlanningWindowOutcome => ({
    limit: summary?.limit ?? 0,
    ...counts,
    examinedCount,
    windowHeadTaskId: summary?.windowHeadTaskId ?? null,
    windowHeadItemId: summary?.windowHeadItemId ?? null,
    dueSetTruncated: summary?.dueSetTruncated ?? false,
    examinedTaskIds: examinedTaskIds.slice(0, examinedIdCap),
  });

  const observe: PlanningContinuationAccounting["observe"] = async (itemId, taskId, outcome) => {
    examinedCount += 1;
    const countKey = COUNT_KEY_BY_OUTCOME[outcome];
    if (countKey) counts[countKey] += 1;
    if (!examinedTaskIdSet.has(taskId) && examinedTaskIds.length < examinedIdCap) {
      examinedTaskIdSet.add(taskId);
      examinedTaskIds.push(taskId);
    }
    if (outcome === "dispatched") return;
    const copy = HISTORY_COPY[outcome as Exclude<PlanningContinuationAdmission, "dispatched">];
    if (!copy || typeof deps.logEntryOnce !== "function") return;
    /*
    FNXC:PlanningContinuationDispatch 2026-11-16-20:52 (RUFU-1069 code review P2):
    The write is STARTED here and awaited in `finish`, not awaited inline. `logEntryOnce` opens a
    transaction and takes the per-task advisory lock, so awaiting it for every examined row put up to
    `limit` sequential store round-trips inside a pass meant to run every 2 s - a contended store would
    have re-created, in the accounting path, the very starvation this card removes from the dispatch
    path. Detached keeps the owning lane moving; the flush at the end of the pass is bounded by one
    `sinkTimeoutMs`, and a sink that is absent, throws, rejects, or never settles still cannot cost a
    dispatch (`withDeadline` plus the swallow below).
    */
    const write = withDeadline(
      () => deps.logEntryOnce?.(taskId, {
        action: copy,
        outcome,
        // The pair is the identity: a body that varies must not make a new key, or the floor is
        // unbounded again (RUFU-442).
        dedupeKey: `planning-window-outcome:${outcome}`,
        windowMs: historyWindowMs,
      }),
      sinkTimeoutMs,
      deps.nowMs,
    ).catch(() => undefined);
    pendingHistoryWrites.push(write);
    void itemId;
  };

  /** Drain the detached History writes once, under a single aggregate deadline. */
  const flushHistoryWrites = async (): Promise<void> => {
    const pending = pendingHistoryWrites;
    pendingHistoryWrites = [];
    if (pending.length === 0) return;
    await settleSinkSafely(() => Promise.allSettled(pending));
  };

  const finish: PlanningContinuationAccounting["finish"] = async (summary) => {
    const outcome = snapshot(summary);
    const stalled = outcome.examinedCount > 0 && outcome.dispatchedCount === 0;
    // The counters belong to the pass that just ended, so they reset before any await: a second
    // pass that starts while the emit is in flight must not inherit them.
    counts = { ...EMPTY_COUNTS };
    examinedCount = 0;
    examinedTaskIds.length = 0;
    examinedTaskIdSet.clear();
    // Every pass, stalled or not, closes the History writes it opened, under one bounded flush.
    await flushHistoryWrites();
    if (!stalled || typeof deps.emitAudit !== "function") return undefined;
    const headTaskId = outcome.windowHeadTaskId;
    /*
    FNXC:RunAudit 2026-11-16-20:52 (RUFU-1069 code review P1):
    The row carries the window head's task id as its own `taskId`. Retention reaches a run-audit row
    only through `task_id` (`pruneOperationalLogsAsync` deletes by task), so a taskless row is immortal
    - `store:open` had to be given an explicit bounded per-project exception for exactly that reason
    (RUFU-344). Attributing to the head card is the cheaper, self-clearing choice: the row is then
    collected with the card it describes, and no new retention exception is needed. A stalled pass
    always has a head card; a hand-built summary that names none is skipped rather than written
    unowned, because an uncollectable row is a leak rather than a record.
    */
    if (headTaskId === null) return outcome;
    const now = deps.nowMs();
    if (lastStalledWindowEmissionAt !== null
      && now - lastStalledWindowEmissionAt < refreshFloorMs) {
      return outcome;
    }
    lastStalledWindowEmissionAt = now;
    await settleSinkSafely(() => withDeadline(
      () => deps.emitAudit?.({
        mutationType: "task:planning-window-outcome",
        agentId: "planning-dispatch",
        runId: `planning-window-outcome:${headTaskId}`,
        domain: "database",
        target: headTaskId,
        taskId: headTaskId,
        metadata: outcome,
      }),
      sinkTimeoutMs,
      deps.nowMs,
    ));
    return outcome;
  };

  return { observe, finish, snapshot };
}
