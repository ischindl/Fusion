/*
FNXC:BranchConflictRecovery 2026-09-13-01:15:
RUFU-231 terminates the zero-own-commit / foreign-tainted branch-conflict recovery loop.

The RUFU-217 wedge proved the failure mode: a review-lane card whose branch owns zero
commits and whose tip belongs to a foreign lineage is re-admitted by every maintenance
pass, because every refusal path parked or held the card WITHOUT persisting any counter —
so the dispatcher budget (`retryCount: task.recoveryRetryCount ?? 0` in the immutable
class-decision engine) could never reach exhaustion and the card was re-tried forever,
head-of-line blocking peers behind its retained checkout.

This module is the single accounting authority every branch-conflict refusal site shares:

- `planBranchConflictRecoveryPass` derives the bounded budget from the PERSISTED
  `Task.recoveryRetryCount` (the dispatcher decision-engine input) — attempt N+1, terminal
  when `attempt > autoRecovery.maxRetries`. An explicit `mode: "off"` disables accounting
  entirely (operator opt-out; refusals stay pure log/hold without counter writes).
- `buildBranchConflictRecoveryParkPatch` is the terminal park: `failed` + `paused` with the
  EXISTING `branch-conflict-recovery-exhausted` reason (no new pause-reason enum member)
  and an error that names the concrete remedy (resolve against the integration branch,
  retry, or reset to todo). The patch NEVER touches `worktree`/`branch` — the terminal park
  is separated from lease release so the operator can still inspect the retained checkout
  (and the dormant file-scope lease semantics order, not hard-serialize, peers meanwhile).
  The sweep's candidate filter admits `pausedReason === "branch-conflict-unrecoverable"`
  only, so the exhausted park is not re-admitted; a manual retry resets the budget through
  MANUAL_RETRY_RESET_COUNTER_KEYS.
- `emitBranchConflictRecoveryParkAudit` records the park through the bounded audit seam so
  telemetry can never become a lifecycle dependency.
*/
import type { AutoRecoverySettings, Task, TaskStore } from "@fusion/core";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { reportBranchAttribution } from "../execution/branch-conflicts.js";

/*
FNXC:BranchConflictRecovery 2026-09-13-02:05:
RUFU-231 Mission defect 2 (evidence half): `AutoRecoveryDispatcher.isDestructiveAmbiguity` reads
`evidence.ownCommits` / `evidence.foreignAttributedCommits`, and every branch-conflict dispatch
site omitted them — so a genuinely mixed own+foreign branch was classified by mode (→ retry,
toward a destructive path) instead of taking the intended destructive-ambiguity pause. These
helpers produce the counts from the SAME attribution parser the executor post-session audit uses
(`reportBranchAttribution`), on one `base..branch` git call. This is a safety read, NOT a routing
mechanism: the dispatcher routing table is unchanged.
*/

/** Best recorded identity for attributing branch commits; falls back to the caller-provided integration ref. */
export function conflictAttributionBase(
  task: Pick<Task, "baseCommitSha" | "baseBranch" | "executionStartBranch">,
  integrationBranch: string | null | undefined,
): string | null {
  return task.baseCommitSha ?? task.baseBranch ?? task.executionStartBranch ?? integrationBranch ?? null;
}

export interface BranchConflictDispatchEvidence {
  ownCommits: number;
  foreignAttributedCommits: number;
}

/**
 * Compute the dispatcher's destructive-ambiguity evidence counts for one refusal site.
 * Best-effort by design: an unreadable branch/base, or a set with NO trailer-attributed commit
 * at all, yields NO evidence keys — the refusal keeps today's byte-identical evidence shape and
 * the dispatcher decision is unchanged (ambiguity needs own AND foreign attributed commits).
 * Only observed attribution is attached; a failed git call never throws on a refusal path.
 */
export async function branchConflictDispatchEvidenceCounts(input: {
  repoDir: string;
  taskId: string;
  branchRef: string | null | undefined;
  baseRef: string | null | undefined;
}): Promise<BranchConflictDispatchEvidence | null> {
  if (!input.branchRef || !input.baseRef) return null;
  const report = await reportBranchAttribution(input.repoDir, input.branchRef, input.baseRef, input.taskId).catch(() => null);
  if (!report) return null;
  const ownCommits = report.ownTrailed + report.ownUntrailed.length;
  const foreignAttributedCommits = report.foreign.length;
  if (ownCommits === 0 && foreignAttributedCommits === 0) return null;
  return { ownCommits, foreignAttributedCommits };
}

/** Fixed provenance enum for park audit rows — never free text. */
export type BranchConflictRecoverySource =
  | "self-owned-reclaim"
  | "pr-reclaim"
  | "executor-conflict"
  | "dirty-checkout-hold"
  | "foreign-tip-reject";

export interface BranchConflictRecoveryPass {
  /** Counter value persisted on the task BEFORE this pass. */
  persisted: number;
  /** persisted + 1 — the value this pass persists (or the park carries). */
  attempt: number;
  maxRetries: number;
  /** True when `attempt > maxRetries`: this pass must park terminal instead of re-offering the transient pause. */
  terminal: boolean;
  /** False when auto-recovery `mode: "off"` — no counter writes, no terminal park. */
  counted: boolean;
}

/**
 * Derive this pass's bounded recovery budget. `maxRetries` mirrors the dispatcher call
 * sites' fallback (`autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 }`).
 */
export function planBranchConflictRecoveryPass(
  task: Pick<Task, "recoveryRetryCount">,
  autoRecovery: AutoRecoverySettings | undefined,
): BranchConflictRecoveryPass {
  const maxRetries = autoRecovery?.maxRetries ?? 3;
  const counted = autoRecovery?.mode !== "off";
  const persisted = task.recoveryRetryCount ?? 0;
  const attempt = counted ? persisted + 1 : persisted;
  return { persisted, attempt, maxRetries, terminal: counted && attempt > maxRetries, counted };
}

/** Patch merged into a non-terminal transient pause/persist so the budget advances in the same write. */
export function branchConflictRecoveryCounterPatch(pass: BranchConflictRecoveryPass): Pick<Task, "recoveryRetryCount"> | Record<string, never> {
  return pass.counted ? { recoveryRetryCount: pass.attempt } : {};
}

/**
 * Operator-facing remedy. Contract (pinned by the RUFU-231 regression suite): names the
 * integration branch and at least one recovery door (retry / reset to todo) so the park is
 * actionable, not just terminal.
 */
export function branchConflictRecoveryRemedy(pass: BranchConflictRecoveryPass, integrationBranch: string | undefined, detail: string): string {
  const ref = integrationBranch?.trim() || "main";
  return (
    `Branch-conflict recovery exhausted after ${pass.attempt} bounded passes (budget ${pass.maxRetries}): ${detail} ` +
    `Inspect this card's branch against the integration branch (${ref}), then retry the task or reset it to todo; ` +
    `automatic reclaim passes stay suppressed until a manual retry resets the recovery budget.`
  );
}

/**
 * Terminal park patch. Deliberately omits `worktree`/`branch`/`baseCommitSha`: terminating
 * the loop never mutates the checkout the operator must still inspect.
 */
export function buildBranchConflictRecoveryParkPatch(
  pass: BranchConflictRecoveryPass,
  integrationBranch: string | undefined,
  detail: string,
): Partial<Task> {
  return {
    status: "failed",
    paused: true,
    pausedReason: "branch-conflict-recovery-exhausted",
    recoveryRetryCount: pass.attempt,
    error: branchConflictRecoveryRemedy(pass, integrationBranch, detail),
  };
}

export async function emitBranchConflictRecoveryParkAudit(input: {
  store: TaskStore;
  agentId: string;
  runId: string;
  task: Pick<Task, "id" | "lineageId">;
  pass: BranchConflictRecoveryPass;
  source: BranchConflictRecoverySource;
}): Promise<void> {
  await emitBoundedRunAudit(input.store, {
    agentId: input.agentId,
    runId: input.runId,
    taskId: input.task.id,
    domain: "database",
    mutationType: "task:branch-conflict-recovery-parked",
    target: input.task.id,
    metadata: {
      taskId: input.task.id,
      attempt: input.pass.attempt,
      maxRetries: input.pass.maxRetries,
      source: input.source,
      terminal: true,
    },
  });
}
