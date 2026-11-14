/*
FNXC:ExecutionReArmCeiling 2026-11-14-16:20 (RUFU-1028):
`mergeDetails` TRUTHINESS is not "a merge happened".

Three engine paths asked `Boolean(task.mergeDetails)` and got "yes" from a row that had never merged
anything, because `MergeDetails` also carries recovery bookkeeping (`pushRecovery`,
`mergeBoundaryRecovery`, the pre-RUFU-1027 `executionRearm` ladder). The measured cost of that ambiguity is
the RUFU-583 loop: the in-progress preflight saw a truthy `mergeDetails`, declared a stale merge state, and
ran `cleanupMergeStateForReverification`, which writes `status: null, error: null` — clearing the only
row-level announcement the bounded re-arm park had, which is how a card that had already exhausted its
budget restarted its ladder at `attempt 1/4` and burned 44 grants in under two hours.

So the question each consumer asks gets a named predicate over a CLOSED key classification:
- `recovery-bookkeeping` keys record that recovery was attempted. They prove nothing about a landing and
  must never trigger a merge reset, a merge-state bounce, or a denial of the completed-work hand-off.
- `merge-evidence` keys record a landing or a merge decision. They are what the truthiness check was
  reaching for.

Value rule, applied uniformly to every evidence key: the value must actually SAY something — a non-empty
string, a positive number, `true`, or a non-empty array/object. A recovery path legitimately writes
`filesChanged: 0` or `landedFiles: []` while nothing landed, and letting such a value decide "a merge
happened" would put the reset trigger back into the hands of the writer that must not own it. Conversely an
unclassified key counts as evidence (preserving today's truthiness for a field this file has not been taught
yet), and the census test in `src/__tests__/merge-details-evidence.test.ts` fails when a declared key is
added without a bucket, so "unknown" cannot quietly become the permanent state of a new field.

Deliberately NOT a wholesale-preservation rule: `cleanupMergeStateForReverification` still nulls the whole
column, and the RUFU-469 stale-generation guarantee in `tasks/overlap-wait-release.ts` depends on that.
*/
import type { MergeDetails } from "../types/task/task-core.js";

export type MergeDetailClassification = "merge-evidence" | "recovery-bookkeeping";

/**
 * Keys that record an attempted recovery, never a landing. `executionRearm` is the pre-RUFU-1027 host of the
 * re-arm ladder: still declared, still READ by `readExecutionRarmMarker` as a legacy fallback, never written
 * again — and its presence is the exact case that must not read as merge evidence.
 */
export const MERGE_DETAIL_RECOVERY_BOOKKEEPING_KEYS: readonly string[] = [
  "pushRecovery",
  "mergeBoundaryRecovery",
  "executionRearm",
];

/** Every other declared key. Kept as data so the census test can prove the two buckets cover the type. */
export const MERGE_DETAIL_EVIDENCE_KEYS: readonly string[] = [
  "commitSha",
  "landedBranchTipSha",
  "rebaseBaseSha",
  "landedFiles",
  "filesChanged",
  "insertions",
  "deletions",
  "noOpVerifiedShortCircuit",
  "landedFilesAttributionRestricted",
  "landedFilesCaptureFallback",
  "uncommittedWorkHold",
  "mergeCommitMessage",
  "mergedAt",
  "mergeConfirmed",
  "noOpMerge",
  "noOpReason",
  "prNumber",
  "mergeTargetBranch",
  "mergeTargetSource",
  "resolutionStrategy",
  "resolutionMethod",
  "attemptsMade",
  "autoResolvedCount",
  "integrityWarning",
  "transientRecoveryCount",
  "workspaceLandedShas",
  "workspaceLandedFiles",
  "workspaceCommitFreeBasis",
  "workspaceCommitFreeBranchTipShas",
];

export function classifyMergeDetailKey(key: string): MergeDetailClassification {
  if (MERGE_DETAIL_RECOVERY_BOOKKEEPING_KEYS.includes(key)) return "recovery-bookkeeping";
  return "merge-evidence";
}

/** Does this value record something, as opposed to a placeholder a recovery path left behind? */
function recordsSomething(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "boolean") return value === true;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value as object).length > 0;
  return false;
}

/**
 * True only when the row carries a key that records a landing or a merge decision. `{}`, `undefined`, `null`,
 * and a bookkeeping-only row are all false; an empty or zero value under an evidence key is also false.
 */
export function mergeDetailsCarriesMergeEvidence(
  details: MergeDetails | null | undefined,
): boolean {
  if (!details || typeof details !== "object") return false;
  for (const [key, value] of Object.entries(details)) {
    if (classifyMergeDetailKey(key) !== "merge-evidence") continue;
    if (recordsSomething(value)) return true;
  }
  return false;
}

/**
 * FNXC:ExecutionReArmCeiling 2026-11-14-16:20 (RUFU-1028):
 * A copy holding ONLY the recovery bookkeeping, for the writer that must clear merge evidence while leaving a
 * recovery episode's host intact. Named keys are enumerated rather than filtered generically, so a new
 * bookkeeping key cannot be silently carried by a cast — it has to be named here, in the same place it is
 * classified, or it is not kept.
 */
export function pickMergeDetailRecoveryOnlyKeys(
  mergeDetails: MergeDetails | undefined | null,
): MergeDetails {
  const out: Record<string, unknown> = {};
  if (!mergeDetails || typeof mergeDetails !== "object") return out as MergeDetails;
  if (mergeDetails.pushRecovery !== undefined) out.pushRecovery = mergeDetails.pushRecovery;
  if (mergeDetails.mergeBoundaryRecovery !== undefined) out.mergeBoundaryRecovery = mergeDetails.mergeBoundaryRecovery;
  if (mergeDetails.executionRearm !== undefined) out.executionRearm = mergeDetails.executionRearm;
  return out as MergeDetails;
}
