import type { Task } from "../types.js";
import type { LifecycleColumns } from "../workflows/workflow-lifecycle-traits.js";
import {
  getTaskCompletionBlocker,
  getTaskMergeBlocker,
  isPreMergeStepsNotRunBlocker,
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
  | "dependency-blocker";

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

/** Legacy literals used only when the corresponding lane resolution is absent. */
const LEGACY_COMPLETE_COLUMN = "done";
const LEGACY_ARCHIVED_COLUMN = "archived";
const LEGACY_REVIEW_COLUMN = "in-review";

/**
 * Derive the canonical stall/hold reason for one task, or `undefined` when the card is moving,
 * terminal, suppressed, or the reason cannot be proven. Never throws: every probe failure degrades
 * to `undefined` (fail-open — a missing diagnostic is acceptable, a broken read is not).
 *
 * Determination order (pinned by unit tests): suppressed > terminal > review lane > dependencies.
 */
export async function deriveTaskStallReason(
  task: StallableTask,
  context: TaskStallReasonContext = {},
): Promise<TaskStallReason | undefined> {
  if (context.suppressed) return undefined;

  const lifecycle = context.lifecycleColumns;
  const completeLane = lifecycle?.complete;
  const archivedLane = lifecycle?.archived;
  const inTerminalLane =
    (completeLane ? task.column === completeLane : task.column === LEGACY_COMPLETE_COLUMN)
    || (archivedLane ? task.column === archivedLane : task.column === LEGACY_ARCHIVED_COLUMN);
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
      return {
        code: isPreMergeStepsNotRunBlocker(blocker) ? "pre-merge-gate-pending" : "merge-blocker",
        reason: blocker,
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
  if (!hasBlockedBy && !hasDependencies) return undefined;
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
    if (!blocker) return undefined;
    return { code: "dependency-blocker", reason: blocker, observedAt };
  } catch {
    return undefined;
  }
}
