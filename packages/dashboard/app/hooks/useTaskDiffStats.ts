import { useEffect, useRef, useState } from "react";
import { fetchTaskDiff } from "../api";
import { useVisibilityAwarePoll } from "./visibilitySuspension";
import type { ColumnRoleFlags } from "../utils/columnRoles";
import { isCompleteColumnRole, isReviewColumnRole, isWipColumnRole } from "../utils/columnRoles";

interface DiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

interface UseTaskDiffStatsResult {
  stats: DiffStats | null;
  loading: boolean;
}

interface UseTaskDiffStatsOptions {
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-03:30 (fleet phase):
  Resolved trait flags for the task's column, so "is this done / still working" is a ROLE question. The
  hook took a bare `column: string` and compared it to `done` / `in-progress` / `in-review`, which on a
  renamed board fetched NOTHING — the diff stats silently never loaded and the row showed no changes.

  OPTIONAL, and the helpers fall back to the legacy ids without it, so the ten existing test call sites
  and any caller that has no flags keep their current behaviour. The one production caller (TaskCard)
  already had `taskColumnFlags` in scope.
  */
  columnFlags?: ColumnRoleFlags;
  /** Enable fetching when true (default). Suppresses fetches for offscreen cards. */
  enabled?: boolean;
  /** Worktree path for active task columns. */
  worktree?: string;
  /** Version identifier that changes when steps update. Forces cache invalidation when changed. */
  stepVersion?: number | string;
  /** Authoritative active-task snapshot version, including task metadata that can change without step updates. */
  snapshotVersion?: number | string;
  /**
   * Done-task merge enrichment signature (e.g. landedFiles length + filesChanged).
   * For done cards this invalidates cache/refetches when mergeDetails enrichment lands,
   * analogous to stepVersion invalidation for active columns.
   */
  mergeSignature?: number | string;
  /** Poll interval in ms for active columns (in-progress, in-review). Forces re-fetch bypassing cache. */
  pollIntervalMs?: number;
}

/**
 * Cache for diff stats to avoid repeated fetches during rerenders.
 * Key format: "taskId:projectId"
 * Entries expire after the TTL to ensure freshness.
 */
const diffStatsCache = new Map<string, { stats: DiffStats; expiresAt: number }>();
const CACHE_TTL_MS = 30_000; // 30 seconds

function getCacheKey(taskId: string, projectId?: string, worktree?: string, stepVersion?: string, mode?: "done" | "active"): string {
  return `${taskId}:${projectId ?? ""}:${worktree ?? ""}:${stepVersion ?? ""}:${mode ?? ""}`;
}

function getCachedStats(taskId: string, projectId?: string, worktree?: string, stepVersion?: string, mode?: "done" | "active"): DiffStats | null {
  const key = getCacheKey(taskId, projectId, worktree, stepVersion, mode);
  const entry = diffStatsCache.get(key);

  if (!entry) return null;

  // Check expiration
  if (Date.now() > entry.expiresAt) {
    diffStatsCache.delete(key);
    return null;
  }

  return entry.stats;
}

function setCachedStats(taskId: string, projectId: string | undefined, worktree: string | undefined, stepVersion: string | undefined, mode: "done" | "active", stats: DiffStats): void {
  const key = getCacheKey(taskId, projectId, worktree, stepVersion, mode);
  diffStatsCache.set(key, {
    stats,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/**
 * Clears all entries from the diff stats cache.
 * Exported for testing purposes.
 */
export function __test_clearDiffStatsCache(): void {
  diffStatsCache.clear();
}

/**
 * Fetches diff stats for a task's Changes tab.
 *
 * For active worktree-backed tasks, this keeps the TaskCard count aligned with
 * the Changes tab. For done tasks, this hook's `stats.filesChanged` is the
 * authoritative lineage-union total from `/api/tasks/:id/diff`, not the final
 * merge commit's shortstat.
 * Per FN-4527/FN-4647, consumers must not fall back to
 * `task.mergeDetails.filesChanged` once `loading` is false and `stats` is null:
 * stored mergeDetails counts can be stale after post-merge rebase-and-push
 * flows (see FN-4526).
 *
 * @param taskId - Task identifier
 * @param column - Current task column
 * @param commitSha - Merge commit SHA (undefined = no merge yet)
 * @param projectId - Optional project identifier
 * @param options.enabled - When false, no fetch is made and returns empty/stable state
 * @param options.mergeSignature - Done-mode invalidation signal derived from mergeDetails enrichment
 */
export function useTaskDiffStats(
  taskId: string,
  column: string,
  commitSha: string | undefined,
  projectId?: string,
  options: UseTaskDiffStatsOptions = {},
): UseTaskDiffStatsResult {
  const enabled = options.enabled ?? true;
  const worktree = options.worktree;
  const stepVersion = options.stepVersion;
  const snapshotVersion = options.snapshotVersion;
  const pollIntervalMs = options.pollIntervalMs;
  const mergeSignature = options.mergeSignature;
  const columnFlags = options.columnFlags;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-12:15 (PR #2731 review — coderabbit, and I dismissed this
  twice before checking):
  DERIVED OUTSIDE THE EFFECT SO THEY CAN BE DEPENDENCIES. `columnFlags` arrives from a board-workflows
  fetch, so it is `undefined` on first paint and populated later. The effect read it but the dependency
  array did not list it, so the poll kept the PRE-RESOLUTION answer: on a renamed board a card in a
  custom complete/wip/review lane never started fetching diff stats at all.

  The booleans rather than the object: `columnFlags` is a prop object whose identity a parent may change
  every render, which would restart the poll continuously. These are primitives, so they change exactly
  when the answer changes — which is the dependency the effect actually has.
  */
  const shouldFetchDoneTask = isCompleteColumnRole(columnFlags, column);
  const shouldFetchActiveTask = isWipColumnRole(columnFlags, column)
    || isReviewColumnRole(columnFlags, column);
  const activeWorktree = shouldFetchActiveTask ? worktree : undefined;
  const stepVersionStr = stepVersion !== undefined ? String(stepVersion) : undefined;
  const snapshotVersionStr = snapshotVersion !== undefined ? String(snapshotVersion) : undefined;
  const mergeSignatureStr = mergeSignature !== undefined ? String(mergeSignature) : undefined;
  const mode: "done" | "active" = shouldFetchDoneTask ? "done" : "active";
  /*
  FNXC:TaskCardLayout 2026-09-09-16:03:
  Active diff cache identity includes both execution progress and the authoritative task snapshot. A new `updatedAt` or persisted `modifiedFiles` set must never synchronously repaint stats cached for an older snapshot whose steps and worktree happen to be unchanged.
  */
  const cacheVersion = mode === "done"
    ? mergeSignatureStr
    : JSON.stringify([stepVersionStr ?? null, snapshotVersionStr ?? null]);
  const requestKey = getCacheKey(taskId, projectId, activeWorktree, cacheVersion, mode);
  const synchronouslyCachedStats = enabled && taskId && (shouldFetchDoneTask || shouldFetchActiveTask)
    ? getCachedStats(taskId, projectId, activeWorktree, cacheVersion, mode)
    : null;
  const [state, setState] = useState<{ key: string; stats: DiffStats | null; loading: boolean }>(() => ({
    key: requestKey,
    stats: synchronouslyCachedStats,
    loading: false,
  }));

  /*
  FNXC:BoardBootRequestSet 2026-11-08-04:48 (RUFU-493):
  The poll driver lives outside this effect, so the effect publishes its own force-refresh through a ref
  rather than owning a timer. Everything about WHAT is fetched stays here; only the arming moved.
  */
  const forceRefreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    // Disabled state: return stable empty state without fetching
    if (!enabled || !taskId || (!shouldFetchDoneTask && !shouldFetchActiveTask)) {
      setState({ key: requestKey, stats: null, loading: false });
      return;
    }

    let cancelled = false;

    async function load(forceRefresh = false) {
      // Check cache first - return immediately without loading flicker (unless force refresh)
      if (!forceRefresh) {
        /*
        FNXC:WorkflowResolvedColumns 2026-07-30-03:30 DELIBERATE-LITERAL:
        `mode` is this function's OWN `"done" | "active"` discriminant, assigned three lines up from
        `shouldFetchDoneTask`. It is not a column id and there is no trait to resolve — the census
        classifies it as a column guard because the receiver is compared to the string `done`, which is
        a classifier limitation, not a site to convert.
        */
        const cached = getCachedStats(taskId, projectId, activeWorktree, cacheVersion, mode);
        if (cached) {
          if (!cancelled) {
            setState({ key: requestKey, stats: cached, loading: false });
          }
          return;
        }
      }

      setState({ key: requestKey, stats: null, loading: true });
      try {
        /*
        FNXC:TaskDiffStats 2026-09-10-04:03:
        This consumer reads ONLY `data.stats`, so it asks the server for the stats-only shape (`?stats=1`):
        one whole-tree `git diff --numstat` subprocess on the server instead of the per-file patch fan-out
        that exists purely for the Changes tab's diff viewer. The client cache identity is deliberately
        unchanged — the key stays (taskId, projectId, worktree, version, mode) — because the stats-only flag
        is transport, not identity: the numbers under this key are the same numbers.
        */
        const data = await fetchTaskDiff(taskId, activeWorktree, projectId, true);
        if (!cancelled) {
          setState({ key: requestKey, stats: data.stats, loading: false });
          // Store in cache
          /*
        FNXC:WorkflowResolvedColumns 2026-07-30-03:30 DELIBERATE-LITERAL:
        `mode` is this function's OWN `"done" | "active"` discriminant, assigned three lines up from
        `shouldFetchDoneTask`. It is not a column id and there is no trait to resolve — the census
        classifies it as a column guard because the receiver is compared to the string `done`, which is
        a classifier limitation, not a site to convert.
        */
          setCachedStats(taskId, projectId, activeWorktree, cacheVersion, mode, data.stats);
        }
      } catch {
        if (!cancelled) {
          setState({ key: requestKey, stats: null, loading: false });
        }
      }
    }

    // Initial fetch
    void load();

    // The shared visibility gate drives the cadence below; this effect owns only the initial load.
    forceRefreshRef.current = () => {
      // Force refresh on poll - bypass cache
      void load(true);
    };

    return () => {
      cancelled = true;
      forceRefreshRef.current = () => {};
    };
  }, [taskId, column, commitSha, projectId, enabled, worktree, stepVersion, snapshotVersion, mergeSignature, pollIntervalMs, shouldFetchDoneTask, shouldFetchActiveTask, requestKey, activeWorktree, cacheVersion, mode]);

  /*
  FNXC:BoardBootRequestSet 2026-11-08-04:48 (RUFU-493):
  THE ACTIVE-COLUMN POLL GOES THROUGH THE ONE SHARED VISIBILITY GATE. This was the last raw `setInterval`
  poller on the board: a board with ~25 cards whose timers kept firing against a hidden tab, which is the
  exact shape `visibilitySuspension.ts` exists to remove — a backgrounded mobile page that never registers
  as idle gets reclaimed (white-splash reload), and a desktop tab returning to 25 simultaneously armed
  diff polls exhausts the 6-connections-per-origin cap. The gate tears the interval down while hidden and,
  on the hidden -> visible edge, fires exactly one refresh per card through the shared deterministic stagger
  before re-arming, so cadence and cache-bypassing semantics are unchanged while the hidden page does no
  work and the restore path does not burst. `enabled` carries the caller's viewport gate (TaskCard passes
  `isInViewport && !isSearchResult`), so a card scrolled off-screen holds no armed timer at all.
  */
  useVisibilityAwarePoll(
    () => forceRefreshRef.current(),
    pollIntervalMs ?? 0,
    { enabled: enabled && shouldFetchActiveTask && Boolean(pollIntervalMs) },
  );

  if (state.key !== requestKey) {
    return { stats: synchronouslyCachedStats, loading: false };
  }
  return { stats: state.stats, loading: state.loading };
}
