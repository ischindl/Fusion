/*
FNXC:PostMergeRecovery 2026-10-01-09:01 (upstream FN-9442 adopted, RUFU-306 / RUFU-370 / RUFU-430 layered on top):
Two implementations of one recovery existed after the upstream sync — ours (`reseedUnrunPostMergeGate`,
RUFU-306) and upstream's `resumeMissingPostMergeGate` (FN-9442) — under one filename. Upstream's is now the
single mechanism, because it owns two guards ours did not have: a fresh durable checkout lease is live
ownership even with no in-process session, and the seed is fenced on `expectedWorkflowSelection` plus
`expectedTaskUpdatedAt` so a card whose selection moved keeps its park instead of being seeded from an
unrelated workflow. What our seam had and their version lacked is kept as extensions here rather than as a
second function:
  - a bounded per-(task, gate) attempt budget, because their version resumes again on every pass and a gate
    that dies the same way each time burns model budget forever;
  - a refusal REASON on every non-resumable arm, so "why was this card not resumed" is answerable from the
    caller's notice instead of collapsing into one opaque boolean;
  - the per-project evidence contract (RUFU-430), so a board with no CI reporter is never told to go produce
    CI evidence and a board that declares the demand is never exempted;
  - the workspace-card refusal, because seeding a post-merge reviewer onto a lane whose repos are already
    cleaned makes the reviewer re-acquire against a moved base and burn the rerun budget (the SANE-507 loop);
  - `paused` cards whose only hold is the engine's own in-review stall deadlock stay resumable (RUFU-391):
    the classifier exempts paused cards, so refusing them here could never lift.
*/
import {
  allowsAutoMergeProcessing,
  computeWorkflowIrPin,
  getPostMergeEvidenceGateStatuses,
  getPostMergeFinalizeBlocker,
  getRequiredPostMergeEvidenceDecision,
  IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
  isWorkspaceTask,
  resolveWorkflowIrForTaskWithProvenance,
  type PostMergeEvidenceContract,
  type Task,
  type TaskStore,
} from "@fusion/core";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { isTaskExecutionLive } from "./merge-execution-exclusion.js";

/*
FNXC:UnrunPostMergeGateRecovery 2026-09-28-07:34 (RUFU-370):
RUFU-306 bounded the SEED, and the bound holds — but the caller had no way to tell a refusal that will
become a seed later from a refusal that can never produce evidence, so production kept deferring on
seconds-spaced passes: `[post-merge gate reseed: workspace]` for SANE-452 and
`[post-merge gate reseed: active-continuation]` for STAS-288, both forever. These are the refusals where
retrying the same seam is provably useless: a workspace card is refused by this seam by construction, a
workflow with no such node cannot seed it, and the seed budget is already spent. `active-continuation`,
`operator-held` and `workflow-selection-changed` stay NON-terminal here — each names a condition that
can genuinely clear on a later pass, and those cards must keep the transient-defer behaviour.
*/
export const MAX_POST_MERGE_GATE_RESEED_ATTEMPTS = 3;

export type PostMergeGateReseedReason =
  | "seeded"
  | "no-merge-proof"
  | "no-missing-gate"
  | "no-post-merge-node"
  | "workspace"
  | "operator-held"
  | "engine-paused"
  | "finalize-blocked"
  | "checkout-lease"
  | "execution-live"
  | "gate-not-resumable"
  | "selection-drift"
  | "rerun-budget-exhausted"
  | "active-continuation"
  | "unsupported-store";

export interface PostMergeGateReseedResult {
  /** `seeded` means a new idle continuation was installed; nothing else claims a verdict. */
  outcome: "seeded" | "not-seeded";
  /** Why the seam did or did not seed. Never a sentence, never a verdict. */
  reason: PostMergeGateReseedReason;
  /** The gate this pass targeted, when the gate itself was identifiable. */
  workflowStepId?: string;
  /** Seeds already recorded for this (task, gate) BEFORE this attempt; 0 when unmeasured. */
  priorAttemptCount?: number;
}

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

/*
FNXC:UnrunPostMergeGateRecovery 2026-10-01-09:01:
The budget is read from durable task-log lines, not memory, because the lanes that resume are separate
processes on separate timers. Upstream's success sentence is counted alongside our own marker so the
rename does not reset the budget for cards that already hold seeds from the earlier build.
*/
const RESEED_LOG_MARKERS = ["[post-merge-gate-reseed] gate", "[post-merge] Resuming missing verification"];

/** Counts persisted resume markers for one gate, hydrating the log when the row came slimmed. */
async function countReseedAttempts(store: TaskStore, task: Task, gateId: string): Promise<number> {
  const log = Array.isArray(task.log) ? task.log : ((await store.getTask(task.id))?.log ?? []);
  const quoted = `'${gateId}'`;
  return log.filter((entry) => {
    const action = typeof entry.action === "string" ? entry.action : "";
    return RESEED_LOG_MARKERS.some((marker) => action.startsWith(marker) && action.includes(quoted));
  }).length;
}

const DEFAULT_CHECKOUT_LEASE_GRACE_MS = 10 * 60_000;
const CHECKOUT_LEASE_STALENESS_MULTIPLIER = 3;

/** A fresh durable checkout lease is live ownership even when this process holds no session (FN-9442). */
function hasFreshCheckoutLease(
  task: { checkoutRunId?: string | null; checkoutLeaseRenewedAt?: string | null },
  settings: { taskStuckTimeoutMs?: number },
): boolean {
  const leaseAge = task.checkoutLeaseRenewedAt
    ? Date.now() - Date.parse(task.checkoutLeaseRenewedAt)
    : Number.POSITIVE_INFINITY;
  const graceMs = (settings.taskStuckTimeoutMs ?? DEFAULT_CHECKOUT_LEASE_GRACE_MS)
    * CHECKOUT_LEASE_STALENESS_MULTIPLIER;
  return !!task.checkoutRunId && Number.isFinite(leaseAge) && leaseAge >= 0 && leaseAge < graceMs;
}

/**
 * Put a landed card back in front of the required post-merge gate that produced no result row.
 *
 * The idle continuation fence is the only write: the card keeps its column, existing results (including
 * REVISE) stay authoritative, and no verdict is fabricated. `contract` is required — see the core seam —
 * because a derived demand must be read with the same fact the finalizer used to decide it is missing.
 */
export async function resumeMissingPostMergeGate(
  store: TaskStore,
  task: Task,
  options: {
    source: "self-healing" | "auto-merge" | "manual-reconcile";
    contract: PostMergeEvidenceContract | undefined;
  },
): Promise<PostMergeGateReseedResult> {
  if (typeof store.seedWorkspaceCodeReviewContinuationIfIdle !== "function"
    || typeof store.listWorkflowWorkItemsForTask !== "function") {
    return { outcome: "not-seeded", reason: "unsupported-store" };
  }
  /*
  FNXC:PostMergeGateDeliveryShape 2026-09-30-13:09 (RUFU-429):
  This refusal is a backstop, not the reason workspace cards stall: the requirement itself resolves to
  `not-applicable` for a workspace-shaped absence in core, so the finalizer completes and never reaches
  this seam. The guard stays because the SANE-507 loop is a live failure mode.
  */
  if (isWorkspaceTask(task)) return { outcome: "not-seeded", reason: "workspace" };
  // Landed PROOF, not a merge-shaped object: `{}` proves nothing and must not start graph work.
  if (!task.mergeDetails?.mergeConfirmed || !task.mergeDetails?.commitSha) {
    return { outcome: "not-seeded", reason: "no-merge-proof" };
  }
  if (
    task.userPaused
    || task.deletedAt
    || task.autoMerge === false
    || (task.paused === true && task.pausedReason !== IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON)
  ) {
    return { outcome: "not-seeded", reason: "operator-held" };
  }

  const settings = await store.getSettings();
  if (settings.globalPause || settings.enginePaused || !allowsAutoMergeProcessing(task, settings)) {
    return { outcome: "not-seeded", reason: "engine-paused" };
  }
  if (getPostMergeFinalizeBlocker(task)) return { outcome: "not-seeded", reason: "finalize-blocked" };
  if (hasFreshCheckoutLease(task, settings)) return { outcome: "not-seeded", reason: "checkout-lease" };
  if (isTaskExecutionLive(task.id, { activeSessionRegistry, executingTaskLock })) {
    return { outcome: "not-seeded", reason: "execution-live" };
  }
  // A gate that already holds a result — approved, REVISE, or failed — is authoritative; never seed over it.
  const irForGate = await resolveWorkflowIrForTaskWithProvenance(store, task.id);
  const statuses = getPostMergeEvidenceGateStatuses(task, irForGate.ir, options.contract);
  const missingGate = statuses.find((status) => status.state === "missing");
  if (!missingGate) {
    // Nothing is absent: no gate is required, the requirement is inapplicable on this board (RUFU-429
    // delivery shape, RUFU-430 no-reporter), or a result already exists and stays authoritative. Seeding
    // would overwrite a real verdict.
    return { outcome: "not-seeded", reason: "gate-not-resumable" };
  }

  const decision = await getRequiredPostMergeEvidenceDecision(store, task, options.contract);
  if (decision.outcome !== "resumable") return { outcome: "not-seeded", reason: "gate-not-resumable" };
  const gateId = decision.gateId;

  const priorAttemptCount = await countReseedAttempts(store, task, gateId);
  if (priorAttemptCount >= MAX_POST_MERGE_GATE_RESEED_ATTEMPTS) {
    return { outcome: "not-seeded", reason: "rerun-budget-exhausted", workflowStepId: gateId, priorAttemptCount };
  }

  const selection = await store.getTaskWorkflowSelectionAsync(task.id);
  const resolved = irForGate;
  if (resolved.source === "default" && !resolved.selectionAbsent) {
    return { outcome: "not-seeded", reason: "selection-drift", workflowStepId: gateId };
  }
  const { ir } = resolved;
  const node = ir.version === "v2" ? ir.nodes.find((candidate) => candidate.id === gateId) : undefined;
  if (!node) return { outcome: "not-seeded", reason: "no-post-merge-node", workflowStepId: gateId };

  const items = await store.listWorkflowWorkItemsForTask(task.id);
  const seeded = await store.seedWorkspaceCodeReviewContinuationIfIdle({
    taskId: task.id,
    nodeId: node.id,
    kind: "task",
    state: "runnable",
    runId: `${task.id}:post-merge-gate-reseed:${node.id}:${items.length}`,
    stableWorkflowRunId: `${task.id}:${ir.name}`,
    continuationSequence: items.length,
    sourceColumn: task.column,
    targetColumn: task.column,
    irHash: computeWorkflowIrPin(ir, node.id).irHash,
    expectedWorkflowSelection: selection ?? null,
    expectedTaskUpdatedAt: task.updatedAt,
  });
  if (!seeded.seeded) return { outcome: "not-seeded", reason: "active-continuation", workflowStepId: gateId };

  await store.logEntry(
    task.id,
    `[post-merge] Resuming missing verification at '${node.id}'; already-landed implementation and merge `
      + `will not run again (reseed ${priorAttemptCount + 1} of ${MAX_POST_MERGE_GATE_RESEED_ATTEMPTS})`,
  );
  return { outcome: "seeded", reason: "seeded", workflowStepId: gateId, priorAttemptCount };
}

/*
FNXC:PostMergeRecovery 2026-10-01-09:01:
`reseedUnrunPostMergeGate` (RUFU-306) is DELETED. Its callers call `resumeMissingPostMergeGate` with the
same source label, and its invariants are listed in the header above. Do not re-add a second post-merge
seed function: the two implementations disagreeing in one file is what produced the merge-time collision
this resolution removed.
*/
