/*
FNXC:ApprovalDestroyingRetry 2026-11-14-01:35 (RUFU-599 reproductions 4 and 6, RUFU-472 / RUFU-474 / SANE-482):
RETRY IS REFUSED WHERE IT CAN ONLY DESTROY THE CARD'S LAST REMEDY.

Each reported card had a required pre-merge gate whose approval still stood, plus a blocker no Retry can
touch — a required POST-merge gate holding a never-ran or verdict-less carrier on an already-landed delivery
(RUFU-474), or a workspace delivery whose post-merge report can no longer be produced (SANE-482). Pressing
Retry on those cards did real damage: the review-scope stage restart discards this column's gate rows, so one
click erased the `APPROVE` evidence, and the reopen path (`fn task retry` → move back to the hold lane) wipes
`workflowStepResults` wholesale. RUFU-284 and RUFU-304 measured the result in hours — a re-burned review
cycle per attempt, ending at the same blocker.

The refusal asks THREE questions and all three must hold, so it cannot swallow a legitimate Retry:

1. **Is the card in a review lane?** (resolved from the IR's traits, not a column-id literal — a renamed
   board is the same lifecycle role). Outside a review lane Retry is untouched.
2. **Is the card's remaining remedy an operator waiver?** Answered by `deriveReviewBypassTarget`, the ONE
   waiver fact Steps 2–3 made the menu, the store write and the merge door share. "Retry is worse than
   useless here" is exactly "a waiver is offered", so re-deriving a blocker list locally would be the second
   copy RUFU-432 had to delete. The target must also be one this Retry cannot re-run: a post-merge gate, or
   a pre-merge gate whose node is not in the card's column. A gate that the restart replays is a legitimate
   Retry target, which is what keeps the `failed`-verdict and verdict-less-gate classes retryable.
3. **Would this Retry actually destroy an approval?** Only a required pre-merge gate whose node lives in the
   card's OWN column is counted, because that is the row set the in-place restart discards. An approving row
   for a gate in an earlier column survives a review restart, so counting it would refuse a Retry that
   destroys nothing.

The predicate is pure, node-free and I/O-free — the same shape as `classifyStrandedGateRetry` — so all FOUR
Retry surfaces (the dashboard stage-restart planner, `fn task retry`, the `fn_task_retry` extension tool and
the chat Retry) answer one card identically. Three of those surfaces predate this module and had already
drifted once (see the `FNXC:WorkflowLifecycleColumns` census in `cli/src/commands/task.ts`), which is why the
answer is exported rather than inlined into one branch. It can only ever REFUSE a write; it performs none.
*/

import type { Task, WorkflowStepResult } from "../types.js";
import type { WorkflowIr } from "../workflows/workflow-ir-types.js";
import {
  deriveReviewBypassTarget,
  resolveReviewBypassLanes,
  type ReviewBypassTarget,
} from "../merge/review-bypass-target.js";
import { isAuditedOperatorBypass } from "../merge/pre-merge-approval.js";
import { isGateApprovalVerdict, resolveRequiredPostMergeGateIds } from "../merge/confirmed-merge-reconciliation.js";
import { resolveRequiredPreMergeStepIds } from "../merge/required-pre-merge-steps.js";

/** What a refused Retry would have destroyed, and the decision the operator must make instead. */
export interface ApprovalDestroyingRetry {
  /** The gate whose approving evidence this Retry discards. */
  destroyedApproval: { workflowStepId: string; workflowStepName: string };
  /** The gate the operator waiver already offers — the remedy the refusal names. */
  waiver: ReviewBypassTarget;
  /** Operator-facing sentence: names the waiver, never offers Retry as the fix. */
  sentence: string;
}

/** Approval evidence for a content gate: an audited operator waiver, or a pass carrying an approving verdict. */
function isApprovingEvidence(row: WorkflowStepResult): boolean {
  return isAuditedOperatorBypass(row)
    || (row.status === "passed" && isGateApprovalVerdict(row.verdict));
}

/** The latest non-superseded row a gate holds, in append order. */
function latestRowFor(rows: readonly WorkflowStepResult[], workflowStepId: string): WorkflowStepResult | undefined {
  return rows.filter((row) => row.workflowStepId === workflowStepId && row.supersededAt == null).at(-1);
}

export type ApprovalDestroyingRetryClassification =
  | { kind: "approval-destroying"; refusal: ApprovalDestroyingRetry }
  | { kind: "not-approval-destroying" };

/*
The waiver half of the answer, shared by the classifier and its tests: the waiver the door already
offers, but only when this card's Retry cannot re-run the gate it names. `phase: "post-merge"` is
never re-runnable from a review lane — a post-merge report is produced at the merge, and the merge is
the step that gate is refusing. A pre-merge target is re-runnable exactly when its node sits in the
column the restart replays.
*/
function waiverBeyondThisRetry(
  task: Task,
  ir: WorkflowIr,
  requiredPreMergeStepIds: ReadonlySet<string>,
): ReviewBypassTarget | undefined {
  const lanes = resolveReviewBypassLanes(ir);
  if (!lanes.includes(task.column)) return undefined;
  const waiver = deriveReviewBypassTarget(
    task,
    requiredPreMergeStepIds,
    new Set(lanes),
    new Set(resolveRequiredPostMergeGateIds(task, ir)),
  );
  if (!waiver) return undefined;
  if (waiver.phase === "post-merge") {
    /*
    An ABSENT post-merge gate is still dispatchable: the graph reaches it on the next pass and the FN-9243 /
    RUFU-276 re-seed lane re-seeds it in place, so Retry can genuinely fix that card and the waiver offer is
    only the fallback RUFU-408 added. A gate that already reported a `skipped` carrier refusing the door is
    the one that tried and refused: re-running the review around it cannot produce the report, it can only
    delete the approval. That is the RUFU-474 and SANE-482 shape, so only that half refuses.
    */
    return waiver.kind === "verdictless-skipped" ? waiver : undefined;
  }
  const waiverNode = ir.nodes.find((node) => node.id === waiver.workflowStepId);
  // An undeclared gate has no node for the restarted column to replay, so the restart leaves it standing.
  if (!waiverNode) return waiver;
  return waiverNode.column === task.column ? undefined : waiver;
}

/**
 * The single classifier every Retry surface asks. Returns the refusal only when the card sits in a
 * review lane, its remaining remedy is an operator waiver this Retry cannot re-run, AND the Retry's
 * own write would discard a required pre-merge approval belonging to this column.
 */
export function classifyApprovalDestroyingRetry(input: {
  task: Task;
  ir: WorkflowIr | undefined;
}): ApprovalDestroyingRetryClassification {
  const { task, ir } = input;
  if (!ir) return { kind: "not-approval-destroying" };

  const requiredPreMergeStepIds = resolveRequiredPreMergeStepIds(ir, task.enabledWorkflowSteps, task);
  if (requiredPreMergeStepIds.size === 0) return { kind: "not-approval-destroying" };

  const waiver = waiverBeyondThisRetry(task, ir, requiredPreMergeStepIds);
  if (!waiver) return { kind: "not-approval-destroying" };

  const rows = task.workflowStepResults ?? [];
  const columnNodeIds = new Set(ir.nodes.filter((node) => node.column === task.column).map((node) => node.id));
  for (const workflowStepId of requiredPreMergeStepIds) {
    if (!columnNodeIds.has(workflowStepId)) continue;
    const latest = latestRowFor(rows, workflowStepId);
    if (!latest || !isApprovingEvidence(latest)) continue;
    const workflowStepName = latest.workflowStepName || workflowStepId;
    const waiverLabel = waiver.phase === "post-merge"
      ? `the post-merge gate \`${waiver.workflowStepId}\``
      : `the gate \`${waiver.workflowStepId}\``;
    return {
      kind: "approval-destroying",
      refusal: {
        destroyedApproval: { workflowStepId, workflowStepName },
        waiver,
        sentence:
          `Retry is refused here: \`${workflowStepName}\` already approved this work, and Retry cannot re-run ` +
          `${waiverLabel} — which is what the merge door is still waiting on. Retrying would delete that approval ` +
          `and leave the blocker standing. The decision that clears this card is an operator waiver on ` +
          `${waiverLabel} (bypass with an audited reason), which keeps the approval.`,
      },
    };
  }
  return { kind: "not-approval-destroying" };
}

/** Convenience for surfaces that only need the refusal. */
export function findApprovalDestroyingRetry(input: {
  task: Task;
  ir: WorkflowIr | undefined;
}): ApprovalDestroyingRetry | undefined {
  const classification = classifyApprovalDestroyingRetry(input);
  return classification.kind === "approval-destroying" ? classification.refusal : undefined;
}
