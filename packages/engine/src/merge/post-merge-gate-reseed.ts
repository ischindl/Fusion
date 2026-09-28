/*
FNXC:UnrunPostMergeGateRecovery 2026-09-25-15:35 (RUFU-306):
A card whose merge is CONFIRMED can still never finalize: `getRequiredPostMergeEvidenceBlocker`
refuses completion while an enabled gate-mode post-merge group has produced no result row at all,
and for these cards the graph never visits that node again — the merge ran on the `merge-attempt`
success edge, finalization blocked, and the run ended. Production 2026-09-25 shows the loop verbatim:
`Auto-merge finalization deferred for DGXS-313 / ROZV-290: required post-merge evidence gate
'post-merge-verification' has not reported`, plus RUFU-220 and ROZV-286 parked in `in-review` with
their work proven on `main`. Each pass leaves the card in place, so the board cannot drain and the
slot stays held.

This module seeds the missing post-merge node so the real gate inspects the landed content and
produces its own genuine result. It is the post-merge sibling of FN-9243's `pre-merge-gate-reseed.ts`
and inherits its discipline:

- Seed, never fabricate. A missing result row gets a real run; a result row that EXISTS but was not
  approved is a review decision and is refused outright (`no-missing-gate`), because re-running to
  flip a verdict would be a machine overruling a gate.
- In place, never moved. The seeded continuation names the card's CURRENT column. The pre-merge
  sibling clamps a cross-lane gate through `clampReviewGateEntry`, but a post-merge node's own column
  is the complete lane, so honouring it here would hand the card a forward move into `done` that it
  has not earned — which is the very thing the blocker exists to prevent (FN-207/FN-217 containment).
- Idle only. `seedWorkspaceCodeReviewContinuationIfIdle` refuses when a continuation is already live.
- Bounded. Three seeds per (task, gate) counted from durable task-log markers, so a gate that dies
  the same way forever reaches the operator instead of burning model budget on every finalize retry.
- Operator holds are absolute: `userPaused`, `deletedAt`, `autoMerge:false`, and any pause other than
  the in-review stall-deadlock park this lane may itself be undoing.
- Landed proof is a precondition. Without `mergeDetails` this is not a post-merge recovery at all.
*/
import {
  computeWorkflowIrPin,
  getPostMergeEvidenceGateStatuses,
  IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
  isWorkspaceTask,
  resolveWorkflowIrForTask,
  type Task,
  type TaskStore,
} from "@fusion/core";
// FN-9175: engine-lane emitters use the engine seam, which absorbs an absent, throwing, or hanging sink.
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";

export const MAX_POST_MERGE_GATE_RESEED_ATTEMPTS = 3;

export type PostMergeGateReseedReason =
  | "seeded"
  | "no-merge-proof"
  | "no-missing-gate"
  | "no-post-merge-node"
  | "workspace"
  | "operator-held"
  | "rerun-budget-exhausted"
  | "active-continuation"
  | "unsupported-store"
  | "workflow-selection-changed";

export interface PostMergeGateReseedResult {
  seeded: boolean;
  reason: PostMergeGateReseedReason;
  workflowStepId?: string;
  /** Seeds already recorded for this (task, gate) BEFORE this attempt; 0 when unmeasured. */
  priorAttemptCount?: number;
}

/*
FNXC:UnrunPostMergeGateRecovery 2026-09-28-07:34 (RUFU-370):
RUFU-306 bounded the SEED, and the bound holds — but the caller had no way to tell a refusal that will
become a seed later from a refusal that can never produce evidence, so production kept deferring on
seconds-spaced passes: `[post-merge gate reseed: workspace]` for SANE-452 and
`[post-merge gate reseed: active-continuation]` for STAS-288, both forever. These are the refusals where
retrying the same seam is provably useless: a workspace card is refused by this seam by construction, a
workflow with no such node cannot seed it, and the seed budget is already spent. `active-continuation`,
`operator-held` and `workflow-selection-changed` stay NON-terminal here — each names a condition that
can genuinely clear on a later pass, and those cards must keep the old transient-defer behaviour.
*/
const TERMINAL_POST_MERGE_RESEED_REFUSALS = new Set<PostMergeGateReseedReason>([
  "workspace",
  "no-post-merge-node",
  "rerun-budget-exhausted",
  "unsupported-store",
]);

/** True when no future pass through this seam can produce the missing post-merge evidence row. */
export function isTerminalPostMergeReseedRefusal(reason: PostMergeGateReseedReason): boolean {
  return TERMINAL_POST_MERGE_RESEED_REFUSALS.has(reason);
}

/** Fixed per-gate marker prefix; gate ids cannot contain apostrophes, so the quoting is safe to match. */
export function postMergeGateReseedLogMarker(gateId: string): string {
  return `[post-merge-gate-reseed] gate '${gateId}'`;
}

/** Counts persisted reseed markers for one gate, hydrating the log when the row came slimmed. */
async function countReseedAttempts(store: TaskStore, task: Task, gateId: string): Promise<number> {
  const marker = postMergeGateReseedLogMarker(gateId);
  const log = Array.isArray(task.log) ? task.log : ((await store.getTask(task.id))?.log ?? []);
  return log.filter((entry) => typeof entry.action === "string" && entry.action.startsWith(marker)).length;
}

/**
 * Seed the earliest required post-merge gate that has produced NO result row.
 *
 * `expectedWorkflowSelection` fences the seed to the selection that named the gate (the upstream
 * FN-9353 discipline): a card whose selection changed since the blocker was read keeps its park for
 * reclassification instead of being seeded with a node from an unrelated workflow.
 */
export async function reseedUnrunPostMergeGate(
  store: TaskStore,
  task: Task,
  options: {
    source: "self-healing" | "auto-merge";
    expectedWorkflowSelection?: { workflowId: string; stepIds: string[] } | null;
  } = { source: "self-healing" },
): Promise<PostMergeGateReseedResult> {
  // Landed PROOF, not a merge-shaped object: `{}` proves nothing and must not start graph work.
  if (!task.mergeDetails?.commitSha) return { seeded: false, reason: "no-merge-proof" };
  // RUFU-370: this guard was duplicated in the RUFU-306 edit; a workspace card is refused by this
  // seam by construction, which is why SANE-452 deferred forever with zero seed attempts.
  if (isWorkspaceTask(task)) return { seeded: false, reason: "workspace" };
  if (
    task.userPaused
    || task.deletedAt
    || task.autoMerge === false
    || (task.paused === true && task.pausedReason !== IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON)
  ) {
    return { seeded: false, reason: "operator-held" };
  }

  const reader = store as Partial<{ getTaskWorkflowSelection(taskId: string): unknown }>;
  if (typeof reader.getTaskWorkflowSelection !== "function") {
    // No selection read means the required-gate question itself is unanswerable — same reason the
    // core blocker returns no blocker for such a store.
    return { seeded: false, reason: "no-missing-gate" };
  }
  if (typeof store.seedWorkspaceCodeReviewContinuationIfIdle !== "function"
    || typeof store.listWorkflowWorkItemsForTask !== "function") {
    return { seeded: false, reason: "unsupported-store" };
  }

  const ir = await resolveWorkflowIrForTask(store, task.id);
  // Only `missing` is seedable. `not-approved` carries a real verdict and stays the operator's call.
  const missing = getPostMergeEvidenceGateStatuses(task, ir).filter((status) => status.state === "missing");
  if (missing.length === 0) return { seeded: false, reason: "no-missing-gate" };

  const gateId = missing[0]!.gateId;
  const node = ir.nodes.find((candidate) => candidate.id === gateId);
  if (!node) return { seeded: false, reason: "no-post-merge-node", workflowStepId: gateId };

  const priorAttemptCount = await countReseedAttempts(store, task, gateId);
  if (priorAttemptCount >= MAX_POST_MERGE_GATE_RESEED_ATTEMPTS) {
    return { seeded: false, reason: "rerun-budget-exhausted", workflowStepId: gateId, priorAttemptCount };
  }

  const items = await store.listWorkflowWorkItemsForTask(task.id);
  const seed = await store.seedWorkspaceCodeReviewContinuationIfIdle({
    taskId: task.id,
    nodeId: node.id,
    kind: "task",
    state: "runnable",
    runId: `${task.id}:unrun-post-merge-gate-reseed:${node.id}:${items.length}`,
    stableWorkflowRunId: `${task.id}:${ir.name}`,
    continuationSequence: items.length,
    sourceColumn: task.column,
    /*
    Deliberately NOT `clampReviewGateEntry(...)`, unlike the pre-merge sibling: for a POST-merge node
    the node's own column resolves to the complete lane, so honouring it would hand the card a forward
    move into `done` that it has not earned — the exact opposite of why this blocker exists. The card
    keeps the column it stands in and only the real finalizer, once the gate reports approval, moves it.
    */
    targetColumn: task.column,
    irHash: computeWorkflowIrPin(ir, node.id).irHash,
    expectedWorkflowSelection: options.expectedWorkflowSelection,
  });
  if (!seed.seeded) {
    return {
      seeded: false,
      reason: seed.reason === "workflow-selection-changed" ? "workflow-selection-changed" : "active-continuation",
      workflowStepId: gateId,
      priorAttemptCount,
    };
  }

  // The marker is the durable budget counter: write it only AFTER the seed landed.
  await store.logEntry(
    task.id,
    `${postMergeGateReseedLogMarker(gateId)} landed merge has no post-merge evidence row, re-seeded in place `
      + `for a fresh run (reseed ${priorAttemptCount + 1} of ${MAX_POST_MERGE_GATE_RESEED_ATTEMPTS})`,
  );
  // Best-effort telemetry must never become a finalization dependency (FN-9175).
  await emitBoundedRunAudit(store, {
    taskId: task.id,
    agentId: "self-healing",
    runId: `${task.id}:unrun-post-merge-gate-reseed:${node.id}`,
    domain: "database",
    mutationType: "task:merge-unrun-post-merge-gate-reseeded",
    target: task.id,
    metadata: {
      taskId: task.id,
      nodeId: node.id,
      workflowStepId: gateId,
      source: options.source,
      outcome: "seeded",
      reseedAttempt: priorAttemptCount + 1,
      missingGateCount: missing.length,
    },
  });
  return { seeded: true, reason: "seeded", workflowStepId: gateId, priorAttemptCount };
}
