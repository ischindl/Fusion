/**
 * FNXC:CodeOrganization 2026-08-03-09:25:
 * cleanupMergeStateForReverification peeled from TaskExecutor (U4).
 * Clears merge/status bookkeeping and reopens verification suffix steps for re-verification.
 */
import type { Task, TaskStore } from "@fusion/core";
import type { EngineRunContext } from "../util/run-audit.js";
import { preservePreExecutionWorkflowStepResults } from "./workflow-step-satisfaction.js";
import { announceExecutionRearmParkDisturbed, readExecutionRarmMarker } from "./execution-rearm.js";

/**
 * FNXC:ExecutionReArmCeiling 2026-11-14-16:20 (RUFU-1028):
 * WHY this cleanup fires is now a named value rather than an absence of merge evidence. It used to be
 * triggered by `Boolean(task.mergeDetails)`, which is TRUE for a row carrying only recovery bookkeeping, so a
 * card that had never merged anything had its failure marker cleared anyway — and that clearing is what
 * disarmed the re-arm park guard (Step 1). The source is recorded so a wipe is attributable; an absent or
 * unrecognized value normalizes to `unknown`, never to prose.
 */
export type MergeResetSource = "execute-preflight" | "lane-return";

function normalizeMergeResetSource(value: string | undefined): "execute-preflight" | "lane-return" | "unknown" {
  return value === "execute-preflight" || value === "lane-return" ? value : "unknown";
}

export type CleanupMergeStateDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
};

export async function cleanupMergeStateForReverification(
  deps: CleanupMergeStateDeps,
  task: Task,
  logMessage: string,
  options?: {
    preserveVerificationFailureCount?: boolean;
    stepReopenPolicy?: "reopen-trailing" | "none";
    resetSource?: MergeResetSource;
  },
): Promise<Task> {
  const preservedWorkflowStepResults = preservePreExecutionWorkflowStepResults(task);
  /*
   * FNXC:ExecutionReArmCeiling 2026-11-14-16:20 (RUFU-1028):
   * Read the ladder BEFORE the write, because this statement is the one that removes the park's only
   * row-level announcement. The episode key itself survives untouched — RUFU-1027 moved the ladder to
   * `sourceMetadata`, which this update never names — so the park still holds after this call; what is lost
   * is the operator-visible `status`/`error` badge, and that loss must be attributable rather than silent.
   * Deliberately NOT a key-level carry: RUFU-469's stale-generation guarantee depends on this write nulling
   * every delivery snapshot, so restoring merge bookkeeping here would undo an audited guarantee.
   */
  const standingPark = readExecutionRarmMarker(task);
  await deps.store.updateTask(task.id, {
    mergeDetails: null,
    mergeRetries: 0,
    status: null,
    error: null,
    verificationFailureCount: options?.preserveVerificationFailureCount ? task.verificationFailureCount ?? 0 : 0,
    workflowStepResults: preservedWorkflowStepResults,
  });

  /*
   * FNXC:WorkflowStepReopenAuthority 2026-08-23-08:51:
   * FN-180 makes sendTaskBackForFix the sole workflow-resolved replay authority. Cleanup only
   * clears stale merge bookkeeping: reopening here and again during the remediation bounce could
   * reopen two different steps from one rejection. The resolved policy still travels through each
   * caller to the send-back path, where `none` has a concrete no-reopen exit.
   */
  await deps.store.logEntry(task.id, logMessage, undefined, deps.getRunContextFor(task.id));

  /*
   * FNXC:ExecutionReArmCeiling 2026-11-14-16:20 (RUFU-1028):
   * Observation only, and best-effort by construction: a park that stands on the episode keeps standing,
   * and neither a missing sink nor a throwing History write may turn this cleanup into a failure. Telemetry
   * that can break the writer it describes is how a diagnostic becomes a defect.
   */
  if (standingPark?.heldAt != null) {
    const runContext = deps.getRunContextFor(task.id);
    await announceExecutionRearmParkDisturbed({
      store: deps.store,
      taskId: task.id,
      agentId: runContext?.agentId ?? "executor",
      runId: runContext?.runId,
      marker: standingPark,
      observedFrom: "merge-reset",
      resetSource: normalizeMergeResetSource(options?.resetSource),
    }).catch(() => undefined);
  }
  return deps.store.getTask(task.id);
}
