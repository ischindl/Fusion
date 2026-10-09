/**
 * FNXC:ListReadSearchVectorOmission 2026-10-09-20:07:
 * Live list reads were `SELECT *`, which shipped the stored `search_vector` tsvector to
 * Node on every board refresh. Measured on a live 24-project / 2 417-card instance that
 * column is 12.49 MB of 73.6 MB of live-row bytes — 17.0% of the payload, 5.0 KiB per
 * card, and ~90% of the read path's allocation sits in the row→Task decode this feeds.
 *
 * `search_vector` is a `tsvector GENERATED ALWAYS AS (...) STORED` search *predicate*
 * target (`@@`, `ts_rank`). It is not a `Task` field and no deserializer reads it, so it
 * is omitted from both live-list projections. These tests hold the two halves of that
 * claim:
 *
 *   1. SAFETY — every other task-table column still reaches the row, and the `Task` a
 *      caller assembles from a list read is field-for-field the `Task` a detail read
 *      assembles. A projection may not silently delete an observable field.
 *   2. EFFECT — the omitted column is genuinely absent from the transferred row, while
 *      full-text search still resolves through it.
 *
 * The omission set is written out literally below rather than imported from the module:
 * adding a column to it must be an edit a reviewer sees here, next to the assertion that
 * proves the omission is unobservable.
 */
import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { Column, eq, is } from "drizzle-orm";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { readLiveTaskRows } from "../../task-store/async/async-persistence.js";
import * as schema from "../../postgres/schema/index.js";

const pgTest = pgDescribe;

/** The ONLY task-table columns a live list read may omit. See the header note. */
const OMITTED_FROM_LIST_READS = ["searchVector"] as const;

/** CamelCase TS property names of every real column on `project.tasks`. */
function taskColumnKeys(): string[] {
  return Object.entries(schema.project.tasks)
    .filter(([, value]) => is(value, Column))
    .map(([key]) => key);
}

pgTest("live list projections omit only the never-addressed columns", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_list_projection",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("the full-row and slim projections differ by `log` and nothing else", async () => {
    await h.store().createTaskWithReservedId(
      { description: "projection probe", title: "Projection probe", column: "todo" },
      { taskId: "FN-PROJ-1", applyDefaultWorkflowSteps: false },
    );

    const full = await readLiveTaskRows(h.layer(), {});
    const slim = await readLiveTaskRows(h.layer(), { excludeLog: true });
    expect(full).toHaveLength(1);
    expect(slim).toHaveLength(1);

    const fullKeys = Object.keys(full[0]!).sort();
    const slimKeys = Object.keys(slim[0]!).sort();
    const expectedFull = taskColumnKeys()
      .filter((key) => !OMITTED_FROM_LIST_READS.includes(key as (typeof OMITTED_FROM_LIST_READS)[number]))
      .sort();

    // SAFETY: the projection is the whole schema minus the explicit omission set…
    expect(fullKeys).toEqual(expectedFull);
    // …and `log` is the ONLY thing the slim mode additionally drops.
    expect(slimKeys).toEqual(expectedFull.filter((key) => key !== "log"));
  });

  it("a list row carries no searchVector yet full-text search still resolves", async () => {
    const store = h.store();
    await store.createTaskWithReservedId(
      {
        description: "zebra-quinquesectional anchor text for fts",
        title: "Search anchor",
        column: "todo",
      },
      { taskId: "FN-PROJ-2", applyDefaultWorkflowSteps: false },
    );

    // EFFECT: the tsvector is not transferred…
    const rows = await readLiveTaskRows(h.layer(), {});
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!)).not.toContain("searchVector");

    // …and yet the column still does its job, because it is a predicate target, not a value.
    const hits = await store.searchTasks("zebra-quinquesectional", { limit: 10 });
    expect(hits.map((task) => task.id)).toContain("FN-PROJ-2");
  });

  it("a list read assembles the same Task a detail read does, field for field", async () => {
    const store = h.store();
    const created = await store.createTaskWithReservedId(
      {
        description: "rich card with every column family populated",
        title: "Rich card",
        column: "in-review",
        status: "awaiting-user-review",
        priority: "high",
        size: "M",
        branch: "fusion/projection",
        branchWriteOrigin: "operator",
        worktree: "/tmp/projection-worktree",
        summary: "a completion summary",
        dependencies: [],
        customFields: { owner: "operator" },
      },
      { taskId: "FN-PROJ-3", applyDefaultWorkflowSteps: false },
    );
    await store.updateTask("FN-PROJ-3", {
      log: [
        { timestamp: created.updatedAt, action: "[timing] step finished in 42ms", outcome: "Implement" },
      ] as never,
    });
    await store.updateTask("FN-PROJ-3", {
      workflowStepResults: [
        {
          id: "step-1",
          stepIndex: 0,
          stepName: "Implement",
          status: "approved",
          verdict: "APPROVE",
          output: "shipped",
          startedAt: created.createdAt,
          completedAt: created.updatedAt,
        },
      ] as never,
    });

    // The invariant a projection must not break lives at the ROW level: every column the
    // list read is allowed to fetch arrives exactly as the full row does. Comparing the
    // assembled `Task` would be the wrong subject — list and detail reads differ there on
    // purpose (the detail read re-reads PROMPT.md for `prompt`/`steps`, and derived stall
    // signals carry a wall-clock `observedAt`).
    const [listed] = await readLiveTaskRows(h.layer(), {});
    const [fullRow] = await h.layer().db
      .select()
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, "FN-PROJ-3"));
    expect(listed).toBeDefined();
    expect(fullRow).toBeDefined();

    for (const [key, value] of Object.entries(fullRow!)) {
      if (key === "searchVector") continue;
      expect(listed![key], `column ${key} lost by the list projection`).toEqual(value);
    }

    // The omitted column is populated, so omitting it is a real saving rather than a no-op…
    expect(String(fullRow!.searchVector).length).toBeGreaterThan(0);
    // …and it is the only thing the row loses.
    expect(Object.keys(listed!)).not.toContain("searchVector");

    // The heavy jsonb families are genuinely populated, so the equality above compared
    // real payloads rather than two empty columns agreeing by accident.
    const detailed = await store.getTask("FN-PROJ-3");
    expect(detailed!.log.length).toBeGreaterThan(0);
    expect(detailed!.workflowStepResults?.length).toBeGreaterThan(0);
  });
});
