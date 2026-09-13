import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Resolve the fork-point base SHA for a freshly acquired task worktree.
 *
 * Called immediately after worktree acquisition, when the task branch was
 * just created/force-reset from the local integration branch
 * (`prepareForTask` forks from local `main` via `resolveIntegrationBranch`).
 *
 * The merge-base MUST be measured against LOCAL main first (origin/main only
 * as a fallback), matching the contamination-base sites in
 * `worktree-acquisition.ts` and `auto-recovery-handlers/branch-worktree.ts`.
 * The merger lands tasks on local main before pushing, so at fork time local
 * main can be ahead of origin/main by merged-but-unpushed commits. Measuring
 * against origin/main rewinds the base past those commits; once the
 * post-merge rebase-and-push rewrites their SHAs, `baseCommitSha..HEAD`
 * permanently sweeps the predecessors' files into this task's diff (FN-5937:
 * in-review tasks showing 31 "files changed" instead of 12).
 *
 * Returns `undefined` only when every git invocation fails (caller treats a
 * missing base as non-fatal).
 *
 * FNXC:Workspace 2026-06-21-20:10:
 * `integrationBranch` is an OPTIONAL TRAILING param defaulting to the historic
 * "main" literal so the single-repo executor caller and the real-git tests stay
 * green without change. Workspace mode (U2/KTD3) passes each sub-repo's RESOLVED
 * integration branch so per-repo base capture forks against the right branch
 * instead of a hardcoded "main". The local-first ordering (merge-base HEAD
 * <local> then origin/<branch>) is preserved per-branch to keep the
 * inflation-prevention invariant (FN-5937) intact for non-main integration
 * branches too.
 */
export async function resolveCapturedBaseCommitSha(
  worktreePath: string,
  logger?: { warn: (msg: string) => void },
  integrationBranch: string = "main",
): Promise<string | undefined> {
  const branch = integrationBranch.trim() || "main";
  /*
  FNXC:Workspace 2026-06-22-09:00:
  Shell-quote with a real single-quoted POSIX literal, NOT JSON.stringify. A
  JSON double-quoted string still lets bash expand `$(...)`, backticks, and `$VAR`
  inside it; JSON.stringify is not a shell-quoting function. Git ref names can't
  legally contain backticks so there's no live injection path today, but
  single-quoting is the idiomatic safe form and stays correct if a caller ever
  passes a less-constrained ref. A single quote inside the value is escaped as
  the standard `'\''` close-reopen sequence.
  */
  const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
  const localRef = shellSingleQuote(branch);
  const originRef = shellSingleQuote(`origin/${branch}`);

  const mergeBase = async (against: string): Promise<string | undefined> => {
    try {
      const { stdout } = await execAsync(`git merge-base HEAD ${against}`, { cwd: worktreePath, encoding: "utf-8" });
      return stdout.trim() || undefined;
    } catch (err: unknown) {
      logger?.warn(`merge-base against ${against} failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };

  /*
  FNXC:BranchBaseIdentity 2026-09-13-00:05:
  RUFU-231 — record the identity the branch ACTUALLY sits on. A fresh task branch is
  created from the local integration branch and then rebased onto `<remote>/<integrationBranch>`
  by `rebaseNewWorktreeOntoRemote`. Measuring only against local main re-records the stale
  identity whenever local main is behind the remote-tracking ref (the RUFU-217 wedge: the
  branch tip WAS the remote-tracking tip while the row recorded a local-main merge-base 25
  commits behind it, so every later zero-loss `baseCommitSha..branch` check read inherited
  landed work as "unique foreign" content). Choose the DESCENDANT of the two merge-bases:
  remote-tracking ahead (post-rebase truth) wins; local ahead or diverged keeps local —
  which preserves the FN-5937 inflation guard verbatim (local-ahead never rewinds).
  */
  const isStrictDescendant = async (candidate: string, ancestor: string): Promise<boolean> => {
    if (candidate === ancestor) return false;
    try {
      await execAsync(
        `git merge-base --is-ancestor ${shellSingleQuote(ancestor)} ${shellSingleQuote(candidate)}`,
        { cwd: worktreePath, encoding: "utf-8" },
      );
      return true;
    } catch {
      return false;
    }
  };

  const [mbLocal, mbRemote] = await Promise.all([mergeBase(localRef), mergeBase(originRef)]);
  let baseCommitSha: string | undefined;
  if (mbLocal && mbRemote) {
    baseCommitSha = (await isStrictDescendant(mbRemote, mbLocal)) ? mbRemote : mbLocal;
  } else {
    baseCommitSha = mbLocal ?? mbRemote;
  }

  if (!baseCommitSha) {
    try {
      const { stdout } = await execAsync("git rev-parse HEAD", {
        cwd: worktreePath,
        encoding: "utf-8",
      });
      baseCommitSha = stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  return baseCommitSha;
}
