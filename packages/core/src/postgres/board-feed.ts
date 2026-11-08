import { Column, is, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * The project-settings key whose 12 members the board feed is allowed to carry, and the ONLY keys the
 * board surfaces. Declared here (rather than in `task-store/reads.ts`) because both the SQL projection
 * and the post-hydration compaction must spell the same allowlist — one spelling, one definition site.
 */
export const BOARD_SOURCE_METADATA_KEYS = [
  "agentName",
  "issueUrl",
  "nearDuplicateOf",
  "nearDuplicateDismissed",
  "duplicateSource",
  "revertOf",
  "revertedAt",
  "restoredAt",
  "handoffFrom",
  "transferredTo",
  "wipAdmissionStall",
  "fusionBranchContext",
] as const;

/**
 * The columns the board feed never selects because `compactBoardFeedRow` already discards the field
 * they hydrate into. Membership is DERIVED from that compaction, never invented: each entry is a
 * column whose hydrated `Task` field compaction overwrites with `undefined` (or with `[]` that
 * compaction then overwrites), so removing the transfer cannot change the object the caller receives.
 */
export const BOARD_FEED_DROPPED_COLUMNS: readonly string[] = [
  "summary",
  "comments",
  "steeringComments",
  "stepReports",
  "recommendations",
];

/**
 * The four columns `rowToTask` probes to decide whether a card carries usage at all.
 *
 * FNXC:BoardFeedProjection 2026-11-08-18:07 (RUFU-902):
 * These are selected as SQL `NULL` literals rather than omitted. `rowToTask`'s guard is a strict
 * `=== null` test, so an ABSENT key reads as "usage present" and builds a `tokenUsage` object of
 * `undefined`s — a shape the board has never served. A NULL makes the guard answer the same way the
 * real all-NULL column does, which is what `compactBoardFeedRow({ includeTokenUsage: false })`
 * produces downstream anyway. The remaining six `tokenUsage*` columns are omitted outright because
 * the guard returns before they are ever read.
 */
export const BOARD_FEED_TOKEN_USAGE_NULL_COLUMNS: readonly string[] = [
  "tokenUsageInputTokens",
  "tokenUsageOutputTokens",
  "tokenUsageCachedTokens",
  "tokenUsageTotalTokens",
];

/**
 * The board's `source_metadata` key allowlist, executed in PostgreSQL.
 *
 * FNXC:BoardFeedProjection 2026-11-08-18:52 (RUFU-902):
 * Equivalent to `projectBoardSourceMetadata` in `task-store/reads.ts`, which keeps only the named
 * keys a row actually holds. The three `CASE` arms exist because that function has three behaviours,
 * not one, and collapsing them would break parity on states the board can actually meet:
 *
 *   * object  — aggregate the allowlisted members. Keys the row does not hold are ABSENT, never
 *               JSON null, which is why this is an aggregate over `jsonb_each` and not
 *               `jsonb_build_object`: the latter invents a null member for every key the row omits,
 *               so `{}` would come back as 12 nulls and a card's chip would read a field that was
 *               never written. A held-but-empty object stays `{}` in both implementations.
 *   * array   — the JS version iterates only the 12 named keys, so a JSON array projects to `{}`.
 *               `jsonb_each` over an array yields ordinal keys that match none of them, so the
 *               aggregate is `{}` on its own; the explicit arm only makes that intent readable.
 *   * else    — SQL NULL, JSON null, and scalars pass through untouched. This is the arm that keeps
 *               a NULL column NULL: coercing it to `'{}'::jsonb` would hydrate `sourceMetadata`
 *               as `{}` where today it is `undefined`, and `branchContext` is derived from it.
 *
 * `jsonb_typeof` returns NULL for SQL NULL, so `IS DISTINCT FROM 'object'` cannot be used to fold
 * the arms — it would send a NULL column down the array arm.
 */
function boardSourceMetadataSql(column: PgColumn): SQL {
  const allowlist = sql.join(
    BOARD_SOURCE_METADATA_KEYS.map((key) => sql`${key}`),
    sql`, `,
  );
  return sql`(
    CASE
      WHEN jsonb_typeof(${column}) = 'object' THEN (
        SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
        FROM jsonb_each(${column}) e
        WHERE e.key IN (${allowlist})
      )
      WHEN jsonb_typeof(${column}) = 'array' THEN '{}'::jsonb
      ELSE ${column}
    END
  )`;
}

/**
 * Resolve the board-feed column set — the projection the board page SELECTs when the flag is ON.
 *
 * FNXC:BoardFeedProjection 2026-11-08-18:07 (RUFU-902):
 * MEASURED WHY. `GET /api/tasks/page?limit=100` answers in 12,95 s median and `board-workflows` in
 * 17,21 s; a 100-row board page transfers ~91 kB, i.e. ~24 467 B of hydrated row per card. Allocation
 * sampling over 60 s of production traffic took 788 MB, ~90 % of it inside the pg driver building
 * full rows (`DataRow` 53 %, `fromJson` 35 %). Earlier slices on this path already earned
 * `compactBoardFeedRow` (2,21 MB → ~342 kB of payload), parse-once hydration (`rowToTask` 97,6 →
 * 61,8 µs) and a declared read-set that took one hot read from 182 columns / 6 279 B per row to
 * 163 / 929 B. Every one of those levers is post-query. This module moves the last droppable payload
 * in FRONT of the query, so the driver never materialises it.
 *
 * THE DESIGN CHOICE, and why no new table. The audited recommendation offered a derived board
 * representation in PostgreSQL or, if a table could be proven unnecessary, a narrow server-side
 * projection. The projection is what ships, because every field the board renders is already a
 * column of `project.tasks` — lane, status, pause state, timestamps, identity — so a materialised
 * board table would copy state the database can read in one pass and would then need a writer, a
 * backfill, and a reconciliation sweep. Its only benefit is fewer bytes per row, and bytes per row
 * are a property of the SELECT list, not of the table. A derived table also creates the failure class
 * this task forbids: a board answer that is warm while the database has moved on. Dropping columns
 * cannot drift, because there is nothing left to be stale.
 *
 * THE CONTRACT THIS PROJECTION MUST KEEP: it is a strict subset of `TASK_SLIM_PROJECTION` — the same
 * keys, never a new one — and every difference is a column the pipeline already discarded. That is
 * what makes the parity test meaningful: for any input row, hydrating the projected row and then
 * compacting must produce the identical `Task` to hydrating the slim row and compacting.
 *
 * THE OPEN RISK, stated rather than hidden: projecting `source_metadata` key-by-key forces PostgreSQL
 * to decompress the jsonb server-side. RUFU-615 prototyped exactly that trade for `log` and REJECTED
 * it at 4,5–11,5 s of PostgreSQL CPU per full-board read, because any per-row touch of a toasted
 * column decompresses the whole thing. `source_metadata` is orders of magnitude smaller than `log`
 * (kilobytes, not megabytes), so the trade is expected to land the other way — but this slice
 * measures transferred bytes, not PostgreSQL CPU, and that measurement is named in the residual risks.
 *
 * FNXC:BoardFeedProjection 2026-11-08-20:54 (RUFU-902) — MEASURED RESULT, fixture-shaped row, from
 * `FUSION_BOARD_FEED_BENCH=1`: the board page's current read (`TASK_SLIM_PROJECTION`, which is what
 * `listTasks({ excludeLog: true })` sends) is 182 columns / 16 590 B per row. This projection is
 * 171 columns / 8 588 B with the cost badge hidden and 177 / 8 684 with it visible — a 48,2 % cut in
 * transferred bytes per card, i.e. 1 620 kB → 839 kB across a 100-card page. Two figures in the brief
 * describe a DIFFERENT shape and must not be compared to these: the brief's 163-column / 929 B row is
 * one hot engine read with a declared field set, not the board's slim read; and the brief's ~91 kB is
 * the COMPRESSED HTTP payload after `compactBoardFeedRow`, whereas these are pre-parse wire bytes.
 * The 24 467 B/hydrated-card figure is post-hydration in-Node size, also not the same quantity.
 *
 * `base` is the caller's slim projection, passed in rather than imported: `async-persistence.ts` is
 * this module's only production caller and it owns `TASK_SLIM_PROJECTION`, so importing it from here
 * would close an import cycle across the two files for no gain.
 */
export function resolveBoardFeedProjection(
  /** The slim projection this narrows — see the note above. */
  base: Record<string, PgColumn>,
  options: { includeTokenUsage: boolean },
): Record<string, PgColumn | SQL> {
  const projection: Record<string, PgColumn | SQL> = {};
  for (const [key, column] of Object.entries(base)) {
    if (BOARD_FEED_DROPPED_COLUMNS.includes(key)) continue;
    if (key === "sourceMetadata") {
      projection.sourceMetadata = boardSourceMetadataSql(column as PgColumn);
      continue;
    }
    if (BOARD_FEED_TOKEN_USAGE_NULL_COLUMNS.includes(key)) {
      if (!options.includeTokenUsage) {
        projection[key] = sql`NULL::bigint`;
        continue;
      }
    } else if (key.startsWith("tokenUsage") && !options.includeTokenUsage) {
      continue;
    }
    if (is(column, Column)) projection[key] = column as PgColumn;
  }
  return projection;
}

/** The flag name, exported so the ratchet test and the operator-facing changeset name one string. */
export const BOARD_FEED_PROJECTION_ENV = "FUSION_BOARD_FEED_PROJECTION";

/**
 * One flag, default OFF. Rollback is pointing the read path back at the old query by unsetting it —
 * no migration to undo, because this slice writes no new state.
 */
export function isBoardFeedProjectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[BOARD_FEED_PROJECTION_ENV];
  if (raw === undefined) return false;
  const normalized = String(raw).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
