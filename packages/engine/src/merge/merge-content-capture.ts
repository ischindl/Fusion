import type { MergeContentDescriptor, Task } from "@fusion/core";
import { describeMergeContentShape } from "@fusion/core";
import { resolveDiffBaseRef } from "../executor/worktree-git-refs.js";
import { probeSingularReviewDiffFingerprint } from "../worktree/review-diff-fingerprint.js";
import {
  captureWorkspaceReviewEvidence,
  WorkspaceMemberEvidenceError,
} from "../worktree/workspace-review-evidence.js";

export type MergeContentCaptureDeps = {
  workspaceRootDir: string;
  settings: Record<string, unknown>;
};

/**
 * Controls which ref the SINGULAR leg measures. Workspace members are unaffected either way — they
 * already measure `entry.branch` in `captureWorkspaceReviewEvidence`.
 *
 * - `undefined` (no options passed): derive `task.branch`. Every door that asks "does this match what
 *   the reviewer approved?" must measure the same ref the dispatch lane measured, or a drifted checkout
 *   makes one honest side look stale and the card reroutes forever.
 * - a string: measure that branch.
 * - `null`: stay on `HEAD`. The explicit opt-out for a caller that deliberately captures a different
 *   tree than the card's branch; naming it here keeps the exception reviewable instead of a silent
 *   caller that simply forgot the branch.
 */
export type MergeContentCaptureOptions = {
  branchRef?: string | null;
};

/*
FNXC:MergeContentDescriptor 2026-08-23-07:14:
FN-180 requires every merge-start door to use content proof in the task's own
shape. This asynchronous capture stays outside synchronous queue ticks: Git
failure becomes an unavailable descriptor and the positive approval gate defers.
*/
export async function captureMergeContentDescriptor(
  task: Task,
  deps: MergeContentCaptureDeps,
  options?: MergeContentCaptureOptions,
): Promise<MergeContentDescriptor> {
  if (describeMergeContentShape(task) === "workspace") {
    try {
      const evidence = await captureWorkspaceReviewEvidence({
        task,
        workspaceRootDir: deps.workspaceRootDir,
        settings: deps.settings,
      });
      return {
        kind: "workspace",
        repositories: {
          state: "captured",
          fingerprints: Object.fromEntries(evidence.repositories
            .filter((repository) => repository.fingerprint)
            .map((repository) => [repository.repository, repository.fingerprint!])),
          inScopeModified: [...evidence.modifiedRepositories].sort(),
        },
      };
    } catch (error) {
      /*
      FNXC:WorkspaceReviewEvidence 2026-10-03-00:57 (RUFU-519): the reason is the only thing that survives
      into `getTaskMergeBlocker` and the sweep's `gatesSatisfied`, so a swallowed git error made a card
      that could never be merge look like a card that was merely not ready yet. Keep the generic bucket
      for unknown failures, name the known one.
      */
      return {
        kind: "workspace",
        repositories: {
          state: "unavailable",
          reason: error instanceof WorkspaceMemberEvidenceError
            ? error.classification
            : "workspace-evidence-capture-failed",
        },
      };
    }
  }

  const baseRef = task.worktree
    ? await resolveDiffBaseRef(task.worktree, task.baseCommitSha)
    : undefined;
  /*
  FNXC:ReviewInputProof 2026-11-10-23:31 (RUFU-521):
  The singular door measured `base..HEAD`, the mutable checkout tip, while the fingerprint it compares
  against came from the review. One reclaimed checkout parked off the branch made the two disagree: the
  card with commits read as the `empty-review-input:v1` sentinel and either auto-passed on a matching
  no-commit claim or raised a false `stale_content` REVISE (RUFU-290). The door now asks the same
  question the review answered — what does this card's own branch deliver — and an unresolvable branch
  names itself as `branch-ref-unresolvable` instead of ever resolving to `empty`. Workspace members
  already measured `entry.branch` here and at `merger-ai.ts`'s per-repository leg; this closes the
  singular half of that same rule.
  */
  const branchRef = options?.branchRef === undefined ? task.branch : options.branchRef;
  const probe = await probeSingularReviewDiffFingerprint({
    worktreePath: task.worktree,
    recordedBaseCommitSha: baseRef,
    branchRef: branchRef ?? undefined,
  });
  return { kind: "singular", diff: probe };
}
