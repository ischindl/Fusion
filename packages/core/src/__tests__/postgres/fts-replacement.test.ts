/**
 * Full-text search replacement (FTS5 → tsvector/GIN) PostgreSQL integration
 * tests (fts-replacement feature, U7).
 *
 * FNXC:TaskStoreSearch 2026-06-24-14:00:
 * Integration tests proving the PostgreSQL tsvector/GIN full-text search path
 * produces correct results and sync-on-write semantics, replacing the SQLite
 * FTS5 external-content tables (tasks_fts, archived_tasks_fts). Each test
 * creates a uniquely-named fresh database, applies the baseline schema
 * (which now includes the search_vector generated columns + GIN indexes), and
 * exercises the tsvector search helpers in async-search.ts.
 *
 * Coverage targets (the assertions fts-replacement fulfills):
 *   VAL-SEARCH-001 — Search parity with FTS5 baseline (row membership).
 *   VAL-SEARCH-002 — tsvector sync-on-write (insert): new task immediately searchable.
 *   VAL-SEARCH-003 — tsvector sync-on-write (update): text changes reflected immediately.
 *   VAL-SEARCH-004 — tsvector sync-on-write (delete): deleted task gone from search.
 *   VAL-SEARCH-005 — Archive search parity (row membership).
 *   VAL-SEARCH-006 — Non-text mutation does not regenerate the tsvector.
 *   VAL-SEARCH-007 — Index rebuild (REINDEX) restores search without data loss.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server.
 */

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import { insertTaskRow } from "../../task-store/async/async-persistence.js";
import {
  searchTasksTsvector,
  countSearchTasksTsvector,
  searchArchivedTasksTsvector,
  readTaskSearchVector,
  reindexTasksSearchVector,
  sanitizeSearchTokens,
} from "../../task-store/async/async-search.js";
import { searchArchivedTasks } from "../../async-stores/async-archive-db.js";
import { upsertArchivedTaskEntry } from "../../task-store/async/async-archive-lineage.js";
import type { ArchivedTaskEntry } from "../../types.js";

/*
FNXC:PgTestHarnessAdoption 2026-08-16-03:45:
Migrated off the hand-rolled per-test CREATE DATABASE + applySchemaBaseline scaffolding
(~3-4s of DDL per test) onto the shared PG harness: one template-cloned database per file
with TRUNCATE-based reset per test. The database setup here was scaffolding, not the
subject under test (the tsvector/GIN search path is), and every assertion is unchanged.
The DROP INDEX / REINDEX cases re-create the same index state they mutate, so they stay
safe on a per-file shared database.
*/
interface TestCtx {
  layer: AsyncDataLayer;
}

/** A minimal task record with the NOT NULL columns filled. */
function makeMinimalTask(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id,
    description: "test task description",
    column: "todo",
    currentStep: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Insert a task with the default serialization context (lineageId null). */
async function insertTask(
  layer: AsyncDataLayer,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await insertTaskRow(layer, makeMinimalTask(id, overrides), { lineageId: null });
}

/** Extract the set of task ids from search result rows. */
function resultIds(rows: Record<string, unknown>[]): string[] {
  return rows.map((r) => r.id as string).sort();
}

pgDescribe("fts-replacement: tsvector/GIN full-text search (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_fts_test",
  });
  let ctx: TestCtx;

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    ctx = { layer: h.layer() };
  });
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  // ── VAL-SEARCH-001: Search parity with FTS5 baseline (row membership) ──

  it("returns the same row membership as the FTS5 baseline for representative queries (VAL-SEARCH-001)", async () => {
    // Seed tasks with distinct searchable text.
    await insertTask(ctx.layer, "FTS-001", { title: "database migration guide" });
    await insertTask(ctx.layer, "FTS-002", { title: "frontend redesign" });
    await insertTask(ctx.layer, "FTS-003", { title: "database index optimization" });
    await insertTask(ctx.layer, "FTS-004", { title: "unrelated chore" });

    // Query "database" should match FTS-001 and FTS-003 (both have "database" in title).
    const dbResults = await searchTasksTsvector(ctx.layer.db, "database");
    expect(resultIds(dbResults)).toEqual(["FTS-001", "FTS-003"]);

    // Query "frontend" should match only FTS-002.
    const feResults = await searchTasksTsvector(ctx.layer.db, "frontend");
    expect(resultIds(feResults)).toEqual(["FTS-002"]);

    // Multi-term query "database optimization" uses OR semantics (to_tsquery
    // with | join), matching FTS5 baseline. Both FTS-001 ("database") and
    // FTS-003 ("database optimization") match.
    const multiResults = await searchTasksTsvector(ctx.layer.db, "database optimization");
    expect(resultIds(multiResults)).toEqual(["FTS-001", "FTS-003"]);

    // A term in description (not title) should also match.
    const descResults = await searchTasksTsvector(ctx.layer.db, "description");
    expect(descResults.length).toBe(4); // all have "description" in the description column
  });

  it("matches terms across id, title, description, and comments columns (VAL-SEARCH-001)", async () => {
    await insertTask(ctx.layer, "SEARCH-ID-1", { title: "alpha" });
    await insertTask(ctx.layer, "PLAIN-002", { title: "beta", comments: [{ text: "gamma delta notes" }] });

    // Match by id token.
    const idResults = await searchTasksTsvector(ctx.layer.db, "SEARCH-ID");
    expect(resultIds(idResults)).toEqual(["SEARCH-ID-1"]);

    // Match by comment text.
    const commentResults = await searchTasksTsvector(ctx.layer.db, "gamma");
    expect(resultIds(commentResults)).toEqual(["PLAIN-002"]);
  });

  // FNXC:TaskStoreSearch 2026-06-24-15:50:
  // Prefix matching regression test: "frob" must find "frobnicator" (FTS5 * parity).
  // to_tsquery with :* suffix reproduces FTS5's `${token}*` prefix token.
  it("prefix matching: partial token finds longer indexed term (VAL-SEARCH-001)", async () => {
    await insertTask(ctx.layer, "PREFIX-001", { title: "frobnicator setup" });
    await insertTask(ctx.layer, "PREFIX-002", { title: "database tuning" });

    // "frob" is a prefix of "frobnicator" — must match with :* prefix.
    const prefixResults = await searchTasksTsvector(ctx.layer.db, "frob");
    expect(resultIds(prefixResults)).toEqual(["PREFIX-001"]);

    // "data" is a prefix of "database" — must match both PREFIX-002 and FTS-001
    // if FTS-001 existed, here just the one.
    const dataResults = await searchTasksTsvector(ctx.layer.db, "data");
    expect(resultIds(dataResults)).toEqual(["PREFIX-002"]);
  });

  it("matches suffixes and preserves punctuation and SQL wildcard characters literally", async () => {
    await insertTask(ctx.layer, "FN-352", { title: "Dans la barre de recherche" });
    await insertTask(ctx.layer, "FN-901", { title: "retire de fichier txt" });
    await insertTask(ctx.layer, "FN-902", { title: "Add the bonjour.txt file" });
    await insertTask(ctx.layer, "FN-903", { title: "Keep 100%_literal coverage" });
    await insertTask(ctx.layer, "FN-904", { title: "Keep 100XXliteral coverage" });

    expect(resultIds(await searchTasksTsvector(ctx.layer.db, "52"))).toEqual(["FN-352"]);
    expect(resultIds(await searchTasksTsvector(ctx.layer.db, ".TXT"))).toEqual(["FN-902"]);
    expect(await countSearchTasksTsvector(ctx.layer.db, ".txt")).toBe(1);
    expect(resultIds(await searchTasksTsvector(ctx.layer.db, "%_"))).toEqual(["FN-903"]);
  });

  // ── VAL-SEARCH-002: tsvector sync-on-write (insert) ──

  it("newly inserted task is immediately searchable without explicit reindex (VAL-SEARCH-002)", async () => {
    // No tasks exist yet.
    const before = await searchTasksTsvector(ctx.layer.db, "freshly");
    expect(before).toEqual([]);

    // Insert a task and search immediately.
    await insertTask(ctx.layer, "NEW-001", { title: "freshly inserted task" });
    const after = await searchTasksTsvector(ctx.layer.db, "freshly");
    expect(resultIds(after)).toEqual(["NEW-001"]);
  });

  // ── VAL-SEARCH-003: tsvector sync-on-write (update) ──

  it("updated task text fields are reflected in search immediately (VAL-SEARCH-003)", async () => {
    await insertTask(ctx.layer, "UPD-001", { title: "original title" });

    // "renamed" not present initially.
    const before = await searchTasksTsvector(ctx.layer.db, "renamed");
    expect(before).toEqual([]);

    // Update the title to include a new searchable term.
    await ctx.layer.db
      .update(schema.project.tasks)
      .set({ title: "renamed title" })
      .where(eq(schema.project.tasks.id, "UPD-001"));

    // Now searchable by the new term.
    const after = await searchTasksTsvector(ctx.layer.db, "renamed");
    expect(resultIds(after)).toEqual(["UPD-001"]);

    // And no longer the only match for "original" (it was replaced, but
    // "title" still tokenizes). Actually "original" should no longer match
    // because the title changed. Verify it's gone.
    const oldTerm = await searchTasksTsvector(ctx.layer.db, "original");
    expect(resultIds(oldTerm)).toEqual([]);
  });

  // ── VAL-SEARCH-004: tsvector sync-on-write (delete) ──

  it("soft-deleted task no longer appears in live search (VAL-SEARCH-004)", async () => {
    await insertTask(ctx.layer, "DEL-001", { title: "to be deleted searchable" });
    await insertTask(ctx.layer, "DEL-002", { title: "to be deleted keeper" });

    // Both match "deleted" initially.
    const before = await searchTasksTsvector(ctx.layer.db, "deleted");
    expect(resultIds(before)).toEqual(["DEL-001", "DEL-002"]);

    // Soft-delete DEL-001 (sets deleted_at). Live search excludes it.
    const now = new Date().toISOString();
    await ctx.layer.db
      .update(schema.project.tasks)
      .set({ deletedAt: now })
      .where(eq(schema.project.tasks.id, "DEL-001"));

    const after = await searchTasksTsvector(ctx.layer.db, "deleted");
    expect(resultIds(after)).toEqual(["DEL-002"]);
  });

  it("hard-deleted task row is gone from search (VAL-SEARCH-004)", async () => {
    await insertTask(ctx.layer, "HARD-001", { title: "hard delete target" });

    const before = await searchTasksTsvector(ctx.layer.db, "target");
    expect(resultIds(before)).toEqual(["HARD-001"]);

    await ctx.layer.db
      .delete(schema.project.tasks)
      .where(eq(schema.project.tasks.id, "HARD-001"));

    const after = await searchTasksTsvector(ctx.layer.db, "target");
    expect(after).toEqual([]);
  });

  // ── VAL-SEARCH-005: Archive search parity ──

  it("archived-task search returns matching rows via tsvector (VAL-SEARCH-005)", async () => {
    const baseEntry = (id: string, title: string, description: string) =>
      ({
        id,
        title,
        description,
        archivedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) as unknown as ArchivedTaskEntry;

    await upsertArchivedTaskEntry(ctx.layer.db, baseEntry("ARC-001", "legacy migration notes", "old desc"));
    await upsertArchivedTaskEntry(ctx.layer.db, baseEntry("ARC-002", "frontend refactor", "old desc"));
    await upsertArchivedTaskEntry(ctx.layer.db, baseEntry("ARC-003", "legacy cleanup", "old desc"));

    const results = await searchArchivedTasksTsvector(ctx.layer.db, "legacy", 10);
    expect(resultIds(results)).toEqual(["ARC-001", "ARC-003"]);

    // FNXC:TaskStoreSearch 2026-06-25-10:35:
    // Multi-term OR semantics (FTS5 parity). The tsquery joins sanitized tokens
    // with ` | ` (OR) and applies `:*` prefix matching per token, reproducing
    // the SQLite FTS5 baseline (see buildTsqueryFragment in async-search.ts).
    // So "legacy cleanup" matches any archived row whose tsvector contains
    // "legacy" OR "cleanup": ARC-001 ("legacy migration notes") and ARC-003
    // ("legacy cleanup"). This mirrors VAL-SEARCH-001 multi-term OR recall.
    const multi = await searchArchivedTasksTsvector(ctx.layer.db, "legacy cleanup", 10);
    expect(resultIds(multi)).toEqual(["ARC-001", "ARC-003"]);
  });

  // ── VAL-SEARCH-006: Non-text mutation does not regenerate tsvector ──

  it("a mutation touching only non-text columns leaves search_vector unchanged (VAL-SEARCH-006)", async () => {
    await insertTask(ctx.layer, "VEC-001", { title: "stable title text" });

    // Read the initial search_vector value.
    const svBefore = await readTaskSearchVector(ctx.layer.db, "VEC-001");
    expect(svBefore).not.toBeNull();
    // The vector should contain the title tokens.
    expect(svBefore).toContain("'stable'");

    // Update ONLY a non-text column (status + updated_at). The search_vector
    // generated column depends only on id/title/description/comments, so this
    // mutation must NOT regenerate it.
    await ctx.layer.db
      .update(schema.project.tasks)
      .set({ status: "in-progress", updatedAt: new Date().toISOString() })
      .where(eq(schema.project.tasks.id, "VEC-001"));

    const svAfter = await readTaskSearchVector(ctx.layer.db, "VEC-001");
    expect(svAfter).toBe(svBefore); // byte-identical — no regeneration
  });

  it("a mutation touching a text column DOES regenerate the tsvector (VAL-SEARCH-006 inverse)", async () => {
    await insertTask(ctx.layer, "VEC-002", { title: "before change" });

    const svBefore = await readTaskSearchVector(ctx.layer.db, "VEC-002");
    expect(svBefore).toContain("'before'");

    await ctx.layer.db
      .update(schema.project.tasks)
      .set({ title: "after change" })
      .where(eq(schema.project.tasks.id, "VEC-002"));

    const svAfter = await readTaskSearchVector(ctx.layer.db, "VEC-002");
    expect(svAfter).not.toBe(svBefore);
    expect(svAfter).toContain("'after'");
    expect(svAfter).not.toContain("'before'");
  });

  // ── VAL-SEARCH-007: Index rebuild restores search ──

  it("REINDEX on the GIN index restores correct search without data loss (VAL-SEARCH-007)", async () => {
    await insertTask(ctx.layer, "RIDX-001", { title: "reindex probe alpha" });
    await insertTask(ctx.layer, "RIDX-002", { title: "reindex probe beta" });

    const baseline = await searchTasksTsvector(ctx.layer.db, "reindex");
    expect(resultIds(baseline)).toEqual(["RIDX-001", "RIDX-002"]);

    // Force index bloat by deleting and reinserting many rows, then REINDEX.
    // This simulates the operator maintenance path. The generated-column data
    // is unaffected; only the index is rebuilt.
    for (let i = 0; i < 20; i++) {
      await ctx.layer.db
        .delete(schema.project.tasks)
        .where(eq(schema.project.tasks.id, `BOGUS-${i}`));
    }
    await reindexTasksSearchVector(ctx.layer.db, false);

    // Search still returns correct results after rebuild — no data loss.
    const after = await searchTasksTsvector(ctx.layer.db, "reindex");
    expect(resultIds(after)).toEqual(["RIDX-001", "RIDX-002"]);

    // Count is also correct.
    const count = await countSearchTasksTsvector(ctx.layer.db, "probe");
    expect(count).toBe(2);
  });

  it("DROP + re-CREATE the GIN index restores search (VAL-SEARCH-007 alternate)", async () => {
    await insertTask(ctx.layer, "DROP-001", { title: "drop recreate search" });

    // Drop the index (simulating corruption/missing index).
    await ctx.layer.db.execute(sql`DROP INDEX IF EXISTS "idxTasksSearchVector"`);

    // Recreate it from the existing generated-column data.
    await ctx.layer.db.execute(
      sql`CREATE INDEX IF NOT EXISTS "idxTasksSearchVector" ON project.tasks USING gin(search_vector)`,
    );

    const results = await searchTasksTsvector(ctx.layer.db, "recreate");
    expect(resultIds(results)).toEqual(["DROP-001"]);
  });

  // ── Helpers / edge cases ──

  it("empty and whitespace queries return no results (no crash)", async () => {
    await insertTask(ctx.layer, "EDGE-001", { title: "something" });

    expect(await searchTasksTsvector(ctx.layer.db, "")).toEqual([]);
    expect(await searchTasksTsvector(ctx.layer.db, "   ")).toEqual([]);
    expect(await searchTasksTsvector(ctx.layer.db, "\t\n")).toEqual([]);
  });

  it("sanitizeSearchTokens strips FTS5 operators", () => {
    // The function splits on whitespace, then strips FTS5 operator chars
    // ("{}:*^+()) from each token. Note: '-' is NOT stripped (not in the set),
    // so "-not" survives as a token. This mirrors the sync path exactly.
    expect(sanitizeSearchTokens('"quoted term"')).toEqual(["quoted", "term"]);
    expect(sanitizeSearchTokens('+must (group)')).toEqual(["must", "group"]);
    expect(sanitizeSearchTokens("")).toEqual([]);
    expect(sanitizeSearchTokens("   ")).toEqual([]);
  });

  // ========================================================================
  // FNXC:TaskStoreSearch 2026-11-18-02:19 (RUFU-680):
  // The recall half of the search contract, asserted at the lane level. Every case below is the shape the old
  // rule made impossible: a punctuated token SITTING BESIDE a word. `isLiteralOnlySearchQuery` used to fire on
  // ANY punctuation anywhere, which discarded the tsvector arm for the WHOLE query, so membership collapsed to
  // one `%whole query%` substring match. No card contains a whole query verbatim, so the honest answer was `[]`
  // - and the caller above, the mandatory pre-create duplicate scan, reads an empty result as "no duplicate
  // exists" and files a duplicate card.
  //
  // Membership here is read through `searchTasksTsvector`, the lane that applies `buildTaskSearchPredicate`.
  // It ranks by `ts_rank` only when a tsquery exists, so a punctuated query that lost its lexical arm also lost
  // its ordering, which the density case below makes observable.
  // ========================================================================

  /** Seed cards that together carry the query's words but never hold the query as one contiguous sentence. */
  async function seedRecallCorpus(): Promise<void> {
    await insertTask(ctx.layer, "R680-A", { title: "long term MEMORY.md consolidation", description: "agent memory file" });
    await insertTask(ctx.layer, "R680-B", { title: "budget over budget gate", description: "planning lane" });
    await insertTask(ctx.layer, "R680-C", { title: "memory and consolidation reporting", description: "token spend" });
    await insertTask(ctx.layer, "R680-D", { title: "an unrelated chore", description: "nothing here matches" });
  }

  it("RUFU-680 answers a punctuated multi-word query and supersedes the same query spaced out", async () => {
    await seedRecallCorpus();

    const punctuated = await searchTasksTsvector(ctx.layer.db, "memory long-term budget over budget consolidation", { limit: 100 });
    const spaced = await searchTasksTsvector(ctx.layer.db, "memory long term budget over budget consolidation", { limit: 100 });

    // The measured symptom: this row of the table answered `[]` / "No tasks matched".
    expect(punctuated.length).toBeGreaterThan(0);
    // The invariant that makes the symptom structurally impossible: punctuation may not narrow the result set
    // below the same words written without it.
    const punctuatedIds = new Set(punctuated.map((row) => row.id as string));
    for (const row of spaced) expect(punctuatedIds.has(row.id as string)).toBe(true);
  });

  it("RUFU-680 keeps the ranked lane and its own count in agreement per query", async () => {
    await seedRecallCorpus();

    for (const q of ["memory long-term consolidation", "memory consolidation", ".txt", "% _"]) {
      const ranked = await searchTasksTsvector(ctx.layer.db, q, { limit: 100 });
      const counted = await countSearchTasksTsvector(ctx.layer.db, q);
      expect(counted, `count for ${JSON.stringify(q)}`).toBe(ranked.length);
    }
  });

  it("RUFU-680 ranks a punctuated query instead of answering it unranked", async () => {
    /*
    Pre-fix this lane built no tsquery for a punctuated query, so it ordered by the `length(id) * 0` constant
    placeholder and the card that merely mentions the words could come back first. With the lexical arm restored,
    `ts_rank` decides and the denser card leads. R2 is seeded BEFORE R1 so a createdAt tie-break cannot be what
    puts R1 first.
    */
    await insertTask(ctx.layer, "R680-R2", {
      title: "weekly reporting",
      description:
        "Routine weekly reporting across the team, including standup notes, sprint grooming, oncall handoff, " +
        "release packaging, and one passing mention of the memory budget consolidation gate.",
    });
    await insertTask(ctx.layer, "R680-R1", {
      title: "memory budget consolidation",
      description: "memory budget consolidation for the memory budget lane",
    });

    const ranked = await searchTasksTsvector(ctx.layer.db, "memory long-term budget consolidation", { limit: 100 });
    expect(ranked.length).toBeGreaterThanOrEqual(2);
    expect(ranked[0]!.id).toBe("R680-R1");
  });

  it("RUFU-680 keeps one punctuated token exact while the multi-token form reaches its fragments", async () => {
    await insertTask(ctx.layer, "R680-SPLIT", { title: "RUFU and 276 mentioned apart", description: "split token trap" });
    await insertTask(ctx.layer, "R680-EXACT", { title: "RUFU-276 exact token", description: "the real card" });

    // ONE punctuated raw token: the whole string is the search term, so it may not be fragment-broadened.
    expect(resultIds(await searchTasksTsvector(ctx.layer.db, "RUFU-276", { limit: 100 }))).toEqual(["R680-EXACT"]);
    // The same token typed as a multi-word query IS lexical and does reach the split-token card.
    expect(resultIds(await searchTasksTsvector(ctx.layer.db, "RUFU-276 exact token", { limit: 100 }))).toEqual([
      "R680-EXACT",
      "R680-SPLIT",
    ]);
  });

  it("RUFU-680 answers a lexeme-less query literally and never as bare wildcards", async () => {
    await seedRecallCorpus();

    // `% _` yields no letters or digits, so it stays literal-only with its LIKE wildcards escaped. Were that
    // guard to lapse, both of these would read as wildcards matching every row on the board.
    expect(await searchTasksTsvector(ctx.layer.db, "% _", { limit: 100 })).toEqual([]);
    expect(await searchTasksTsvector(ctx.layer.db, "%_", { limit: 100 })).toEqual([]);
  });

  it("RUFU-680 answers injection-shaped queries without raising SQL or admitting an operator expression", async () => {
    await seedRecallCorpus();

    /*
    Measured against this same cluster: `to_tsquery('simple', 'zzz:* | | memory:*')` and
    `to_tsquery('simple', 'a!<>&|:* | memory:*')` both raise `syntax error in tsquery`. So "did not raise" is a
    real assertion here and not a tautology - it goes red the moment a metacharacter reaches the tsquery string
    instead of being decided by the plan. `%_` is the LIKE half of the same guard.
    */
    const hostile = ["a|b memory", "%_", "x:* y", "a!<>&| memory", "memory <-> nonesuch"];
    for (const q of hostile) {
      await expect(searchTasksTsvector(ctx.layer.db, q, { limit: 100 }), `rank(${q})`).resolves.toBeInstanceOf(Array);
      await expect(countSearchTasksTsvector(ctx.layer.db, q), `count(${q})`).resolves.toBeTypeOf("number");
      await expect(searchArchivedTasks(ctx.layer.db, q, 100), `archive(${q})`).resolves.toBeInstanceOf(Array);
    }

    /*
    A leaked NOT arm would make `memory !nonesuchzzz` match every card LACKING that word, i.e. the whole board
    including the unrelated chore. Asserting that every returned row really carries the word is what proves the
    operator authored no tsquery expression - the `!` was decided by the plan, not handed to PostgreSQL.
    */
    const negated = await searchTasksTsvector(ctx.layer.db, "memory !nonesuchzzz", { limit: 100 });
    expect(negated.length).toBeGreaterThan(0);
    for (const row of negated) {
      expect(`${row.id} ${row.title} ${row.description}`.toLowerCase()).toContain("memory");
    }
  });

  it("RUFU-680 gives an archived card the membership the live board gives the same query", async () => {
    const entry = (id: string, title: string, description: string) =>
      ({
        id,
        title,
        description,
        archivedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) as unknown as ArchivedTaskEntry;

    /*
    The SAME card is placed in both tables, plus a non-matching card in both, so parity is a two-way check on
    identical input: if either lane applies its own membership rule, the two id sets differ. That is the
    RUFU-312 invariant, and it is exactly what a one-sided edit to only the live or only the archive predicate
    breaks.
    */
    const title = "long term MEMORY.md consolidation";
    const description = "agent memory file";
    await insertTask(ctx.layer, "P680-MATCH", { title, description });
    await insertTask(ctx.layer, "P680-NOMATCH", { title: "an unrelated chore", description: "nothing here matches" });
    await upsertArchivedTaskEntry(ctx.layer.db, entry("P680-MATCH", title, description));
    await upsertArchivedTaskEntry(ctx.layer.db, entry("P680-NOMATCH", "an unrelated chore", "nothing here matches"));

    const q = "memory long-term consolidation";
    const liveIds = resultIds(await searchTasksTsvector(ctx.layer.db, q, { limit: 100 }));
    const archiveIds = resultIds(await searchArchivedTasks(ctx.layer.db, q, 100));
    expect(liveIds).toEqual(["P680-MATCH"]);
    expect(archiveIds).toEqual(liveIds);
  });
});
