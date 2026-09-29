import type { Task, WorkflowStepResult } from "../types.js";
import { resolveWorkflowIrForTask, type WorkflowIrResolverStore } from "../workflows/workflow-ir-resolver.js";
import { isWorkflowOptionalGroupEnabled } from "../workflows/workflow-optional-steps.js";
import type { WorkflowIr } from "../workflows/workflow-ir-types.js";
import { BLOCKING_TASK_STATUSES, clearMergeConfirmedTransientStatus } from "./task-merge.js";
import { isAuditedOperatorBypass } from "./pre-merge-approval.js";

export type ConfirmedMergeChecklistReconciliation = {
  skippedStepIndexes: number[];
  reconciledWorkflowStepIds: string[];
};

/*
FNXC:ConfirmedMergeFinalization 2026-08-23-07:42:
FN-180 requires a confirmed integration merge to finalize even when a concurrent
review bounce left a stale checklist. Post-merge checks deliberately exclude
steps and review verdicts; only independent task blocking states may defer.

FNXC:ConfirmedMergeFinalization 2026-08-28-11:05:
A failed status cannot block post-merge finalization because all consumers establish durable merge
or landing proof before calling this helper: the shared finalizer uses hasDurableMergeProof, the
project-engine fast path verifies mergeConfirmed reachability, and self-healing proves the landed
commit. getTaskHardMergeBlocker already neutralizes failed for the same FN-9193 failure shape. This
is not a laundering path: keeping proven-landed work out of completion cannot un-merge it and only
leaves a permanently failed board card; every independent operator and planning status still blocks.
*/
export function getPostMergeFinalizeBlocker(task: Pick<Task, "status" | "error">): string | undefined {
  const status = clearMergeConfirmedTransientStatus(task.status);
  if (status && status !== "failed" && BLOCKING_TASK_STATUSES.has(status)) {
    return task.error ? `task is marked '${status}': ${task.error}` : `task is marked '${status}'`;
  }
  return undefined;
}

/*
FNXC:WorkflowPostMerge 2026-09-23-07:48:
A confirmed merge does not erase an enabled gate-mode post-merge requirement. Finalizers and
self-healing share this resolver-backed decision so absent, pending, skipped, or revised evidence
keeps the task outside completion until the durable gate result approves it. Explicitly disabled
and advisory groups retain their intentional non-blocking behavior.
*/

/** The enabled gate-mode post-merge groups a task must still satisfy, in IR order. */
export function resolveRequiredPostMergeGateIds(
  task: Pick<Task, "enabledWorkflowSteps">,
  ir: WorkflowIr,
): string[] {
  if (ir.version !== "v2") return [];
  return ir.nodes.flatMap((node) => {
    if (node.kind !== "optional-group" || node.config?.phase !== "post-merge") return [];
    const template = node.config.template as { nodes?: Array<{ config?: { gateMode?: unknown } }> } | undefined;
    const gateMode = template?.nodes?.some((inner) => inner.config?.gateMode === "gate");
    return gateMode && isWorkflowOptionalGroupEnabled(task.enabledWorkflowSteps, node.id, node.config.defaultOn === true)
      ? [node.id]
      : [];
  });
}

/*
FNXC:UnrunPostMergeGateRecovery 2026-09-25-15:35 (RUFU-306):
Two states hide behind the one blocker sentence, and only one of them is repairable by re-running
the gate. `missing` means the node never reported at all — nothing was ever evaluated, so the graph
can still be seeded with it. `not-approved` means a verdict exists and was negative: that is a
review decision, and re-seeding it would be a machine overruling a gate. The engine's recovery
route is allowed to see this distinction; the blocker TEXT deliberately stays the single sentence
operators already recognise, so no consumer changes shape.
*/
export type PostMergeEvidenceGateState = "missing" | "not-approved";

export interface PostMergeEvidenceGateStatus {
  gateId: string;
  state: PostMergeEvidenceGateState;
}

/** Per-gate evidence state for every required post-merge gate, in IR order. */
export function getPostMergeEvidenceGateStatuses(
  task: Pick<Task, "enabledWorkflowSteps" | "workflowStepResults">,
  ir: WorkflowIr,
): PostMergeEvidenceGateStatus[] {
  return resolveRequiredPostMergeGateIds(task, ir).flatMap((gateId): PostMergeEvidenceGateStatus[] => {
    const result = (task.workflowStepResults ?? []).find((entry) => entry.workflowStepId === gateId);
    if (!result) return [{ gateId, state: "missing" as const }];
    /*
    FNXC:PostMergeGateOperatorWaiver 2026-09-29-15:49 (RUFU-408):
    An audited operator waiver satisfies the post-merge gate, exactly as it satisfies the pre-merge door
    (`evaluatePreMergeApprovals`' `auditedOperatorWaiver` class). Without this, the bypass the RUFU-370
    notice names as the remedy rewrote the row to `skipped` and the finalizer STILL refused: `skipped`
    is not `passed`, so the waiver closed one door and left the other shut, and the landed card stayed
    in `in-review` forever with a recorded human decision on it. This is not a verdict — no reviewer
    approval is fabricated; the row keeps `bypassedBy`/`bypassedAt`/`bypassReason` and the
    `task:bypass-review` audit row, and the shared `isAuditedOperatorBypass` predicate refuses every
    automated actor, so only a named human waiver clears the gate.
    */
    if (isAuditedOperatorBypass(result)) return [];
    if (result.status !== "passed" || (result.verdict !== "APPROVE" && result.verdict !== "APPROVE_WITH_NOTES")) {
      return [{ gateId, state: "not-approved" as const }];
    }
    return [];
  });
}

export async function getRequiredPostMergeEvidenceBlocker(
  store: WorkflowIrResolverStore,
  task: Pick<Task, "id" | "enabledWorkflowSteps" | "workflowStepResults">,
): Promise<string | undefined> {
  const reader = store as Partial<WorkflowIrResolverStore>;
  if (typeof reader.getTaskWorkflowSelection !== "function") return undefined;

  const ir = await resolveWorkflowIrForTask(store, task.id);
  for (const { gateId, state } of getPostMergeEvidenceGateStatuses(task, ir)) {
    return state === "missing"
      ? `required post-merge evidence gate '${gateId}' has not reported`
      : `required post-merge evidence gate '${gateId}' is not approved`;
  }
  return undefined;
}

export function planConfirmedMergeChecklistReconciliation(
  task: Pick<Task, "steps" | "workflowStepResults">,
): ConfirmedMergeChecklistReconciliation {
  /*
  FNXC:ConfirmedMergeFinalization 2026-09-01-05:49:
  `steps` is typed non-optional, but a row can still reach here without it — an older row, a partial
  projection, a store path that does not populate it. This function runs on the merge-CONFIRMED
  fast path, i.e. after the work has already landed, so a TypeError here abandons the finalize and
  leaves a merged task un-finalized. Tolerating the absence costs nothing; asserting the type does
  not make the row real. Measured: a task whose row carried no `steps` threw
  "Cannot read properties of undefined (reading 'map')" and the landed merge never finalized.
  */
  return {
    skippedStepIndexes: (task.steps ?? [])
      .map((step, index) => step.status === "pending" || step.status === "in-progress" ? index : -1)
      .filter((index) => index >= 0),
    reconciledWorkflowStepIds: (task.workflowStepResults ?? [])
      .filter((result: WorkflowStepResult) => result.status === "pending")
      .map((result) => result.workflowStepId),
  };
}
