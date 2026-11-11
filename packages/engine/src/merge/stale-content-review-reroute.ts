/*
FNXC:PreMergeApproval 2026-09-01-06:53:
FN-9234 requires a singular stale approval to exit through review of CURRENT content, never by
transferring a lane's approval to content it did not inspect. The seed is idle-guarded, so a live
graph continuation wins. Selecting only a stale lane and refusing no-progress makes this route
terminating rather than a merge-retry loop.

FNXC:PreMergeApproval 2026-09-06-00:11:
FN-9264 deliberately defers a stale-content seed that is discovered from a live merge node. The
one-active-task-continuation constraint means excluding or retiring the merge row would race its
runner's terminal transition; the idle self-healing owner seeds only after that row is terminal.
*/
import {
  computeWorkflowIrPin,
  resolveWorkflowIrForTask,
  type MergeContentDescriptor,
  type Task,
  type TaskStore,
  type WorkflowIrNode,
} from "@fusion/core";
/*
FNXC:StaleContentParkRecovery 2026-10-09-21:02 (RUFU-343):
An earlier note here claimed importing the canonical engine-park predicate would be "a real
load-order cycle" and compared the pause reason locally instead. That claim was measured false:
`pre-merge-gate-reseed.ts` reads `AUTO_MERGE_RETRY_REJECTED_PREFIX` from `stale-content-park.ts`
only inside a function body (its `shape:` derivation), and nothing in that pair imports this
module, so this import adds no cycle at all. Keeping a local copy of the rule was not harmless
either — see the guard below for what the two definitions disagree about.
*/
import { isEngineAuthoredInReviewStallPark } from "./pre-merge-gate-reseed.js";

export type SingularStaleContentRerouteReason =
  | "seeded"
  | "active-continuation"
  | "no-review-route"
  | "no-progress"
  | "not-singular"
  | "operator-held";

function isContentReviewNode(node: WorkflowIrNode): boolean {
  if (node.kind !== "optional-group" && node.kind !== "step-review") return false;
  const name = typeof node.config?.name === "string" ? node.config.name : "";
  return node.id === "code-review" || node.config?.reviewKind === "code" || /code review/i.test(name);
}

export async function rerouteSingularStaleContentToReview(
  store: TaskStore,
  task: Task,
  options: {
    requiredPreMergeStepIds: ReadonlySet<string>;
    mergeContent: MergeContentDescriptor;
    /*
    FNXC:StaleContentParkRecovery 2026-10-09-20:04 (RUFU-343):
    The stall-deadlock park is the ONLY pause this lane may seed under, and only when the caller
    explicitly passes `allowDeadlockPark` — the parked-card recovery route in `recoverMergeableReviewTasks`
    has already ruled that the hold is the engine's own watchdog park and that the stale-content lane owns
    lifting it, so the seed must be able to run while the card is still `paused: true` carrying that reason.
    Any other automation pause, and every operator hold (`userPaused`, `deletedAt`, `autoMerge: false`),
    stays a hard `operator-held` refusal, so each existing caller's behavior is byte-identical. A bare
    `task.paused` veto instead made a completed card's only recoverable park permanently invisible:
    production card RUFU-301 sat behind `In-review stall deadlock: completed-review-status-none` naming a
    `code-review` approval for older input, and no layer ever named the class it was refusing, so every
    consumer reported progress forever.

    FNXC:StaleContentParkAdmission 2026-10-09-21:02 (RUFU-343 remediation):
    The admission test is the canonical `isEngineAuthoredInReviewStallPark`, not a local comparison of
    `pausedReason`. The pause marker alone is weaker than the class it names: the watchdog's park is a
    pause marker PLUS its own error sentence still on the row, so a card whose `error` was later
    overwritten by an unrelated terminal keeps a stale `pausedReason` while the failure it now reports is
    no longer a stall the watchdog owns. A local reason-string check would seed review under that card
    and its recovery would then clear the pause, deleting the operator's only view of the newer failure —
    the exact hazard the canonical predicate exists to refuse (`pre-merge-gate-reseed.ts`, RUFU-391).
    The classifier, this seed-lane guard, and the recovery route's atomic clear fence now decide that
    class from the ONE predicate, so the three cannot drift into admitting different cards.
    */
    allowDeadlockPark?: boolean;
  },
): Promise<{ rerouted: boolean; reason: SingularStaleContentRerouteReason; nodeId?: string; workflowStepId?: string }> {
  const mergeContent = options.mergeContent;
  if (mergeContent.kind !== "singular" || task.workspaceWorktrees !== undefined) {
    return { rerouted: false, reason: "not-singular" };
  }
  const deadlockParkAdmissible =
    options.allowDeadlockPark === true && isEngineAuthoredInReviewStallPark(task);
  if (task.userPaused || task.deletedAt || task.autoMerge === false || (task.paused && !deadlockParkAdmissible)) {
    return { rerouted: false, reason: "operator-held" };
  }
  if (mergeContent.diff.state !== "fingerprint") return { rerouted: false, reason: "no-progress" };
  const currentFingerprint = mergeContent.diff.fingerprint;

  const ir = await resolveWorkflowIrForTask(store, task.id);
  const selection = store.getTaskWorkflowSelectionAsync
    ? await store.getTaskWorkflowSelectionAsync(task.id)
    : store.getTaskWorkflowSelection(task.id);
  const selected = selection?.stepIds ?? [];
  const nodes = ir.nodes.filter((node) => {
    if (!isContentReviewNode(node) || !options.requiredPreMergeStepIds.has(node.id)) return false;
    return node.config?.defaultOn === true || selected.includes(node.id);
  });
  const node = nodes.find((candidate) => {
    const latest = task.workflowStepResults?.filter((result) => result.workflowStepId === candidate.id).at(-1);
    return latest?.reviewInputFingerprint !== currentFingerprint;
  });
  if (!node) return { rerouted: false, reason: nodes.length ? "no-progress" : "no-review-route" };

  const items = await store.listWorkflowWorkItemsForTask(task.id);
  const result = await store.seedWorkspaceCodeReviewContinuationIfIdle({
    taskId: task.id,
    nodeId: node.id,
    kind: "task",
    state: "runnable",
    runId: `${task.id}:stale-content-review-reroute:${node.id}:${items.length}`,
    stableWorkflowRunId: `${task.id}:${ir.name}`,
    continuationSequence: items.length,
    sourceColumn: task.column,
    targetColumn: node.column ?? task.column,
    irHash: computeWorkflowIrPin(ir, node.id).irHash,
  });
  return result.seeded
    ? { rerouted: true, reason: "seeded", nodeId: node.id, workflowStepId: node.id }
    : { rerouted: false, reason: "active-continuation", nodeId: node.id, workflowStepId: node.id };
}
