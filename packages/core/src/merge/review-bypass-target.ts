/*
FNXC:ReviewLaneBypass 2026-09-03-10:07 (RUFU-179):
ONE ANSWER FOR "WHICH PRE-MERGE GATE MAY THIS OPERATOR BYPASS, AND WHY?".

Before this module the answer existed twice and they disagreed. `store.ts`'s
`bypassFailedPreMergeReviewStep` accepted a review-lane card whose only problem was an enabled
required pre-merge gate with NO result (FN-158's `absentStepId` branch), while the dashboard's
`TaskContextMenu` re-implemented a miniature predicate that asked only "is there a `failed`
result?". The narrower client question silently refused the operator the escape hatch the backend
already granted — reported downstream as SANE-387 on a card stranded by "task has enabled
pre-merge workflow steps that never ran", with `POST /tasks/:id/bypass-review` succeeding for that
exact card while no surface on screen offered it. The AI lanes are deliberately forbidden from
this tool, so the GUI was the only path and it was closed.

This is why the client must NOT own the predicate (the obvious fix, and the shape the duplicated
miniature invited): deciding the unrun case needs the task's RESOLVED workflow IR
(`resolveRequiredPreMergeStepIds`), which is server-side authority. Shipping the derived answer is
the only version that cannot be wrong on a custom board.

THE INVARIANT this module exists to hold: UI eligibility equals store acceptance. `store.ts` calls
`deriveReviewBypassTarget` for its own target selection, so "the menu offered it" and "the store
accepted it" are one fact computed by one function — a dead affordance (menu offers, API refuses)
and an unreachable escape (API accepts, menu silent) are both structurally impossible here rather
than merely tested against each other.

Deliberately pure, node-free, deterministic, and I/O-free so the SAME function runs in the store's
write path and in every read-path hydration, and is unit-testable without a store. Note this is a
CAPABILITY, not a diagnostic: unlike the sibling `inReviewStall` signal it must never be
activity-suppressed, because an operator's escape hatch cannot depend on whether a reviewer
session last wrote a log line.
*/

import type { Task, WorkflowStepResult } from "../types.js";
import type { WorkflowIr } from "../workflows/workflow-ir-types.js";
import { declaresAnyLifecycleTrait, resolveReviewColumns } from "../workflows/workflow-lifecycle-traits.js";
import { getLatestFailedPreMergeReviewStep } from "./task-merge.js";

/**
 * Which of the two bypassable states a card is in.
 *
 * - `"failed"` — a pre-merge review-lane result came back `failed` (FN-7720's original case,
 *   leading real-world cause: Runfusion/Fusion#1946's `(no feedback captured)` no-verdict dispatch).
 * - `"absent"` — an enabled required pre-merge gate has no result entry at all (FN-158's case, and
 *   the one the UI never covered). Skipping it records a deliberate operator decision, NOT a
 *   review approval, which is why the copy for this kind must not claim a failure or a pass.
 */
export type ReviewBypassTargetKind = "failed" | "absent";

/** The step a bypass would currently act on, plus the reason class the copy must branch on. */
export interface ReviewBypassTarget {
  kind: ReviewBypassTargetKind;
  workflowStepId: string;
  workflowStepName: string;
}

/**
 * Narrow row view the derivation needs, so it is callable from a full `Task` or a hydrated row.
 *
 * `userPaused` is part of the view because the pause gate is an OPERATOR-hold test, not a bare
 * `paused` test — see `isOperatorPausedForOperatorEscapeHatch`. It stays in the `Partial` half so an
 * existing narrow fixture or fake store that never carries the field keeps compiling and simply
 * reads as "not an operator hold".
 */
export type ReviewBypassTaskView = Pick<Task, "column" | "paused"> &
  Partial<Pick<Task, "workflowStepResults" | "userPaused">>;

/*
FNXC:ReviewLaneBypass 2026-09-10-23:19 (RUFU-218):
ONE PAUSE PREDICATE FOR THE ESCAPE HATCH, SHARED BY THE DERIVATION AND THE STORE'S OWN GUARD.

THE REQUIREMENT: an operator who deliberately held a card by hand is holding this escape hatch too,
so a hold refuses both the offer and the acceptance. An ENGINE-originated park is not a hold on the
hatch — it is the engine freezing AUTOMATION. Before this predicate, three gates (this derivation,
`task-store/reads.ts`'s hydration, and `store.ts`'s own refusal) each tested the bare `paused` flag,
so the card whose own stall diagnostic reads "re-run or bypass this gate to clear the merge door"
was the one card with no bypass action anywhere and an API answering `task is paused`. The operator
recovery sequence was unpause → bypass → re-park, i.e. the park had confiscated the human's only
lever while pointing at it (observed live on RUFU-204, 2026-09-10).

THE DISCRIMINANT is the one `AGENTS.md`'s Move-Task contract guarantees: "Engine rebounds must not
set `userPaused`", so `paused && !userPaused` is an engine park and `paused && userPaused` is an
operator hold. `manual-retry-reset.ts` (`task.userPaused !== true`), `provider-health-monitor.ts`,
and `branch-group-ops.ts` already read the pair this way, and `pauseTask`'s fence is the only writer
of `userPaused` — `updateTask` cannot write it (`tasks/task-column-restart.ts`), so a park written
outside that fence structurally cannot look like a hold.

`pausedReason` is DELIBERATELY NOT consulted. The engine parks bare in several sinks —
`engine/src/executor/handle-graph-failure.ts` and `engine/src/missions/mission-autopilot.ts` both
write `{ paused: true }` with no reason — so a reason-keyed test (the overseer-style
`paused && !pausedReason` heuristic) would hide the hatch again for exactly those parks, and would
keep refusing the park classes that DO name themselves (`in-review-stall-deadlock`,
`merge-deadlock-detected`, `branch-conflict-unrecoverable`, `provider-rate-limit:*`,
`duplicate-decision-required). The operator flag is the only field with a single disciplined writer.

THE SECOND NAMED PARK CLASS — AN OUTSIDE-WORKTREE FREEZE — IS ALSO NOT A HOLD, BY ITS OWN NOTE.
`buildTaskExternalBlockPatch` (`tasks/task-external-block.ts`) parks `paused: true` with
`pausedReason: "external-block"`, `status: "blocked"`, and deliberately no `userPaused`, because its
FNXC note rules an external block "operator-recoverable lifecycle state rather than an operator-authored
pause". A review-lane card frozen that way therefore gains the capability and the store's acceptance
under this predicate, which is that note's own answer rather than an accident of it: the operator is
exactly the person who must clear the wedged gate. Nothing unsafe is conceded — `status: "blocked"` is not
a `BLOCKING_TASK_STATUSES` member, so the freeze holds the merge door through the SAME `paused` condition
every other engine park holds it through (plus the `externalBlock` record the operator must clear), and a
bypass on such a card clears only the wedged gate row. It is asserted in the pause table, not defaulted.
*/
/*
FNXC:OperatorEscapeHatch 2026-09-11-13:27 (RUFU-219):
ONE PREDICATE, TWO ESCAPE HATCHES — the name dropped its bypass-specific prefix to match.
This predicate now gates BOTH operator recovery levers for a wedged pre-merge review gate:
(1) `bypassFailedPreMergeReviewStep` / `fn_task_bypass_review` rewrites a FAILED or UNRUN gate to a
skipped result (RUFU-218's consumer, FN-7720), and (2) `resumeWorkflowStep` / `fn_workflow_step_resume`
flips a gate stuck in `pending` (dispatched prompt node that never received its verdict callback,
Runfusion/Fusion#1946) to a terminal `failed` result so the bypass can then clear it. The levers are
a pipeline: resume makes the wedge bypassable, bypass clears the merge door — so a bare `paused`
refusal on EITHER hatch recreates the unpause → act → re-park dance this predicate exists to end.
RUFU-218 narrowed the bypass gate; the still-bare `paused` check on the resume gate refused the
operator one call earlier, and outright on a WIP-lane card where the pause check ran before the lane
check. THE RULE, stated once: an operator hold refuses BOTH hatches; an engine-originated park
refuses NEITHER — it freezes automation, and both hatches exist precisely for the card the engine
parked. A third pause-gated escape hatch must reuse this predicate rather than author a divergent
pause check; that is why the name is hatch-neutral.
*/
export function isOperatorPausedForOperatorEscapeHatch(task: Pick<Task, "paused" | "userPaused">): boolean {
  return task.paused === true && task.userPaused === true;
}

/**
 * The review lanes a bypass is admitted in — the STORE's rule, exported so both consumers resolve
 * the same set and cannot disagree about which columns are bypassable.
 *
 * A board with no resolvable IR or no lifecycle traits falls back to the legacy `in-review` id;
 * otherwise it is the workflow's own union of the three review roles.
 *
 * Do NOT "simplify" this by reusing `reads.ts`'s `resolveReviewColumnsForTask`: that one always
 * unions the legacy `"in-review"` id in so a board mid-rename is never skipped for the diagnostic
 * badges. Here a broader answer is a BUG, not a safety margin — it would offer the affordance on a
 * renamed lane the store then refuses, manufacturing exactly the dead-affordance class RUFU-179
 * deletes. The refusal guard admits and moves nothing, so the broad-but-exact store set is right.
 */
export function resolveReviewBypassLanes(ir: WorkflowIr | undefined): string[] {
  return ir === undefined || !declaresAnyLifecycleTrait(ir)
    ? ["in-review"]
    : resolveReviewColumns(ir);
}

/**
 * Derive the bypass target for a card, or `undefined` when a bypass would be refused.
 *
 * Order is the store's acceptance order and must stay that way (the operator-hold and lane gates are
 * checked even when a target exists, because the store refuses on them first):
 * 1. `isOperatorPausedForOperatorEscapeHatch(task)` → nothing. An OPERATOR hold is a hold on automation AND
 *    on this escape hatch; an engine-originated park (`paused` with no `userPaused`) is not — it
 *    freezes automation only, and the hatch exists precisely for the card the engine parked.
 * 2. `task.column` not in `reviewColumns` → nothing.
 * 3. `getLatestFailedPreMergeReviewStep()` when present → `kind: "failed"`. Failed WINS over an
 *    unrun gate: the store rewrites the failed result and one bypass must not silently also
 *    consume the unrun-gate decision the operator has not made yet.
 * 4. else the first `requiredStepIds` entry with no entry in `workflowStepResults` → `"absent"`.
 *    A `pending` result counts as PRESENT: a gate that is running is not a gate that never ran, and
 *    offering to skip it mid-flight would let an operator skip past a review in progress.
 * 5. else nothing (includes the fast lane and the no-gates case, whose resolved set is empty).
 *
 * `requiredStepIds` is resolved by the caller because it needs the workflow IR, which only the
 * server holds — see the module note for why that keeps this predicate server-side.
 */
export function deriveReviewBypassTarget(
  task: ReviewBypassTaskView,
  requiredStepIds: ReadonlySet<string>,
  reviewColumns: ReadonlySet<string>,
): ReviewBypassTarget | undefined {
  if (isOperatorPausedForOperatorEscapeHatch(task)) return undefined;
  if (!reviewColumns.has(task.column)) return undefined;

  const failedStep: WorkflowStepResult | undefined = getLatestFailedPreMergeReviewStep(task);
  if (failedStep) {
    return {
      kind: "failed",
      workflowStepId: failedStep.workflowStepId,
      workflowStepName: failedStep.workflowStepName,
    };
  }

  const results = task.workflowStepResults ?? [];
  for (const workflowStepId of requiredStepIds) {
    if (!results.some((result) => result.workflowStepId === workflowStepId)) {
      return { kind: "absent", workflowStepId, workflowStepName: workflowStepId };
    }
  }
  return undefined;
}
