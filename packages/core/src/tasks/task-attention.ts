/*
FNXC:BoardOrdering 2026-11-13-09:30:
RUFU-526 - the board's default order must rank cards that need the operator ABOVE idle/backlog
cards. The operator steering comment that created this requirement is explicit: "The board's first
screen must show work that needs attention first; idle/backlog cards must never bury actionable
items." Measured before this module existed: one failed card among 200+ idle `todo` cards ranked
~201st, below every fold on desktop and mobile, because a lane's default order knew only the active
partition, Boost and arrival.

THIS MODULE IS PRESENTATION, NEVER LIFECYCLE. A tier is a display rank and nothing else: it must not
be imported from `packages/engine/src/execution/`, must never decide admission, dispatch, merge,
pause or retry, and must never write a card. The engine keeps asking its own authorities directly;
`compareTasksByQueueOrder` and `taskQueueOrderBy()` (which the dispatch paths consume) are unchanged
by this module and stay that way.

ONE LADDER, TWO HALVES. The same seven tiers exist twice:
  - `resolveAttentionTier` reads the HYDRATED row and may see derived display signals
    (`stallReason`, `inReviewStall`).
  - `sqlAttentionTier` reads ONLY the durable `tasks` columns that the PostgreSQL tier expression in
    `task-store/task-queue-order-ops.ts` reads, so it can serve as a keyset cursor key.
The SQL expression may UNDER-rank a row (a signal it cannot see leaves the row idle) but must never
OVER-rank it. The one declared divergence is `in-review-stall-deadlock`: the client sees it at tier 3
through the hydrated stall signal while SQL sees only `paused_reason` and ranks it 4 - never the
reverse. `task-attention-parity.test.ts` asserts `mirror >= client` for every fixture row rather
than excluding that pair.

WHY THE TIERS ARE NUMBERED FROM ZERO AND COMPARED ASCENDING: "lowest matching tier ranks highest" is
the normative contract of the ladder table, so both halves return the same integer and the comparator
sorts it ascending. `ATTENTION_TIER_IDLE` is the floor - a row matching nothing is idle, never urgent.
*/

/** A row matches nothing above it: idle `todo` (null/`queued`), backlog, done. */
export const ATTENTION_TIER_IDLE = 6;

const TIER_ERROR = 0;
const TIER_REQUIRED_GATE = 1;
const TIER_APPROVAL = 2;
const TIER_REVIEW_STALL = 3;
const TIER_PAUSED = 4;
const TIER_DEPENDENCY = 5;

/** The closed ladder. Lower ranks higher; `ATTENTION_TIER_IDLE` is the floor. */
export type AttentionTier =
  | typeof TIER_ERROR
  | typeof TIER_REQUIRED_GATE
  | typeof TIER_APPROVAL
  | typeof TIER_REVIEW_STALL
  | typeof TIER_PAUSED
  | typeof TIER_DEPENDENCY
  | typeof ATTENTION_TIER_IDLE;

/** The statuses whose mere presence means "this card stopped badly". */
const FAILING_STATUSES: ReadonlySet<string> = new Set(["failed", "blocked"]);

/*
The tier-1 vocabulary is CLOSED to these three shapes, and the closure is the contract:
`WorkflowStepResult.status` is `passed | failed | advisory_failure | skipped | pending`
(`types/workflow/workflow-steps.ts`), and `advisory_failure` is non-blocking by contract while
`skipped` is often an audited operator waiver. Treating either as attention would put a reporting-only
group or an operator waiver at the top of the board - the exact defect `ReportingOnlyGroup
2026-08-26-06:56` recorded in `merge/required-pre-merge-steps.ts`, where an advisory REVISE turned
into a reporter holding the merge door shut.
*/
const GATE_ATTENTION_STATUSES: ReadonlySet<string> = new Set(["failed", "pending"]);
/** Spelled once so a missing latest row and an attention status share one test. */
const GATE_MISSING_ROW_MARKER = "";

/**
 * The row fields the ladder reads.
 *
 * Every member is optional because this is a READ VIEW over a hydrated `Task`, not a new shape: a
 * field the caller did not load simply matches nothing, which is the under-rank direction the module
 * header allows. `AttentionTask` narrows to exactly the fields the CLIENT half reads; the durable
 * half (`sqlAttentionTier`) re-checks its own narrower durable subset.
 */
export interface AttentionTask {
  error?: string | null;
  status?: string | null;
  enabledWorkflowSteps?: readonly string[] | null;
  workflowStepResults?: readonly { workflowStepId: string; status: string }[] | null;
  awaitingApprovalReason?: string | null;
  humanPlanApproval?: { enabled?: boolean; decision?: unknown } | null;
  humanMergeApproval?: { enabled?: boolean; decision?: unknown } | null;
  /** Hydrated diagnostic only. Never persisted, therefore never a cursor input. */
  stallReason?: { code?: string } | null;
  /** Hydrated diagnostic only. Never persisted, therefore never a cursor input. */
  inReviewStall?: { code?: string; reason?: string; observedAt?: string } | null;
  pausedReason?: string | null;
  blockedBy?: string | null;
  overlapBlockedBy?: string | null;
  dependencies?: readonly string[] | null;
}

export interface ResolveAttentionTierOptions {
  /*
  The review-scope gate. `false` (the default) drops tier 1 and tier 3 entirely, and that is the
  cost bound the ladder owes: tier 1 is the ONLY arm that walks a step array, so a plain `todo` lane
  - the 200-idle-card lane this card exists for - runs zero nested step work per comparison. The
  server resolves the gate with `isReviewColumnRole`, the same authority the client uses, and a lane
  request naming MIXED columns gates OFF (all-or-nothing): enabling tier 1 for a plain `todo` column
  mixed in would OVER-rank it, which the ladder forbids.
  */
  reviewScope?: boolean;
}

/*
FNXC:BoardOrdering 2026-11-13-09:30:
Non-blank test shared by both halves. The blank set is the SIX ASCII whitespace characters
(`\t \n \v \f \r space`), deliberately narrower than `String.prototype.trim()`'s set, and the direction
of that narrowing is the whole point: the PostgreSQL arm spells the same test `~ '\S'`, and those six
characters are whitespace in every locale PostgreSQL can be built with, while JavaScript's `trim()` also
discards NBSP, the BOM, and the Unicode space separators. So "blank" here is a SUBSET of "blank" there,
which means "SQL sees a signal" always implies "the client sees a signal" - the ladder's one directional
rule. A value of nothing but a non-breaking space therefore ranks as a signal in TypeScript and stays
idle in SQL, which is the permitted direction (calmer, never more urgent); the reverse - trusting
`trim()` - would let the database float a card the client ranks idle.
*/
function isFilledText(value: string | null | undefined): boolean {
  return typeof value === "string" && /[^\t\n\v\f\r ]/.test(value);
}

/** Non-empty array test; a non-array or missing value matches nothing (under-rank). A predicate so the ladder can iterate the narrowed array. */
function hasItems(values: readonly unknown[] | null | undefined): values is readonly unknown[] {
  return Array.isArray(values) && values.length > 0;
}

/** Tier 0: the card stopped badly. `error` is trimmed so a whitespace value stays idle both sides. */
function tierError(task: AttentionTask): boolean {
  return isFilledText(task.error) || FAILING_STATUSES.has(task.status ?? "");
}

/*
Tier 1: a required pre-merge gate that is failed, pending, or has produced no result at all.

The step set is the row's OWN `enabledWorkflowSteps`, deliberately NOT `resolveRequiredPreMergeStepIds`
- that helper resolves the workflow IR per row, which PostgreSQL cannot express as one predicate, and
a tier whose two halves resolve differently is worse than a narrower tier. A stale
`enabledWorkflowSteps` naming a step the workflow no longer runs therefore reads as "no latest row"
and ranks 1: the ladder accepts that under-rank-shaped edge because it is exactly what the merge door
also blocks on, so the operator is never shown a card as calmer than the door considers it.
*/
function tierRequiredGate(task: AttentionTask): boolean {
  const enabled = task.enabledWorkflowSteps;
  if (!hasItems(enabled)) return false;
  const latestByStep = new Map<string, string>();
  /*
  FNXC:BoardOrdering 2026-11-13-09:30 (RUFU-526):
  The `Array.isArray` test here is not decoration. A corrupt row - a jsonb scalar or object where the array
  should be - reaches a hydrated task verbatim, and iterating a non-iterable would throw from the ordering
  path while the board was being drawn. The store's own writer refuses a non-array, so this is the
  read-side half of the same guard the SQL predicate carries as `jsonb_typeof(...) = 'array'`: a corrupt
  result list means "no verdict rows", which is the missing-row case, and never a crashed render.
  */
  const results = Array.isArray(task.workflowStepResults) ? task.workflowStepResults : [];
  for (const result of results) {
    if (typeof result?.workflowStepId !== "string") continue;
    // Array order is arrival order: the LAST row for a step id is the latest, matching
    // `latestResultForStep` in `merge/pre-merge-approval.ts`.
    latestByStep.set(result.workflowStepId, typeof result.status === "string" ? result.status : GATE_MISSING_ROW_MARKER);
  }
  for (const stepId of enabled) {
    if (typeof stepId !== "string") continue;
    const status = latestByStep.get(stepId) ?? GATE_MISSING_ROW_MARKER;
    if (GATE_ATTENTION_STATUSES.has(status) || status === GATE_MISSING_ROW_MARKER) return true;
  }
  return false;
}

/*
Tier 2: a decision the operator owes. `awaitingApprovalReason` is the persisted blocker, and the two
approval locks count while ARMED AND UNDECIDED - an approval the operator already answered is not
waiting on them. `decision === undefined` (key absent) is the armed signal on both halves: a persisted
`decision: null` keeps the key present, so client and SQL agree that it is not a wait either.
*/
function approvalArmed(state: { enabled?: boolean; decision?: unknown } | null | undefined): boolean {
  return state?.enabled === true && state.decision === undefined;
}

function tierApproval(task: AttentionTask): boolean {
  return (
    isFilledText(task.awaitingApprovalReason)
    || approvalArmed(task.humanPlanApproval)
    || approvalArmed(task.humanMergeApproval)
  );
}

/*
Tier 3: the engine's own merge/stall refusal on a card standing in a review lane.

These two fields are the reason tier 3 exists client-side only. `tasks/task-stall-reason.ts` documents
`stallReason` as derived and never persisted ("Diagnostic-only: must not be used as an auto-completion
signal and must never gate a merge"), and `inReviewStall` is hydrated on the same read paths. So this
arm reads EXACTLY these two fields and nothing from the neighbouring `task-core.ts` diagnostic block:
the other display summaries there are not blockers, and treating one as a blocker would rank a card
above what the durable row can justify - the over-rank the cursor contract forbids.
*/
function tierReviewStall(task: AttentionTask): boolean {
  return task.stallReason != null || task.inReviewStall != null;
}

/*
Tier 4: any pause reason. The presence of the reason is the signal, NOT `paused` itself - a card whose
pause flag has already been cleared while a stale reason lingers is still something the operator must
be able to find, and the reverse (reason set, flag false) is the documented data state this arm
answers "attention".
*/
function tierPaused(task: AttentionTask): boolean {
  return isFilledText(task.pausedReason);
}

/** Tier 5: waiting on another card - a dependency edge, or a file-scope / overlap wait. */
function tierDependency(task: AttentionTask): boolean {
  return (
    isFilledText(task.blockedBy)
    || isFilledText(task.overlapBlockedBy)
    || hasItems(task.dependencies)
  );
}

/**
 * The CLIENT tier: the display rank of one hydrated row.
 *
 * First match wins and the lowest matching tier ranks highest. The review-scope gate removes tier 1
 * and tier 3 when off, so a plain `todo` lane never walks a step array and never trusts a derived
 * stall signal. `priority` is not an input here and the existing priority/Boost weights inside a tier
 * are untouched: this function decides a bucket, never a total order.
 */
export function resolveAttentionTier(
  task: AttentionTask,
  options: ResolveAttentionTierOptions = {},
): AttentionTier {
  if (tierError(task)) return TIER_ERROR;
  if (options.reviewScope === true && tierRequiredGate(task)) return TIER_REQUIRED_GATE;
  if (tierApproval(task)) return TIER_APPROVAL;
  if (options.reviewScope === true && tierReviewStall(task)) return TIER_REVIEW_STALL;
  if (tierPaused(task)) return TIER_PAUSED;
  if (tierDependency(task)) return TIER_DEPENDENCY;
  return ATTENTION_TIER_IDLE;
}

/** The durable columns the SQL tier expression reads. Anything outside this set may not appear here. */
export type SqlAttentionTierTask = Pick<
  AttentionTask,
  | "error"
  | "status"
  | "awaitingApprovalReason"
  | "humanPlanApproval"
  | "humanMergeApproval"
  | "pausedReason"
  | "blockedBy"
  | "overlapBlockedBy"
  | "dependencies"
  | "enabledWorkflowSteps"
  | "workflowStepResults"
>;

/**
 * The MIRROR tier: the value the PostgreSQL tier expression actually sorted this row by.
 *
 * A keyset cursor is only safe when the key it stores is the key the database sorted by - the same
 * reason `sqlEffectiveBoostSequence` deliberately omits the workflow identity check (see the module
 * header of `task-store/task-queue-order-ops.ts`: "Resolving the boost in TypeScript with the
 * workflow identity would produce `0` for a row SQL ranked above `0`, and pagination would then skip
 * rows). Minting from `resolveAttentionTier` instead would store tier 3 for a row SQL ranked 4 and
 * the exclusive continuation predicate would then skip every row between them.
 *
 * Structurally identical to the client ladder by construction: the two arms SQL cannot see
 * (`stallReason`, `inReviewStall`) are absent from `SqlAttentionTierTask`, so this half cannot rank
 * anything ahead of what the durable row justifies. `in-review-stall-deadlock` therefore mirrors to
 * tier 4 through `pausedReason` while the client ranks it 3 - under-rank, never over-rank.
 */
export function sqlAttentionTier(
  task: SqlAttentionTierTask,
  options: ResolveAttentionTierOptions = {},
): AttentionTier {
  if (tierError(task)) return TIER_ERROR;
  if (options.reviewScope === true && tierRequiredGate(task)) return TIER_REQUIRED_GATE;
  if (tierApproval(task)) return TIER_APPROVAL;
  if (tierPaused(task)) return TIER_PAUSED;
  if (tierDependency(task)) return TIER_DEPENDENCY;
  return ATTENTION_TIER_IDLE;
}
