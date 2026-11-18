/**
 * FNXC:SqliteFinalRemoval 2026-06-25-11:00:
 * PostgreSQL-backed counterpart of the searchTasks portions of
 * store-create.test.ts and store-parsing.test.ts. Validates the public
 * TaskStore.searchTasks() facade against the PostgreSQL backend mode,
 * exercising the full tsvector -> pgRowToTaskRow -> rowToTask -> hydration
 * stack (the low-level tsvector helpers are covered by fts-replacement.test.ts;
 * this file validates the facade glue and derived-field hydration).
 *
 * Migrated from `new TaskStore(rootDir, globalDir, { inMemoryDb: true })`
 * (SQLite) to `createSharedPgTaskStoreTestHarness` (PostgreSQL).
 */
import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("TaskStore.searchTasks facade (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_search",
    projectId: "search-project",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });

  it("empty/whitespace query falls back to listTasks (returns all live tasks)", async () => {
    const store = h.store();
    await store.createTask({ description: "alpha beta" });
    await store.createTask({ description: "gamma delta" });

    const empty = await store.searchTasks("");
    expect(empty.length).toBe(2);

    const whitespace = await store.searchTasks("   ");
    expect(whitespace.length).toBe(2);
  });

  it("matches a term in description and returns hydrated Task objects", async () => {
    const store = h.store();
    await store.createTask({ description: "Migrate the database layer" });
    await store.createTask({ description: "Redesign the frontend" });

    const results = await store.searchTasks("database");
    expect(results.length).toBe(1);
    expect(results[0].description).toContain("database");
    // Hydrated derived fields are present (not undefined crashes).
    expect(results[0].retrySummary).toBeDefined();
  });

  it("matches a term in title", async () => {
    const store = h.store();
    await store.createTask({ title: "Frobnicator setup", description: "setup the frob" });
    await store.createTask({ title: "Unrelated", description: "nothing here" });

    const results = await store.searchTasks("frobnicator");
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Frobnicator setup");
  });

  it("excludes soft-deleted tasks from search results", async () => {
    const store = h.store();
    const keep = await store.createTask({ description: "searchable keeper term" });
    const drop = await store.createTask({ description: "searchable dropper term" });
    await store.deleteTask(drop.id);

    const results = await store.searchTasks("searchable");
    const ids = results.map((t) => t.id);
    expect(ids).toContain(keep.id);
    expect(ids).not.toContain(drop.id);
  });

  it("slim mode strips the log payload", async () => {
    const store = h.store();
    await store.createTask({ description: "slim log probe target" });

    const full = await store.searchTasks("slim");
    expect(full.length).toBe(1);

    const slim = await store.searchTasks("slim", { slim: true });
    expect(slim.length).toBe(1);
    expect(slim[0].log).toEqual([]);
  });

  it("prefix matching: partial token finds longer indexed term", async () => {
    const store = h.store();
    await store.createTask({ title: "frobnicator install", description: "install the frob" });

    const results = await store.searchTasks("frob");
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("frobnicator install");
  });

  it("matches an ID suffix and treats punctuation as literal membership", async () => {
    const store = h.store();
    await store.createTaskWithReservedId(
      { title: "Dans la barre de recherche", description: "suffix fixture" },
      { taskId: "FN-352", applyDefaultWorkflowSteps: false },
    );
    await store.createTaskWithReservedId(
      { title: "retire de fichier txt", description: "plain token fixture" },
      { taskId: "FN-901", applyDefaultWorkflowSteps: false },
    );
    await store.createTaskWithReservedId(
      { title: "Add the bonjour.txt file", description: "punctuation fixture" },
      { taskId: "FN-902", applyDefaultWorkflowSteps: false },
    );
    await store.createTaskWithReservedId(
      { title: "foo", description: "metacharacter false-positive fixture" },
      { taskId: "FN-903", applyDefaultWorkflowSteps: false },
    );

    expect((await store.searchTasks("52")).map((task) => task.id)).toEqual(["FN-352"]);
    expect((await store.searchTasks(".TXT")).map((task) => task.id)).toEqual(["FN-902"]);
    expect(await store.searchTasks("foo*")).toEqual([]);
  });

  /*
  FNXC:TaskStoreSearch 2026-11-18-02:19 (RUFU-680) — the symptom, asserted through THIS facade.
  `fn_task_search` travels through `store.searchTasks()`, and the defect it hit was the mandatory pre-create
  duplicate scan: a query containing a hyphen, a dot, a slash or a bracket was answered from one
  `%whole query%` substring match, returned zero rows, and the agent filed a duplicate card because an empty
  result is what it reads as "no duplicate exists". Everything below runs through the same call the tool makes,
  not through the lower-level helper, so a fix that only patched a lane the tool does not use cannot pass.
  */
  it("RUFU-680 symptom: answers a punctuated multi-word query through the searchTasks facade", async () => {
    const store = h.store();
    // Three fixtures that together carry the query's words but never contain the query as one sentence.
    await store.createTask({ title: "Konsolidovať long term MEMORY.md agent", description: "batched memory" });
    await store.createTask({ title: "budget over budget consolidation", description: "planning lane" });
    await store.createTask({ title: "memory budget reporting", description: "token spend" });
    await store.createTask({ title: "unrelated chore", description: "nothing to do with memory" });

    const punctuated = await store.searchTasks(
      "memory long-term budget over budget consolidation",
    );
    const spaced = await store.searchTasks("memory long term budget over budget consolidation");

    const punctuatedIds = punctuated.map((task) => task.id);
    const spacedIds = spaced.map((task) => task.id);

    // The measured symptom was `[]` / "No tasks matched" for the punctuated row of the table.
    expect(punctuatedIds.length).toBeGreaterThan(0);
    // The invariant that makes an empty answer structurally impossible for a query whose words are on cards:
    // punctuation may not narrow the result set below the same query written without it.
    for (const id of spacedIds) expect(punctuatedIds).toContain(id);
  });

  it("RUFU-680 keeps the single punctuated token contract while widening only the multi-token shape", async () => {
    const store = h.store();
    await store.createTaskWithReservedId(
      { title: "RUFU carries the word and 276 the number", description: "split-token trap" },
      { taskId: "FN-6801", applyDefaultWorkflowSteps: false },
    );
    await store.createTaskWithReservedId(
      { title: "Real RUFU-276 duplicate scan", description: "exact token" },
      { taskId: "FN-6802", applyDefaultWorkflowSteps: false },
    );

    // `RUFU-276` is ONE punctuated raw token: it must match the card carrying that exact string and must NOT
    // broaden onto the card that merely carries `RUFU` and `276` as separate words.
    expect((await store.searchTasks("RUFU-276")).map((task) => task.id)).toEqual(["FN-6802"]);
    // The same words as a MULTI-token query do reach the split-token card: that is the recall this change adds.
    const split = (await store.searchTasks("RUFU-276 duplicate scan")).map((task) => task.id);
    expect(split).toContain("FN-6801");
    expect(split).toContain("FN-6802");
  });

  it("RUFU-680 keeps the cold-index LIKE fallback suppressed for a literal-only query and live for a multi-token one", async () => {
    const store = h.store();
    /*
    `comments` is no longer in the tsvector (migration 0094 narrowed it to title + description), so a word that
    exists ONLY in a comment is invisible to the primary GIN arm and to every literal arm unless it is typed
    contiguously. Whatever answers for it can therefore only have come from the LIKE fallback, which makes the
    fallback-gate semantics observable rather than asserted from the code shape.
    */
    const commentOnly = await store.createTask({ title: "comment-only carrier", description: "board text" });
    await store.addComment(commentOnly.id, { text: "memory and consolidation live only here" });

    // Literal-only (one punctuated raw token): the gate holds, and the fallback may not re-read it tokenized.
    expect(await store.searchTasks("nothingmatches_this")).toEqual([]);

    // Multi-token punctuated: the gate must NOT apply. The primary lexical and literal arms find nothing in
    // title/description, so only an unsuppressed fallback can surface this card.
    const viaFallback = (await store.searchTasks("memory long-term consolidation")).map((t) => t.id);
    expect(viaFallback).toContain(commentOnly.id);
  });

  it("RUFU-680 answers the board search page with the same membership the facade gives", async () => {
    const store = h.store();
    /*
    The fixture deliberately carries the query's words WITHOUT containing the query contiguously, so the
    page lane cannot pass by falling back to a `%whole query%` substring hit. Before this change the search box
    answered this query with zero rows; a pin that passed at base would not have been a guard.
    */
    await store.createTask({ title: "memory probe against long term retention", description: "board lane" });
    await store.createTask({ title: "unrelated", description: "neither word" });

    const page = await store.listCurrentTasksPage({ query: "long-term memory probe", limit: 20 });
    expect(page.tasks.map((task) => task.title)).toContain("memory probe against long term retention");

    const bySearch = await store.searchTasks("long-term memory probe");
    expect(bySearch.map((task) => task.title)).toContain("memory probe against long term retention");
  });
});
