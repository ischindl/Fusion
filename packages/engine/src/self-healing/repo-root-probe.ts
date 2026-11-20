/**
 * Shared "is this project root actually a Git repository?" probe for the self-healing
 * sweeps that use `rootDir` as the git working directory.
 *
 * FNXC:SelfHealingRepoRoot 2026-11-20-06:37 (RUFU-804):
 * Two sweeps (`reclaimStaleActiveBranches`, `pruneWorktrees`) built git commands with
 * `cwd: this.options.rootDir` and never proved that path is a repository. On a runtime whose
 * registered project root is a NON-git workspace root (a folder holding several member repos),
 * every pass threw and was swallowed by a broad catch. Measured on the production daemon
 * (era pid 4051354, :4040, boot 2026-10-28 09:31:39Z, 473,765 lines read at 11:04Z): the reclaim
 * failure sentence appeared 7 times = exactly one per sweep invocation, while the sweep's success
 * line appeared 0 times; `Worktree prune failed` appeared 2 times. Reproduced with a control —
 * `git branch --list 'fusion/*'` and `git worktree prune` both fail with
 * "fatal: not a git repository (or any parent up to mount point /)" at the workspace root and
 * succeed in its member directory.
 *
 * The invariant this module encodes: a self-healing pass may not spawn git against a project root
 * it has not proven to be a repository. The sibling merge-metadata reconciler already carried that
 * lesson (`FNXC:Workspace 2026-06-22-14:10`, "This reconciler assumes ONE git repo at
 * `this.options.rootDir` … for a workspace task that root is NON-git") but only as a
 * workspace-task skip; the precondition was never propagated to the sweeps named above.
 *
 * This is deliberately the ONE probe for the family: it reuses the existing detection seam
 * ({@link detectGitRepository}) rather than inventing a parallel one, so the error classification
 * stays single-sourced.
 */
import { statSync } from "node:fs";
import { formatGitRepositoryDetectionError } from "../executor/session-worktree-paths.js";
import { detectGitRepository, type GitRepoDetection } from "../worktree/worktree-pool.js";

/**
 * Why a self-healing pass may not run git at the project root.
 *
 * `missing-root` is the only locally-derived member: the shared detection union has no arm for
 * "the directory does not exist", because detection asks git, and git is never asked here.
 */
export type RepoRootRefusalReason =
  | "missing-root"
  | "not-repo"
  | "dubious-ownership"
  | "git-missing"
  | "timeout"
  | "unknown";

export type RepoRootProbeResult =
  | { status: "repo" }
  | {
      status: "refused";
      reason: RepoRootRefusalReason;
      /** Whether the root path itself exists — `missing` only ever pairs with `missing-root`. */
      rootState: "present" | "missing";
      /** Operator-facing daemon sentence. May name the path; must never reach run-audit. */
      operatorMessage: string;
    };

/** The injectable detection dependency — the narrow seam that lets a test drive every verdict arm. */
export type RepoRootDetector = (dir: string) => Promise<GitRepoDetection>;

/*
FNXC:SelfHealingRepoRoot 2026-11-20-06:37 (RUFU-804):
The shared detection-error formatter is typed to the `error` arm only, so the `not-repo` arm cannot
be routed through it without a force-cast. This is its sibling sentence: same opening, same
copy-paste-safety rule (the path appears only in the descriptive clause, never inside a remedy
command), and it states the consequence a sweep needs — the pass was skipped, not that git is broken.
*/
function formatRepoRootNotRepositoryError(rootDir: string, stderr: string): string {
  const detail = stderr.trim() || "git rev-parse --git-dir reported this path is not a Git repository";
  return `Git repository detection refused for project directory "${rootDir}": git reports it is not a Git repository (${detail}). Fusion skipped this self-healing pass rather than running git against a directory it could not prove is a repository.`;
}

/*
FNXC:SelfHealingRepoRoot 2026-11-20-06:37 (RUFU-804):
Existence is checked BEFORE detection, and that order is the point. The shared classifier maps a
missing working directory to `ENOENT` -> `git-missing`, which would tell the operator "the git
binary is missing" when in fact the registered project directory is gone — a false claim about the
host's toolchain that sends them to install git instead of to fix the registration. Checking first
keeps the two verdicts distinguishable, and it also means no git child is spawned for a path that
cannot exist.

The claim is kept as narrow as the evidence: only a PROVEN `ENOENT` says `missing-root`. An
unstatable path for any other reason (permissions, an exotic filesystem error) is not proven absent,
so it falls through to the git-derived verdict instead of being reported as a missing directory.
*/
function proveRootAbsent(rootDir: string): boolean {
  try {
    statSync(rootDir);
    return false;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  }
}

function formatRepoRootMissingError(rootDir: string): string {
  return `Git repository detection refused for project directory "${rootDir}": the directory does not exist, so Fusion could not verify it is a Git repository and skipped this self-healing pass.`;
}

/**
 * Prove the project root is a Git repository, or name why a pass may not run git there.
 *
 * The caller gets a verdict, never a throw: the calling sweep's broad `catch` used to be the only
 * handler, and a swallowed subprocess error is what made the outage invisible.
 *
 * @param rootDir the project root a sweep would use as the git working directory.
 * @param detect detection seam; defaults to production {@link detectGitRepository}. Injectable
 *   because the classifier inside that seam is module-private and its `error` arms
 *   (`dubious-ownership`, `timeout`, `unknown`) are not reachable from a temp directory. The
 *   classifier itself is NOT duplicated here — reusing `detectGitRepository` is reusing it.
 */
export async function probeRepoRootIsGitRepository(
  rootDir: string,
  detect: RepoRootDetector = detectGitRepository,
): Promise<RepoRootProbeResult> {
  if (proveRootAbsent(rootDir)) {
    return {
      status: "refused",
      reason: "missing-root",
      rootState: "missing",
      operatorMessage: formatRepoRootMissingError(rootDir),
    };
  }

  const detection = await detect(rootDir);
  if (detection.status === "repo") return { status: "repo" };
  if (detection.status === "not-repo") {
    return {
      status: "refused",
      reason: "not-repo",
      rootState: "present",
      operatorMessage: formatRepoRootNotRepositoryError(rootDir, detection.stderr),
    };
  }

  return {
    status: "refused",
    reason: detection.reason,
    rootState: "present",
    operatorMessage: formatGitRepositoryDetectionError(rootDir, detection),
  };
}
