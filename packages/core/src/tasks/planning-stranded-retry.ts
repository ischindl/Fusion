import type { Task } from "../types.js";
import type { WorkflowIr, WorkflowIrV2 } from "../workflows/workflow-ir-types.js";
import { resolveColumnFlags } from "../workflows/trait-registry.js";
import { workflowDeclaresColumnModel, workflowPlansInColumn } from "../workflows/workflow-transitions.js";

/*
FNXC:PlanningStrandedRetry 2026-11-10 (RUFU-575, measured on saneca SANE-282 / SANE-524):
A planning run that dies on provider timeouts used to leave the card `queued` in its own planning lane
carrying `Specification failed after 3 transient errors: Request timed out.`, and NO verb could recover
it: `fn task retry SANE-282` answered "is not in a retryable state (status: queued)". The sibling shape
(SANE-524, `needs-replan` in the same lane) got the identical refusal. The card is not `failed` (so every
retry gate refuses it), not `planning` (the live planner claim), and not paused-with-a-reason (hold-release
owns those) — it is stranded while wearing a healthy-looking status, and nothing re-dispatches it.

FN-9512 already fixed the PRODUCER: transient planning exhaustion now writes an escalated reseed
(`status` from `resolvePlanningRetryHoldStatus`, `error: null`, `recoveryRetryCount: null`,
`recoveryDisposition: "escalated-reseed"`, `nextRecoveryAt: null`) instead of a terminal
`PLANNING_FAILED_EXHAUSTED` park. What FN-9512 could not fix is the CONSUMER half, because every retry
surface re-derives retryability from its own private status union — the exact
FNXC:WorkflowLifecycleColumns / FNXC:StrandedGateRetry defect class, whose own note states the invariant
this module exists to keep: "Core answers the shape identically here, on the CLI, in the extension tool
and on the board, so no surface can call the same card un-retryable."

This module is the ONE classification and the ONE non-destructive patch for that shape.

ADMISSION READS THE ROW AND ITS LANE, NEVER THE SPEC BODY — deliberately, and this is the load-bearing
decision of the whole change. Two facts fix it:
1. The re-arm patch below never writes `PROMPT.md`, so spec preservation is proven by *not touching the
   file* and asserted at each surface's test — there is nothing for an admission gate to check.
2. `packages/engine/src/triage.ts` already answers "the planner died and left no `PROMPT.md`" by
   escalating to a fresh planning pass (`PROMPT.md remained missing after ...; escalating to a fresh
   planning pass` -> `status: "needs-replan"`, `recoveryDisposition: "escalated-reseed"`). A provider
   timeout's NORMAL residue is a missing or seed-only spec, so a `no-durable-spec` refusal leg would
   refuse exactly the reported card and every unit test would stay green while `fn task retry SANE-282`
   kept answering "not in a retryable state". That is why this module exports no `promptContent` /
   `promptExists` parameter at all: with no such argument, no surface can re-introduce a spec-content
   gate by passing one. Do not add one, now or later.
*/

/**
 * The transient-spec-exhaustion sentence, split out of {@link PLANNING_EXHAUSTION_ERROR_MARKERS} because
 * the wedge layer asks a narrower question than the Retry verbs do.
 *
 * INCIDENT-ONLY provenance: zero writers remain in `packages/` after FN-9512 replaced the transient-
 * exhaustion exit, so the current tree writes this sentence nowhere. It exists on the real saneca rows
 * (SANE-282 `queued`, SANE-524 `needs-replan`) that motivated the task, and recognition of those rows
 * must survive.
 *
 * WHY A SEPARATE LIST. This marker's producer is exactly the exit FN-9512 deleted, so a row carrying it
 * has NO recovery claimant of any kind — which is the bar a wedge alert must clear. The authoring park
 * below does have one (generic terminal-failure auto-recovery), and `task-wedge-planning-fence.test.ts`
 * and `task-wedge-deterministic-spec.test.ts` both pin that deliberately ("For an authoring exhaustion a
 * retry really is the next move, so auto-recovery keeps claiming it"), so absorbing its rows here would
 * mute a live recovery lane for an alert. Alerting where a recovery is already running is the RUFU-288
 * defect pointed the other way, so the two marker families stay separate and each lane claims its own.
 */
export const PLANNING_SPEC_TIMEOUT_ERROR_MARKERS = [
  "Specification failed after ",
] as const;

/**
 * The authoring-exhaustion park prefix. IN-TREE provenance:
 * `packages/engine/src/planning-handoff-recovery.ts` still reads it (`PLANNING_FAILED_EXHAUSTED_PREFIX`
 * in `getPlanningFencePark`), so pre-RUFU-575 rows carrying it are a live population, not history. Such
 * a park may itself be stranded (its status is `failed`, which the CLI and the extension tool accept but
 * the board refuses and answers destructively), and the operator's remedy for it is the same
 * non-destructive re-plan — so it joins RETRY admission but not wedge visibility. See
 * {@link PLANNING_SPEC_TIMEOUT_ERROR_MARKERS}.
 */
export const PLANNING_AUTHORING_EXHAUSTION_ERROR_MARKERS = [
  "PLANNING_FAILED_EXHAUSTED:",
] as const;

/**
 * Closed list of terminal-planning-failure error markers RETRY admission recognises: the union of the two
 * families above, each carrying the provenance the RUFU-575 census named. A marker nobody has shown is
 * not registered — `PLANNING_TRANSIENT_EXHAUSTED` in particular is ABSENT, because the census found no
 * writer, no reader, and no changelog naming it, and registering it would be inventing a marker to match
 * a row nobody has shown.
 */
export const PLANNING_EXHAUSTION_ERROR_MARKERS = [
  ...PLANNING_SPEC_TIMEOUT_ERROR_MARKERS,
  ...PLANNING_AUTHORING_EXHAUSTION_ERROR_MARKERS,
] as const;

/** The row fields that decide whether planning exhausted on this card. Deliberately no spec body. */
export type PlanningExhaustionEvidenceTask = Pick<Task, "error" | "recoveryDisposition">;

/**
 * Whether the row itself proves a planning run reached an exhausted/escalated end: either it carries a
 * terminal-planning-failure marker in `error`, or it carries the FN-9512 escalated-reseed disposition
 * that the producer writes when it gives up on the current pass.
 *
 * Exported separately from the classification because the wedge layer needs exactly this row-only
 * question (`isTaskProgressing` has no IR in hand). The disposition alone is sufficient evidence ONLY
 * because the value names its authoring lane: `escalated-reseed` is written by planning exits whose every
 * site also nulls `nextRecoveryAt` — `triage.ts` spec/transient/unknown exhaustion and its missing-
 * `PROMPT.md` escalation, `scheduler.ts` filesystem-validation exhaustion, `self-healing.ts`
 * planning-handoff transport loss — while the execution lane's reseeds now carry
 * `escalated-execution-reseed` and never reach this leg. See the note on
 * {@link taskCarriesPlanningSpecTimeoutEvidence} for the collision that made the value, and not the status,
 * the discriminator.
 */
export function taskCarriesPlanningExhaustionEvidence(
  task: PlanningExhaustionEvidenceTask,
): boolean {
  return taskCarriesPlanningSpecTimeoutEvidence(task)
    || PLANNING_AUTHORING_EXHAUSTION_ERROR_MARKERS.some((marker) => includesMarker(task.error, marker));
}

/*
FNXC:ReseedLaneDiscriminator 2026-11-12-14:54 (RUFU-575 code review P0):
The disposition leg used to read `recoveryDisposition === "escalated-reseed"` alone, and that single
comparison was wrong because the value had two authors. The execution lane wrote it too —
`reseedExhaustedTransientExecution` and the stale-assistant-continuation exhaustion in
`executor/run-implementation.ts`, `executor/non-continuable-session.ts`,
`executor/worktree-branch-conflict-handle.ts`, `executor/required-artifact-recovery.ts`, and
`self-healing.ts`'s branch-conflict reclaim reseed — and each of those writes `status: null` and moves the
card to its rebound lane, where the scheduler then stamps the waiting status: capacity/admission refusal
(`scheduler.ts` `formatConcurrencyLimitReason`) and dependency/overlap queueing both write
`status: "queued"` and touch nothing else. The value is cleared only when the executor actually claims the
card, so it is on the row for the entire wait. The resulting row — planning column, `queued`, `error: null`,
`escalated-reseed` — matched fixture F3 on every field this predicate and the wedge arm read, so a fully-
specified card merely waiting for a slot alerted as "the planning run exhausted before it wrote a usable
specification" and, worse, an operator Retry answered it with `status: "needs-replan"`: a fresh planning
pass on a card whose spec and steps were intact, where the honest pre-change answer was a refusal naming
`queued`. That is the RUFU-372/RUFU-300 mistake in the other direction — capacity waits announcing as
failures — and a status-list guard could not catch it because the executor's own queued stamp produces the
planning lane's status.

The fix is at the value, not at any reader: `escalated-execution-reseed` is now the execution lane's value
(see the field note in `types/task/task-core.ts`), so this leg reads the PLANNING value only and no surface
has to prove the lane a second time. Three constraints this keeps: F3 — the post-FN-9512 planning row —
stays admitted because the planning writers were not touched and the FN-9512 pins are byte-identical; the
board badge still says "Recovery reseeded" for both values, so the diagnostic that the claim-time clear
deliberately preserves across the queue wait is not lost; and this classification still takes no spec body,
because the discriminator is the row's own author, not the residue on disk.

Known bounded residue, stated rather than papered over: rows written before this value split carry the
shared `escalated-reseed` for either lane, so a pre-split EXECUTION reseed still waiting unclaimed is
readable as planning evidence. Nothing in the row separates them after the queue stamp — the status, the
nulled error, and the nulled `nextRecoveryAt` agree — and refusing the shared value outright would refuse
the post-FN-9512 planning population this class exists to serve. The executor's claim-time clear is what
drains the stale rows, one claim per card.
*/

/*
FNXC:PlanningStrandedRetry 2026-11-10-23:06 (RUFU-575):
The narrower predicate defined just below is what the WEDGE layer reads, and the asymmetry is the point.
`taskCarriesPlanningExhaustionEvidence` answers "may Retry re-arm this card", which is the broadest
question; the wedge answers "does anything else bring this card back", and for a row carrying the
authoring-park prefix something does — generic terminal-failure auto-recovery claims it, a contract two
existing engine tests pin on purpose. So the alert-visibility predicate sees the transient-spec sentence
and the FN-9512 escalated-reseed disposition only — never the execution lane's
`escalated-execution-reseed`, whose card was handed back to its graph role instead of stranded. Do not
collapse the two predicates: the day the wedge
reads the broad one, `task-wedge-planning-fence.test.ts` and `task-wedge-deterministic-spec.test.ts` go
red over a recovery that is still running, which is exactly how RUFU-288's withheld alert was born.
*/
/**
 * Whether the row proves a planning run whose ONLY remaining path is an operator Retry: the transient
 * spec-timeout sentence FN-9512's producer no longer writes, or the PLANNING lane's escalated-reseed
 * disposition (whose writers all null `nextRecoveryAt`). The execution lane's reseeds carry
 * `escalated-execution-reseed` and are not evidence here. See the two notes above: one names the lane
 * collision this predicate must not read, the other why the authoring park is excluded.
 */
export function taskCarriesPlanningSpecTimeoutEvidence(
  task: PlanningExhaustionEvidenceTask,
): boolean {
  if (task.recoveryDisposition === "escalated-reseed") return true;
  return PLANNING_SPEC_TIMEOUT_ERROR_MARKERS.some((marker) => includesMarker(task.error, marker));
}

/** Marker test shared by both predicates: a non-empty string error, substring match, no parsing. */
function includesMarker(error: unknown, marker: string): boolean {
  return typeof error === "string" && error.length > 0 && error.includes(marker);
}

export type PlanningStrandedRetryClassification =
  | { kind: "planning-stranded" }
  | { kind: "not-planning-stranded"; reason: PlanningStrandedRetryRefusal };

/**
 * Why a card is NOT this retry class, so a retry surface can answer "why not" and keep naming the real
 * status in its refusal. CLOSED, and it has no spec-body member (see the module note).
 */
export type PlanningStrandedRetryRefusal =
  | "no-column-model"
  | "unknown-column"
  | "not-planning-column"
  | "status-owned-by-another-lane"
  | "operator-held"
  | "recovery-scheduled"
  | "no-planning-exhaustion-evidence";

/**
 * Statuses in which a stranded planning card exists. Each is a real observed owner of the reported rows,
 * and the exclusion list is what keeps this from being a global reclassification of `queued`:
 *
 * - `queued` — the scheduler's overlap/capacity stamp, and the shape SANE-282 was found in. Legitimate
 *   `queued` cards carry no exhaustion evidence and are refused by that leg, not by their status.
 * - `needs-replan` — SANE-524's shape, and what the post-FN-9512 producers write.
 * - `failed` / `stuck-killed` — a legacy `PLANNING_FAILED_EXHAUSTED:` park. Already accepted by the CLI
 *   and the tool, but the board refuses them for a planning card and answers with a destructive restart.
 *
 * `planning` is NEVER admitted: that is the live planner claim
 * (`claimPlanningStateUnlessDispatchClaimed` in `triage.ts`), and re-arming under a running planner
 * would race it. Every WIP/review/merge-active status is refused by the same leg — those lanes own
 * their own recovery.
 */
function statusIsStrandedPlanningStatus(status: Task["status"] | undefined | null): boolean {
  return status === "queued" || status === "needs-replan" || status === "failed" || status === "stuck-killed";
}

export type PlanningStrandedRetryTask = Pick<Task,
  | "column"
  | "status"
  | "error"
  | "recoveryDisposition"
  | "paused"
  | "userPaused"
  | "nextRecoveryAt">;

/**
 * Whether this card is stranded in its own planning lane by an exhausted planning run.
 *
 * Every refusal is its own named leg so no surface re-derives the answer and none can collapse two
 * different reasons into one "no":
 * - `no-column-model` / `unknown-column` — the IR cannot answer placement questions, or the card stands
 *   in a column the workflow does not declare.
 * - `not-planning-column` — the lane must be a pre-execution (hold/intake) lane AND the workflow must
 *   actually place a planning node in it (`workflowPlansInColumn`). WIP, review, merge and terminal lanes
 *   answer their own recovery; a card that carries the marker but sits elsewhere is not this class.
 * - `status-owned-by-another-lane` — see {@link statusIsStrandedPlanningStatus}.
 * - `operator-held` — a human or engine pause owns the card; a Retry that lifted it would silently
 *   overrule the hold, and neither pause reason this class appears under is in
 *   `buildAutoPauseClearPatch`'s engine-park allowlist.
 * - `recovery-scheduled` — a future `nextRecoveryAt` means the bounded scheduler retry owns the next
 *   attempt, and the wedge layer must stay silent for the same reason.
 * - `no-planning-exhaustion-evidence` — the leg that keeps a healthy capacity- or overlap-throttled
 *   `queued` card (the shape this task's own card logged as `queued - maxConcurrent capacity exhausted`)
 *   out of the class.
 */
export function classifyPlanningStrandedRetry(input: {
  task: PlanningStrandedRetryTask;
  ir: WorkflowIr | undefined;
  now?: number;
}): PlanningStrandedRetryClassification {
  const { task, ir } = input;
  if (!ir || !workflowDeclaresColumnModel(ir)) return { kind: "not-planning-stranded", reason: "no-column-model" };
  const column = (ir as WorkflowIrV2).columns?.find((entry) => entry.id === task.column);
  if (!column) return { kind: "not-planning-stranded", reason: "unknown-column" };

  const flags = resolveColumnFlags(column);
  const isPreExecutionLane = (flags.hold === true || flags.intake === true)
    && flags.countsTowardWip !== true
    && flags.mergeBlocker !== true
    && flags.humanReview !== true
    && flags.complete !== true;
  if (!isPreExecutionLane || !workflowPlansInColumn(ir, task.column)) {
    return { kind: "not-planning-stranded", reason: "not-planning-column" };
  }

  if (!statusIsStrandedPlanningStatus(task.status)) return { kind: "not-planning-stranded", reason: "status-owned-by-another-lane" };
  if (task.userPaused === true || task.paused === true) return { kind: "not-planning-stranded", reason: "operator-held" };
  const now = input.now ?? Date.now();
  const nextRecoveryAt = Date.parse(task.nextRecoveryAt ?? "");
  if (Number.isFinite(nextRecoveryAt) && nextRecoveryAt > now) return { kind: "not-planning-stranded", reason: "recovery-scheduled" };
  if (!taskCarriesPlanningExhaustionEvidence(task)) return { kind: "not-planning-stranded", reason: "no-planning-exhaustion-evidence" };

  return { kind: "planning-stranded" };
}

/** The re-arm patch — exactly these keys, and nothing else. */
export type PlanningStrandedRetryPatch = Pick<Task,
  | "status"
  | "error"
  | "recoveryRetryCount"
  | "nextRecoveryAt"
  | "recoveryDisposition"
  | "planningFailure">;

/**
 * The non-destructive re-arm, and the whole deliverable in six keys: `status: "needs-replan"` is the
 * re-admission request the planner and the scheduler already honour
 * (`isTaskAwaitingPlanning` / `AWAITING_PLANNING_STATUSES` treat it as awaiting planning, and triage's
 * todo rediscovery consumes it), while `null` would name no owner at all. The stale error and the
 * planning recovery bookkeeping go with it, because a row that still carries the exhausted run's error
 * or counters keeps looking like the failure the operator just asked to redo.
 *
 * It deliberately does NOT name `column`, `steps`, `currentStep`, `promptContent`, `worktree`, `branch`,
 * `baseBranch`, `baseCommitSha`, `sessionFile`, `blockedBy`, `overlapBlockedBy`, or any merge/worktree
 * field. `PROMPT.md` is never written or deleted — the next planner pass decides whether to keep or
 * overwrite the body it finds, which is what makes a missing or seed-only spec an ordinary input rather
 * than a special case. `blockedBy`/`overlapBlockedBy` stay untouched because the scheduler owns the queue.
 *
 * Surfaces compose this with the shared `buildManualRetryResetPatch` / `applyRetryReset` exactly as they
 * already do for every other retry class, so the retry counters keep one owner.
 */
export function buildPlanningStrandedRetryPatch(
  _task: Pick<Task, "column" | "status">,
): PlanningStrandedRetryPatch {
  return {
    status: "needs-replan",
    error: null as unknown as Task["error"],
    recoveryRetryCount: null as unknown as Task["recoveryRetryCount"],
    nextRecoveryAt: null as unknown as Task["nextRecoveryAt"],
    recoveryDisposition: null as unknown as Task["recoveryDisposition"],
    planningFailure: null as unknown as Task["planningFailure"],
  };
}
