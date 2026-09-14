/*
FNXC:PreMergeApproval 2026-09-02-10:36:
FN-9243 repairs resultless enabled pre-merge gates by seeding the earliest missing gate, never by
inventing a verdict or moving a review-lane card backward. The idle seed lets the real gate inspect
current content and produce its own genuine result.

FNXC:LifecycleContainment 2026-09-02-22:41:
RUFU-178: the seeded continuation's targetColumn must be a column the card will ACTUALLY stand in.
A plan-review gate authored in the planning lane would otherwise make a review-lane card's
continuation name `todo` — a position the boundary refuses to move it to (backward review-gate
entries enter in place). Clamping through the shared `clampReviewGateEntry` keeps the seed honest:
when the node-column entry would be backward, the continuation names the card's current column.

FNXC:VerdictlessFailedGate 2026-09-14-13:32 (RUFU-217, AC2):
The seedable set widens from `missing` to `missing ∪ verdict-less-failed`. A required gate whose
latest row failed with NO authored verdict is a plumbing death (crashed session, FN-8492 orphan
rewrite, FN-279 stripped approval), not a reviewer REVISE; the merge door still refuses it — this
lane only guarantees it gets a fresh real run instead of terminalizing as a deadlock park. The
earliest seedable gate in IR order wins, so a genuinely-missing gate keeps precedence over a later
verdict-less one. All existing guards stay: singular content only, workspace cards excluded,
operator-held cards excluded, idle-only seeding (an active continuation never gets doubled).
A verdict-less target consumes a persistent per-(task, gate) rerun budget counted from fixed-marker
task-log entries (see `MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS`); a missing target stays idle-only and
unbudgeted exactly as FN-9243 shipped it, so that lane's behavior is byte-stable.
*/
import {
  clampReviewGateEntry,
  computeWorkflowIrPin,
  evaluatePreMergeApprovals,
  IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
  resolveWorkflowIrForTask,
  type MergeContentDescriptor,
  type Task,
  type TaskLogEntry,
  type TaskStore,
} from "@fusion/core";

export type UnrunPreMergeGateRerouteReason =
  | "seeded"
  | "verdictless-seeded"
  | "rerun-budget-exhausted"
  | "active-continuation"
  | "no-unrun-gate"
  | "no-review-route"
  | "not-singular"
  | "operator-held";

/*
FNXC:VerdictlessFailedGate 2026-09-14-13:32 (RUFU-217, AC3):
Persistent cap on verdict-less gate re-runs per (task, gate). Three strikes mirrors the stall
park's three-strike threshold and every strike is a real gated AI run, so a gate that crashes the
same way four times stops reseeding and reaches the operator instead of burning model budget in a
loop. The counter is durable-by-log (not an in-memory map): a daemon restart must not hand a
looping gate a fresh budget, and no schema change is allowed. Entries are appended by this module
immediately after a successful verdict-less seed and counted by the fixed marker prefix below.
*/
export const MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS = 3;

/** Fixed per-gate marker prefix; the quoted gate id carries no apostrophes (gate ids cannot). */
export function verdictlessGateRerunLogMarker(gateId: string): string {
  return `[verdictless-gate-rerun] gate '${gateId}'`;
}

/** Counts persisted verdict-less rerun markers for one gate, hydrating the log when slimmed away. */
async function countVerdictlessGateRerunAttempts(
  store: TaskStore,
  task: Task,
  gateId: string,
): Promise<number> {
  const marker = verdictlessGateRerunLogMarker(gateId);
  const log: TaskLogEntry[] = Array.isArray(task.log)
    ? task.log
    : ((await store.getTask(task.id))?.log ?? []);
  return log.filter((entry) => typeof entry.action === "string" && entry.action.startsWith(marker)).length;
}

/*
FNXC:VerdictlessFailedGate 2026-09-14-14:47 (RUFU-217, Step 5 / AC1):
The stall-deadlock park is the ONLY pause this lane may seed under, and only when the caller
explicitly passes `allowDeadlockPark` (the parked-card recovery route). Step 5 recovery seeds FIRST
and clears the park only after the seed lands, so the seed must run while the card is still
`paused:true, pausedReason:"in-review-stall-deadlock"` — a pause this lane itself is undoing, not
an operator hold. The pause REASON must name the deadlock park: any other automation pause, and
all operator holds (`userPaused`, `deletedAt`, `autoMerge:false`), remain hard `operator-held`
refusals, so every existing caller's behavior is byte-identical.
*/
export async function rerouteUnrunPreMergeGateToReview(
  store: TaskStore,
  task: Task,
  options: { requiredPreMergeStepIds: ReadonlySet<string>; mergeContent: MergeContentDescriptor; allowDeadlockPark?: boolean },
): Promise<{ rerouted: boolean; reason: UnrunPreMergeGateRerouteReason; nodeId?: string; workflowStepId?: string }> {
  const { mergeContent, requiredPreMergeStepIds } = options;
  if (mergeContent.kind !== "singular" || task.workspaceWorktrees !== undefined) return { rerouted: false, reason: "not-singular" };
  const deadlockParkAdmissible =
    options.allowDeadlockPark === true
    && task.paused === true
    && task.pausedReason === IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON;
  if (task.userPaused || task.deletedAt || task.autoMerge === false || (task.paused && !deadlockParkAdmissible)) {
    return { rerouted: false, reason: "operator-held" };
  }
  if (requiredPreMergeStepIds.size === 0) return { rerouted: false, reason: "no-unrun-gate" };

  /*
  FNXC:VerdictlessFailedGate 2026-09-14-13:32 (RUFU-217, AC2):
  Seedable = `missing` (FN-9243) ∪ `verdictLessFailed` (RUFU-217). The class of the EARLIEST
  seedable gate in IR order decides whether the persistent rerun budget applies: missing targets
  keep the unbudgeted idle-only semantics, verdict-less targets must leave room for the operator
  when a gate crashes identically forever.
  */
  const seedable = new Map<string, "missing" | "verdictless">();
  for (const approval of evaluatePreMergeApprovals(task, { requiredPreMergeStepIds, mergeContent })) {
    if (approval.state === "missing") seedable.set(approval.workflowStepId, "missing");
    else if (approval.verdictLessFailed === true) seedable.set(approval.workflowStepId, "verdictless");
  }
  if (seedable.size === 0) return { rerouted: false, reason: "no-unrun-gate" };

  const ir = await resolveWorkflowIrForTask(store, task.id);
  const node = ir.nodes.find((candidate) => requiredPreMergeStepIds.has(candidate.id) && seedable.has(candidate.id));
  if (!node) return { rerouted: false, reason: "no-review-route" };

  const targetClass = seedable.get(node.id)!;
  const rerunAttempts = targetClass === "verdictless"
    ? await countVerdictlessGateRerunAttempts(store, task, node.id)
    : 0;
  if (targetClass === "verdictless" && rerunAttempts >= MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS) {
    return { rerouted: false, reason: "rerun-budget-exhausted", nodeId: node.id, workflowStepId: node.id };
  }

  const items = await store.listWorkflowWorkItemsForTask(task.id);
  const result = await store.seedWorkspaceCodeReviewContinuationIfIdle({
    taskId: task.id,
    nodeId: node.id,
    kind: "task",
    state: "runnable",
    runId: `${task.id}:unrun-pre-merge-gate-reseed:${node.id}:${items.length}`,
    stableWorkflowRunId: `${task.id}:${ir.name}`,
    continuationSequence: items.length,
    sourceColumn: task.column,
    targetColumn: clampReviewGateEntry(ir, node, task.column).toColumn ?? task.column,
    irHash: computeWorkflowIrPin(ir, node.id).irHash,
  });
  if (!result.seeded) return { rerouted: false, reason: "active-continuation", nodeId: node.id, workflowStepId: node.id };
  if (targetClass === "verdictless") {
    // The marker is the durable budget counter; write it only AFTER the seed actually landed.
    await store.logEntry(
      task.id,
      `${verdictlessGateRerunLogMarker(node.id)} verdict-less failure, re-seeded in place for a fresh run`
        + ` (rerun ${rerunAttempts + 1} of ${MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS})`,
    );
    return { rerouted: true, reason: "verdictless-seeded", nodeId: node.id, workflowStepId: node.id };
  }
  return { rerouted: true, reason: "seeded", nodeId: node.id, workflowStepId: node.id };
}
