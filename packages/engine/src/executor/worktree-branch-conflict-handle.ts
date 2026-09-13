/**
 * FNXC:CodeOrganization 2026-08-03-16:05:
 * reclaimExistingWorktree + handleBranchConflict peeled from TaskExecutor (U4 Slice B).
 * Branch-conflict recovery lifecycle: inspect → reclaim/retry/sticky, with FN-4811 live-owner guard.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { classifyTaskBranchOrigin, isFusionDeletableBranch, type Settings, type Task, type TaskStore } from "@fusion/core";
import {
  assertCleanBranchAtBase,
  BranchConflictError,
  inspectBranchConflict,
  taskWorktreeCheckoutIsClean,
} from "../execution/branch-conflicts.js";
import { recoverForeignOnlyContamination } from "../recovery/foreign-only-contamination.js";
/*
FNXC:BranchConflictRecovery 2026-09-13-01:45:
RUFU-231 bounded-budget accounting for the executor's sticky branch-conflict park path.
*/
import {
  branchConflictRecoveryCounterPatch,
  buildBranchConflictRecoveryParkPatch,
  branchConflictDispatchEvidenceCounts,
  conflictAttributionBase,
  emitBranchConflictRecoveryParkAudit,
  planBranchConflictRecoveryPass,
} from "../recovery/branch-conflict-recovery-accounting.js";
import { preserveWorktreeChangesIncludingUntracked } from "../execution/worktree-change-preservation.js";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";
import { mergeEffectiveSettings } from "../project/effective-settings.js";
import { preservedWorktreeTargetPathForTask } from "../worktree/worktree-pinning.js";
import { executorLog } from "../logger.js";
import type { AutoRecoveryDispatcher } from "../healing/auto-recovery.js";
import { generateSyntheticRunId, type EngineRunContext, type RunAuditor } from "../util/run-audit.js";
import { resolveDiffBaseRef } from "./worktree-git-refs.js";
import { getWorktreeBranchMap } from "./worktree-registry-helpers.js";
import {
  formatBranchConflictAgentLog,
  formatBranchConflictLifecycleLog,
} from "./branch-conflict-format.js";

const execAsync = promisify(exec);

export type BranchConflictHandleDeps = {
  rootDir: string;
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  findActiveWorktreeOwner: (worktreePath: string, requestingTaskId: string) => Promise<string | null>;
  normalizeReclaimableWorktreePath: (
    sourcePath: string,
    targetPath: string,
    taskId: string,
    settings: Partial<Settings>,
  ) => Promise<string>;
  cleanupConflictingWorktree: (worktreePath: string, branch: string, taskId: string) => Promise<boolean>;
  getAutoRecoveryDispatcher: (audit: RunAuditor) => AutoRecoveryDispatcher;
  createRunAuditor: (runContext: EngineRunContext | undefined) => RunAuditor;
  persistTokenUsage: (taskId: string) => Promise<void>;
  onError?: (task: Task, error: Error) => void;
};

export async function reclaimExistingWorktree(
  deps: BranchConflictHandleDeps,
  task: Task,
  livePath: string,
  branch: string,
  tipSha: string,
  count: number,
  settings: Partial<Settings>,
): Promise<void> {
  const targetPath = preservedWorktreeTargetPathForTask(task.id, livePath, settings, deps.rootDir);
  const normalizedPath = await deps.normalizeReclaimableWorktreePath(livePath, targetPath, task.id, settings);
  await deps.store.updateTask(task.id, {
    worktree: normalizedPath,
    branch,
    branchWriteOrigin: classifyTaskBranchOrigin(task, branch) === "operator-supplied" ? "operator" : "engine",
  });
  const latestTask = await deps.store.getTask(task.id);
  const baseRef = await resolveDiffBaseRef(normalizedPath, latestTask.baseCommitSha);
  if (baseRef) {
    await assertCleanBranchAtBase(deps.rootDir, branch, baseRef, task.id);
  }
  const message = `[recovery] reclaimed existing worktree for ${task.id} at ${normalizedPath} (${count} commits preserved, tip ${tipSha.slice(0, 12)})`;
  await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
  await deps.store.appendAgentLog(task.id, "Branch conflict auto-recovery", "status", message, "executor");
}

export async function handleBranchConflict(
  deps: BranchConflictHandleDeps,
  task: Task,
  error: BranchConflictError,
): Promise<"retry" | "reclaimed" | "sticky"> {
  // FN-4811: Before invoking inspection-based recovery (which may force-remove the
  // conflicting worktree), verify the conflict isn't currently bound to a live session.
  // If it is, refuse the whole recovery dance — a force-remove here would yank an active
  // task's filesystem out from under it, producing FN-4781/FN-4804-style cascade failures.
  const activeOwner = await deps.findActiveWorktreeOwner(error.conflictingWorktreePath, task.id);
  if (activeOwner !== null) {
    const refusalMessage = `[FN-4811] Branch conflict on ${error.branchName} deferred: conflicting worktree ${error.conflictingWorktreePath} is actively owned by ${activeOwner}`;
    executorLog.warn(refusalMessage);
    await deps.store.logEntry(task.id, refusalMessage, undefined, deps.getRunContextFor(task.id));
    return "sticky";
  }
  const settings = await mergeEffectiveSettings(deps.store, task, await deps.store.getSettings());

  const integrationRef = task.mergeDetails?.mergeTargetBranch ?? task.baseBranch ?? task.executionStartBranch ?? await resolveIntegrationBranch(deps.rootDir, undefined);
  const inspection = await inspectBranchConflict({
    repoDir: deps.rootDir,
    branchName: error.branchName,
    conflictingWorktreePath: error.conflictingWorktreePath,
    requestingTaskId: task.id,
    ownerTaskId: task.id,
    startPoint: error.startPoint,
    integrationRef,
  });

  if (inspection.kind === "stale-resolved") {
    await deps.store.updateTask(task.id, { worktree: null, branch: null, branchWriteOrigin: "engine" as const, baseCommitSha: null });
    const message = `[recovery] ${task.id} stage-A: pruned stale admin entry for ${error.branchName}`;
    await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
    await deps.store.appendAgentLog(task.id, "Branch conflict auto-recovery", "status", message, "executor");
    return "retry";
  }

  if (inspection.kind === "tip-already-merged") {
    /*
    FNXC:BranchBaseIdentity 2026-09-13-03:00:
    RUFU-231 (never release an unproven checkout): a tip proven landed ONLY against the
    remote-tracking identity (the zero-own-commit wedge shape) requires explicit checkout
    proof before release. Clean → release. Dirty → capture a recovery patch first and
    release only once it exists; a failed capture falls through to the dispatcher below
    instead of destroying work. Local-identity landings keep the pre-existing behavior
    byte-for-byte — the gate applies only to the newly reachable wedge verdict.
    */
    let provenReleasable = true;
    if (inspection.landedVia === "remote-tracking" && inspection.livePath && existsSync(inspection.livePath)) {
      if (!await taskWorktreeCheckoutIsClean(inspection.livePath)) {
        const patchPath = await preserveWorktreeChangesIncludingUntracked(deps.rootDir, inspection.livePath, task.id);
        if (patchPath) {
          await deps.store.logEntry(
            task.id,
            `[recovery] ${task.id}: uncommitted work preserved to ${patchPath} before tip-landed checkout release`,
            undefined,
            deps.getRunContextFor(task.id),
          );
        } else {
          provenReleasable = false;
        }
      }
    }
    if (provenReleasable) {
      if (inspection.livePath) {
        await deps.cleanupConflictingWorktree(inspection.livePath, error.branchName, task.id);
      }
      try {
        await execAsync("git worktree prune", {
          cwd: deps.rootDir,
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch {
        // best-effort
      }
      if (isFusionDeletableBranch(task, error.branchName)) try {
        await execAsync(`git branch -D ${JSON.stringify(error.branchName)}`, {
          cwd: deps.rootDir,
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch {
        // best-effort
      }
      await deps.store.updateTask(task.id, { worktree: null, branch: null, branchWriteOrigin: "engine" as const, baseCommitSha: null });
      const message = `[recovery] ${task.id} stage-A: tip-already-merged cleanup for ${error.branchName} (${inspection.tipSha.slice(0, 12)} on ${inspection.integrationRef})`;
      await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
      await deps.store.appendAgentLog(task.id, "Branch conflict auto-recovery", "status", message, "executor");
      return "retry";
    }
    await deps.store.logEntry(
      task.id,
      `[recovery] ${task.id} tip-landed-on-trusted-remote held: checkout dirty and unproven (landed on ${inspection.integrationRef})`,
      undefined,
      deps.getRunContextFor(task.id),
    );
  }

  if (inspection.kind === "reclaimable") {
    await reclaimExistingWorktree(deps, task, inspection.livePath, error.branchName, inspection.tipSha, inspection.taskAttributedCommitCount, settings);
    return "reclaimed";
  }

  if (inspection.kind === "fully-subsumed") {
    await reclaimExistingWorktree(deps, task, inspection.livePath, error.branchName, inspection.tipSha, 0, settings);
    return "reclaimed";
  }

  if (inspection.kind === "live-foreign") {
    /*
    FNXC:BranchBaseIdentity 2026-09-13-03:05:
    RUFU-231 Deliverable 1: before force-cleaning a live-foreign conflict, consult the
    classification-proven exit. When the branch provably carries zero own commits, zero
    unattributed commits, and foreign work that has already landed on a trusted integration
    identity, recoverForeignOnlyContamination re-anchors it to base (worktree preserved) or
    discards it only when the checkout is already unusable — instead of force-deleting a
    possibly-dirty tree. Non-matching classifications return recovered:false at no cost and
    the existing cleanup path proceeds unchanged.
    */
    const recoveryIntegrationBranch = await resolveIntegrationBranch(deps.rootDir, undefined);
    const liveTask = await deps.store.getTask(task.id).catch(() => null);
    const recovered = await recoverForeignOnlyContamination(liveTask ?? task, {
      repoDir: deps.rootDir,
      taskStore: deps.store,
      runAudit: deps.createRunAuditor(deps.getRunContextFor(task.id)),
      integrationBranch: recoveryIntegrationBranch,
    }).catch(() => null);
    if (recovered?.recovered) {
      const message = `[recovery] ${task.id} live-foreign conflict resolved by foreign-only recovery (subtype=${recovered.subtype}) — no force-delete needed`;
      await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
      await deps.store.appendAgentLog(task.id, "Branch conflict auto-recovery", "status", message, "executor");
      return "reclaimed";
    }
    const cleanupSuccess = await deps.cleanupConflictingWorktree(inspection.livePath, error.branchName, task.id);
    if (cleanupSuccess) {
      try {
        await execAsync("git worktree prune", { cwd: deps.rootDir });
      } catch {
        // best-effort
      }
      try {
        const worktreeMap = await getWorktreeBranchMap(deps.rootDir);
        if (!worktreeMap.has(error.branchName) && isFusionDeletableBranch(task, error.branchName)) {
          await execAsync(`git branch -D "${error.branchName}"`, { cwd: deps.rootDir });
        }
      } catch {
        // best-effort
      }
      return "retry";
    }
  }

  const conflictMessage = `Task branch conflict: ${error.branchName} is already checked out at ${error.conflictingWorktreePath}. ` +
    `Resolve the local branch/worktree conflict with git tooling (inspect/reclaim or discard) before retrying.`;
  await deps.store.logEntry(task.id, formatBranchConflictLifecycleLog(task.id, error), undefined, deps.getRunContextFor(task.id));
  await deps.store.appendAgentLog(task.id, "Branch conflict recovery required", "tool_error", formatBranchConflictAgentLog(task.id, error), "executor");
  /*
  FNXC:BranchConflictRecovery 2026-09-13-01:46:
  RUFU-231 bounded budget for the executor's sticky conflict path. Every recovery dispatch here
  is an attempt on the card's persisted budget (RUFU-217's heartbeat loop ran forever because
  the decision-engine input `recoveryRetryCount` was never written). At attempt maxRetries+1 —
  the decision engine's own `retryCount >= maxRetries` boundary — the pass parks terminal with
  the existing `branch-conflict-recovery-exhausted` reason and an operator remedy instead of
  re-offering "retry"; the retained checkout stays inspectable (park is separated from lease
  release). Successful force-cleanup returns before this point and consumes no budget.
  */
  const recoveryPass = planBranchConflictRecoveryPass(task, settings.autoRecovery);
  if (recoveryPass.counted && recoveryPass.terminal) {
    await deps.store.updateTask(task.id, buildBranchConflictRecoveryParkPatch(recoveryPass, error.startPoint, conflictMessage));
    await emitBranchConflictRecoveryParkAudit({
      store: deps.store,
      agentId: "executor",
      runId: deps.getRunContextFor(task.id)?.runId ?? generateSyntheticRunId("executor-branch-conflict-park", task.id),
      task,
      pass: recoveryPass,
      source: "executor-conflict",
    });
    await deps.store.logEntry(task.id, `[recovery] branch-conflict recovery exhausted ${task.id}: parked terminal after ${recoveryPass.attempt} bounded passes (checkout retained)`, undefined, deps.getRunContextFor(task.id));
    return "sticky";
  }
  const autoRecoveryDispatcher = deps.getAutoRecoveryDispatcher(deps.createRunAuditor(deps.getRunContextFor(task.id)));
  const decision = await autoRecoveryDispatcher.dispatch({
    class: "branch-conflict-unrecoverable",
    taskId: task.id,
    runId: deps.getRunContextFor(task.id)?.runId,
    pausedReason: "branch-conflict-unrecoverable",
    evidence: {
      branchName: error.branchName,
      conflictingWorktreePath: error.conflictingWorktreePath,
      /*
      FNXC:BranchConflictRecovery 2026-09-13-02:10:
      RUFU-231 destructive-ambiguity evidence: `isDestructiveAmbiguity` reads
      `ownCommits`/`foreignAttributedCommits` — without them a mixed own+foreign branch is
      classified by mode (→ retry toward force-cleanup) instead of pausing. Safety read only;
      the dispatcher routing table stays byte-identical.
      */
      ...(await branchConflictDispatchEvidenceCounts({
        repoDir: deps.rootDir,
        taskId: task.id,
        branchRef: error.branchName,
        baseRef: conflictAttributionBase(task, error.startPoint),
      }) ?? {}),
    },
    underlyingError: error,
  }, {
    task,
    retryCount: recoveryPass.persisted,
    settings: settings.autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 },
  });

  if (decision.rationale === "destructive-ambiguity" || decision.rationale === "retry-budget-exhausted") {
    await deps.store.updateTask(task.id, buildBranchConflictRecoveryParkPatch(recoveryPass, error.startPoint, conflictMessage));
    await emitBranchConflictRecoveryParkAudit({
      store: deps.store,
      agentId: "executor",
      runId: deps.getRunContextFor(task.id)?.runId ?? generateSyntheticRunId("executor-branch-conflict-park", task.id),
      task,
      pass: recoveryPass,
      source: "executor-conflict",
    });
    await deps.store.logEntry(task.id, `[recovery] branch-conflict recovery exhausted ${task.id}: ${decision.rationale} — parked terminal (checkout retained)`, undefined, deps.getRunContextFor(task.id));
    return "sticky";
  }

  if (decision.action === "pause") {
    await deps.store.updateTask(task.id, {
      status: "failed",
      error: conflictMessage,
      branch: error.branchName,
      worktree: error.conflictingWorktreePath,
      /*
       * FNXC:BranchWriteOrigin 2026-08-20-14:40: FN-9161's store validation requires an explicit write origin on every branch write.
       * FNXC:BranchWriteOrigin 2026-08-28-10:12: the parked branch may be operator-supplied, so origin derives from the classifier
       * like the sibling re-pin above (#3523 Greptile P1).
       */
      branchWriteOrigin: classifyTaskBranchOrigin(task, error.branchName) === "operator-supplied" ? "operator" : "engine",
      paused: true,
      pausedReason: "branch-conflict-unrecoverable",
      ...branchConflictRecoveryCounterPatch(recoveryPass),
    });
    await deps.persistTokenUsage(task.id);
    executorLog.warn(`✗ ${task.id} branch conflict sticky failure: ${error.branchName} @ ${error.conflictingWorktreePath}`);
    deps.onError?.(task, error);
    return "sticky";
  }

  if (recoveryPass.counted) {
    await deps.store.updateTask(task.id, branchConflictRecoveryCounterPatch(recoveryPass));
  }

  return "retry";
}
