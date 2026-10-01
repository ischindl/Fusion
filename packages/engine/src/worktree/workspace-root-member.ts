/*
FNXC:WorkspaceRootMember 2026-09-28-08:41 (RUFU-390):
A workspace member is configured as a path RELATIVE TO THE WORKSPACE ROOT
(`.fusion/workspace.json` → `repos[]`), and every acquisition joins it onto that root. Nothing
checked that the joined directory is a repository OF ITS OWN. A member directory that merely sits
inside the root repository — an engine scratch directory, a stale clone remnant, a directory with
the root repo's own name — passes every existing git probe because `git rev-parse` WALKS UP to the
parent repository and answers happily: measured on the saneca board, `git -C <root>/saneca
rev-parse --show-toplevel` returned `<root>` itself.

The consequence is fatal and silent: the acquisition then asks that SAME repository for a linked
worktree on branch `fusion/<id>` — the branch the task already occupies in its own worktree — and
git refuses with `Branch fusion/<id> is already checked out at <path>`. One branch, one worktree;
the member can never be created. Measured on one board in one 4-hour window: 42 cards carry
`Workspace repository preparation failed for saneca during acquire`, 26 of them sit `in-review`
with a verdict-less Code Review row plus an `in-review-stall-deadlock` park, and the project made
one lifecycle move per 40 minutes. Every lane that touches the workspace (execution, code review,
post-merge verification, landing) fails at the same line, so no per-lane recovery can help.

These two probes make the distinction observable: whether the member directory is its own
repository root, and which registered worktree (if any) already holds the task's branch.
*/
import { exec } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { getWorktreeBranchMap } from "../executor/worktree-registry-helpers.js";

const execAsync = promisify(exec);

/** How a configured workspace member relates to the workspace root repository. */
export type WorkspaceRootMembership =
  /** The member directory is its own git repository — the ordinary case. */
  | { kind: "own-repository" }
  /** The member directory resolves to the workspace root repository itself (git walked up). */
  | { kind: "workspace-root-repository"; toplevel: string }
  /** Git could not answer (unborn repo, spawn failure); never rewrite anything on this answer. */
  | { kind: "unknown" };

/** Canonical path, falling back to the raw value when the filesystem cannot resolve it. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Classify one configured workspace member against the workspace root repository.
 *
 * Fail-closed to `"unknown"`: an unreadable answer must never be read as "this member is the root
 * repository", because that answer authorizes rewriting the member's persisted worktree path.
 */
export async function resolveWorkspaceRootMembership(
  repoAbsPath: string,
  workspaceRootDir: string,
  timeout = 20_000,
): Promise<WorkspaceRootMembership> {
  try {
    const { stdout } = await execAsync("git rev-parse --show-toplevel", {
      cwd: repoAbsPath,
      encoding: "utf-8",
      timeout,
    });
    const toplevel = stdout.trim();
    if (!toplevel) return { kind: "unknown" };
    return (await canonical(toplevel)) === (await canonical(workspaceRootDir))
      ? { kind: "workspace-root-repository", toplevel }
      : { kind: "own-repository" };
  } catch {
    return { kind: "unknown" };
  }
}

/**
 * Path of the registered worktree in `rootRepoDir` that already has `branch` checked out, or
 * `undefined` when no worktree holds it (or the list cannot be read).
 */
export async function findWorktreeHoldingBranch(rootRepoDir: string, branch: string): Promise<string | undefined> {
  if (!branch) return undefined;
  try {
    return (await getWorktreeBranchMap(rootRepoDir)).get(branch);
  } catch {
    return undefined;
  }
}
