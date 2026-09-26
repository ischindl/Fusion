import { ACTIVE_WORKFLOW_WORK_ITEM_STATES, HUMAN_MERGE_APPROVAL_HOLD_MARKER, type WorkflowWorkItem } from "@fusion/core";

/*
FNXC:StrandedContinuationReclaim 2026-08-11-09:12:
The scheduler's due-poll (`in-process-runtime.ts` -> `drainDuePlanningContinuations`) selects ONLY
`runnable`/`retrying`. A continuation that stops in `running` or `held` is therefore never looked at
again by any dispatcher, and the two ways it can stop there are both ordinary:

  1. `running` with a dead session. `acquireWorkflowWorkItemLease` is the only historical writer that
     sets `leaseExpiresAt`; the upsert/transition paths that install a fence leave it NULL. Triage's
     `writePlanningContinuation` is one such path, so a LIVE planner used to look exactly like a dead
     owner unless the caller supplied the independent planning-liveness proof.
  2. `held` with a blocked reason nothing retries. `acquireWorkflowWorkItemLease` can only re-take a
     `held` row whose `blockedReason` matches `workflow-principal-%`, `workflow-named-principal-%`, or
     `workflow-role-pool-%`; a NULL or non-matching reason never becomes claimable again.

Observed on the Fusion board on 2026-08-11: seven cards (FN-8932/8950/8953/8954/8956/8957/8958) sat in
`running` behind leases from a process that exited ~9h earlier, and FN-8901/FN-8902 sat `held` with a
NULL `blockedReason` for 46h. None produced a single run-audit row while stranded — the same silent
shape as the FN-8923 incident, whose sweep only covers `held` + `workflowRole: "triage"` +
`blockedReason` starting `workflow-principal-`, and so caught none of these nine.

A third case is pure residue: 33 rows in active states belonged to tasks that were archived AND
soft-deleted, the oldest from 2026-07-13. The FK is `ON DELETE CASCADE`, which only fires on a HARD
delete, so soft-deleting a task strands its continuations forever. They cannot run (their task is gone
from every scan) but they are counted by every `ACTIVE_WORKFLOW_WORK_ITEM_STATES` filter in the engine.

This module is the pure decision shared by the sweep and its tests, so "what is reclaimable" cannot
drift from "what the sweep reclaims" — the drift that let the FN-8923 sweep ship covering one ninth of
the problem it was written for.
*/

/** Terminal disposition for a row whose task can never run it again. */
export const RECLAIM_RETIRED_STATE = "cancelled" as const;

export type StrandedContinuationAction = "requeue" | "retire" | "defer" | "none";

export type StrandedContinuationReason =
  | "engine-paused"
  | "task-terminal"
  | "task-missing"
  | "operator-paused"
  | "manual-hold"
  | "live-session"
  | "live-planning"
  | "too-fresh"
  | "lease-active"
  | "scheduler-owned"
  | "dead-lease"
  /* RUFU-263 dedicated-owner suppressions — each names the seam that owns the wait. */
  | "principal-routing-hold"
  | "human-merge-approval-hold"
  | "file-scope-hold"
  | "stale-file-scope-hold"
  | "dependency-hold"
  | "stale-dependency-hold"
  /* RUFU-263 sustained condition: the same unclaimable hold this sweep already acted on once. */
  | "unclaimable-sustained"
  | "unclaimable-hold"
  /*
  FNXC:StrandedContinuationReclaim 2026-09-26-03:06 (RUFU-285):
  The row says nothing while the task row says everything: `overlapBlockedBy` names a live card whose
  file-scope lease is unavailable. Writing the canonical wait reason ends the loop instead of re-firing it.
  */
  | "file-scope-wait-converged";

/*
FNXC:StrandedContinuationReclaim 2026-09-22-14:21 (RUFU-263):
A discriminated union, because each action owns a DIFFERENT set of writes and the caller must not be able
to forget that:

- `requeue`  — the row becomes claimable; the caller may write the per-card `[recovery]` task-log line and
  writes the re-queue event row, but only when `announceRecovery` says this condition has not been
  announced before (RUFU-263: one note per condition, not one per maintenance pass).
- `retire`   — the row is terminalised; no task-log line (unchanged), one event row.
- `defer`    — the row stays in its current state with a durable `retryAfter`; NO task-log line and NO
  mutation event row. The sustained condition is instead recorded once, deduped, by the caller's
  `reconcile-stranded-no-action` row. `retryAfterMs` is the durable half of the bound: the same due-gate
  that hides the row from this sweep hides it from every reader, so the bound survives a restart.
- `none`     — a wait a named seam owns; the caller writes NOTHING at all.

RUFU-285 adds:

- `converge` — one CAS that adopts the wait the TASK row already proves: `blockedReason` becomes the canonical
  `file-scope:<blockerId>` (`ownedReason`) and `retryAfterMs` stamps the deferral in the SAME write. It writes
  NO task-log line and NO re-queue event row: an evidenced wait is not a recovery, and the `[recovery]` line is
  exactly the artifact that accumulated to 402 lines in six days. Afterwards the row is an ordinary owned
  file-scope wait, which the shipped `file-scope-hold` branch suppresses and
  `releaseFileScopeWaitingContinuations` releases.
*/
export type StrandedContinuationVerdict =
  | { action: "requeue"; reason: StrandedContinuationReason; announceRecovery: boolean; retryAfterMs?: number }
  | { action: "retire"; reason: StrandedContinuationReason }
  | { action: "defer"; reason: StrandedContinuationReason; retryAfterMs: number }
  | { action: "converge"; reason: "file-scope-wait-converged"; ownedReason: string; retryAfterMs: number }
  | { action: "none"; reason: StrandedContinuationReason };

/*
FNXC:StrandedContinuationReclaim 2026-09-22-14:21 (RUFU-263):
`held` is not one condition, and the reason string is the only field that says which one it is. Every
row below is measured against a NAMED owner, because a re-queue that a dedicated owner immediately
undoes is not recovery — it is the 5,914-row churn this change removes (RUFU-220 alone: 782 identical
`[recovery] workflow continuation re-queued` lines over nine days while the card never left
`todo/queued`). Owners are read from the writers, never guessed:

- `workflow-principal-*`, `workflow-named-principal-*`, `workflow-role-pool-*` — the three families the
  store's OWN claim predicate re-takes (`workflow-workitems-ops-2.ts`: `blockedReason IS NULL OR state =
  'runnable' OR state = 'retrying' OR (state = 'held' AND leaseOwner IS NULL AND blockedReason LIKE those
  three patterns)`), written by `executor/workflow-admission-hold.ts` (`workflowAdmissionHoldReason`),
  `executor/workflow-principal-before-node.ts` and `workflows/workflow-task-runtime.ts`. The scheduler
  re-claims these rows itself, so the generic sweep was never their owner; the planning-lane subset is
  additionally owned by FN-8923 `reconcilePrincipalHeldPlanningContinuations`. Suppression must be PURE
  (`action: "none"`): BOTH of its owners enumerate it through the due-gated `listDueWorkflowWorkItems` —
  `claimDueWorkflowWorkItem` (`workflows/work-work-scheduler.ts`) passes no `states` filter, so a `held`
  row is listed only while it is due, and FN-8923's sweep lists due `held` rows too. Stamping
  `retryAfter` would therefore hide the row from its own reclaimers and turn a churn into a freeze.
- `workflow-human-merge-approval*` (`HUMAN_MERGE_APPROVAL_HOLD_MARKER`, FN-514) — owned by
  `releaseHumanMergeApprovalHolds`, which ALSO lists due-gated `held` rows to detect that the operator's
  decision identity changed. Pure suppression for the same due-gate reason.
- `file-scope:<blockerId>` (`FILE_SCOPE_CONTINUATION_WAIT_PREFIX` + `fileScopeContinuationWaitReason`,
  written by `settlePlanningContinuationDispatch`) — owned by `releaseFileScopeWaitingContinuations`,
  which is event-driven (an `OverlapBlockerRelease`) and lists rows per task, NOT by due time. So a
  deferral is safe here, and a hold whose blocker evidence is already gone must be re-queued: the event
  that would have released it may have been lost across a restart, and the release owner refuses a task
  with an unmet `blockedBy`, so it would never come.
- `dependency:<taskId>` (written by `settlePlanningContinuationDispatch` when `task.status === "queued"`)
  and `dependency-configuration-blocked` (`workflowAdmissionHoldReason`) — NO dedicated releaser exists:
  `releaseFileScopeWaitingContinuations` matches only the exact `file-scope:` reason, and the `wake*`
  helpers clear `retryAfter` on `runnable` planning rows only. A permanent `none` would therefore be a
  freeze, so these get a durable deferred re-check instead, and a row whose `blockedBy` evidence no
  longer matches is stale and recovers immediately.
- `autoMerge:false` / `manual merge required` (`workflow-workitems-ops.ts` completion-handoff and
  merge-request projections) carry `state: "manual-required"`, which is not an ACTIVE state, and their
  `manual-hold` kind is already suppressed above — they cannot reach this classifier at all.
*/

/** Reason prefixes the store's own claim predicate re-takes; the scheduler owns these waits. */
export const CLAIMABLE_HOLD_REASON_PREFIXES: readonly string[] = [
  "workflow-principal-",
  "workflow-named-principal-",
  "workflow-role-pool-",
];

/** Canonical copy of `FILE_SCOPE_CONTINUATION_WAIT_PREFIX` (`runtimes/in-process-runtime.ts`), restated so
 *  this pure module stays free of the runtime's store imports. Drift is caught by the owner-routing tests. */
export const FILE_SCOPE_HOLD_REASON_PREFIX = "file-scope:";

/** Continuation wait for an unmet task dependency; written by `settlePlanningContinuationDispatch`. */
export const DEPENDENCY_HOLD_REASON_PREFIX = "dependency:";

/** Graph admission refusal for an unsatisfiable dependency configuration (`workflowAdmissionHoldReason`). */
export const DEPENDENCY_CONFIGURATION_HOLD_REASON = "dependency-configuration-blocked";

/*
FNXC:StrandedContinuationReclaim 2026-09-26-03:06 (RUFU-285):
The two reasons that mean "no seam owns this reason string", i.e. the row is about to be re-queued or put on
the unclaimable ladder. They are the ONLY verdicts that can still be rescued by task-level file-scope
overlap evidence, so the caller spends its one extra `getTask` (the holder liveness read) exactly here and
never for an owned-family row — a holder lookup per item would tax every maintenance pass to answer
questions the reason string has already settled.
*/
export function needsOverlapHolderProof(reason: StrandedContinuationReason): boolean {
  return reason === "unclaimable-hold" || reason === "unclaimable-sustained";
}

/*
FNXC:StrandedContinuationReclaim 2026-09-22-14:21 (RUFU-263):
The re-fire ladder. A sustained condition is reconsidered after 30 min, then 2 h, then at most every 6 h,
so a card that is genuinely waiting costs the operator <= 4 sweeps/day instead of one per ~15-minute
maintenance pass, while a hold whose blocking evidence clears is still picked up the next time it is due.
Which rung we are on is read back out of the row itself: the durable gap between `retryAfter` and the
moment the row last stopped (`updatedAt`) IS the width of the previous deferral, which is how the bound
survives a restart without a new column or a migration.
*/
export const RECLAIM_DEFERRAL_LADDER_MS: readonly number[] = [30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];

/**
 * Condition signature for the caller's once-per-condition memo: the same row, in the same state, for the
 * same stated reason, is ONE condition. A changed reason or state is genuinely new information and is
 * announced again.
 */
export function strandedHoldConditionKey(
  item: Pick<WorkflowWorkItem, "taskId" | "nodeId" | "state">,
  reason: string | null | undefined,
): string {
  return `${item.taskId}|${item.nodeId}|${item.state}|${reason ?? "<none>"}`;
}

/** Rung lookup: the first ladder step strictly wider than the deferral already observed on the row. */
function nextDeferralMs(priorWidthMs: number): number {
  let widest = 0;
  for (const rung of RECLAIM_DEFERRAL_LADDER_MS) {
    widest = rung;
    if (!Number.isFinite(priorWidthMs) || priorWidthMs < rung) return rung;
  }
  return widest;
}

/** Reason families whose wait the store's own claim predicate can re-take without this sweep. */
function isPrincipalRoutingHold(reason: string): boolean {
  return CLAIMABLE_HOLD_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

/** Ids named by a `dependency:A,B` wait reason. */
function dependencyHoldIds(reason: string): string[] {
  return reason.slice(DEPENDENCY_HOLD_REASON_PREFIX.length).split(",").map((id) => id.trim()).filter(Boolean);
}

/**
 * FNXC:StrandedContinuationReclaim 2026-08-11-09:12:
 * Decide what to do with ONE continuation row. Ordering is deliberate and load-bearing:
 *
 * - `enginePaused` wins over everything. A paused engine must not silently re-queue work an operator
 *   stopped; the row is still stranded when the engine resumes and the next sweep sees it.
 * - Retirement is tested BEFORE the pause and liveness gates. A soft-deleted or historical task has no
 *   operator decision left to respect and no session that could be live, and its row is exactly the
 *   residue that accumulates for a month when this check sits behind those guards.
 * - `manual-hold` is an operator-owned kind (`WORKFLOW_WORK_ITEM_KINDS`), not an accident. Its whole
 *   purpose is to stop until a human acts, so automatic reclaim must never touch it.
 * - Execution and planning liveness are separate caller proofs. Triage is a fourth possible owner of
 *   a `running` row, and its historical `writePlanningContinuation` path left `leaseExpiresAt` NULL.
 *   Both live-owner guards therefore outrank dead-lease classification and prevent double dispatch.
 * - `lease-active` still defers to a real unexpired lease even past the grace window: an expiry in the
 *   future is affirmative proof of a live claim, which staleness alone never is.
 *
 * @param input.item The continuation row under consideration.
 * @param input.taskTerminal The owning task is deleted, archived, or otherwise past running this row.
 * @param input.taskMissing No task row resolved for `item.taskId` at all.
 * @param input.live Caller-proven live execution for the owning task.
 * @param input.planningLive Caller-proven live planning for the owning task; omitted means false.
 * @param input.stalenessMs Age of the row's last update.
 * @param input.graceMs Minimum age before a row is considered abandoned.
 *
 * RUFU-263 adds the reason-aware branch below `dead-lease`: a `held` row is only re-queued when THIS
 * sweep can actually help. A wait owned by a named seam is suppressed or deferred, never re-queued, and
 * an unchanged condition is announced to the card history at most once — see the owner table above.
 *
 * @param input.taskBlockedBy The owning task's current unmet dependency, for validating a dependency wait.
 * @param input.taskOverlapBlockedBy The owning task's current file-scope blocker, for validating a file-scope wait.
 * @param input.alreadyAnnounced Caller-memo proof that this exact condition was already announced since
 *   process start; only an unclaimable hold consumes it, to stop the per-pass re-fire.
 * @param input.overlapHolderLive Caller-proven liveness for `taskOverlapBlockedBy`'s task (resolves, not
 *   soft-deleted, not in the terminal column); omitted means unproven, which keeps the wedge-class answer.
 *   RUFU-285: proving liveness is what keeps a dead blocker's leftover evidence from freezing a card.
 */
export function evaluateStrandedContinuationReclaim(input: {
  item: Pick<WorkflowWorkItem, "state" | "kind" | "leaseExpiresAt" | "leaseOwner" | "blockedReason" | "taskId" | "nodeId" | "retryAfter">;
  taskTerminal: boolean;
  taskMissing: boolean;
  taskPaused: boolean;
  live: boolean;
  planningLive?: boolean;
  enginePaused: boolean;
  stalenessMs: number;
  graceMs: number;
  now: number;
  taskBlockedBy?: string | null;
  taskOverlapBlockedBy?: string | null;
  alreadyAnnounced?: boolean;
  /**
  FNXC:StrandedContinuationReclaim 2026-09-26-03:06 (RUFU-285):
  Caller-resolved proof that `taskOverlapBlockedBy` names a task that still resolves, is not
  soft-deleted, and is not in the terminal column. Optional and compared with `=== true`, so an
  omitted proof (any existing caller) keeps the wedge-class answer rather than converging on an
  assumption.
  */
  overlapHolderLive?: boolean;
}): StrandedContinuationVerdict {
  if (input.enginePaused) return { action: "none", reason: "engine-paused" };
  if (input.taskMissing) return { action: "retire", reason: "task-missing" };
  if (input.taskTerminal) return { action: "retire", reason: "task-terminal" };
  if (!ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(input.item.state)) {
    return { action: "none", reason: "scheduler-owned" };
  }
  if (input.item.kind === "manual-hold") return { action: "none", reason: "manual-hold" };
  if (input.taskPaused) return { action: "none", reason: "operator-paused" };
  if (input.live) return { action: "none", reason: "live-session" };
  /*
  FNXC:PlanningExecutionLiveness 2026-09-06-00:29:
  A triage planner can own this row without any execution-liveness signal. Keep that proof distinct so
  recovery diagnostics identify `live-planning`, while omission preserves legacy callers as not live.
  */
  if (input.planningLive === true) return { action: "none", reason: "live-planning" };
  /*
  FNXC:StrandedContinuationReclaim 2026-08-11-09:12:
  `runnable`/`retrying` rows are the dispatcher's own queue. They are only reachable here through the
  retirement branches above (a dead task's row), never for reclaim — re-writing a live queue entry
  would reset its scheduling position for no gain.
  */
  if (input.item.state === "runnable" || input.item.state === "retrying") {
    return { action: "none", reason: "scheduler-owned" };
  }
  if (input.stalenessMs < input.graceMs) return { action: "none", reason: "too-fresh" };
  if (input.item.state === "running") {
    const expiresAt = input.item.leaseExpiresAt ? Date.parse(input.item.leaseExpiresAt) : Number.NaN;
    if (Number.isFinite(expiresAt) && expiresAt > input.now) return { action: "none", reason: "lease-active" };
    return { action: "requeue", reason: "dead-lease", announceRecovery: true };
  }
  /*
  FNXC:StrandedContinuationReclaim 2026-09-22-14:21 (RUFU-263):
  Everything below is a `held` row older than the grace window. Its `blockedReason` is the field that
  distinguishes a deliberate wait from an orphaned row, and reading it here is the whole fix: the sweep
  used to answer every one of them with a re-queue, which the owning seam answered back with the same
  hold ~15 minutes later, forever.
  */
  const reason = input.item.blockedReason?.trim() ?? "";
  /*
  The deferral ladder reads the width of the previous deferral off the row itself: `retryAfter` minus the
  instant the row last stopped (`updatedAt` = now - stalenessMs). A row never deferred by this sweep has
  no such width and starts at rung 0.
  */
  const stoppedAt = input.now - input.stalenessMs;
  const priorWidthMs = input.item.retryAfter ? Date.parse(input.item.retryAfter) - stoppedAt : Number.NaN;
  const deferVerdict = (why: "dependency-hold" | "unclaimable-sustained"): StrandedContinuationVerdict => ({
    action: "defer",
    reason: why,
    retryAfterMs: input.now + nextDeferralMs(priorWidthMs),
  });

  if (isPrincipalRoutingHold(reason)) {
    /*
    PURE suppression, never a deferral. Both releasers are due-gated: the claim predicate
    (`workflow-workitems-ops-2.ts`) is reached only through `claimDueWorkflowWorkItem`'s
    `listDueWorkflowWorkItems` listing, and FN-8923's `reconcilePrincipalHeldPlanningContinuations` lists
    due `held` rows as well. A `retryAfter` stamp would hide the row from the two seams that can release
    it. RUFU-263 review P2 named this second due-gated reader so the defer-eligible family set is
    enumerated rather than inferred.
    */
    return { action: "none", reason: "principal-routing-hold" };
  }
  if (reason.startsWith(HUMAN_MERGE_APPROVAL_HOLD_MARKER)) {
    /*
    FN-514's delivery lock. Its release owner `releaseHumanMergeApprovalHolds` (runtimes/in-process-runtime.ts)
    also lists due-gated `held` rows to notice that the operator's decision identity changed, so this is
    pure suppression for the same reason as principal routing.
    */
    return { action: "none", reason: "human-merge-approval-hold" };
  }
  if (reason.startsWith(FILE_SCOPE_HOLD_REASON_PREFIX)) {
    const blockerId = reason.slice(FILE_SCOPE_HOLD_REASON_PREFIX.length).trim();
    if (blockerId && input.taskOverlapBlockedBy?.trim() === blockerId) {
      // The blocker is still the task's current one; `releaseFileScopeWaitingContinuations` owns the release.
      return { action: "none", reason: "file-scope-hold" };
    }
    /*
    The wait names a blocker the task no longer carries. The release is an event (`OverlapBlockerRelease`)
    that a restart can lose, and its owner refuses any task with an unmet `blockedBy`, so nothing else will
    ever move this row: recover it. This is the acceptance-#2 clear-evidence case.
    */
    return { action: "requeue", reason: "stale-file-scope-hold", announceRecovery: true };
  }
  if (reason === DEPENDENCY_CONFIGURATION_HOLD_REASON
    || reason.startsWith(DEPENDENCY_HOLD_REASON_PREFIX)) {
    const stillWaiting = reason === DEPENDENCY_CONFIGURATION_HOLD_REASON
      ? !!input.taskBlockedBy?.trim()
      : dependencyHoldIds(reason).includes(input.taskBlockedBy?.trim() ?? "");
    if (stillWaiting) {
      /*
      No dedicated releaser exists for a dependency wait, so this cannot be a permanent `none` — that would
      trade the churn for a freeze. A durable `retryAfter` re-check keeps the card recoverable (the next due
      pass re-reads the task evidence) without re-firing every maintenance cycle.
      */
      return deferVerdict("dependency-hold");
    }
    // The dependency the wait named is gone (cleared, replaced, or satisfied): stale wait, recover now.
    return { action: "requeue", reason: "stale-dependency-hold", announceRecovery: true };
  }
  /*
  FNXC:StrandedContinuationReclaim 2026-09-26-03:06 (RUFU-285):
  A `held` row whose reason proves nothing, sitting on a card whose TASK row carries the durable proof of a
  real wait: `overlapBlockedBy` names another live card, published by `transitionQueuedEpisode` together with
  the matching `queuedLogEpisodeSignature`. The reason string is missing that evidence only because two
  different seams re-hold this row with their own vocabulary (`onSuspend` writes none at all, a capacity
  suspension; `holdPlanReviewNoOpContinuation` writes `plan-review-close-*`) and each replacement arrives with
  a fresh row identity, which resets `retryAfter` and changes the memo's condition signature. That is why
  process-local bounds cannot fix it: the loop RUFU-263 measured (402 `[recovery]` lines in six days on
  RUFU-254) is the sweep re-queuing a wait that was real every single time.

  So the verdict adopts the task row's evidence instead of fighting the row's vocabulary: the canonical
  `file-scope:<blockerId>` reason — byte-identical to what `settlePlanningContinuationDispatch` writes — plus
  the deferral ladder in ONE write. Two guards keep this honest: a lease owner means a claimant is mid-cycle
  (the claim predicate's `leaseOwner IS NULL` conjunct stays the truth), and the blocker must not be the row's
  own task, which would converge a card onto its own lease forever.
  */
  const overlapBlockerId = input.taskOverlapBlockedBy?.trim() ?? "";
  if (
    input.overlapHolderLive === true
    && overlapBlockerId
    && overlapBlockerId !== input.item.taskId
    && input.item.leaseOwner == null
  ) {
    return {
      action: "converge",
      reason: "file-scope-wait-converged",
      ownedReason: `${FILE_SCOPE_HOLD_REASON_PREFIX}${overlapBlockerId}`,
      retryAfterMs: input.now + nextDeferralMs(priorWidthMs),
    };
  }
  /*
  Genuinely unclaimable: no reason at all (the FN-8901/FN-8902 shape, held 46h with a NULL reason) or a
  reason no seam owns. The FIRST observation keeps the recovery exactly as FN-8901 wrote it — an immediate
  re-queue plus the `[recovery]` line, because that is what makes a real wedge move. A repeat of the SAME
  condition re-fires on the ladder instead of every pass, staying silent in the card history while the
  caller records the sustained state once, deduped.
  */
  if (input.alreadyAnnounced) return deferVerdict("unclaimable-sustained");
  return { action: "requeue", reason: "unclaimable-hold", announceRecovery: true };
}
