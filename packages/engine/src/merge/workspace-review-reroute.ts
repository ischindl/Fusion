import {
  computeWorkflowIrPin,
  resolveWorkflowIrForTask,
  type Task,
  type TaskStore,
  type WorkflowIrNode,
} from "@fusion/core";
import {
  classifyContinuationHolderOwnership,
  MAX_CONTINUATION_HOLD_GATE_RERUN_ATTEMPTS,
  readContinuationHoldLedger,
  continuationHoldHolderAlreadyStruck,
  recordContinuationHoldRefusal,
  resolveContinuationHoldHolder,
} from "./pre-merge-gate-reseed.js";

function isCodeReviewNode(node: WorkflowIrNode): boolean {
  if (node.kind !== "optional-group" && node.kind !== "step-review") return false;
  const name = typeof node.config?.name === "string" ? node.config.name : "";
  return node.id === "code-review"
    || node.config?.reviewKind === "code"
    || /code review/i.test(name);
}

/**
 * Seed exactly one durable Code Review owner after workspace landing rejects stale evidence.
 * A live continuation wins the race; it will consume the graph's own rework path instead.
 */
export async function rerouteWorkspaceReviewToCodeReview(
  store: TaskStore,
  task: Task,
): Promise<{
  rerouted: boolean;
  reason: "seeded" | "active-continuation" | "continuation-hold-budget-exhausted" | "no-code-review-route";
}> {
  const ir = await resolveWorkflowIrForTask(store, task.id);
  const node = ir.nodes.find(isCodeReviewNode);
  if (!node) return { rerouted: false, reason: "no-code-review-route" };

  const selection = store.getTaskWorkflowSelectionAsync
    ? await store.getTaskWorkflowSelectionAsync(task.id)
    : store.getTaskWorkflowSelection(task.id);
  const selected = selection?.stepIds ?? [];
  const defaultOn = node.config?.defaultOn === true;
  if (!defaultOn && !selected.includes(node.id)) return { rerouted: false, reason: "no-code-review-route" };

  /*
  FNXC:ContinuationHoldBudget 2026-11-11-09:52 (RUFU-490):
  The workspace arm of the same refusal, bounded the same way. A workspace card whose landing rejects
  stale evidence re-enters review by seeding this node, and the seed is task-wide-idle — so an
  abandoned continuation on ANY node of the card stops every later re-entry, which is the shape that
  let one refusal type reach 99.6% of the audit rows on a live board. An owned holder returns
  `active-continuation` writing nothing at all; only a provably unserved holder is charged, and only
  once per distinct holder.
  */
  const now = Date.now();
  const items = await store.listWorkflowWorkItemsForTask(task.id);
  const holder = resolveContinuationHoldHolder(items, node.id);
  const holdLedger = holder && classifyContinuationHolderOwnership(holder, now) === "unowned"
    ? await readContinuationHoldLedger(store, task.id, node.id)
    : null;
  if (holder && holdLedger && holdLedger.struckHolderKeys.length >= MAX_CONTINUATION_HOLD_GATE_RERUN_ATTEMPTS) {
    await recordContinuationHoldRefusal(store, task, node.id, holder, holdLedger, now);
    return { rerouted: false, reason: "continuation-hold-budget-exhausted" };
  }
  /*
  FNXC:ContinuationHoldBudget 2026-11-11-10:36 (RUFU-490):
  An abandoned holder that already carries its strike gets the same `active-continuation` refusal with
  no second doomed seed write, exactly as the two singular-card lanes do — the workspace lane is the
  third arm the Surface Enumeration names, and it refuses task-wide on the same fence.
  */
  if (holder && holdLedger && continuationHoldHolderAlreadyStruck(holder, holdLedger)) {
    return { rerouted: false, reason: "active-continuation" };
  }

  const result = await store.seedWorkspaceCodeReviewContinuationIfIdle({
    taskId: task.id,
    nodeId: node.id,
    kind: "task",
    state: "runnable",
    runId: `${task.id}:workspace-review-reroute:${node.id}:${items.length}`,
    stableWorkflowRunId: `${task.id}:${ir.name}`,
    continuationSequence: items.length,
    sourceColumn: task.column,
    targetColumn: node.column ?? task.column,
    irHash: computeWorkflowIrPin(ir, node.id).irHash,
  });
  if (result.seeded) return { rerouted: true, reason: "seeded" };
  if (holder && holdLedger) {
    await recordContinuationHoldRefusal(store, task, node.id, holder, holdLedger, now);
  }
  return { rerouted: false, reason: "active-continuation" };
}
