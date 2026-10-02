import type { Task } from "@fusion/core";

export type WorkspaceMergeReadiness =
  | { kind: "ready"; repositories: string[]; preservedFiles: string[] }
  | { kind: "no-op"; repositories: []; preservedFiles: [] }
  | { kind: "blocked"; reason: string };

/**
 * FNXC:WorkspaceFinalization 2026-08-21-08:46:
 * A workspace's confirmed repository intent survives a first successful land. A subsequent
 * finalization pass may have no fresh diff because the task branch was already integrated, but its
 * landed repository is still an obligation that must contribute durable aggregate merge proof.
 * Empty evidence is therefore a no-op only for an explicitly commit-free task; every other empty
 * workspace boundary remains visible for operator repair instead of succeeding by vacuous truth.
 */
export function resolveWorkspaceMergeReadiness(
  task: Pick<Task, "id" | "noCommitsExpected" | "repositoryScope" | "workspaceWorktrees" | "modifiedFiles">,
  freshModifiedRepositories: ReadonlySet<string>,
  netZeroBranchRepositories: ReadonlySet<string>,
): WorkspaceMergeReadiness {
  const scope = task.repositoryScope;
  if (scope?.state !== "confirmed") {
    return { kind: "blocked", reason: `Workspace repository scope is unresolved for ${task.id}; operator confirmation is required before landing` };
  }

  const entries = task.workspaceWorktrees ?? {};
  const declaredRepositories = scope.repositories.map((repository) => repository.trim());
  if (declaredRepositories.some((repository) => !repository) || new Set(declaredRepositories).size !== declaredRepositories.length) {
    /*
    FNXC:WorkspaceFinalization 2026-08-21-09:50:
    Persisted scope is an integration authority, so malformed duplicate declarations cannot be
    normalized into a smaller obligation set. Stop before dispatch or Git writes for operator repair.
    */
    return { kind: "blocked", reason: `Workspace repository scope has duplicate or invalid declarations for ${task.id}; operator repair is required` };
  }
  const worktreePaths = Object.values(entries)
    .map((entry) => entry.worktreePath?.trim())
    .filter((path): path is string => Boolean(path));
  if (new Set(worktreePaths).size !== worktreePaths.length) {
    return { kind: "blocked", reason: `Workspace merge has duplicate worktree paths for ${task.id}; operator repair is required` };
  }
  const repositories = declaredRepositories
    .filter((repo) => Boolean(entries[repo]))
    .filter((repo) => freshModifiedRepositories.has(repo) || netZeroBranchRepositories.has(repo) || Boolean(entries[repo]?.landedSha))
    .sort();
  const preservedFiles = [...new Set(task.modifiedFiles ?? [])].sort();

  if (repositories.length > 0) return { kind: "ready", repositories, preservedFiles };
  if (task.noCommitsExpected === true && scope.repositories.length === 0) {
    return { kind: "no-op", repositories: [], preservedFiles: [] };
  }

  /*
  FNXC:WorkspaceFinalization 2026-10-02-19:51 (RUFU-504):
  A commit-free workspace that DECLARED and ACQUIRED its repositories owes a landing obligation per
  repository, and until now it matched none of the three disjuncts above. `freshModifiedRepositories`
  needs a file, `netZeroBranchRepositories` needs commits whose content cancels out
  (`workspace-review-evidence.ts:96` computes `ahead` as a BOOLEAN, so a branch sitting exactly on its
  merge-base is `ahead: false`), and `landedSha` needs a prior land. The declared-commit-free case fell
  through to the same operator-repair refusal as unexplained emptiness, because the no-op arm above only
  covers the degenerate workspace with zero declared repositories.

  Measured on the saneca workspace 2026-10-02: 16 of 17 parked review-lane cards already carried
  `no_commits_expected = 1` with `repositoryScope.state = confirmed` and acquired member entries, so the
  pipeline HAD declared the contract; only readiness disagreed with it. Each of those cards then repeated
  one blocker sentence until the stall classifier parked it (`in-review-stall-deadlock`), which is how a
  delivered zero-diff card becomes indistinguishable from a frozen one.

  Returning `ready` rather than a new terminal kind is deliberate: `landOneRepo` already short-circuits a
  confidently-zero branch to `outcome: "empty"` with a durable `merge:ai-empty` row
  (`merger-ai.ts:1164`), so per-repository delivery proof is written by code that already handles this
  shape. No new probe primitive and no fabricated sha.

  Two conditions keep the vacuous-truth fence this function exists for:
  1. `noCommitsExpected` must be the pipeline's own declaration, so an acquisition that silently produced
     nothing stays unexplained emptiness and keeps its refusal.
  2. EVERY declared repository must have an acquired entry. A workspace that declared two members and
     acquired one is a partial acquisition, not a commit-free delivery, and must still reach the
     no-acquired-repositories refusal below.
  */
  if (task.noCommitsExpected === true && declaredRepositories.length > 0) {
    const acquired = declaredRepositories.filter((repo) => entries[repo] !== undefined);
    if (acquired.length === declaredRepositories.length) {
      return { kind: "ready", repositories: acquired.sort(), preservedFiles };
    }
  }

  const declared = [...declaredRepositories].sort();
  const knownEntries = declared.filter((repo) => entries[repo] !== undefined);
  if (knownEntries.length === 0) {
    return { kind: "blocked", reason: `Workspace merge has no acquired repositories matching confirmed scope for ${task.id}; operator repair is required` };
  }
  return { kind: "blocked", reason: `Workspace merge has no evidenced landing obligations for ${task.id}; operator repair is required` };
}

/** Exposed for focused tests without coupling readiness to Git acquisition. */
export function isWorkspaceLandedObligation(entry: NonNullable<Task["workspaceWorktrees"]>[string] | undefined): boolean {
  return Boolean(entry?.landedSha);
}
