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
/*
FNXC:VerdictlessSkippedGate 2026-11-12-20:25 (RUFU-657):
ONE row-shape predicate shared by the merge door, the stall classifier and this capability. The
invariant of this module is that UI eligibility equals store acceptance, and a second local copy of
"which `skipped` row owes a verdict" is exactly how the two sides drift apart again.
*/
import { isVerdictLessSkippedOwedVerdictRow } from "./pre-merge-approval.js";
import { postMergeGateWaiverReason } from "./confirmed-merge-reconciliation.js";

/**
 * Which of the bypassable states a card is in.
 *
 * - `"failed"` — a pre-merge review-lane result came back `failed` (FN-7720's original case,
 *   leading real-world cause: Runfusion/Fusion#1946's `(no feedback captured)` no-verdict dispatch).
 * - `"absent"` — an enabled required pre-merge gate has no result entry at all (FN-158's case, and
 *   the one the UI never covered). Skipping it records a deliberate operator decision, NOT a
 *   review approval, which is why the copy for this kind must not claim a failure or a pass.
 * - `"verdictless-skipped"` — a required gate's latest row is `skipped` with no verdict, no honest
 *   not-run reason and no recorded waiver: it refused to report while owing an authored verdict
 *   (RUFU-657). Measured on RUFU-343 and RUFU-366: this was the ONLY exit and no surface offered it —
 *   `store.bypassFailedPreMergeReviewStep` already accepted the row through its residual unapproved
 *   class, so the store could act while the menu stayed dark (RUFU-179's unreachable-escape bug, from
 *   the other side). Like `absent`, the copy for this kind must claim neither a failure nor a pass:
 *   the bypass records the operator's decision and never writes a `verdict`.
 */
export type ReviewBypassTargetKind = "failed" | "absent" | "verdictless-skipped";

/** The step a bypass would currently act on, plus the reason class the copy must branch on. */
export interface ReviewBypassTarget {
  kind: ReviewBypassTargetKind;
  workflowStepId: string;
  workflowStepName: string;
  /*
  FNXC:PostMergeGateOperatorWaiver 2026-09-29-15:49 (RUFU-408):
  Only a POST-merge target carries this field. It stays optional (pre-merge targets keep returning the
  exact object shape they always returned) so the two existing UI branches on `kind` need no change and
  the store stamps the materialised `skipped` row with the phase the gate actually belongs to — a
  post-merge waiver written as a `pre-merge` row would be read by `evaluatePreMergeApprovals` as a
  pre-merge gate result, which is a different door.
  */
  phase?: "post-merge";
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
  Partial<Pick<Task, "workflowStepResults" | "userPaused" | "mergeDetails" | "workspaceWorktrees">>;

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
 * The bypass decision tree: which gate a bypass would act on, or which class refuses it.
 *
 * FNXC:ReviewBypassDecline 2026-11-17-17:40 (RUFU-583, folded from RUFU-243):
 * Every "nothing" below is now a NAMED refusal class (`ReviewBypassDeclineReason`). The tree itself is
 * unchanged — same gates, same order, same precedence — only the refusals stopped being anonymous, so
 * a card that cannot be bypassed can say why on the surface the operator is looking at.
 *
 * Order is the store's acceptance order and must stay that way (the operator-hold and lane gates are
 * checked even when a target exists, because the store refuses on them first):
 * 1. `isOperatorPausedForOperatorEscapeHatch(task)` → `operator-task-hold`. An OPERATOR hold is a hold on automation AND
 *    on this escape hatch; an engine-originated park (`paused` with no `userPaused`) is not — it
 *    freezes automation only, and the hatch exists precisely for the card the engine parked.
 * 2. `task.column` not in `reviewColumns` → `not-in-review-lane`.
 * 3. `getLatestFailedPreMergeReviewStep()` when present → `kind: "failed"`. Failed WINS over an
 *    unrun gate: the store rewrites the failed result and one bypass must not silently also
 *    consume the unrun-gate decision the operator has not made yet.
 * 4. else the first `requiredStepIds` entry with no entry in `workflowStepResults` → `"absent"`.
 *    A `pending` result counts as PRESENT: a gate that is running is not a gate that never ran, and
 *    offering to skip it mid-flight would let an operator skip past a review in progress.
 * 5. else a required POST-merge gate with NO result row → `kind: "absent"` + `phase: "post-merge"`.
 * 6. else `no-refusing-gate` (includes the fast lane and the no-gates case, whose resolved set is empty,
 *    and is deliberately not split further — see the reason list for why those three are one class).
 *
 * `requiredStepIds` is resolved by the caller because it needs the workflow IR, which only the
 * server holds — see the module note for why that keeps this predicate server-side.
 *
 * FNXC:PostMergeGateOperatorWaiver 2026-09-29-15:49 (RUFU-408):
 * STEP 5 EXISTS BECAUSE THE NOTICE PROMISED A LEVER THAT DID NOT EXIST. A merge-CONFIRMED card whose
 * enabled gate-mode post-merge group never reported is held out of `done` by
 * `getRequiredPostMergeEvidenceBlocker`, and RUFU-370 hands it to the operator in a mailbox message
 * that reads "either an operator bypass of the gate or a workflow whose post-merge node can run".
 * Measured on the saneca board 2026-09-29: seven landed cards sat in `in-review` on exactly that
 * message while `POST /tasks/:id/bypass-review` answered `no failed pre-merge review step found` — the
 * derivation asked only about PRE-merge gates, so the promised human decision had no surface and the
 * cards spun 5,319 `task:auto-merge-finalize-post-merge-gate-unreachable` rows in one day. Only the
 * `absent` class is admitted here: a post-merge row that EXISTS and was not approved carries a real
 * reviewer verdict, and FN-7720's hatch exists for gates that never ran, not to overrule a reviewer.
 * A `pending` post-merge row is a review in flight and stays unselectable, as in step 4.
 *
 * THE POST-MERGE BRANCH ALSO REQUIRES DURABLE MERGE PROOF. The post-merge gate is not a door until the
 * work has landed — `getTaskMergeBlocker` never consults it — so offering the waiver on an unlanded
 * card would hand the operator a way to pre-emptively waive evidence the card has not yet earned, and
 * would light the menu item beside a perfectly healthy Merge button. `mergeDetails.mergeConfirmed` is
 * the same proof the finalizer and every recovery lane keys on.
 */
/**
 * Every way this module can answer "no". A REFUSAL-CLASS LIST, not a copy list: the operator-facing
 * sentence lives in the hydration consumer and in `app/utils/taskRetryCopy.ts`, never here, because the
 * module note rules this derivation pure, I/O-free and string-free so the SAME function runs in the
 * store's write path and in every read-path hydration.
 *
 * FNXC:ReviewBypassDecline 2026-11-17-17:40 (RUFU-583, folded from RUFU-243):
 * ONE NAME PER REFUSAL, because a refusal with no name is invisible in exactly the two places an
 * operator can look. Measured on RUFU-583: a held card in the review lane rendered NO bypass row at
 * all, and the detail modal said nothing, while the API answered `task is paused` — the operator had
 * three surfaces and not one of them said which condition held. Six classes, and no sixth invented:
 *
 * - `"operator-task-hold"` — an operator-authored hold (`paused` AND `userPaused`). The hold holds this
 *   escape hatch too (RUFU-218/RUFU-219); an engine-originated park is NOT this class and stays offered.
 * - `"not-in-review-lane"` — the card rests outside every lane the bypass admits. Two different operator
 *   situations reach this exit (a lane a human decides in, and a lane held for a human merge) and the
 *   pure derivation cannot tell them apart without a lane vocabulary no caller passes it, so it names
 *   the ONE class it can defend and does not invent the distinction.
 * - `"no-refusing-gate"` — the lane admits the bypass and no gate is refusing. This single name covers
 *   the fast lane and the no-gates board as well, and the derivation deliberately does NOT distinguish
 *   those: a board whose resolved required-gate set is empty is indistinguishable from a card whose
 *   gates all passed, and guessing would be a fabricated diagnosis.
 * - `"post-merge-review-not-owed"` — a required post-merge gate exists but the work has not landed, so
 *   there is no evidence to waive yet (RUFU-408's durable-proof requirement).
 * - `"workspace-scope-withheld"` — the only refusing gate is a `verdictless-skipped` carrier on a
 *   multi-repo card, where an audited waiver cannot clear the door (`evaluatePreMergeApprovals` refuses
 *   a workspace descriptor). RUFU-179's dead-affordance rule withholds the offer; RUFU-583 makes the
 *   withholding say so.
 * - `"workflow-ir-unreadable"` — the workflow IR could not be resolved, so the required-gate set is
 *   unknown. This class is authored by the HYDRATION seam (`task-store/reads.ts`), not by the pure
 *   derivation, which has no IR to fail on; it exists because that arm's `catch { return undefined }`
 *   laundered a broken workflow read into "no gate is refusing", the one cause an operator could not
 *   tell a refusal from.
 */
export type ReviewBypassDeclineReason =
  | "operator-task-hold"
  | "not-in-review-lane"
  | "no-refusing-gate"
  | "post-merge-review-not-owed"
  | "workspace-scope-withheld"
  | "workflow-ir-unreadable";

/** The decline, named, plus the gate it concerns where the refusal can point at one. */
export interface ReviewBypassDecline {
  reason: ReviewBypassDeclineReason;
  workflowStepId?: string;
}

/**
 * The whole answer: the gate a bypass would act on, or the class that refuses it. Consumers project
 * the half they need — `deriveReviewBypassTarget` and the shipped `task.reviewBypass` field read the
 * `"offered"` arm exactly as they always did, and `task.reviewBypassDecline` carries the other.
 */
export type ReviewBypassDecision =
  | { kind: "offered"; target: ReviewBypassTarget }
  | { kind: "declined"; decline: ReviewBypassDecline };

/**
 * The decision tree, total. Order is the store's acceptance order and is the order the reasons were
 * already refused in — no gate moved, no precedence changed.
 *
 * FNXC:ReviewBypassDecline 2026-11-17-17:40 (RUFU-583):
 * This is the function `deriveReviewBypassTarget` used to be, with the four `return undefined` exits
 * given a name. The refusal classes are enumerated at `ReviewBypassDeclineReason`, including the two
 * the derivation deliberately cannot tell apart (see the reason list: a declined arm must name a class
 * it can prove from its inputs, never one it infers from what the operator probably meant).
 */
export function deriveReviewBypassDecision(
  task: ReviewBypassTaskView,
  requiredStepIds: ReadonlySet<string>,
  reviewColumns: ReadonlySet<string>,
  requiredPostMergeStepIds: ReadonlySet<string> = new Set(),
): ReviewBypassDecision {
  if (isOperatorPausedForOperatorEscapeHatch(task)) {
    return { kind: "declined", decline: { reason: "operator-task-hold" } };
  }
  if (!reviewColumns.has(task.column)) {
    return { kind: "declined", decline: { reason: "not-in-review-lane" } };
  }

  const failedStep: WorkflowStepResult | undefined = getLatestFailedPreMergeReviewStep(task);
  if (failedStep) {
    return {
      kind: "offered",
      target: {
        kind: "failed",
        workflowStepId: failedStep.workflowStepId,
        workflowStepName: failedStep.workflowStepName,
      },
    };
  }

  const results = task.workflowStepResults ?? [];
  /*
  FNXC:VerdictlessSkippedGate 2026-11-12-20:25 (RUFU-657):
  Step 3b — a required gate that refused to report is bypassable, and is offered BEFORE the
  never-ran class: the operator must decide about the specific gate that refused, and a card can hold
  both shapes at once (one gate owed a verdict, another never dispatched).

  SINGULAR SCOPE ONLY, and that is a refusal rather than an omission. `evaluatePreMergeApprovals`
  resolves an audited waiver into approval only when the merge-content descriptor is not a workspace
  (`auditedOperatorWaiver = isAuditedOperatorBypass(result) && descriptor?.kind !== "workspace"`), so on
  a multi-repo card the bypass this branch would advertise cannot clear the door it advertises against.
  Offering it there would be the dead affordance RUFU-179 was written to delete, in the direction the
  operator pays for.
  */
  let withheldWorkspaceGate: string | undefined;
  if (task.workspaceWorktrees === undefined) {
    for (const workflowStepId of requiredStepIds) {
      const latest = results.filter((result) => result.workflowStepId === workflowStepId).at(-1);
      if (latest && isVerdictLessSkippedOwedVerdictRow(latest)) {
        return {
          kind: "offered",
          target: {
            kind: "verdictless-skipped",
            workflowStepId,
            workflowStepName: latest.workflowStepName || workflowStepId,
          },
        };
      }
    }
  } else {
    /*
    FNXC:ReviewBypassDecline 2026-11-17-17:40 (RUFU-583):
    The singular-scope rule above SKIPS the verdictless class on a multi-repo card, and that withholding
    used to reach the caller as a bare `undefined` — indistinguishable from "nothing is refusing". It is
    now NAMED, but remembered rather than returned on the spot: a workspace card can hold a withheld
    carrier AND an unrun gate at once, and the unrun gate is offered today. Returning here would have
    taken that offer away, which is the dead-refusal direction of the RUFU-179 invariant this module
    exists to keep — the store would still accept the unrun gate while the surface said declined.
    */
    for (const workflowStepId of requiredStepIds) {
      const latest = results.filter((result) => result.workflowStepId === workflowStepId).at(-1);
      if (latest && isVerdictLessSkippedOwedVerdictRow(latest)) {
        withheldWorkspaceGate = workflowStepId;
        break;
      }
    }
  }
  for (const workflowStepId of requiredStepIds) {
    if (!results.some((result) => result.workflowStepId === workflowStepId)) {
      return {
        kind: "offered",
        target: { kind: "absent", workflowStepId, workflowStepName: workflowStepId },
      };
    }
  }
  for (const workflowStepId of requiredPostMergeStepIds) {
    if (task.mergeDetails?.mergeConfirmed !== true) {
      return { kind: "declined", decline: { reason: "post-merge-review-not-owed", workflowStepId } };
    }
    const latestPostMerge = results.filter((result) => result.workflowStepId === workflowStepId);
    if (latestPostMerge.length === 0) {
      return {
        kind: "offered",
        target: { kind: "absent", workflowStepId, workflowStepName: workflowStepId, phase: "post-merge" },
      };
    }
    /*
    FNXC:PostMergeGateWaiver 2026-11-14-01:35 (RUFU-599 reproduction 1, RUFU-474):
    Step 5 widened from "no row at all" to "the row the door's own remedy sentence names a waiver for".
    RUFU-408 admitted only the `absent` class, on the reasoning that "a post-merge row that EXISTS and was
    not approved carries a real reviewer verdict". That premise fails on the shape RUFU-474 measured: the
    row existed, carried NO verdict (an honest `ci-repository-unresolved` not-run carrier, or any plain
    `skipped`), and `getRequiredPostMergeEvidenceBlocker` still refused the door on it while its remedy text
    told the operator to "bypass with an audited reason from the dashboard". The affordance derivation never
    offered it, `bypassFailedPreMergeReviewStep` accepted writes for that gate anyway, and the card had no
    surface to make the decision the sentence asked for — 2 days 18 h in `in-review`.

    Exactly one row is required, and that is `getRequiredPostMergeEvidenceDecision`'s own rule: two rows for
    one gate refuses `duplicate` BEFORE the requirement is consulted, and the store's rewrite targets the
    first matching row, so waiving a duplicate keeps the duplicate. Offering the waiver there would be the
    dead affordance RUFU-179 deletes; a duplicated post-merge report is a broken workflow definition, not a
    human decision. Only a `skipped` carrier is offered: a `failed` or `pending` post-merge row belongs to
    the engine's bounded re-seed (RUFU-375) and to the reviewer in flight, not to an operator overwrite.
    */
    if (latestPostMerge.length === 1 && postMergeGateWaiverReason(latestPostMerge[0]) !== undefined) {
      const [row] = latestPostMerge;
      return {
        kind: "offered",
        target: {
          kind: "verdictless-skipped",
          workflowStepId,
          workflowStepName: row.workflowStepName || workflowStepId,
          phase: "post-merge",
        },
      };
    }
  }
  if (withheldWorkspaceGate !== undefined) {
    return { kind: "declined", decline: { reason: "workspace-scope-withheld", workflowStepId: withheldWorkspaceGate } };
  }
  return { kind: "declined", decline: { reason: "no-refusing-gate" } };
}

/**
 * Derive the bypass target for a card, or `undefined` when a bypass would be refused.
 *
 * A one-line projection over `deriveReviewBypassDecision`, and it must stay exactly that: this is the
 * shape `store.ts`, `reads.ts` and every existing assertion contract on (~40 assertions in
 * `review-bypass-target.test.ts` are this signature's contract, not a suggestion). The refusal it
 * returns as `undefined` is not lost — the decision underneath names it, which is what
 * `task.reviewBypassDecline` ships.
 */
export function deriveReviewBypassTarget(
  task: ReviewBypassTaskView,
  requiredStepIds: ReadonlySet<string>,
  reviewColumns: ReadonlySet<string>,
  requiredPostMergeStepIds: ReadonlySet<string> = new Set(),
): ReviewBypassTarget | undefined {
  const decision = deriveReviewBypassDecision(task, requiredStepIds, reviewColumns, requiredPostMergeStepIds);
  return decision.kind === "offered" ? decision.target : undefined;
}
