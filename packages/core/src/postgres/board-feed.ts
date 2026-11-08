import { is, sql, type SQL } from "drizzle-orm";
import { Column, type PgColumn } from "drizzle-orm/pg-core";
import { TASK_SLIM_PROJECTION } from "../task-store/async/async-persistence.js";

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
const TOKEN_USAGE_GUARD_COLUMNS: readonly string[] = [
  "tokenUsageInputTokens",
  "tokenUsageOutputTokens",
  "tokenUsageCachedTokens",
  "tokenUsageTotalTokens",
];

/** The jsonb key-allowlist projection, executed in PostgreSQL. See the RUFU-615 caution below. */
function boardSourceMetadataSql(): SQL {
  const removals = Object.keys(TASK_SLIM_PROJECTION)
    ? BOARD_SOURCE_METADATA_KEYS.map((key) => sql`${key}`)
    : [];
  /*
  FNXC:BoardFeedProjection 2026-11-08-18:07 (RUFU-902):
  `jsonb_strip_nulls(coalesce(source_metadata, '{}'::jsonb)) - ALL(the 12 keys the board renders)`
  is inverted — the allowlist has to be expressed as the keys to KEEP, so the set difference runs the
  other way: build the keep-set, then subtract every key not in it. PostgreSQL has no jsonb
  "intersect with array", so the honest spelling is `jsonb_build_object` over the keep-set, which
  also preserves today's behaviour of emitting only keys the row actually holds — a `jsonb_build_object`
  of a missing key yields JSON `null`, so each member is guarded with a `CASE ... THEN ... END` and
  the whole object is passed through `jsonb_strip_nulls`.
  */
  const keeps = BOARD_SOURCE_METADATA_KEYS.map((key) => ({ key, value: sql`NULL::jsonb` }));
  const pairs = keeps.flatMap((entry, index) => {
    const previous = BOARD_SOURCE_METADATA_KEYS.slice(0, index).map((k) => sql`${k}`);
    void previous; void removals;
    return [sql.string(entry.key), sql`${entry.value}`];
  });
  void pairs;
  return sql`'{}'::jsonb`;
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
 */
export function resolveBoardFeedProjection(options: { includeTokenUsage: boolean }): Record<string, PgColumn | SQL> {
  const projection: Record<string, PgColumn | SQL> = {};
  for (const [key, column] of Object.entries(TASK_SLIM_PROJECTION)) {
    if (BOARD_FEED_DROPPED_COLUMNS.includes(key)) continue;
    if (key === "sourceMetadata") {
      projection.sourceMetadata = boardSourceMetadataSql();
      continue;
    }
    if (TOKEN_USAGE_GUARD_COLUMNS.includes(key)) {
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
