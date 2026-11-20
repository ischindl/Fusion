/*
FNXC:TasksListReadIndex 2026-11-20-06:45 (RUFU-585):
The page comparator and its index are three separate declarations of ONE expression, written in
three files that no compiler links:

  1. `task-store/async/async-persistence.ts` — `numericTaskSuffix`, the `ORDER BY` the board page
     read actually issues (and the keyset-cursor comparator beside it).
  2. `postgres/schema/project.ts` — `idxTasksProjectLiveCreatedId`, built for a FRESH database.
  3. `postgres/migrations/0098_rufu_585_tasks_list_read_index.sql` — the same index, built on an
     UPGRADED database.

If any one of the three drifts, nothing fails: the query stays correct, the database keeps an
index that no query matches, and the ordered page walk silently reverts to the project-blind
`idxTasksCreatedAt` scan that removes other projects' rows by filter (measured on a shared
cluster: 230 rows removed at `limit=20`, 5 450 across 1 599 buffers at `limit=600`, against 5 and
47 buffers with the matching index). A silent reversion is the failure mode, so the pairing is
pinned here rather than hoped for.

WHY THIS IS A SOURCE-CONTRACT GUARD AND NOT A `EXPLAIN` ASSERTION — stated because the obvious
test is the one deliberately not written. `scripts/bench-tasks-list-reads.mjs` measured that
PostgreSQL only SELECTS this index once the board's project is a MINORITY of `tasks` (chosen at
0.25 % of the cluster's live rows, declined at 10 % where it mispriced 1 097 against 1 272 while
real times were 4.8 ms against 1.1 ms). A pg test seeds rows into ONE project, i.e. a 100 % share,
which is exactly the shape in which the planner honestly declines the index — so a plan-shape
assertion in the pg lane would assert a choice the planner does not make and would fail for a
reason that has nothing to do with the invariant. The growth and plan numbers therefore live in
the bench, which seeds foreign projects through `--foreign` and prints the real
`EXPLAIN (ANALYZE, BUFFERS)` output; what belongs in a deterministic test is the pairing the bench
cannot check: that all three declarations still name one expression. Comments and prose are never
asserted — only the executable expressions themselves.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CORE_SRC = join(__dirname, "..");

/** Collapse whitespace so a reflow of a wrapped SQL template cannot fail a contract it did not change. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function read(...parts: string[]): string {
  return readFileSync(join(CORE_SRC, ...parts), "utf8");
}

/** The `sql\`…\`` fragment a declaration builds its index/comparator on, captured verbatim. */
function sqlTemplate(source: string, anchor: RegExp, label: string): string {
  const match = source.match(anchor);
  if (!match?.[1]) throw new Error(`No ${label} declaration found — the contract has moved, not just drifted.`);
  return normalize(match[1]);
}

/** The comparator as PostgreSQL sees it, with every template-interpolated column reference reduced to `id`. */
const CANONICAL_COMPARATOR = "COALESCE(substring(id from '-([0-9]+)$')::numeric, 0)";

/**
 * Reduce a declaration to the SQL PostgreSQL receives. The page read interpolates
 * `${schema.project.tasks.id}` and the schema declaration interpolates `${t.id}`, both of which
 * drizzle renders to the bare `id` column; the migration is already literal SQL. Reducing all three
 * to one spelling compares the EXPRESSIONS instead of the host-language syntax around them.
 */
function canonical(expr: string): string {
  return normalize(expr.replace(/\$\{[^}]*\.id\}/g, "id"));
}

describe("RUFU-585 page comparator and its index are one expression", () => {
  const persistence = read("task-store", "async", "async-persistence.ts");
  const schemaProject = read("postgres", "schema", "project.ts");
  const migration = read(
    "postgres",
    "migrations",
    "0098_rufu_585_tasks_list_read_index.sql",
  );

  const comparator = sqlTemplate(
    persistence,
    /const numericTaskSuffix = sql`([^`]*)`/,
    "`numericTaskSuffix` page comparator",
  );
  const schemaIndex = sqlTemplate(
    schemaProject,
    /index\("idxTasksProjectLiveCreatedId"\)\s*\.on\([^)]*sql`([^`]*)`\)/,
    "fresh-database index declaration",
  );
  const migrationIndex = normalize(
    migration.match(/COALESCE\(substring\(id from[\s\S]*?::numeric, 0\)/)?.[0] ?? "",
  );

  it("the page read sorts on the numeric task-id suffix, not on the id text", () => {
    // The JS comparator `readLiveTaskRows` breaks arrival-order ties on the NUMERIC suffix, so an
    // index on `id` alone would not serve it and the page would sort.
    expect(canonical(comparator)).toBe(CANONICAL_COMPARATOR);
    expect(comparator).toContain("::numeric");
  });

  it("the fresh-database index carries the SAME expression the page read orders by", () => {
    expect(canonical(schemaIndex)).toBe(canonical(comparator));
  });

  it("the upgrade migration carries the SAME expression, so an upgraded cluster is not left unindexed", () => {
    // Both halves of the pair must exist: `schema/project.ts` only serves a FRESH database, and an
    // upgraded cluster — the shape every long-lived operator runs — is migrated.
    expect(migrationIndex).not.toBe("");
    expect(canonical(migrationIndex)).toBe(canonical(comparator));
    // The leading columns are what removes the foreign-row burn; an index carrying only the tie-break
    // would sort correctly and still walk every project's rows.
    expect(normalize(migration)).toMatch(
      /ON project\.tasks \( project_id, created_at, COALESCE\(substring\(id from '-\(\[0-9\]\+\)\$'\)::numeric, 0\) \) WHERE deleted_at IS NULL;/,
    );
  });

  it("both index declarations are partial on live rows, matching ACTIVE_TASK_FILTER", () => {
    // A non-partial index would keep indexing tombstones: soft-deleted rows are excluded from every
    // board read, so the index would grow without serving anything.
    expect(schemaProject).toMatch(
      /index\("idxTasksProjectLiveCreatedId"\)[\s\S]{0,220}?\.where\(sql`\$\{t\.deletedAt\} IS NULL`\)/,
    );
    expect(normalize(migration)).toMatch(/WHERE deleted_at IS NULL;$/);
  });

  it("the migration is registered, because an unwired .sql in migrations/ silently never runs", () => {
    const applier = read("postgres", "schema-applier.ts");
    expect(applier).toMatch(/export const TASKS_LIST_READ_INDEX_VERSION = "0098"/);
    expect(applier).toMatch(
      /TASKS_LIST_READ_INDEX_MIGRATION_PATH = join\(MIGRATIONS_DIR, "0098_rufu_585_tasks_list_read_index\.sql"\)/,
    );
    expect(applier).toMatch(/applied\.includes\(TASKS_LIST_READ_INDEX_VERSION\)/);
    // The ceiling must move with the file, or every boot reads the database this binary just
    // migrated as newer than the binary and logs the stale-binary warning.
    expect(applier).toMatch(/export const SCHEMA_BASELINE_VERSION = "0098"/);
  });
});
