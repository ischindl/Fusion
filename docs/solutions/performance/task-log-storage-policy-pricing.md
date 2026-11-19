---
category: performance
module: packages/core/src/postgres/migrations
date: 2026-11-18
problem_type: performance
severity: medium
component: postgres-storage
applies_when:
 - "Someone proposes another `tasks.log` storage change (TOAST policy, side table, or `DROP COLUMN`)"
 - "A board read is slow and the suspicion lands on History storage rather than on the reader"
 - "An operator is deciding whether to schedule `VACUUM (FULL, ANALYZE) project.tasks`"
tags:
 - toast
 - storage-policy
 - task-history
 - measurement
 - census
related:
 - docs/storage.md
 - docs/solutions/performance/dashboard-heap-growth-runbook.md
 - docs/solutions/performance/list-tasks-derive-optout-and-memo.md
 - packages/core/src/postgres/migrations/0092_rufu_615_task_log_projections.sql
 - packages/core/src/postgres/migrations/0093_rufu_312_task_log_entries.sql
---

# `tasks.log` storage, priced against the shipped side table (RUFU-634)

## What this answers

The original report proposed two things: (1) change the TOAST storage policy of `project.tasks.log`,
and (2) move History into a `task_log` side table. **Option 2 shipped before this card ran** (RUFU-312,
migration `0093_rufu_312_task_log_entries.sql`, with `0094` alongside), so this document records it as
delivered and prices only what it left behind. **Option 1 is now measured**, and the verdict is
**DO NOT LAND**. The deciding number: `SET STORAGE EXTERNAL` grows the column's TOAST relation by
**+188 604 416 bytes (+150 %)** - measured 125 435 904 -> 314 040 320 on a copy - to save **5.6 ms** on
the one shipped read that still touches the column (15.2 ms -> 9.6 ms, 29 rows), and the migration
cannot deliver even that on an existing database by any route Fusion is allowed to take.

Everything below is a measurement, not a proposal. Pre-cutover figures are labelled historical.

## The shape being priced (both fixes already shipped)

| Fact | Evidence |
|---|---|
| A pure History append writes `project.task_log_entries` and `project.task_log_rollup`, **not** `project.tasks` | `packages/core/src/task-store/task-log-entries.ts`, `docs/storage.md` sec. "Task History beside the task row" |
| `excludeLog: true` is effective on its own; the board feed selects neither `log` nor a per-row derivation | `TASK_SLIM_PROJECTION` in `packages/core/src/task-store/async/async-persistence.ts`; pinned by `packages/engine/src/__tests__/board-read-shape-guard.test.ts` |
| One read keeps `log` **by decision**: merge eligibility, because `hasAutoHealableVerificationBufferFailure` pattern-matches log *content* | `packages/engine/src/project-engine.ts`; the guard test asserts both halves (`toContain("excludeLog: true")` for switchers, `not.toContain("excludeLog")` for retentions) |
| The detail read is the owner of whole History and merges the legacy prefix per row | `getTaskImpl` -> `hydrateTaskLogEntries`, bounded by that row's own newest legacy timestamp (`latestEntryTimestamp`) |
| The column is written today only by the compound seams that pair it: `async-persistence.ts`, `task-mutation-ops.ts` (3 sites), `overlap-wait-ops.ts`, `overlap-wait-reconciliation.ts`, `human-merge-approval-ops.ts`, all through `withTaskLogProjections` | grep of `withTaskLogProjections`: 16 source call sites, 8 files; seam list held by `task-store/__tests__/task-log-projection-pairing.test.ts` |
| The pairing writes **three** columns, not two: `timing_total_ms`, `log_recent`, and the authorship stamp `log_projection_at` | `packages/core/src/task-store/task-log-projections.ts` (`TASK_TIMING_TOTAL_MS_COLUMN`, `TASK_LOG_RECENT_COLUMN`, plus the RUFU-312 author stamp) |

## Method, including the traps that make a wrong number look right

Both traps produced a plausible-but-false reading during this card's own work, so they are part of the
recipe rather than a footnote.

1. **`EXPLAIN (ANALYZE, BUFFERS)` does not measure a TOAST read.** A bare `SELECT ..., log` passes the
   toasted datum through the projection as a *short external pointer*; it is detoasted only when
   serialized to a client, which `EXPLAIN` never does. The shipped whole-board read with `log` measured
   `Execution Time: 7.752 ms` and `Buffers: shared hit=847` (heap pages only) - while the same query
   delivered 287 MB to the client. Every read cost below therefore comes from a **server-side detoast
   aggregate** (`sum(octet_length(log::text))`), which forces the fetch inside the executor and charges
   the buffers honestly.
2. **`psql`'s own formatting costs more than the database does, and in aligned mode it can cost the
   filesystem.** Timing a plain `SELECT` with aligned output reported **37 s wall** for a query whose
   server-side execution was 15 ms. Aligned mode also pads *every* cell to the widest value in the result
   set, so one card carrying a multi-megabyte History is re-emitted, padded, for all 3 034 rows: the
   disk-backed variant of the whole-board-with-`log` shape reached **65 GB in a single file**
   (operator-measured 2026-11-18) where the same query streams as **287 MB** of CSV. Wall clock here is
   therefore `COPY (...) TO STDOUT` to `/dev/null`, and client bytes are `COPY (...) TO STDOUT | wc -c`;
   byte sums come from server-side aggregates. Never size a result by writing it to a file (`psql -o ...`
   plus `readFileSync(...).length` is the refused pattern), and never redirect it to `/tmp` either -
   `/tmp` is tmpfs on this host, so a 65 GB payload becomes an OOM instead of an ENOSPC. This is not a
   hygiene note: `/home` measured **96 % used with 72 GB free** during this card (operator-measured at
   15:14 and 15:24 UTC, re-measured here at 72 GB), so one more full-board pass was a coin flip from
   ENOSPC, and ENOSPC there breaks task mirrors, agent logs, `fusion.db` and backups for **every** lane
   on the board, not just this card. The two scratch scripts that encoded the refused method - one
   deleting its discard file only *after* each shape, so peak equals the full payload, the other leaving
   one payload file per stage behind and holding up to 1 GB in `maxBuffer` - were **deleted from
   `.scratch/`** rather than repaired, so no later pass can re-run them. If a number genuinely needs a
   file, take it from a bounded sample (`LIMIT N`).
3. **A storage policy is only observable through `attstorage`, never through its name.**
   `attstorage` codes are `p`lain, `m`ain, `e`xternal (uncompressed, chunked), `x`tended (compressed,
   chunked). `jsonb`'s own `pg_type.typstorage` is **`x` = EXTENDED**, so the shipped column was
   *compressed* - confirmed independently by `pg_column_compression(log)` returning **`pglz`**, and by
   `sum(pg_column_size(log))` = 53 MB against `sum(octet_length(log::text))` = 190 MB (a 3.6x ratio that
   only exists if the stored bytes are compressed). Reading `x` as "EXTERNAL" inverts the entire
   decision, which is what the first pass of this card did before the witness function was consulted.

All destructive probes ran on a scratch copy (`scripts/pg-test-server.mjs`, local port 25432,
PostgreSQL 15.18, `shared_buffers=128MB`, `default_toast_compression=pglz`). The operator's live
database (PostgreSQL 18.6, `shared_buffers=2GB`, 7 062 MB) received **SELECT and `pg_*` catalog reads
only**. Per-pass variance on the scratch cluster reached **+/-35 %** on repeated identical probes, so only
the byte measurements (exact and deterministic) carry the verdict.

## Today's census - the live reference database, read-only

Four storage surfaces (`pg_relation_size` / `pg_indexes_size` / `pg_total_relation_size`):

| relation | rows (est.) | heap | indexes | toast | total |
|---|---|---|---|---|---|
| `project.tasks` | 3 559 | 7 766 016 | 20 725 760 | 152 379 392 | 180 903 936 |
| `project.task_log_entries` | 693 331 (`n_live_tup` 711 636) | 238 698 496 | 149 225 472 | 15 622 144 | 403 636 224 |
| `project.task_log_rollup` | 3 207 | 1 826 816 | 204 800 | 8 192 | 2 072 576 |
| `project.task_log_backfill_marker` | 26 | 8 192 | 16 384 | 8 192 | 32 768 |

Per-column bytes carried by the task row (`sum(pg_column_size(col))`, all 3 559 rows):

| column | bytes | share of row payload |
|---|---|---|
| **`log`** | **53 101 171** | **42.9 %** |
| `search_vector` | 15 907 784 | 12.8 % |
| `workflow_step_results` | 15 615 704 | 12.6 % |
| `description` | 8 272 677 | 6.7 % |
| `comments` | 4 054 243 | 3.3 % |
| `source_metadata` | 3 387 627 | 2.7 % |
| `log_recent` | 905 649 | 0.7 % |
| `steering_comments` | 670 797 | 0.5 % |
| all columns summed | 123 789 152 | 100 % |

Data-shape states, guarded against the non-array shape (`jsonb_typeof`): 3 559 rows all carry a
**non-empty legacy array**; `log IS NULL` = 0; empty-array default = 0; non-array = 0; at the
`DEFAULT_TASK_ACTIVITY_LOG_ENTRY_LIMIT` cap (>= 1000 entries) = **293**; max observed = 1 005 entries;
soft-deleted rows = 525. Legacy-vs-side: 3 177 cards have both a legacy array and side rows; for 1 057
the side table is strictly ahead, for 2 120 the legacy newest timestamp is still the bound the merge
uses.

Write-path evidence that the cutover happened, from the same read (`pg_stat_user_tables`):
`tasks` n_tup_upd = 591 540 with `n_dead_tup` = 198 today; `task_log_entries` n_tup_ins = 796 370,
n_tup_upd = 1 (append-only as designed); `task_log_rollup` n_tup_upd = 152 129 of which
n_tup_hot_upd = 151 445 - the per-append write moved off `tasks` onto a HOT-updated one-row-per-card
rollup.

### Historical baseline, kept for comparison only

The report measured 31 787 737 bytes of TOAST for `log` over 2 417 live rows = 42.7 % of 73.6 MB of
live-row bytes, ~13 KB per row. Today's read-only measurement is **53 101 171 bytes over 3 034 live
rows = 42.9 % of 123.8 MB**, ~17.5 KB per live row. The *share* reproduced to within 0.2 points, which
is the finding: the cutover stopped the column from growing for new cards and removed it from board
reads, but it did **not** shrink it, exactly as `docs/storage.md` says. The absolute bytes grew because
the board grew, and the ~13 KB -> ~17.5 KB shift is the 1 000-entry cap saturating on 293 cards.

## Read shapes today (scratch copy, warm, server-side detoast)

| shape | rows | EXTENDED (`x`, shipped) | notes |
|---|---|---|---|
| board feed, `excludeLog: true` (`TASK_SLIM_PROJECTION`) | 3 034 | **13.2-15.1 ms**, `Buffers: shared hit=847` | touches the heap only; pays no TOAST at all under either policy |
| lane-role read that keeps `log` (merge eligibility) | 29 | **15.2 ms** | the only shipped read that still decompresses History |
| single-card detail read (all columns by id) | 1 | **0.69-0.80 ms**, 59 buffers | 33 KB of History text for this card |
| whole-board read that keeps `log` | 3 034 | **820.6 ms** warm (fresh restore); 1 115-1 151 ms after the policy round-trip | no shipped caller runs this any more; 287 MB client payload |
| rollup envelope read | 3 207 | **7.5 ms**, 1.1 MB text | the log-free fallback lane |

Historical comparison: RUFU-615 measured 4.5-11.5 s per full-board read *while deriving* from `log`.
The 0.82-1.15 s detoast cost above is the storage half of that number, and it is why `excludeLog` and
the two narrow projection columns are the shipped answer rather than SQL-side derivation.

## Option 1 priced: a TOAST storage policy on `project.tasks.log`

Baseline (`attstorage='x'`, EXTENDED = the `jsonb` type default, `pg_column_compression` = `pglz`).
All rows below are the same 3 559 copied rows at each stage.

| # | action on the copy | `attstorage` | stored compression | tasks TOAST bytes | `sum(pg_column_size(log))` | toast chunks | WAL written | wall |
|---|---|---|---|---|---|---|---|---|
| S0 | fresh restore (state of the world today) | `x` | `pglz` | 125 435 904 | 53 075 167 | 72 850 | - | - |
| S1 | `ALTER ... SET STORAGE EXTERNAL`, **no rewrite** | `e` | **still `pglz`** | **125 435 904 (delta 0)** | 53 075 167 | 72 850 | 1 000 B | 0.01 s |
| S2 | `VACUUM (FULL, ANALYZE)` under EXTERNAL | `e` | **still `pglz`** | 132 005 888 (+5 %) | 53 075 167 | **72 850 (identical)** | 142 900 880 B | 2.93 s |
| S3 | value-touching rewrite (`UPDATE ... SET log = log \|\| '[]'::jsonb`) | `e` | uncompressed | 369 803 264 (dead chunks included) | **227 882 413 (*4.3)** | 160 461 | 321 686 392 B | 2.02 s |
| S5 | + `VACUUM (FULL, ANALYZE)` - steady state under EXTERNAL | `e` | uncompressed | **314 040 320** | 227 882 401 | 160 461 | 330 305 624 B | 3.27 s |
| S7 | back to `EXTENDED` + same rewrite + `VACUUM FULL` (reversibility) | `x` | `pglz` | 132 202 496 | 53 088 921 | 72 861 | 195 524 928 B | 5.08 s |
| S8 | `ALTER ... SET STORAGE PLAIN` then any write | `p` | - | - | - | - | - | `ERROR: row is too big: size 8696, maximum size 8160` (35 400 for one fat row) |

Read cost of the winning policy candidate (S5 vs S0):

| shape | EXTENDED (shipped) | EXTERNAL (S5) | delta |
|---|---|---|---|
| lane-role read, 29 rows | 15.2 ms | 9.6 ms | **-5.6 ms** |
| single-card detail read | 0.7-0.8 ms | 0.70 ms | none |
| project-board detoast, 900 rows (both fully cache-resident) | 176.8 / 236.0 / 316.6 ms, `hit=4 977` | 201.6 ms, `hit=10 109` | inside the +/-35 % variance, **2* the buffer footprint** |
| whole-board detoast, 3 034 rows | 820.6-1 151 ms, all cache hits | 522.8-613.3 ms but with `read=26 050...27 269` pages | faster only because decompression CPU exceeded the I/O it newly adds at `shared_buffers=128MB` |
| client payload of the whole board with `log` | 287 405 283 B | 287 405 283 B | **identical** - the policy never changes what a reader transfers |

**Verdict: DO NOT LAND.** The sentence that decided it: *the policy costs +150 % on the column's TOAST
relation (188.6 MB on a 125 MB baseline, and +174 % on the whole `tasks` relation: 146.9 MB -> 334.3 MB)
to buy 5.6 ms on the single shipped read that still touches the column, and it cannot be applied to an
existing database at all - `VACUUM (FULL, ANALYZE)`, the only remedy `docs/storage.md` allows and the
only one Fusion may not automate, re-inserts the same compressed chunks (identical chunk count, witness
still `pglz`); only a value-touching rewrite of every card's History re-toasts, which is a data
migration this card's contract excludes.*

Two secondary findings from the same table, both durable:

- **A storage-class change needs a value rewrite, not a table rewrite.** `ALTER ... SET STORAGE` is
  catalog-only (S1 changed zero bytes); `VACUUM FULL` copies existing TOAST by reference (S2 left the
  chunk count byte-for-byte identical). Anyone shipping a storage policy therefore ships a migration
  that does nothing on the installed base unless it also rewrites values.
- **`SET STORAGE PLAIN` is not a usable option and must not be tried.** PostgreSQL accepts the `ALTER`
  and then refuses every subsequent write to a fat row. A migration could pass CI on empty fixtures and
  break History appends in production.

The `TASK_LOG_RECENT_INLINE_BYTE_BUDGET` note in `task-log-projections.ts` also says why a *smaller*
policy is not the lever: the read fix is keeping the derived envelope under the 2 040-byte
toast-threshold, and that is already shipped as `log_recent` (905 649 bytes for 3 559 cards).

## Option 2: recorded as delivered, not re-priced

RUFU-312 (merged RUFU-304/309/310/311) shipped the reporter's option 2 as
`0093_rufu_312_task_log_entries.sql`: `project.task_log_entries` (append-only, `seq GENERATED ALWAYS AS
IDENTITY`, two indexes), `project.task_log_rollup`, `project.task_log_backfill_marker`, plus RLS and the
trigger requirements any new `project` table inherits; `0094` landed alongside. Measured effect from the
census above: appends now insert 796 370 side rows and HOT-update one rollup row per append
(151 445 HOT updates) while `tasks` took 591 540 cumulative updates in its whole pre-cutover life; the
board read that keeps no `log` runs in 13-15 ms. **No second side table, no new `task_log_*` table, no
backfill change, and no re-pricing here.** The cost side is honest too: History did not shrink, it
moved - `task_log_entries` is now 403 636 224 bytes (68.8 % of the four surfaces) and is the table worth
watching, not `tasks`.

## The priced residual: what the legacy column still costs

- **Bytes:** 53 101 171 stored (`pg_column_size`) = 42.9 % of live-row column payload, 34.9 % of the
  `tasks` TOAST relation, 29.4 % of `pg_total_relation_size('project.tasks')`, 9.1 % of the four
  surfaces summed. Per live card: ~17.5 KB.
- **Reclaim price, measured rather than estimated:** on the copy, `ALTER TABLE project.tasks DROP
  COLUMN log` reclaimed **zero** (it only marks `attisdropped`; plain `VACUUM` does not reclaim a dropped
  attribute's TOAST), and the following `VACUUM (FULL, ANALYZE)` (4.20 s on the copy) took the relation
  from 152 510 464 to 95 035 392 bytes = **57 475 072 bytes (54.8 MB) reclaimed**, i.e. the column's real
  relation cost is `pg_column_size` * 1.083 (TOAST chunk overhead). Scaled to the reference database
  that is ~ 57.5 MB, which is **0.8 % of its 7 062 MB** - the reason this is hygiene, not an emergency.
- **Readers that keep it alive** (counts across `packages/core`, `packages/dashboard`, `packages/engine`,
  `packages/cli`, sources and tests; commands in the appendix - a single-line grep silently under-counts
  because this repo writes `UPDATE project.tasks` and its `SET` clause on separate lines, so SQL literals
  are counted with whole-file multiline matching):
 - raw SQL touching the column: **7 files** (1 source: `task-store/async/async-task-log-shape.ts`;
    6 pg tests: `boot-backlog-attribution`, `overlap-wait-release`, `review-remediation-budget-fence`,
    `task-log-projections`, `task-log-shape-repair`, `hold-release-sweep-bench`)
 - Drizzle column references `tasks.log`: **32 refs in 26 files**; source-only naming
    `schema.project.tasks.log`: `task-store/audit-ops.ts`, `task-store/overlap-wait-ops.ts`,
    `task-store/task-log-entries.ts`
 - merge-path readers: `mergeTaskLogViews` 6 refs / 2 files, `latestEntryTimestamp` 4 / 2,
    `readTaskLogEntriesBatch` 6 / 2, `hydrateTaskLogEntries` 9 / 4, `pickTaskLogEnvelope` 14 / 6,
    `readTaskLogRollups` 6 / 3
 - the content-matching consumer that forces the retention: `hasAutoHealableVerificationBufferFailure`
    **18 refs / 7 files**
 - compound writers through `withTaskLogProjections`: **16 source call sites / 8 files**; the pairing
    test carries the seam list
 - descriptor and pairing tests naming the column: **8 test files**; `TASK_COLUMN_DESCRIPTORS` plus
    `task-log-side-table.pg.test.ts` and `task-log-projection-pairing.test.ts` are exactly what
    `docs/storage.md` predicts will name every remaining reader
 - storage-policy vocabulary in shipped schema and docs today: `SET STORAGE` 0, `attstorage` 0,
    "storage policy" 0 (migrations / task-store / docs) - option 1 was genuinely unpriced before this card
- **Price of step (b)** - the code change that stops merging the legacy prefix, estimate only, and
  deliberately **not implemented here**: touch set ~ `task-log-entries.ts` (merge + bounds), `reads.ts`
  and `async-persistence.ts` (per-row merge and lane choice), `task-id-integrity.ts` / `task-mutation-ops.ts`
  (detail read), `async-task-log-shape.ts`, the three source files above, the 6 pg tests, the descriptor
  set and the pairing test - about 15-18 source files plus fixtures. It must not regress: the five
  log-derived signals already read `timing_total_ms` / `log_recent`, so badges are safe; the marker-grepping
  consumers (`hasAutoHealableVerificationBufferFailure`, the stalled-review patterns, the
  `in-review-stall` envelope) must keep matching full text; and `cards_with_legacy_history` is **3 559 of
  3 559** today, so this is a "no card may lose History" migration, not a deletion of dead data. Step
  (c), the `DROP COLUMN` plus rewrite, stays an operator decision per `docs/storage.md`.
- **Recommendation:** schedule step (b) as its own task on read-complexity and correctness grounds (a
  per-row watermark that hides exactly the side-only entries is a live hazard, and
  `docs/storage.md` records a page-wide bound as a code-review P0), **not** for the ~57 MB. If it is
  scheduled, its acceptance must include the `docs/storage.md` safe order (a)->(b)->(c) and the operator
  rewrite, because without (c) the bytes are not returned at all.

## What would change this decision

1. A new read that consumes whole-history bytes per board refresh (option 1's CPU argument revives only
   if a shipped reader pays decompression per refresh, which today only the 29-row lane-role read does).
2. `shared_buffers` on the operator's database falling below the compressed History working set - at
   2 GB the whole 152 MB column is resident, so the I/O penalty measured at 128 MB does not apply there.
3. `cards_with_legacy_history` reaching 0, which makes step (b) a code deletion and returns ~57 MB
   through the operator rewrite.
4. A value-touching migration being explicitly scheduled - the only mechanism that can change the
   storage class of existing rows, and the one thing neither this card nor `docs/storage.md` authorises.

## Appendix: reproduction recipe

Scratch cluster (never the production embedded PostgreSQL, never a port another task owns, never 4040):
`pnpm pg:test:status` -> `FUSION_PG_TEST_URL_BASE=... pnpm pg:test:up` -> `pnpm pg:test:down`. On Darwin
`pg:test:up`/`down` are refused by design and `FUSION_PG_TEST_URL_BASE` must point at a locally operated
server (`scripts/pg-test-server.mjs` refuses non-local hosts and endpoint divergence).

```sql
-- C1 four storage surfaces
SELECT c.relname, c.reltuples::bigint AS est_rows,
       pg_relation_size(c.oid) AS heap_bytes, pg_indexes_size(c.oid) AS index_bytes,
       pg_total_relation_size(c.oid) AS total_bytes,
       CASE WHEN c.reltoastrelid = 0 THEN '-' ELSE c.reltoastrelid::regclass::text END AS toast_rel,
       CASE WHEN c.reltoastrelid = 0 THEN 0 ELSE pg_total_relation_size(c.reltoastrelid) END AS toast_bytes
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'project'
  AND c.relname IN ('tasks','task_log_entries','task_log_rollup','task_log_backfill_marker')
ORDER BY 1;

-- C2 write-path shape (which table the appends actually hit)
SELECT relname, n_live_tup, n_dead_tup, n_tup_ins, n_tup_upd, n_tup_hot_upd, n_tup_del
FROM pg_stat_user_tables
WHERE relname IN ('tasks','task_log_entries','task_log_rollup','task_log_backfill_marker') ORDER BY 1;

-- C3 per-column bytes carried by the task row
SELECT count(*) AS rows_all, sum(pg_column_size(t.*)) AS row_bytes,
       sum(coalesce(pg_column_size(log),0)) AS log_b,
       sum(coalesce(pg_column_size(log_recent),0)) AS log_recent_b,
       sum(coalesce(pg_column_size(source_metadata),0)) AS source_metadata_b,
       sum(coalesce(pg_column_size(workflow_step_results),0)) AS workflow_step_results_b,
       sum(coalesce(pg_column_size(comments),0)) AS comments_b,
       sum(coalesce(pg_column_size(steering_comments),0)) AS steering_comments_b,
       sum(coalesce(pg_column_size(description),0)) AS description_b,
       sum(coalesce(pg_column_size(search_vector),0)) AS search_vector_b
FROM project.tasks t;

-- C4 the policy, and the witness that proves what the code letter means
SELECT a.attname, format_type(a.atttypid,a.atttypmod) AS type, a.attstorage, t.typstorage AS type_default,
       (a.attstorage <> t.typstorage) AS differs_from_type_default
FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
WHERE a.attrelid = 'project.tasks'::regclass
  AND a.attname IN ('log','log_recent','source_metadata','workflow_step_results','search_vector') ORDER BY 1;
SELECT DISTINCT pg_column_compression(log) FROM (SELECT log FROM project.tasks LIMIT 200) s;

-- C5 data shapes, guarded against the non-array row (RUFU-615 records one live row of that shape)
SELECT count(*) AS rows_all,
       count(*) FILTER (WHERE jsonb_typeof(log) = 'array' AND jsonb_array_length(log) > 0) AS cards_with_legacy_history,
       count(*) FILTER (WHERE log IS NULL) AS log_null,
       count(*) FILTER (WHERE jsonb_typeof(log) = 'array' AND jsonb_array_length(log) = 0) AS log_empty_array,
       count(*) FILTER (WHERE log IS NOT NULL AND jsonb_typeof(log) <> 'array') AS log_non_array,
       count(*) FILTER (WHERE jsonb_typeof(log) = 'array' AND jsonb_array_length(log) >= 1000) AS log_at_cap,
       max(jsonb_array_length(log)) FILTER (WHERE jsonb_typeof(log) = 'array') AS max_entries,
       count(*) FILTER (WHERE deleted_at IS NOT NULL) AS soft_deleted
FROM project.tasks;

-- C6 legacy prefix vs side table, per card (why the merge bound is per row, not per page)
WITH legacy AS (
  SELECT t.id, max((entry ->> 'timestamp')) AS newest_legacy
  FROM project.tasks t, LATERAL jsonb_array_elements(t.log) AS entry
  WHERE jsonb_typeof(t.log) = 'array' GROUP BY t.id),
side AS (SELECT task_id, max("timestamp") AS newest_side FROM project.task_log_entries GROUP BY task_id)
SELECT count(*) AS cards_both,
       count(*) FILTER (WHERE s.newest_side IS NULL) AS cards_side_empty,
       count(*) FILTER (WHERE s.newest_side IS NOT NULL AND l.newest_legacy::timestamptz <  s.newest_side::timestamptz) AS cards_side_ahead,
       count(*) FILTER (WHERE s.newest_side IS NOT NULL AND l.newest_legacy::timestamptz >= s.newest_side::timestamptz) AS cards_legacy_ahead_or_equal
FROM legacy l JOIN side s ON s.task_id = l.id;

-- R1 read cost that is real: server-side detoast, per shape (EXPLAIN alone under-measures, see Method)
EXPLAIN (ANALYZE, BUFFERS) SELECT coalesce(sum(octet_length(t.log::text)),0), count(*)
  FROM project.tasks t WHERE t.deleted_at IS NULL;                       -- whole board that keeps log
EXPLAIN (ANALYZE, BUFFERS) SELECT coalesce(sum(octet_length(t.log::text)),0), count(*)
  FROM project.tasks t WHERE t.deleted_at IS NULL
    AND t."column" IN ('in-review','in-progress');                       -- the lane-role retention
EXPLAIN (ANALYZE, BUFFERS) SELECT coalesce(sum(octet_length(t.log::text)),0)
  FROM project.tasks t WHERE t.id = 'RUFU-634' AND t.deleted_at IS NULL; -- single-card detail read
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM project.tasks t WHERE t.deleted_at IS NULL; -- heap-only floor

-- R2 transfer cost, streamed, never written to disk
psql "$CONN" -c "COPY (SELECT * FROM project.tasks WHERE deleted_at IS NULL) TO STDOUT" | wc -c
psql "$CONN" -c "COPY (SELECT * FROM project.tasks WHERE deleted_at IS NULL) TO STDOUT" > /dev/null   # wall clock via TIMEFORMAT=%R

-- P1 option 1, stage by stage (scratch copy only; each stage re-runs C1/C3/C4 + R1)
ALTER TABLE project.tasks ALTER COLUMN log SET STORAGE EXTERNAL;  -- C1/C4 here prove: zero bytes changed
VACUUM (FULL, ANALYZE) project.tasks;                            -- chunk count identical => chunks copied by reference
UPDATE project.tasks SET log = log || '[]'::jsonb;               -- the only thing that re-toasts (321 MB WAL)
VACUUM (ANALYZE) project.tasks;                                  -- drop dead chunks, then re-measure
ALTER TABLE project.tasks ALTER COLUMN log SET STORAGE EXTENDED;
UPDATE project.tasks SET log = log || '[]'::jsonb; VACUUM (FULL, ANALYZE) project.tasks; -- reversibility check

-- X1 residual price of the safe order's step (c) - destructive, scratch copy, last stage
ALTER TABLE project.tasks DROP COLUMN log;  -- reclaims 0
VACUUM (FULL, ANALYZE) project.tasks;       -- reclaims 57 475 072 B on the copy
```

Reader census commands (whole-file multiline matching for SQL literals):

```bash
PKGS="packages/core packages/dashboard packages/engine packages/cli"
# multiline SQL (single-line greps under-count: UPDATE and SET sit on separate lines)
grep -rlE 'project\.tasks' $PKGS --include=*.ts --include=*.sql | xargs perl -0777 -ne \
  'print "$ARGV\n" if /UPDATE\s+project\.tasks\b[\s\S]{0,600}?\blog\b\s*=|\blog\b\s*=[^\n]*jsonb|INSERT\s+INTO\s+project\.tasks[\s\S]{0,400}?\(\s*[^)]*\blog\b/' | sort -u
grep -rn  'schema\.project\.tasks\.log\b\|tasks\.log\b' $PKGS --include=*.ts | grep -vE 'log_recent|log_projection_at' | wc -l
for s in mergeTaskLogViews latestEntryTimestamp readTaskLogEntriesBatch readTaskLogRollups pickTaskLogEnvelope hydrateTaskLogEntries withTaskLogProjections hasAutoHealableVerificationBufferFailure; do
  printf '%s refs=%s files=%s\n' "$s" \
    "$(grep -rn "\b$s\b" $PKGS --include=*.ts | wc -l)" "$(grep -rln "\b$s\b" $PKGS --include=*.ts | wc -l)"
done
for p in "SET STORAGE" "attstorage" "storage policy"; do
  printf '%s: migrations=%s task-store=%s docs=%s\n' "$p" \
    "$(grep -rl "$p" packages/core/src/postgres/migrations | wc -l)" \
    "$(grep -rl "$p" packages/core/src/task-store | wc -l)" "$(grep -rl "$p" docs | wc -l)"
done
```
