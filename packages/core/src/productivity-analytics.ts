import type { Database } from "./db.js";

/**
 * Productivity analytics: files modified (count + language distribution) from
 * `tasks.modifiedFiles`, commit associations from `task_commit_associations`,
 * pull requests from `pull_requests`, and LOC from commit diff stats.
 *
 * **LOC availability.** Fusion does not currently persist commit diff line
 * stats (the `task_commit_associations` schema has no additions/deletions
 * columns). LOC is therefore reported as the documented unavailable sentinel —
 * `{ value: null, unavailable: true }` — **never `0`**, so a missing data source
 * is never mistaken for "zero lines changed". When a diff-stats source is added,
 * fill {@link LocSummary.value} and clear `unavailable`.
 *
 * Inclusivity: `from`/`to` bounds are inclusive. Tasks are filtered by
 * `updatedAt` (the last time the task — and therefore its modifiedFiles — was
 * touched); commit associations by `authoredAt`; PRs by `createdAt`.
 */

export interface ProductivityAnalyticsQuery {
  /** ISO-8601 lower bound (inclusive). */
  from?: string;
  /** ISO-8601 upper bound (inclusive). */
  to?: string;
}

/** A single language's modified-file count. */
export interface LanguageCount {
  /** Lowercased file extension (no dot), or `other` when none. */
  language: string;
  count: number;
}

/**
 * LOC summary. `value` is null and `unavailable` true until a commit diff-stats
 * source exists — never `0`.
 */
export interface LocSummary {
  value: number | null;
  unavailable: boolean;
}

export interface ProductivityAnalytics {
  from: string | null;
  to: string | null;
  /** Total modified-file paths across matched tasks. */
  modifiedFiles: number;
  /** Modified files grouped by language (extension), descending by count. */
  byLanguage: LanguageCount[];
  /** Rows in `task_commit_associations` in range. */
  commits: number;
  /** Rows in `pull_requests` in range. */
  pullRequests: number;
  /** LOC from commit diff stats — unavailable until a source exists. */
  loc: LocSummary;
}

interface CountRow {
  count: number;
}

interface ModifiedFilesRow {
  modifiedFiles: string | null;
}

/** Extract a coarse language key from a file path (its lowercased extension). */
function languageOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "other";
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Aggregate productivity metrics over a date range. Empty range yields zeroed
 * structures (not nulls); LOC is always the unavailable sentinel until a
 * diff-stats source is wired.
 */
export function aggregateProductivityAnalytics(
  db: Database,
  query: ProductivityAnalyticsQuery = {},
): ProductivityAnalytics {
  // Modified files: read the JSON array off tasks updated in range.
  const taskClauses: string[] = [
    "modifiedFiles IS NOT NULL",
    "modifiedFiles NOT IN ('', '[]')",
  ];
  const taskParams: string[] = [];
  if (query.from !== undefined) {
    taskClauses.push("updatedAt >= ?");
    taskParams.push(query.from);
  }
  if (query.to !== undefined) {
    taskClauses.push("updatedAt <= ?");
    taskParams.push(query.to);
  }
  const taskRows = db
    .prepare(
      `SELECT modifiedFiles FROM tasks WHERE ${taskClauses.join(" AND ")}`,
    )
    .all(...taskParams) as ModifiedFilesRow[];

  let modifiedFiles = 0;
  const langMap = new Map<string, number>();
  for (const row of taskRows) {
    if (!row.modifiedFiles) continue;
    let files: unknown;
    try {
      files = JSON.parse(row.modifiedFiles);
    } catch {
      continue;
    }
    if (!Array.isArray(files)) continue;
    for (const f of files) {
      if (typeof f !== "string" || f.length === 0) continue;
      modifiedFiles += 1;
      const lang = languageOf(f);
      langMap.set(lang, (langMap.get(lang) ?? 0) + 1);
    }
  }
  const byLanguage: LanguageCount[] = [...langMap.entries()]
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => b.count - a.count);

  // Commits from task_commit_associations (by authoredAt).
  const commitClauses: string[] = [];
  const commitParams: string[] = [];
  if (query.from !== undefined) {
    commitClauses.push("authoredAt >= ?");
    commitParams.push(query.from);
  }
  if (query.to !== undefined) {
    commitClauses.push("authoredAt <= ?");
    commitParams.push(query.to);
  }
  const commitWhere =
    commitClauses.length > 0 ? `WHERE ${commitClauses.join(" AND ")}` : "";
  const commits = (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM task_commit_associations ${commitWhere}`,
      )
      .get(...commitParams) as CountRow
  ).count;

  // Pull requests. `pull_requests.createdAt` is an INTEGER epoch-ms column, so
  // convert the ISO bounds to epoch ms for comparison.
  const prClauses: string[] = [];
  const prParams: number[] = [];
  if (query.from !== undefined) {
    prClauses.push("createdAt >= ?");
    prParams.push(Date.parse(query.from));
  }
  if (query.to !== undefined) {
    prClauses.push("createdAt <= ?");
    prParams.push(Date.parse(query.to));
  }
  const prWhere = prClauses.length > 0 ? `WHERE ${prClauses.join(" AND ")}` : "";
  const pullRequests = (
    db
      .prepare(`SELECT COUNT(*) AS count FROM pull_requests ${prWhere}`)
      .get(...prParams) as CountRow
  ).count;

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    modifiedFiles,
    byLanguage,
    commits,
    pullRequests,
    // No commit diff-stats source yet — unavailable, never 0.
    loc: { value: null, unavailable: true },
  };
}
