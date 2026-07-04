import type { Task, TaskStore } from "@fusion/core";
import { resolveGitLabClient, resolveGitLabTarget, safeLogGitLabEntry } from "./gitlab-lifecycle.js";

export const GITLAB_RECONCILE_SCAN_LIMIT = 200;

type BackfillResult = { scanned: number; filled: number; skipped: number; errors: number; hasMore: boolean };

function hasDoneColumn(task: Pick<Task, "column">): boolean {
  return task.column === "done";
}

function isGitLabBackfillCandidate(task: Task): boolean {
  return hasDoneColumn(task)
    && task.sourceIssue?.provider === "gitlab"
    && !task.sourceIssue.closedAt;
}

function normalizeProviderTimestamp(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("0001-01-01T00:00:00")) return undefined;
  return trimmed;
}

/**
 * FNXC:CommandCenterGitLab 2026-07-02-00:00:
 * GitLab closed-at backfill is an explicit operator action for local analytics accuracy. It reads real GitLab issue/MR terminal timestamps only, skips already-filled rows, and never fabricates timestamps from local task state or provider `updated_at` values.
 *
 * FNXC:CommandCenterGitLab 2026-07-02-00:00:
 * Archived tasks live in archiveDb, so this active-task backfill intentionally excludes them instead of calling updateTask/logEntry on read-only archive rows.
 */
export class GitLabSourceIssueReconciler {
  async backfillSourceIssueClosedAt(
    store: TaskStore,
    options?: { offset?: number; limit?: number },
  ): Promise<BackfillResult> {
    const offset = Math.max(0, options?.offset ?? 0);
    const limit = Math.max(0, options?.limit ?? GITLAB_RECONCILE_SCAN_LIMIT);
    const listedTasks = await store.listTasks({ slim: false, includeArchived: false } as Parameters<TaskStore["listTasks"]>[0]);
    const matchingTasks = (Array.isArray(listedTasks) ? listedTasks : []).filter(isGitLabBackfillCandidate);
    const tasks = matchingTasks.slice(offset, offset + limit);
    const hasMore = offset + limit < matchingTasks.length;

    const resolved = await resolveGitLabClient(store);
    if (!resolved.ok) {
      for (const task of tasks) {
        await safeLogGitLabEntry(store, task.id, "Skipped GitLab source issue closed-at backfill", resolved.message);
      }
      return { scanned: tasks.length, filled: 0, skipped: tasks.length, errors: 0, hasMore };
    }

    let filled = 0;
    let skipped = 0;
    let errors = 0;

    for (const task of tasks) {
      const sourceIssue = task.sourceIssue;
      if (!sourceIssue) {
        skipped += 1;
        continue;
      }

      const target = resolveGitLabTarget(task);
      if (!target) {
        skipped += 1;
        await safeLogGitLabEntry(store, task.id, "Skipped GitLab source issue closed-at backfill", "Linked GitLab source metadata is incomplete");
        continue;
      }

      try {
        if (target.kind === "merge_request") {
          const mergeRequest = await resolved.client.getMergeRequest(target.project, target.iid);
          const closedAt = normalizeProviderTimestamp(mergeRequest.mergedAt) ?? normalizeProviderTimestamp(mergeRequest.closedAt);
          if (!["closed", "merged"].includes(mergeRequest.state) || !closedAt) {
            skipped += 1;
            continue;
          }
          await store.updateTask(task.id, { sourceIssue: { ...sourceIssue, closedAt } });
          filled += 1;
          continue;
        }

        const issue = await resolved.client.getProjectIssue(target.project, target.iid);
        const closedAt = normalizeProviderTimestamp(issue.closedAt);
        if (issue.state !== "closed" || !closedAt) {
          skipped += 1;
          continue;
        }
        await store.updateTask(task.id, { sourceIssue: { ...sourceIssue, closedAt } });
        filled += 1;
      } catch (error) {
        errors += 1;
        await safeLogGitLabEntry(
          store,
          task.id,
          "Failed to backfill GitLab source issue closed-at",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return { scanned: tasks.length, filled, skipped, errors, hasMore };
  }
}
