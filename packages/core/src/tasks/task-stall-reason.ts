import {
  PLAN_ADMISSION_STALL_METADATA_KEY,
  PLAN_PREMISE_REJECTION_METADATA_KEY,
  type Task,
  type TaskPlanAdmissionStallCode,
  type TaskPlanAdmissionStallEpisode,
} from "../types.js";
import type { LifecycleColumns } from "../workflows/workflow-lifecycle-traits.js";
import {
  getTaskCompletionBlocker,
  getTaskMergeBlocker,
  isPreMergeStepsNotRunBlocker,
  isPreMergeStepsNotRunRefusal,
  PRE_MERGE_STEPS_NOT_RUN_BLOCKER,
} from "../merge/task-merge.js";

/*
FNXC:TaskStallReason 2026-09-01-15:35 (RUFU-174):
The board could say WHEN a card stopped moving (age staleness, in-review quiet windows) but not WHY.
The answering authorities already exist but each covers one slice: `getTaskMergeBlocker` for the
review lane, `allowsAutoMergeProcessing` for human-held cards, `getTaskCompletionBlocker` for the
real `blockedBy`/`dependencies` edges, and the lifecycle traits for terminal lanes. No read surface
stitched them together, so the same card reported "Merge stalled" in one lane and NOTHING when it
sat behind a dependency or in a hold column.

This helper is the canonical stitch, evaluated server-side at every task hydration site so list
consumers (board, search, the incremental sync stream) get one uniform `Task["stallReason"]`:
- answer is DERIVED, never persisted — the four inputs move on their own and a stored copy would
  drift from all of them;
- `undefined` means "moving or not derivable", so absence is not a claim of health — a WIP card
  whose agent died mid-run shows no reason until its stall badge fires;
- fail-OPEN by contract: a probe that throws must never break a task read, it only removes the
  diagnostic. That is the opposite of the merge authority, which fails closed — here a lying
  reason is worse than a missing one, so an unresolvable dependency reference is never asserted
  as a blocker.
The field is diagnostic-only: it must not be used as an auto-completion signal or as merge-gate
authority (the gate keeps asking the authorities directly, never this summary).
*/

/** Machine-readable classification of a stall/hold. The `reason` text is display copy and may be
 *  reworded; consumers that branch must branch on `code`. */
export type TaskStallReasonCode =
  /** The review lane refuses to merge: paused, blocking status, failed pre-merge step, … */
  | "merge-blocker"
  /** An enabled pre-merge gate has not run yet — a pipeline step pending, not a human task. */
  | "pre-merge-gate-pending"
  /** Nothing refuses; the card waits on a human because auto-merge processing is off for it. */
  | "held-human-review"
  /** A live `blockedBy`/`dependencies` edge keeps the card from being treated as complete. */
  | "dependency-blocker"
  /*
  FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
  The planning lane. RUFU-174's union answered only for delivery lanes, so the reported population —
  half a backlog sitting in the planning lane for days with `status: null` — produced no code at all
  and the operator had to patrol for it. These seven name the gate the card is behind.

  They are SEPARATE codes from the delivery ones on purpose: "the planner is full" and "the merge
  door refuses" need opposite remedies, and collapsing them would make the two answers
  indistinguishable to every consumer that branches on `code`.
  */
  /** Planning admission was withheld because no top-level planning slot was reservable. */
  | "plan-admission-throttled"
  /** The workflow's planning lane exists but excludes this card (manual intake / fast-lane skip). */
  | "plan-lane-ineligible"
  /** Planning is held by a plan-premise contract refusal (RUFU-246's episode is the evidence). */
  | "plan-premise-held"
  /** The card's spec artifact exists but cannot be read, so planning cannot start. */
  | "plan-spec-unreadable"
  /** The engine is waiting out a scheduled recovery backoff before it may re-attempt planning. */
  | "plan-recovery-backoff"
  /** Aged and eligible with nothing refusing it — no admission and no gate that can be named. */
  | "plan-no-admission"
  /** The row claims a branch holding commits that are not on the default branch. */
  | "recoverable-work";

export interface TaskStallReason {
  code: TaskStallReasonCode;
  /** Operator-facing sentence: canonical blocker text from the underlying authority, or a fixed
   *  human-hold sentence for `held-human-review`. */
  reason: string;
  /** ISO timestamp of the read that produced this assessment (same clock as sibling signals). */
  observedAt: string;
}

/** The task fields the derivation reads. `getTaskMergeBlocker`/`getTaskCompletionBlocker` take
 *  narrower picks; this is their union plus `column` for the lane gates. */
export type StallableTask = Pick<
  Task,
  | "id"
  | "column"
  | "paused"
  | "pausedReason"
  | "status"
  | "error"
  | "steps"
  | "workflowStepResults"
  | "repositoryScope"
  | "blockedBy"
  | "dependencies"
  /*
  FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
  The planning branch reads the two row episodes (`sourceMetadata` carries both `planAdmissionStall`
  and RUFU-246's `planPremiseRejection`), the scheduler's backoff timestamp, and the pause the
  operator authored. Every field is already persisted, so the branch costs no additional read.
  */
  | "sourceMetadata"
  | "nextRecoveryAt"
  | "userPaused"
>;

export interface TaskStallReasonContext {
  /** Clock (ms epoch) shared with sibling signals; `observedAt` derives from it. */
  now?: number;
  /**
   * Resolved review-lane membership (`resolveReviewColumnsForTask`). Omitted or empty keeps the
   * legacy `"in-review"` literal, matching the DELIBERATE-LITERAL default the merge authority
   * documents for unconverted callers.
   */
  reviewColumns?: ReadonlySet<string>;
  /**
   * Resolved lifecycle lanes for the task's own workflow. Each terminal role falls back to its
   * literal (`done`/`archived`) independently, mirroring the sibling fallback style.
   */
  lifecycleColumns?: LifecycleColumns | undefined;
  /**
   * Resolved required pre-merge gate ids (`resolveRequiredPreMergeStepIds`). Omitted, the gate
   * keeps the legacy results-only semantics and `pre-merge-gate-pending` cannot occur.
   */
  requiredPreMergeStepIds?: ReadonlySet<string>;
  /**
   * `allowsAutoMergeProcessing(task, settings)`. A `false` here is what surfaces a clean review
   * card as `held-human-review`; omitted is treated as allowed. NOTE: unlike `inReviewStall`,
   * which SUPPRESSES its stall signal under this flag, this derivation must still name the hold —
   * the card genuinely waits on a human then.
   */
  autoMergeAllowed?: boolean;
  /*
  FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
  Resolved planning-lane membership for the task's own workflow — the union of the `intake` and
  `hold` trait columns (`columnsWithFlag`). Omitted or empty means "the caller could not resolve a
  planning lane", and the planning branch stays silent: an unnamed card is acceptable, a card told
  it is stalled in a lane its workflow does not have is a lie. There is deliberately no legacy
  literal fallback here, unlike the review/terminal lanes — `todo`/`triage` as a fallback would
  stamp a planning stall on cards in a workflow that renamed its planning column.
  */
  /** Resolved planning-lane column ids (the `intake` and `hold` trait columns). */
  planningColumns?: ReadonlySet<string>;
  /** Suppression decided by the call site: merge-queued, or fresh `agent:log` activity means an
   *  agent is actively working the card, so no stall may be asserted. */
  suppressed?: boolean;
  /**
   * Lock-free reference resolver for `blockedBy`/`dependencies` targets. Called ONLY when the card
   * reaches the dependency branch, and only once per unresolved reference. A resolver that cannot
   * find the reference (missing or soft-deleted) returns null — a stale marker must never be
   * reported as a live blocker, so an unresolved `blockedBy` silently clears exactly like the
   * completion gate treats it.
   */
  resolveDependency?: (taskId: string) => Promise<Pick<Task, "id" | "column"> | null | undefined>;
  /** Per-dependency terminal/review lanes keyed by the DEPENDENCY's id (its workflow decides).
   *  A dependency absent from the map keeps the legacy literals. */
  satisfactionColumnsByTaskId?: ReadonlyMap<string, { terminal: ReadonlySet<string>; review: ReadonlySet<string> }>;
}

/**
FNXC:TaskStallReason 2026-09-01-15:35 (RUFU-174):
Fixed sentence for the human-hold branch, exported so tests and consumers assert the literal instead of restating it.
The branch fires when `allowsAutoMergeProcessing(task, settings)` answers false, which is a BOARD-level gate with a per-task and per-PR
exception: automatic merge processing is withheld when project `settings.autoMerge === false` unless the task opts back in with
`autoMerge: true`, or when the card carries a live human-authored open PR. A per-task `autoMerge: false` under a project that is ON
is NOT a hold on this gate (the merger parks it as manual-required elsewhere), so the sentence deliberately describes the gate's answer
about the card rather than claiming a task-level setting caused it.
*/
export const HELD_HUMAN_REVIEW_STALL_REASON =
  "Waiting on a human: automatic merge processing is withheld for this card, so review completion does not merge it";

/*
FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
One fixed sentence per planning-lane code, exported on the `HELD_HUMAN_REVIEW_STALL_REASON` pattern so
tests assert the literal instead of restating it. Each names the gate that is holding the card and who
owns it; none of them pair "merge" with "blocked", because nothing about the merge is at stake here and
the operator reading a planning card must not be sent to the delivery lane for an answer.
*/

/** Capacity gate (FN-8600): the planner declined to admit the card, it did not refuse it. */
export const PLAN_ADMISSION_THROTTLED_STALL_REASON =
  "Waiting for a planner slot: planning admission is withheld while the running planner capacity is full";

/** The card sits in a declared planning lane that never plans cards of this kind. */
export const PLAN_LANE_INELIGIBLE_STALL_REASON =
  "Waiting for a person to release it: this card's workflow lane does not plan it automatically";

/** RUFU-246's premise episode is present: the plan was refused against its own contract. */
export const PLAN_PREMISE_HELD_STALL_REASON =
  "Planning is held: the last plan was refused for violating its own stated premises, so a corrected plan is required";

/** The spec artifact exists but the read failed (a missing file is `ENOENT` and is NOT this code). */
export const PLAN_SPEC_UNREADABLE_STALL_REASON =
  "Planning cannot start: the card's written plan exists but cannot be read from task storage";

/** A future `nextRecoveryAt` parks the card until the scheduled retry. */
export const PLAN_RECOVERY_BACKOFF_STALL_REASON =
  "Waiting out a scheduled recovery pause before planning is attempted again";

/** The residual: aged, eligible, nothing refuses it, and no admission happened. */
export const PLAN_NO_ADMISSION_STALL_REASON =
  "No planning admission has been recorded for this card, and no gate that refuses it can be named";

/** The row names a branch whose commits are not on the default branch. */
export const RECOVERABLE_WORK_STALL_REASON =
  "This card's claimed branch holds commits that are not on the default branch, so work exists that the card does not show";

/** Code union of the persisted episode — the codes the row itself can carry (RUFU-273). */
type PlanAdmissionEpisodeCode = TaskPlanAdmissionStallCode;

/** Episode code -> stall reason. A fixed table: an episode code with no entry cannot appear as a stall. */
const PLAN_ADMISSION_STALL_SENTENCES: Record<PlanAdmissionEpisodeCode, string> = {
  "plan-admission-throttled": PLAN_ADMISSION_THROTTLED_STALL_REASON,
  "plan-lane-ineligible": PLAN_LANE_INELIGIBLE_STALL_REASON,
  "plan-spec-unreadable": PLAN_SPEC_UNREADABLE_STALL_REASON,
  "plan-no-admission": PLAN_NO_ADMISSION_STALL_REASON,
  "recoverable-work": RECOVERABLE_WORK_STALL_REASON,
};

/**
 * Read the persisted planning-admission-stall episode off a row (RUFU-273).
 *
 * Validation is structural, not permissive: a stored payload whose `code` is outside the fixed union
 * is treated as no episode at all. The episode is written by two engine lanes and read on every task
 * read, so a malformed or hand-edited value must degrade to silence rather than surface a code the
 * dashboard has no copy for.
 */
export function readPlanAdmissionStallEpisode(
  sourceMetadata: Record<string, unknown> | undefined,
): TaskPlanAdmissionStallEpisode | undefined {
  const raw = sourceMetadata?.[PLAN_ADMISSION_STALL_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const candidate = raw as Partial<TaskPlanAdmissionStallEpisode>;
  if (!isPlanAdmissionEpisodeCode(candidate.code)) return undefined;
  if (typeof candidate.lastAt !== "string" || typeof candidate.firstAt !== "string") return undefined;
  if (typeof candidate.stallCount !== "number" || !Number.isFinite(candidate.stallCount)) return undefined;
  return candidate as TaskPlanAdmissionStallEpisode;
}

/** True when `code` is one of the codes the row may carry. Keeps the union the single source of truth. */
function isPlanAdmissionEpisodeCode(code: unknown): code is PlanAdmissionEpisodeCode {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(PLAN_ADMISSION_STALL_SENTENCES, code);
}

/*
FNXC:PlanningAdmissionStall 2026-09-25-18:20 (RUFU-273):
The WRITE half of the episode contract, placed next to the read half so the two can never drift.
Triage's throttle site and the reconciliation sweep are independent writers of the same key, and each
one runs on a short poll. Without one shared decider, the obvious implementations are both wrong: a
naive "write what I just observed" stamps `firstAt` with the current poll and rewrites the row every
~15 s for a stall that lasts hours, while a naive "write only if the key is absent" freezes the FIRST
gate ever observed and hides the later, truer one (a card throttled for capacity that has since lost
its lane eligibility would claim "waiting for a planner slot" forever).

So the rule is: the same code refreshes `lastAt` and preserves `firstAt`, a DIFFERENT code restarts
the episode and resets `stallCount`, and `stallCount` increments only for a same-code repeat. The
refresh floor is what makes an hourly poll cheap: a sustained stall writes at most once per floor.
*/

/** How often a sustained same-code stall may re-stamp `lastAt` (RUFU-273). */
export const PLAN_ADMISSION_STALL_REFRESH_FLOOR_MS = 15 * 60_000;

/** Observation payload a writer contributes; `code` is required, the rest is optional evidence. */
export interface PlanAdmissionStallObservation {
  code: TaskPlanAdmissionStallCode;
  /** Stable dedupe signature supplied by the writer (e.g. triage's gate signature). */
  signature?: string;
  ageMs?: number;
  uniqueCommitCount?: number;
}

/**
 * Decide whether an observation justifies a row write, and produce the episode to write.
 *
 * Returns `undefined` when the write must be skipped — a sustained same-code stall inside the refresh
 * floor, or a `recoverable-work` re-observation whose commit evidence is unchanged and already fresh.
 * The caller writes the returned episode through `sourceMetadataPatch` keyed by
 * `PLAN_ADMISSION_STALL_METADATA_KEY`, which is what keeps unrelated provenance keys alive.
 */
export function planAdmissionStallWrite(
  existing: TaskPlanAdmissionStallEpisode | undefined,
  observation: PlanAdmissionStallObservation,
  observedAt: number = Date.now(),
): TaskPlanAdmissionStallEpisode | undefined {
  const now = new Date(observedAt).toISOString();
  const lastAtMs = existing ? Date.parse(existing.lastAt) : Number.NaN;
  const freshEnough = Number.isFinite(lastAtMs) && observedAt - lastAtMs < PLAN_ADMISSION_STALL_REFRESH_FLOOR_MS;
  const sameCode = existing?.code === observation.code;

  // A different gate is a new episode: it restarts the clock and resets the repeat counter.
  if (existing && !sameCode) {
    return {
      code: observation.code,
      lastAt: now,
      firstAt: now,
      stallCount: 1,
      ...(observation.signature !== undefined ? { signature: observation.signature } : {}),
      ...(observation.ageMs !== undefined ? { ageMs: observation.ageMs } : {}),
      ...(observation.uniqueCommitCount !== undefined ? { uniqueCommitCount: observation.uniqueCommitCount } : {}),
    };
  }

  if (existing && sameCode && freshEnough) return undefined;

  // Unchanged recoverable-work evidence adds nothing; the counts are the whole signal.
  if (
    existing
    && sameCode
    && observation.code === "recoverable-work"
    && observation.uniqueCommitCount === existing.uniqueCommitCount
  ) {
    return undefined;
  }

  return {
    code: observation.code,
    lastAt: now,
    firstAt: existing?.firstAt ?? now,
    stallCount: (existing?.stallCount ?? 0) + 1,
    ...(observation.signature !== undefined ? { signature: observation.signature } : existing?.signature !== undefined ? { signature: existing.signature } : {}),
    ...(observation.ageMs !== undefined ? { ageMs: observation.ageMs } : {}),
    ...(observation.uniqueCommitCount !== undefined ? { uniqueCommitCount: observation.uniqueCommitCount } : {}),
  };
}

/**
 * The key-preserving clear patch for the episode (RUFU-273). Writers must use this rather than
 * touching `sourceMetadata` wholesale — a whole-field wipe would orphan `duplicateOf`, `handoffFrom`,
 * and `contentFingerprint` alongside the stall episode.
 */
export function clearPlanAdmissionStallPatch(): Record<string, unknown> {
  return { [PLAN_ADMISSION_STALL_METADATA_KEY]: null };
}

/*
FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
The planning-lane branch of the derivation, factored out so its own guards are testable in isolation
and so the parent function keeps reading as a lane dispatch.

Evidence precedence is deliberate and mirrors "the most specific proven answer wins":
1. RUFU-246's premise episode — a *named contract violation* outranks a generic admission stall, and it
   is derived rather than copied into this episode so the two writers can never disagree.
2. The persisted admission episode — maps 1:1 onto its code. Triage wrote it for the capacity gate; the
   reconciliation sweep wrote it for the lanes triage cannot observe.
3. A future `nextRecoveryAt` — the engine already scheduled its own retry, so the wait has a cause even
   though no episode was written.

The population guards are the definition of the silent set, not decoration: a paused or user-paused card
is owned by the pause family (which writes its own badge), a non-empty `status` is owned by whatever
wrote it — `"queued"` in particular is a live scheduler transient, so naming it would put a stall chip on
every card that is being dispatched — and a card outside its workflow's planning lane has nothing to say.
*/
function derivePlanningAdmissionStall(
  task: StallableTask,
  context: TaskStallReasonContext,
  observedAt: string,
): TaskStallReason | undefined {
  const planningColumns = context.planningColumns;
  if (!planningColumns?.size || !planningColumns.has(task.column)) return undefined;
  if (task.paused === true || task.userPaused === true) return undefined;
  if (typeof task.status === "string" && task.status.length > 0) return undefined;

  const metadata = task.sourceMetadata;
  /*
  The premise episode is read as "the key is present and object-shaped", NOT through a validator: the
  writer (plan-review node) owns its schema, and this branch only needs to know a refusal is held.
  A malformed-but-present value still means the card is premise-held, and claiming otherwise would
  send the operator to a capacity gate that is not holding them.
  */
  const premise = metadata?.[PLAN_PREMISE_REJECTION_METADATA_KEY];
  if (premise && typeof premise === "object" && !Array.isArray(premise)) {
    return { code: "plan-premise-held", reason: PLAN_PREMISE_HELD_STALL_REASON, observedAt };
  }

  const episode = readPlanAdmissionStallEpisode(metadata);
  if (episode) {
    return { code: episode.code, reason: PLAN_ADMISSION_STALL_SENTENCES[episode.code], observedAt };
  }

  if (typeof task.nextRecoveryAt === "string" && task.nextRecoveryAt.length > 0) {
    const until = new Date(task.nextRecoveryAt).getTime();
    if (Number.isFinite(until) && until > (context.now ?? Date.now())) {
      return { code: "plan-recovery-backoff", reason: PLAN_RECOVERY_BACKOFF_STALL_REASON, observedAt };
    }
  }
  return undefined;
}

/** Legacy literals used only when the corresponding lane resolution is absent. */
const LEGACY_COMPLETE_COLUMN = "done";
const LEGACY_ARCHIVED_COLUMN = "archived";
const LEGACY_REVIEW_COLUMN = "in-review";

/**
 * Derive the canonical stall/hold reason for one task, or `undefined` when the card is moving,
 * terminal, suppressed, or the reason cannot be proven. Never throws: every probe failure degrades
 * to `undefined` (fail-open — a missing diagnostic is acceptable, a broken read is not).
 *
 * Determination order (pinned by unit tests): suppressed > terminal > review lane > dependencies >
 * planning admission.
 */
export async function deriveTaskStallReason(
  task: StallableTask,
  context: TaskStallReasonContext = {},
): Promise<TaskStallReason | undefined> {
  if (context.suppressed) return undefined;

  const lifecycle = context.lifecycleColumns;
  const completeLane = lifecycle?.complete;
  /*
  FNXC:TaskArchivingRemoved 2026-09-06 (merge origin/main dd808ed2c6, FN-295):
  The `archived` lifecycle trait no longer exists, so no live workflow can route a card to an archived
  lane. The historical literal stays terminal: soft-delete/legacy sentinel rows still carry the literal
  `"archived"` column and must never report a stall reason.
  */
  const inTerminalLane =
    (completeLane ? task.column === completeLane : task.column === LEGACY_COMPLETE_COLUMN)
    || task.column === LEGACY_ARCHIVED_COLUMN;
  if (inTerminalLane) return undefined;

  const observedAt = new Date(context.now ?? Date.now()).toISOString();

  const reviewColumns = context.reviewColumns?.size ? context.reviewColumns : undefined;
  const inReviewLane = reviewColumns
    ? reviewColumns.has(task.column)
    : task.column === LEGACY_REVIEW_COLUMN;
  if (inReviewLane) {
    /*
    The identity gate is passed the SAME resolved lane set, so a renamed review lane is checked
    against its real id and the helper can never emit the "must be in 'in-review'" identity sentence
    for a card that is legitimately standing in its own board's review lane.
    */
    let blocker: string | undefined;
    try {
      blocker = getTaskMergeBlocker(task, {
        reviewColumns,
        requiredPreMergeStepIds: context.requiredPreMergeStepIds,
      });
    } catch {
      return undefined;
    }
    if (blocker) {
      /*
      FNXC:TaskStallReason 2026-09-22-23:05 (RUFU-276, AC3):
      A never-ran-gate refusal can reach this arm in two spellings. The canonical one is the exact
      sentence, which `isPreMergeStepsNotRunBlocker` names. The second is the failed-status wrapper —
      `task is marked 'failed': AUTO_MERGE_RETRY_REJECTED: Cannot merge <id>: <canonical sentence>` —
      because the blocking-status arm of `getTaskMergeBlocker` composes the persisted error ahead of
      the not-run arm. Exact equality cannot see through that composition, so the wedge projected the
      generic `merge-blocker` and the operator lost both the gate-pending name and the RUFU-180 alert
      for the one class the engine can actually repair. The wrap-aware classifier recognises the
      embedded sentence; the reason stays the canonical gate sentence so the board chip and the
      notifier never show the composed park prose.
      */
      const unrunGate = isPreMergeStepsNotRunBlocker(blocker) || isPreMergeStepsNotRunRefusal(blocker);
      return {
        code: unrunGate ? "pre-merge-gate-pending" : "merge-blocker",
        reason: unrunGate && !isPreMergeStepsNotRunBlocker(blocker) ? PRE_MERGE_STEPS_NOT_RUN_BLOCKER : blocker,
        observedAt,
      };
    }
    if (context.autoMergeAllowed === false) {
      return { code: "held-human-review", reason: HELD_HUMAN_REVIEW_STALL_REASON, observedAt };
    }
    return undefined;
  }

  const hasBlockedBy = Boolean(task.blockedBy?.trim());
  const hasDependencies = (task.dependencies?.length ?? 0) > 0;
  /*
  FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
  No dependency marker means the dependency question is already answered — that used to end the
  derivation, and it is exactly why a card sitting in the planning lane for five days reported nothing.
  The dependency probe is now skipped rather than returning, so the planning branch below still runs.
  */
  if (!hasBlockedBy && !hasDependencies) {
    try {
      return derivePlanningAdmissionStall(task, context, observedAt);
    } catch {
      return undefined;
    }
  }
  /*
  Without a resolver every `blockedBy` would read as blocking (`getTaskCompletionBlocker`'s
  documented no-resolver contract). A stale marker on an already-terminal or deleted blocker would
  then lie on every card forever, so the diagnostic stays silent instead of unverified.
  */
  if (!context.resolveDependency) return undefined;

  try {
    const blocker = await getTaskCompletionBlocker(task, {
      resolveTask: context.resolveDependency,
      satisfactionColumnsByTaskId: context.satisfactionColumnsByTaskId,
    });
    /*
    FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
    A proven blocker is the stronger, already-authoritative answer and returns as before. A probe that
    PROVED there is no live blocker (every reference resolved terminal or deleted) no longer ends the
    derivation: the card is genuinely unblocked, so the planning lane may now name whatever else is
    holding it. A probe that threw still ends it — an unproven dependency question outranks any
    planning answer, because guessing here is exactly the lie the fail-open contract forbids.
    */
    if (blocker) return { code: "dependency-blocker", reason: blocker, observedAt };
  } catch {
    return undefined;
  }

  /*
  FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
  The planning-lane branch sits LAST — after suppression, the terminal lane, the review lane, and the
  dependency probe — because every earlier answer is more specific and more actionable than "a planner
  has not picked this card up". It shares the derivation's fail-open contract: a malformed episode or an
  unparseable `nextRecoveryAt` degrades to silence, never to a broken task read.
  */
  try {
    return derivePlanningAdmissionStall(task, context, observedAt);
  } catch {
    return undefined;
  }
}
