import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import type { Settings, Task } from "@fusion/core";
import { resolveWorkspaceRepoBaseBranch } from "./workspace-base-branch.js";
import {
  computeReviewDiffFingerprint,
  REVIEW_DIFF_GIT_MAX_BUFFER_BYTES,
  REVIEW_DIFF_GIT_TIMEOUT_MS,
} from "./review-diff-fingerprint.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceRepositoryReviewEvidence {
  repository: string;
  baseCommitSha: string;
  branch: string;
  files: string[];
  qualifiedFiles: string[];
  fingerprint?: string;
  ahead: boolean;
  netZero: boolean;
}

export interface WorkspaceReviewEvidenceCapture {
  repositories: WorkspaceRepositoryReviewEvidence[];
  modifiedFiles: string[];
  modifiedRepositories: Set<string>;
  outOfScopeRepositories: Set<string>;
}

/*
FNXC:WorkspaceReviewEvidence 2026-10-03-00:57 (RUFU-519):
Every number in this file must be measured in the repository the entry names. When a member worktree
is deleted the entry path still resolves - to the enclosing ROOT worktree - so the probes silently read
the root repository, which carries the same `fusion/<id>` branch name. That is worse than a failure:
the diff and `netZero` would describe a different repository, and the commit-free proof built on them
could certify a delivery that was never made. Measured on saneca 2026-10-02: 12 review-lane cards lost
their member worktrees, the root branch existed, only the member base probe threw
(`git rev-parse --verify 927b482…` -> "Needed a single revision"), and it surfaced as a generic
`workspace-evidence-capture-failed` that left the cards owned by no lane at all.

So probe-repository identity is asserted before any measurement, and a mismatch is a named condition a
recovery lane can act on rather than a git error string.
*/
export type WorkspaceMemberEvidenceFailure = "member-worktree-missing" | "member-base-unresolvable";

export class WorkspaceMemberEvidenceError extends Error {
  readonly repository: string;
  readonly worktreePath: string;
  readonly reasonCode: WorkspaceMemberEvidenceFailure;

  constructor(repository: string, worktreePath: string, reasonCode: WorkspaceMemberEvidenceFailure) {
    super(reasonCode === "member-worktree-missing"
      ? `Workspace repository "${repository}" has no worktree at ${worktreePath}; the path resolves to an enclosing repository, so its evidence cannot be measured there.`
      : `Workspace repository "${repository}" has no recorded base reachable from ${worktreePath}.`);
    this.name = "WorkspaceMemberEvidenceError";
    this.repository = repository;
    this.worktreePath = worktreePath;
    this.reasonCode = reasonCode;
  }

  /** Stable classification consumed by the merge-content descriptor and by finalize reporting. */
  get classification(): string {
    return `workspace-${this.reasonCode}:${this.repository}`;
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: REVIEW_DIFF_GIT_MAX_BUFFER_BYTES,
    timeout: REVIEW_DIFF_GIT_TIMEOUT_MS,
  });
  return stdout.trim();
}

/*
FNXC:WorkspaceReviewEvidence 2026-10-03-01:20 (RUFU-519):
Identity has to survive symlinks. `resolve()` is purely lexical, while git reports a resolved path, so
under a symlinked workspace root (a `/var` -> `/private/var` style link, or a linked checkout) a
lexical comparison would declare a perfectly good member worktree missing. Realpath both sides and fall
back to the lexical form only when realpath cannot answer.
*/
async function isSamePath(left: string, right: string): Promise<boolean> {
  if (resolve(left) === resolve(right)) return true;
  const real = async (path: string): Promise<string> => {
    try {
      return await realpath(path);
    } catch {
      return resolve(path);
    }
  };
  return await real(left) === await real(right);
}

/**
 * Name why a member could not be measured. An unresolvable path or an enclosing top-level is a missing
 * member worktree; a repository that is its own top-level but cannot reach the recorded base is a
 * genuinely unresolvable base. Both fail closed; only the wording and the classification differ.
 */
async function classifyMemberEvidenceFailure(
  repository: string,
  worktreePath: string,
): Promise<WorkspaceMemberEvidenceError> {
  const toplevel = await git(["rev-parse", "--show-toplevel"], worktreePath).catch(() => "");
  return toplevel && await isSamePath(toplevel, worktreePath)
    ? new WorkspaceMemberEvidenceError(repository, worktreePath, "member-base-unresolvable")
    : new WorkspaceMemberEvidenceError(repository, worktreePath, "member-worktree-missing");
}

/**
 * Capture the immutable branch payload shared by workspace Code Review and landing.
 *
 * FNXC:WorkspaceReviewEvidence 2026-08-21-19:25:
 * FN-120 requires the review producer and landing consumer to measure the identical
 * base-to-task-branch binary diff. A linked worktree has HEAD at the task branch, so
 * ambient HEAD is never a valid comparison endpoint. Acquiring a clean repository is
 * reported as no obligation while any modified repository outside confirmed intent is
 * retained as a fail-closed observation.
 */
export async function captureWorkspaceReviewEvidence(options: {
  task: Task;
  workspaceRootDir: string;
  settings: Partial<Settings>;
}): Promise<WorkspaceReviewEvidenceCapture> {
  const { task, workspaceRootDir, settings } = options;
  const confirmedScope = task.repositoryScope?.state === "confirmed"
    ? new Set(task.repositoryScope.repositories)
    : new Set<string>();
  const repositories: WorkspaceRepositoryReviewEvidence[] = [];
  const modifiedFiles = new Set<string>();
  const modifiedRepositories = new Set<string>();
  const outOfScopeRepositories = new Set<string>();

  for (const [repository, entry] of Object.entries(task.workspaceWorktrees ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    if (!entry.branch) throw new Error(`Workspace repository ${repository} has no task branch for review evidence`);
    /*
    FNXC:WorkspaceReviewEvidence 2026-10-03-00:57 (RUFU-519): identity before measurement.
    A member entry that is not its own repository top-level cannot be measured at all, and probing it
    would silently describe the enclosing repository instead. Checked before any branch or base read,
    because the enclosing root repo usually HAS a branch of the same name.
    */
    const probeTopLevel = await git(["rev-parse", "--show-toplevel"], entry.worktreePath).catch(() => "");
    if (!probeTopLevel || !await isSamePath(probeTopLevel, entry.worktreePath)) {
      throw new WorkspaceMemberEvidenceError(repository, entry.worktreePath, "member-worktree-missing");
    }
    /* FNXC:WorkspaceReviewEvidence 2026-08-21-19:25: Legacy rows can name a branch which no longer resolves while the linked checkout remains readable. Production acquisition records a resolvable branch; landing remains fail-closed through its later branch checks. */
    let branch = entry.branch;
    try {
      branch = await git(["rev-parse", "--verify", `${entry.branch}^{commit}`], entry.worktreePath);
    } catch {
      branch = await git(["rev-parse", "--verify", "HEAD"], entry.worktreePath);
    }
    let baseCommitSha: string;
    try {
      baseCommitSha = entry.baseCommitSha
      ? await git(["rev-parse", "--verify", `${entry.baseCommitSha}^{commit}`], entry.worktreePath)
      : await (async () => {
        const base = await resolveWorkspaceRepoBaseBranch({
          mode: "recorded",
          repoRootDir: join(workspaceRootDir, repository),
          repoRelPath: repository,
          task,
          settings,
          recordedBaseBranch: entry.baseBranch,
        });
        return git(["merge-base", base.branch, branch], entry.worktreePath);
      })();
    } catch {
      /*
      FNXC:WorkspaceReviewEvidence 2026-10-03-00:57 (RUFU-519): the base entry has no fail-soft path on
      purpose - unlike `entry.branch`, which may legitimately be a legacy row whose branch is gone while
      the checkout stays readable, an unmeasurable base means no diff can be computed at all. Report it
      as the named condition so the merge door, the sweep, and the operator read the same cause.
      */
      throw await classifyMemberEvidenceFailure(repository, entry.worktreePath);
    }
    const range = `${baseCommitSha}..${branch}`;
    const names = await git(["diff", "--name-only", range], entry.worktreePath);
    const files = [...new Set(names.split("\n").map((file) => file.trim()).filter(Boolean))].sort();
    const ahead = Number(await git(["rev-list", "--count", range], entry.worktreePath)) > 0;
    const qualifiedFiles = files.map((file) => `${repository}/${file}`);
    const fingerprint = files.length > 0
      ? await computeReviewDiffFingerprint(entry.worktreePath, baseCommitSha, branch)
      : undefined;
    const netZero = ahead && files.length === 0;
    repositories.push({ repository, baseCommitSha, branch, files, qualifiedFiles, fingerprint, ahead, netZero });
    if (files.length > 0) {
      if (confirmedScope.has(repository)) {
        modifiedRepositories.add(repository);
        for (const file of qualifiedFiles) modifiedFiles.add(file);
      } else {
        outOfScopeRepositories.add(repository);
      }
    }
  }

  return {
    repositories,
    modifiedFiles: [...modifiedFiles].sort(),
    modifiedRepositories,
    outOfScopeRepositories,
  };
}
