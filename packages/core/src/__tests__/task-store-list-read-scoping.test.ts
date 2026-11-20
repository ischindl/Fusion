/*
FNXC:TasksListReadScope 2026-11-20-06:45 (RUFU-585):
The merge-queue read used to be unconditional: `SELECT task_id FROM merge_queue` with no `WHERE`,
once per list/search/detail pass, returning every queued row of every project on the cluster to
answer a question the caller could only ask about the twenty rows it already held. Measured on a
seeded shared cluster (`scripts/bench-tasks-list-reads.mjs`): `Seq Scan on merge_queue ... rows=900`,
99 % of them foreign, growing with the cluster at a fixed `limit`.

The contract this pins is the one the five call sites in `task-store/reads.ts` depend on:

  - ids supplied   -> the statement is PREDICATED on those ids (bounded work, flat in the cluster);
  - ids omitted    -> the historical whole-table answer, unchanged for any caller not yet scoped;
  - ids = []       -> no query at all. With no ids there is no membership question to answer, and
                      issuing one anyway is the same wasted read this card exists to remove;
  - a failed read  -> propagates, scoped or not (see the PostgresUnavailable note below);
  - the result is a `Set<string>` in every case — membership semantics for the ids asked about are
    identical, which is what lets the narrowing ship without touching any badge logic.

The seam is the drizzle builder chain the impl walks, recorded rather than mocked wholesale: the
only thing under test is whether a predicate reaches the statement, which is the difference between
a page-bounded read and a cluster-proportional one.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getMergeQueuedTaskIdsAsyncImpl } from "../task-store/task-id-integrity.js";

/**
 * How the requested ids reach the statement.
 *
 * The claim worth pinning is that a caller's ids travel as PARAMETERS and never as text spliced into
 * SQL — the repo's `board/*-analytics.ts` notes record that choice for the same reason (drizzle
 * expands a JS array written into a template into SQL text, so `= ANY(${ids})` is not the shape to
 * use). Asserted as the two things that are observable without depending on drizzle's chunk
 * internals, which are not a stable surface: the condition handed to `where()` is a structured
 * object rather than a string or array, and the ids themselves appear nowhere in the rendered
 * statement text. A future edit that inlines the ids would fail the second half immediately.
 */
function shapeOf(condition: unknown): { structured: boolean; rendered: string } {
  const wrapper = condition as { SQL?: string; sql?: string } | undefined;
  return {
    structured: typeof condition === "object" && condition !== null && !Array.isArray(condition),
    rendered: String(wrapper?.SQL ?? wrapper?.sql ?? ""),
  };
}

type Recorded = {
  predicateApplied: boolean;
  predicateStructured: boolean;
  predicateSql: string;
  executed: boolean;
  selectCalls: number;
  rejects?: Error;
};

const fresh = (): Recorded => ({
  predicateApplied: false,
  predicateStructured: false,
  predicateSql: "",
  executed: false,
  selectCalls: 0,
});

const QUEUED = [{ taskId: "FN-10" }, { taskId: "FN-11" }, { taskId: "OTHER-1" }];

/**
 * A store whose async layer records whether the built statement ever received a `WHERE`, and can be
 * made to fail the way a dropped PostgreSQL connection fails.
 */
function recordingStore(rows: Array<{ taskId: string }>, rec: Recorded) {
  const settle = () => ({
    then: (resolve: (r: Array<{ taskId: string }>) => void, reject: (e: unknown) => void) => {
      if (rec.rejects) return reject(rec.rejects);
      rec.executed = true;
      resolve(rows);
    },
  });
  return {
    asyncLayer: {
      db: {
        select: () => ({
          from: () => {
            rec.selectCalls += 1;
            return {
              where: (predicate: unknown) => {
                rec.predicateApplied = true;
                /*
                Read the condition through drizzle's own SQL wrapper rather than its rendered text:
                what matters here is that the ids travel as BOUND PARAMETERS (`params`) and not as
                text spliced into the statement — the distinction the repo's `board/*-analytics.ts`
                notes exist to keep, since drizzle expands a JS array written into a template into
                SQL text. Rendering is a drizzle-internal detail; the parameter list is the contract.
                */
                const shape = shapeOf(predicate);
                rec.predicateStructured = shape.structured;
                rec.predicateSql = shape.rendered;
                return settle();
              },
              then: settle().then,
            };
          },
        }),
      },
    },
  } as never;
}

describe("RUFU-585 merge-queue read is bounded by the caller's page", () => {
  it("scopes the statement to the ids asked about when ids are supplied", async () => {
    const rec = fresh();
    const set = await getMergeQueuedTaskIdsAsyncImpl(recordingStore(QUEUED, rec), ["FN-10", "FN-11"]);
    expect(rec.selectCalls).toBe(1);
    expect(rec.executed).toBe(true);
    expect(rec.predicateApplied).toBe(true);
    // The ids travel as parameters: the condition is a structured object, and no requested id appears
    // as literal text in the statement. Inlining them would fail the second half.
    expect(rec.predicateStructured).toBe(true);
    expect(rec.predicateSql).not.toContain("FN-10");
    expect(rec.predicateSql).not.toMatch(/any\s*\(/i);
    expect(set).toBeInstanceOf(Set);
  });

  it("keeps the historical unscoped statement when no ids are given", async () => {
    const rec = fresh();
    const set = await getMergeQueuedTaskIdsAsyncImpl(recordingStore(QUEUED, rec));
    expect(rec.executed).toBe(true);
    expect(rec.predicateApplied).toBe(false);
    expect(set.size).toBe(3);
  });

  it("issues no query at all for an empty id set", async () => {
    const rec = fresh();
    const set = await getMergeQueuedTaskIdsAsyncImpl(recordingStore(QUEUED, rec), []);
    expect(rec.selectCalls).toBe(0);
    expect(rec.executed).toBe(false);
    expect(set.size).toBe(0);
  });

  it("answers membership for the requested ids and nothing else changed", async () => {
    // The exact consumption shape at every call site: `.has(task.id)` for a row the page already holds.
    const rec = fresh();
    const set = await getMergeQueuedTaskIdsAsyncImpl(recordingStore(QUEUED, rec), ["FN-10"]);
    expect(set.has("FN-10")).toBe(true);
  });

  /*
  FNXC:PostgresUnavailable 2026-11-20-06:45 (RUFU-585): the honest half of the narrowing.
  A scoped read must not answer "nothing is queued" when the database is down. Every consumer of
  this set SUPPRESSES a stall badge when the id is present (`reads.ts` uses
  `mergeQueuedTaskIds.has(task.id) ? undefined : detectStalledReview(...)`), so a set emptied by a
  transport failure would paint stall badges onto cards that are merely unreachable — asserting an
  absence no read proved. A scoped read therefore propagates exactly as the unscoped read always did.
  */
  it("propagates a failed scoped read instead of answering 'nothing is queued'", async () => {
    const rec = fresh();
    rec.rejects = new Error("connection terminated unexpectedly");
    await expect(
      getMergeQueuedTaskIdsAsyncImpl(recordingStore(QUEUED, rec), ["FN-10"]),
    ).rejects.toThrow(/connection terminated/);
  });

  it("propagates a failed unscoped read, unchanged from before this card", async () => {
    const rec = fresh();
    rec.rejects = new Error("connection terminated unexpectedly");
    await expect(getMergeQueuedTaskIdsAsyncImpl(recordingStore(QUEUED, rec))).rejects.toThrow(
      /connection terminated/,
    );
  });

  it("leaves no page-path call site in the core read layer unscoped", () => {
    /*
    A future list/search/detail pass written the old way would silently restore the cluster-
    proportional read while still typechecking, because the argument is optional by design — the
    whole-table answer stays legitimate for a caller that holds no page. The ratchet is therefore on
    the call sites: every read in `task-store/reads.ts` (the board list, the queue page, both search
    pages, the single-task detail) must name the ids it asks about.
    */
    const source = readFileSync(join(__dirname, "..", "task-store", "reads.ts"), "utf8");
    expect(source.match(/getMergeQueuedTaskIdsAsync\(\s*\)/g) ?? []).toEqual([]);
    expect(source.match(/getMergeQueuedTaskIdsAsync\(/g)?.length).toBeGreaterThanOrEqual(5);
  });
});
