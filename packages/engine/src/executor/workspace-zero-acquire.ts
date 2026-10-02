import type { Task } from "@fusion/core";
import { getNoCommitEligibilityReason } from "./no-commit-eligibility.js";
import { evaluatePromptDerivedNoCommitEligibility } from "./prompt-derived-eligibility.js";

export type WorkspaceZeroAcquireClassification =
  | { kind: "not-applicable" }
  | { kind: "commit-free-eligible"; reason: string }
  | { kind: "unproven" };

export type WorkspaceZeroAcquireOptions = {
  workspaceMode: boolean;
  noOpCompletion?: boolean;
  noOpCompletionReason?: string;
  /**
   * FNXC:WorkspaceCommitFreeReview 2026-10-02-22:40 (RUFU-504):
   * Repositories the CALLER has just observed to sit on their merge-base with zero changed files.
   * Acquisition is a fact the classifier cannot re-derive (it has no git access), and an unobserved
   * tree must never read as an empty one, so the proof is supplied by the caller that ran the probe.
   * Absent this set, an acquired workspace stays `not-applicable` exactly as before.
   */
  netZeroAtBaseRepositories?: ReadonlySet<string>;
};

/**
 * FNXC:Workspace 2026-08-15-04:21:
 * Completion verification and per-repo review must classify the same empty
 * workspace map identically. Previously one accepted it vacuously while the
 * other returned UNAVAILABLE forever; centralizing the predicate prevents those
 * lifecycle ends from drifting apart again.
 */
export function classifyWorkspaceZeroAcquire(
  task: Task,
  options: WorkspaceZeroAcquireOptions,
): WorkspaceZeroAcquireClassification {
  if (!options.workspaceMode) {
    return { kind: "not-applicable" };
  }
  if (Object.keys(task.workspaceWorktrees ?? {}).length > 0) {
    return classifyAcquiredWorkspaceCommitFree(task, options);
  }

  const explicitReason = getNoCommitEligibilityReason(task);
  if (explicitReason) return { kind: "commit-free-eligible", reason: explicitReason };

  if (options.noOpCompletion) {
    return {
      kind: "commit-free-eligible",
      reason: options.noOpCompletionReason ?? "verified no-op/duplicate completion sentinel",
    };
  }

  const prompt = typeof (task as Task & { prompt?: unknown }).prompt === "string"
    ? (task as Task & { prompt: string }).prompt
    : "";
  const promptEligibility = evaluatePromptDerivedNoCommitEligibility(task, prompt);
  if (promptEligibility.eligible) {
    return {
      kind: "commit-free-eligible",
      reason: promptEligibility.reason ?? "prompt-derived no-commit eligibility",
    };
  }

  return { kind: "unproven" };
}

/**
 * FNXC:WorkspaceCommitFreeReview 2026-10-02-22:40 (RUFU-504):
 * The original classifier only spoke about a workspace that acquired NOTHING. That asymmetry is what froze
 * the saneca review lane: a task that acquired every member repository and legitimately changed nothing has
 * no diff to review, so `reviewWorkspacePerRepo` recorded `NOT_REVIEWED`, the step landed `status: failed`
 * with no verdict, the merge door refused it as a failed pre-merge gate, and the stall classifier parked the
 * card as `in-review-stall-deadlock` - a delivered zero-diff card, retried forever, with no operator
 * sentence that names why. Measured 2026-10-02: 24 saneca cards carry a failed Code Review row and 16 of them
 * are parked.
 *
 * This arm reaches the same conclusion the empty-worktree path already reaches, from the same authority
 * (`getNoCommitEligibilityReason`), but only on three conjunctive conditions:
 *
 * 1. confirmed scope with a well-formed, non-empty repository list - a proposed default or a malformed
 *    duplicate declaration is not delivery authority, matching `resolveWorkspaceMergeReadiness`;
 * 2. EVERY declared repository has an acquired entry - one member missing is a partial acquisition, not a
 *    commit-free delivery, and must keep its existing refusal;
 * 3. EVERY declared repository is in the caller's observed net-zero-at-base set - the content claim, from a
 *    probe, never from the absence of one.
 *
 * `noOpCompletion` is deliberately NOT consulted here. A duplicate-completion sentinel says the card was
 * already finished elsewhere; it says nothing about what these worktrees contain, so it must not become the
 * evidence that an acquired tree was empty.
 *
 * Returning `not-applicable` rather than `unproven` for every rejection is load-bearing:
 * `verifyWorkspaceInvariants` turns `unproven` into a hard `no_commits` completion refusal, and this arm must
 * not silence the richer prompt-derived evaluation that follows it. Only a proven claim short-circuits.
 */
function classifyAcquiredWorkspaceCommitFree(
  task: Task,
  options: WorkspaceZeroAcquireOptions,
): WorkspaceZeroAcquireClassification {
  const scope = task.repositoryScope;
  if (scope?.state !== "confirmed" || scope.repositories.length === 0) {
    return { kind: "not-applicable" };
  }
  const declared = scope.repositories.map((repository) => repository.trim());
  if (declared.some((repository) => !repository) || new Set(declared).size !== declared.length) {
    return { kind: "not-applicable" };
  }

  const reason = getNoCommitEligibilityReason(task);
  if (!reason) return { kind: "not-applicable" };

  const entries = task.workspaceWorktrees ?? {};
  const proven = options.netZeroAtBaseRepositories;
  const isProven = (repository: string) => Boolean(proven?.has(repository));
  if (!declared.every((repository) => entries[repository] !== undefined && isProven(repository))) {
    return { kind: "not-applicable" };
  }

  return {
    kind: "commit-free-eligible",
    reason: `${reason}; every declared repository acquired and observed at its merge-base with zero changed files`,
  };
}
