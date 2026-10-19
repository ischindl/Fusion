/**
 * FNXC:CodeOrganization 2026-08-03-13:35:
 * Pure branch-conflict log formatters peeled from TaskExecutor (U4).
 */
import type { BranchConflictError } from "../execution/branch-conflicts.js";
import { liveCheckoutPathFor } from "../execution/branch-conflicts.js";

/*
FNXC:BranchPhantomEcho 2026-10-19-15:43 (RUFU-376):
Both formatters resolve the reported path through `liveCheckoutPathFor`, the same read the refusal
sentence in `BranchConflictError` uses, so the two can never disagree about whether a checkout exists.
A `foreign-unmerged` conflict has no live checkout, so neither line states a path at all — appending a
qualifier beside the caller's desired path was rejected deliberately: these two strings are read by a
human skimming a log and by the recovery tooling that keys off them, and a path sitting in the
worktree position of either is a checkout claim no matter what words stand next to it.
A caller that needs the requested path reads it from the error itself (`desiredPathFor`); rendering it
here is exactly what this change removes, so nothing in this module imports it.
*/
export function formatBranchConflictLifecycleLog(_taskId: string, error: BranchConflictError): string {
  const livePath = liveCheckoutPathFor(error);
  const strandedSummary = error.strandedCommits.length > 0
    ? error.strandedCommits.map((commit) => `${commit.sha.slice(0, 12)} ${commit.subject}`).join("; ")
    : "none";
  const recommendation = "Resolve the local branch/worktree conflict with git tooling (inspect/reclaim or discard) before retrying.";
  return [
    livePath.length > 0
      ? `Branch conflict: ${error.branchName} is already checked out at ${livePath}`
      : `Branch conflict: ${error.branchName} is refused — it is not checked out in any live worktree`,
    `Existing tip: ${error.existingTipSha}`,
    `Stranded commits since ${error.startPoint}: ${strandedSummary}`,
    recommendation,
  ].join("\n");
}

export function formatBranchConflictAgentLog(_taskId: string, error: BranchConflictError): string {
  const livePath = liveCheckoutPathFor(error);
  const lines = [
    `branch=${error.branchName}`,
    // `none` matches this formatter's own `stranded=none` vocabulary: no checkout, no path.
    `worktree=${livePath.length > 0 ? livePath : "none"}`,
    `existingTipSha=${error.existingTipSha}`,
    `startPoint=${error.startPoint}`,
  ];
  if (error.strandedCommits.length > 0) {
    lines.push(
      ...error.strandedCommits.map((commit) => `stranded=${commit.sha.slice(0, 12)} ${commit.subject}`),
    );
  } else {
    lines.push("stranded=none");
  }
  lines.push(
    `recommendation=Resolve the local branch/worktree conflict with git tooling (inspect/reclaim or discard) before retrying.`,
  );
  return lines.join("\n");
}
