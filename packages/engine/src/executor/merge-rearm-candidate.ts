/**
 * RUFU-834 — the PURE candidacy resolver for a review-lane card whose merge node died terminally.
 *
 * Kept free of stores, git, and clocks-so-settled state so "what is a candidate" cannot drift from
 * "what the sweep reclaims": the same discipline `workflows/stranded-continuation-reclaim.ts` states for
 * its own pure decision, and for the same reason — a sweep whose candidacy lives inside its own I/O is a
 * sweep whose coverage no test can pin (that is how the FN-8923 sweep shipped covering one ninth of the
 * problem it was written for).
 *
 * FNXC:MergeNodeReArm 2026-11-21-10:35 (RUFU-834):
 * WHY THIS SEAM EXISTS. A `kind:"task"` work item that reaches `failed` at a merge-region node is
 * unreachable by every reader that exists:
 *  - the due-poll claims only `runnable`/`retrying` (`runtimes/in-process-runtime.ts` due pass),
 *  - `stranded-continuation-reclaim` refuses everything outside `ACTIVE_WORKFLOW_WORK_ITEM_STATES` by
 *    design (its own classifier returns `scheduler-owned` for a terminal row),
 *  - `execution-rearm` (RUFU-308) refuses the card twice — its WIP-lane guard and its `step-execute`
 *    node guard are exactly the two refusals this shape falls in.
 * Measured on RunFusion: RUFU-293 sat `in-review` with plan-review and code-review both approved,
 * `mergeRetries = 0`, empty `error`, `status` NULL, and its `merge` work item `failed` since 2026-10-16
 * — fourteen days, zero `merge*` audit rows in a two-hour window — while 104 other cards sat `held` on
 * its `file-scope:RUFU-293` wait reason (RUFU-281 = 36, RUFU-369 = 4). The dead card had no re-entry
 * owner, so one inert row became a board-wide planning freeze.
 *
 * This module only ANSWERS "is this card mine, and which row failed where". The bounded action, budget,
 * and terminalization live in `merge-rearm.ts`; the two are split so the admission vocabulary can be
 * exercised per verdict without a store.
 */
import {
  ACTIVE_WORKFLOW_WORK_ITEM_STATES,
  HUMAN_MERGE_APPROVAL_HOLD_MARKER,
  type Task,
  type WorkflowWorkItem,
} from "@fusion/core";
import { FILE_SCOPE_HOLD_REASON_PREFIX } from "../workflows/stranded-continuation-reclaim.js";

/**
 * The node classes that are NOT this seam's because another named owner already re-drives them. A
 * `failed` row here is evidence about a different recovery, never a candidate for a merge re-entry.
 *
 * FNXC:MergeNodeReArm 2026-11-21-10:35 (RUFU-834):
 * `plan-review` / `code-review` / `browser-verification` / `post-merge-verification` belong to the
 * verdict-less-gate family: FN-8492 rewrites an orphaned `pending` row to `failed`, and the RUFU-610 /
 * RUFU-644 class (plus FN-9243 `task:merge-unrun-pre-merge-gate-rerouted` and FN-279's
 * `task:reconcile-unproven-review-approval`) re-seed the GATE, not the merge. `step-execute` is owned by
 * RUFU-308's `attemptExecutionRearm`, whose WIP-lane and `step-execute` guards are what refuse this
 * card — folding its node class in here would give one card two re-entry authorities.
 */
const OTHER_OWNERS_NODE_IDS: ReadonlySet<string> = new Set([
  "plan-review",
  "code-review",
  "browser-verification",
  "post-merge-verification",
  "step-execute",
]);

/** Node ids whose failed row means "the step frontier died", owned by RUFU-308 wherever the card is. */
const STEP_EXECUTE_NODE_PATTERN = /(^|:)step-execute$/;

/** True when a failed row belongs to a gate or the step frontier rather than to the merge lane. */
function belongsToAnotherOwner(nodeId: string): boolean {
  return OTHER_OWNERS_NODE_IDS.has(nodeId) || STEP_EXECUTE_NODE_PATTERN.test(nodeId);
}

/** Terminal work-item states, restated locally so this pure module never imports a private const. */
const TERMINAL_STATE_FAILED = "failed";

function rowTimeMs(row: Pick<WorkflowWorkItem, "updatedAt" | "createdAt">): number {
  const updated = Date.parse(row.updatedAt ?? "");
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(row.createdAt ?? "");
  return Number.isFinite(created) ? created : 0;
}

/** Result of the pure candidacy question. `reason` is `eligible` exactly when `eligible` is true. */
export interface InertMergeCandidate {
  eligible: boolean;
  /** The newest `failed` row at a merge-region node — the node the re-entry must target. */
  failedRow: WorkflowWorkItem | null;
  /** The failed row's node id, which comes from the card's own IR, never from a name list. */
  mergeNodeId: string | null;
  reason: CandidateReason;
}

/**
 * The closed row-level vocabulary. `merge-blocker-present`, `gate-not-approved`, `auto-merge-withheld`,
 * `already-landed`, `no-own-work`, `workspace-owned-elsewhere`, `suppressed-paused`, `too-young`, and
 * `sentinel-already-parked` are decided by `classifyInertMergeReentry` over caller-resolved facts,
 * because none of them is derivable from the work-item rows alone.
 */
export type CandidateReason =
  | "eligible"
  /** The card's lane is not one of its own workflow's review-role columns. */
  | "not-review-lane"
  /** An ACTIVE continuation already owns the card; whoever armed it owns its re-entry. */
  | "active-work-exists"
  /** A `running` row exists, or a caller-proven live session owns the card. */
  | "live-session"
  /** No `failed` row exists at all — there is nothing here to re-enter. */
  | "no-failed-merge-item"
  /** The newest failed row sits on a gate or the step frontier; another seam owns it. */
  | "failure-belongs-to-gate"
  /** A `held` row carries the human-merge-approval marker; `releaseHumanMergeApprovalHolds` owns it. */
  | "human-merge-hold"
  /** A `held` row carries a `file-scope:<id>` wait; `releaseFileScopeWaitingContinuations` owns it. */
  | "lease-held-by-other";

/**
 * Resolve whether one card is this seam's, from its rows alone.
 *
 * @param input.task The card (only `column` and lifecycle flags are read here).
 * @param input.workItems EVERY `kind:"task"` work item for the card, active and terminal. Passing only
 *   active rows would make a terminal row look like "no active row" by accident of the caller's filter;
 *   the caller passes the unfiltered set and this function does the partitioning.
 * @param input.irMergeNodeIds The merge-frontier node ids resolved from the card's SELECTED workflow IR
 *   via `isMergeRegionNode`. Never a hardcoded name list: the live evidence holds a node literally named
 *   `merge` expressed as `{ kind: "prompt", config: { seam: "merge" } }`, while the built-ins use
 *   `merge-gate` / `merge-attempt` / `manual-merge-hold` / `retry-backoff` / `recovery-router`.
 * @param input.reviewColumns The card's own workflow's review-role columns, from `resolveReviewColumns`.
 *   The lane test is resolved-vocabulary by design — matching on the `in-review` literal re-creates the
 *   renamed-board hole RUFU-272 documents.
 */
export function resolveInertMergeReentryCandidate(input: {
  task: Pick<Task, "column" | "paused" | "userPaused">;
  workItems: readonly WorkflowWorkItem[];
  irMergeNodeIds: ReadonlySet<string>;
  reviewColumns: ReadonlySet<string>;
}): InertMergeCandidate {
  const none = (reason: CandidateReason): InertMergeCandidate => ({ eligible: false, failedRow: null, mergeNodeId: null, reason });

  if (!input.reviewColumns.has(input.task.column)) return none("not-review-lane");

  const taskRows = input.workItems.filter((row) => row.kind === "task");
  const active = taskRows.filter((row) => (ACTIVE_WORKFLOW_WORK_ITEM_STATES as readonly string[]).includes(row.state));
  if (active.length > 0) return none(activeHoldReason(active));

  // Newest wins: a card may legitimately hold several historical failed rows after earlier attempts, and
  // only the most recent says where its graph stopped. Multiple candidates therefore still yield ONE
  // re-entry target, never one per row.
  const failed = taskRows
    .filter((row) => row.state === TERMINAL_STATE_FAILED)
    .sort((left, right) => rowTimeMs(right) - rowTimeMs(left));
  if (failed.length === 0) return none("no-failed-merge-item");

  const newest = failed[0]!;
  if (!input.irMergeNodeIds.has(newest.nodeId)) {
    return none(belongsToAnotherOwner(newest.nodeId) ? "failure-belongs-to-gate" : "no-failed-merge-item");
  }
  return { eligible: true, failedRow: newest, mergeNodeId: newest.nodeId, reason: "eligible" };
}

/**
 * Name the owner of an ACTIVE row instead of reporting a bare "something is active". Each branch maps to
 * a seam that already releases this exact reason string, which is what makes the refusal a hand-off
 * rather than a dead end — this seam never hides a row from its due-gated releaser.
 */
function activeHoldReason(active: readonly WorkflowWorkItem[]): CandidateReason {
  if (active.some((row) => row.state === "running")) return "live-session";
  const reasons = active.map((row) => (row.blockedReason ?? "").trim()).filter(Boolean);
  if (reasons.some((reason) => reason.startsWith(HUMAN_MERGE_APPROVAL_HOLD_MARKER))) return "human-merge-hold";
  if (reasons.some((reason) => reason.startsWith(FILE_SCOPE_HOLD_REASON_PREFIX))) return "lease-held-by-other";
  /*
  `workflow-principal-*`, `workflow-named-principal-*`, and `workflow-role-pool-*` need no separate
  verdict: the store's own claim predicate re-takes them (CLAIMABLE_HOLD_REASON_PREFIXES) and FN-8923
  owns the planning-lane subset. They land here as `active-work-exists`, which is the honest statement —
  the row is live and someone else owns it.
  */
  return "active-work-exists";
}
