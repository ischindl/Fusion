/**
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * Task diff and commit association client API peeled from legacy.ts.
 */
import { api } from "../client/client.js";
import { withProjectId } from "../client/health.js";

// ── Task Diff API ──────────────────────────────────────────────────────────

/** Aggregate diff counters — all the TaskCard badge needs. */
export interface TaskDiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

/** Task diff information */
export interface TaskDiff {
  files: Array<{
    path: string;
    status: "added" | "modified" | "deleted";
    additions: number;
    deletions: number;
    patch: string;
  }>;
  stats: TaskDiffStats;
}

/*
FNXC:TaskDiffStats 2026-09-10-04:03:
Response of the diff endpoint when `statsOnly` is requested: the server answers from ONE whole-tree
`git diff --numstat` subprocess and therefore omits `files` entirely — the per-file `git diff -- <path>`
fan-out (one subprocess per changed file, ~25-40 ms of main-thread CPU each at the dashboard's live RSS)
was being paid for a single integer on the card badge.

`TaskDiff.files` stays REQUIRED rather than optional: the full-detail caller (TaskChangesTab, which
renders `data.files.map(...)` patches) must not gain a possibly-undefined guard, and this task does not
own that component. The generic `S` keeps both call sites precisely typed — a falsy/absent flag keeps
`TaskDiff`, a literal `true` gets `TaskDiffStatsResponse`.
*/
export interface TaskDiffStatsResponse {
  stats: TaskDiffStats;
}

/** Response shape selected by the `statsOnly` flag. */
export type TaskDiffResponse<S extends boolean> = S extends true ? TaskDiffStatsResponse : TaskDiff;

/**
 * Fetch diff for a task's changes.
 *
 * @param statsOnly - When true, requests `?stats=1`: aggregate counters only, no per-file patches.
 */
export function fetchTaskDiff<S extends boolean = false>(
  taskId: string,
  worktree?: string,
  projectId?: string,
  statsOnly?: S,
): Promise<TaskDiffResponse<S>> {
  const params = new URLSearchParams();
  if (worktree) params.set("worktree", worktree);
  if (projectId) params.set("projectId", projectId);
  if (statsOnly) params.set("stats", "1");
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<TaskDiffResponse<S>>(`/tasks/${encodeURIComponent(taskId)}/diff${query}`);
}

export interface TaskCommitAssociationRow {
  commitSha: string;
  commitSubject: string;
  authoredAt: string;
  matchedBy: "canonical-lineage-trailer" | "legacy-task-id-trailer" | "legacy-subject" | "manual-reconciliation";
  confidence: "canonical" | "legacy" | "ambiguous";
  taskIdSnapshot: string;
  note?: string;
}

export interface TaskCommitAssociationsResponse {
  taskId: string;
  lineageId: string | null;
  associations: TaskCommitAssociationRow[];
}

/** Fetch lineage commit associations for a task */
export function fetchTaskCommitAssociations(taskId: string, projectId?: string): Promise<TaskCommitAssociationsResponse> {
  return api<TaskCommitAssociationsResponse>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/commit-associations`, projectId));
}

/** Individual file diff */
export interface TaskFileDiff {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  diff: string;
  oldPath?: string;
}

/** Fetch file diffs for a task */
export function fetchTaskFileDiffs(taskId: string, projectId?: string): Promise<TaskFileDiff[]> {
  return api<TaskFileDiff[]>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/file-diffs`, projectId));
}
