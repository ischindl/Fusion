/*
FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-20:20 (RUFU-451):
The tri-state branch-presence read, extracted to a leaf so BOTH lanes that must ask "does this branch
exist in this repository" ask it the same way.

Why a leaf module instead of importing `SelfHealingManager.probeRepoBranch`: the self-healing git substrate
already imports `./merge/already-merged-detector.js`, so a `merge/` → substrate import would hand the merge
lane a new edge into the recovery substrate (the same reason `empty-land-evidence.ts` parses shortstat
locally). The classification is pure and cycle-free, so the correct move is to move the DECISION down into
a leaf both sides import, leaving `probeRepoBranch` as the substrate-side wrapper over its own injectable
`execBranchProbe` seam. Existing importers of `classifyBranchProbeError` keep resolving through
`self-healing-git-evidence.js`, which re-exports this module's function rather than copying it.

The read is `show-ref --verify --quiet`, deliberately not `rev-parse --verify`: `rev-parse` returns 128 for
BOTH "no such ref" and "not a repository", and a lane that cannot read a repository must never be handed
absence as if it were a fact. `unknown` is the answer that keeps every refusal standing.
*/
import { promisify } from "node:util";
import { exec } from "node:child_process";
import { createLogger } from "../logger.js";

const log = createLogger("branch-presence-probe");
const execAsync = promisify(exec);

/** The one `show-ref` invocation that answers branch-presence questions. No second copy may exist. */
export async function execBranchProbeCommand(repoRootDir: string, branch: string): Promise<void> {
  await execAsync(`git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`, {
    cwd: repoRootDir,
    timeout: 30_000,
  });
}

/**
 * Maps a failed `show-ref` to evidence: a clean exit-1 (no signal, not killed) is ABSENCE PROOF; anything
 * else — 128, a timeout, a spawn failure — is UNKNOWN and may never be read as absence.
 */
export function classifyBranchProbeError(error: unknown): "absent" | "unknown" {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 1 &&
    !(error as { killed?: unknown }).killed &&
    ((error as { signal?: unknown }).signal === null || (error as { signal?: unknown }).signal === undefined)
  ) {
    return "absent";
  }
  return "unknown";
}

/**
 * The three answers every consuming rule is written against: `present` (a ref exists), `absent` (git
 * answered "no such ref"), `unknown` (git could not be asked). `exec` stays injectable because the
 * self-healing subclass seam overrides the COMMAND, not the classification.
 */
export async function probeBranchPresence(
  repoRootDir: string,
  branch: string,
  exec: (repoRootDir: string, branch: string) => Promise<void> = execBranchProbeCommand,
): Promise<"present" | "absent" | "unknown"> {
  try {
    await exec(repoRootDir, branch);
    return "present";
  } catch (error) {
    const outcome = classifyBranchProbeError(error);
    if (outcome === "unknown") {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.warn(`[self-healing] branch evidence unavailable for ${repoRootDir} (${branch}): ${errorMessage}`);
    }
    return outcome;
  }
}

/*
FNXC:PlanningLaneWorktreeIdentity 2026-11-18-18:20 (RUFU-893):
CONTAINMENT IS THE SECOND QUESTION A POINTER-CLEARING DECISION HAS TO ASK, and it lives beside the
presence probe so the two tri-state git verdicts about a branch are read and classified in one place.

WHY A NEW READ AND NOT AN EXISTING ONE. `SelfHealingGitEvidence.isCommitReachableFromBranch` and
`execution/branch-conflicts.ts`'s `isAncestor` both `catch { return false }`. That is sound for a caller
asking "is it safe to assume this landed" and fatal for a caller asking "may I drop the pointer", because
the boolean's failure answer is the answer that destroys a branch. `worktree-git-refs.ts` reaches for
`merge-base --is-ancestor` through `execSync`, which is allowlisted for short plumbing only and is not a
lane this sweep may add a call to.

MEASURED EXIT-CODE SHAPE (2026-11-18, this repository): `git rev-list --count <integration>..<ref>` answers
0 with `0` = contained, 0 with `N>0` = divergent, and 128 — never 1 — for a bad ref on EITHER side, so a
repository that cannot answer is structurally unable to produce a `contained` verdict. `--count` is used
rather than `merge-base --is-ancestor` because the two agree exactly (a zero count means every commit
reachable from the branch tip is reachable from the integration branch) and this one also returns the
outstanding-commit count, which is the figure an operator acts on when a refusal names possible lost work.
*/

/** A containment answer. `uniqueCommitCount` is carried only by a verdict that measured one. */
export type BranchContainmentVerdict =
  | { verdict: "contained"; uniqueCommitCount: number }
  | { verdict: "divergent"; uniqueCommitCount: number }
  | { verdict: "unknown"; uniqueCommitCount?: undefined };

/**
 * Is the branch's work already inside the integration branch? A `null` integration branch is not a
 * question that can be asked, so it answers `unknown` rather than `contained`.
 *
 * MEASURED EDGE CASES (characterized in `worktree/__tests__/branch-presence-probe.test.ts`). A bad ref on
 * EITHER side of the range fails with one identical exit-128 `ambiguous argument` message, so this read
 * cannot name which side failed and answers `unknown` for an absent branch rather than claiming
 * absence — absence is what `probeBranchPresence` proves with `show-ref --verify`, which is why the
 * consuming sweep proves presence first and asks this question only about a ref it has already seen.
 * The `refs/heads/` qualification keeps a tag or a detached `HEAD` out; the one degenerate value it lets
 * through is the trunk itself, where the range is empty and the verdict is a vacuous `contained`. That is
 * harmless, because a pointer naming the trunk carries no work the trunk lacks, and it can never fabricate
 * a `divergent` claim of lost work.
 */
export async function probeBranchContainment(
  repoRootDir: string,
  branch: string,
  integrationBranch: string | null,
  exec: (repoRootDir: string, revisionRange: string) => Promise<string> = execBranchCountProbeCommand,
): Promise<BranchContainmentVerdict> {
  if (!integrationBranch) return { verdict: "unknown" };
  const revisionRange = `${integrationBranch}..refs/heads/${branch}`;
  let raw: string;
  try {
    raw = await exec(repoRootDir, revisionRange);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[branch-presence-probe] containment unavailable for ${branch}: ${message}`);
    return { verdict: "unknown" };
  }
  const count = Number(raw.trim());
  if (!Number.isInteger(count) || count < 0) {
    log.warn(`[branch-presence-probe] containment answer unusable for ${branch}: ${JSON.stringify(raw.trim())}`);
    return { verdict: "unknown" };
  }
  return { verdict: count === 0 ? "contained" : "divergent", uniqueCommitCount: count };
}

/** The one `rev-list --count` invocation the containment verdict is read from. No second copy may exist. */
export async function execBranchCountProbeCommand(repoRootDir: string, revisionRange: string): Promise<string> {
  const { stdout } = await execAsync(`git rev-list --count ${shellQuote(revisionRange)}`, {
    cwd: repoRootDir,
    timeout: 30_000,
  });
  return stdout;
}

/** POSIX single-quote escaping, kept local so this module imports nothing from the recovery substrate. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
