import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import { buildTaskInsertValues } from "../../task-store/async/async-persistence.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("TaskStore completed-task pagination", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_done_page" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("returns bounded, non-overlapping Done pages with an exact live total", async () => {
    const store = h.store();
    const first = await store.createTask({ description: "first done", column: "done" });
    const current = await store.createTask({ description: "current", column: "todo" });
    const second = await store.createTask({ description: "second done", column: "done" });
    const deleted = await store.createTask({ description: "deleted done", column: "done" });
    const third = await store.createTask({ description: "third done", column: "done" });
    await store.deleteTask(deleted.id);
    await Promise.all([
      [first.id, "2026-08-01T00:00:00.000Z"],
      [second.id, "2026-08-02T00:00:00.000Z"],
      [third.id, "2026-08-04T00:00:00.000Z"],
    ].map(([id, columnMovedAt]) => h.layer().db
      .update(schema.project.tasks)
      .set({ columnMovedAt })
      .where(eq(schema.project.tasks.id, id!))));

    const pageOne = await store.listCompletedTasks({ limit: 2, slim: true });
    const pageTwo = await store.listCompletedTasks({ limit: 2, cursor: pageOne.nextCursor!, slim: true });

    expect(pageOne.total).toBe(3);
    expect(pageOne.hasMore).toBe(true);
    expect(pageTwo.total).toBe(3);
    expect(pageTwo.hasMore).toBe(false);
    expect(pageOne.tasks).toHaveLength(2);
    expect(pageTwo.tasks).toHaveLength(1);
    expect([...pageOne.tasks, ...pageTwo.tasks].map((task) => task.id)).toEqual([
      third.id,
      second.id,
      first.id,
    ]);
    expect([...pageOne.tasks, ...pageTwo.tasks].map((task) => task.id)).not.toContain(current.id);
    expect([...pageOne.tasks, ...pageTwo.tasks].map((task) => task.id)).not.toContain(deleted.id);
  });

  it("pages every completed row beyond the former 200-item boundary for both sorts", async () => {
    const store = h.store();
    const rows = Array.from({ length: 205 }, (_, index) => {
      const id = `FN-${40000 + index}`;
      const timestamp = new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString();
      return buildTaskInsertValues({
        id,
        description: `historical delivery ${index}`,
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        columnMovedAt: timestamp,
      }, { lineageId: `lineage-${id}` }, h.layer().projectId);
    });
    await h.layer().db.insert(schema.project.tasks).values(rows as never);

    for (const sort of ["completion-date-desc", "task-id-desc"] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.listCompletedTasks({ limit: 50, cursor, sort });
        seen.push(...page.tasks.map((task) => task.id));
        expect(page.total).toBe(205);
        expect(page.counts.byColumn.done).toBe(205);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toHaveLength(205);
      expect(new Set(seen).size).toBe(205);
    }
  });

  it("keeps a newer live insertion out of an existing continuation and includes it after refresh", async () => {
    const store = h.store();
    const older = await store.createTask({ description: "older", column: "done" });
    const oldest = await store.createTask({ description: "oldest", column: "done" });
    await h.layer().db.update(schema.project.tasks).set({ columnMovedAt: "2026-09-01T00:00:00.000Z" }).where(eq(schema.project.tasks.id, older.id));
    await h.layer().db.update(schema.project.tasks).set({ columnMovedAt: "2026-08-01T00:00:00.000Z" }).where(eq(schema.project.tasks.id, oldest.id));
    const first = await store.listCompletedTasks({ limit: 1 });
    const newest = await store.createTask({ description: "newest live", column: "done" });
    await h.layer().db.update(schema.project.tasks).set({ columnMovedAt: "2026-10-01T00:00:00.000Z" }).where(eq(schema.project.tasks.id, newest.id));

    const continuation = await store.listCompletedTasks({ limit: 10, cursor: first.nextCursor! });
    expect(continuation.tasks.map((task) => task.id)).toContain(oldest.id);
    expect(continuation.tasks.map((task) => task.id)).not.toContain(newest.id);
    expect((await store.listCompletedTasks({ limit: 10 })).tasks.map((task) => task.id)).toContain(newest.id);
  });

  /*
  FNXC:TaskQueueOrder 2026-09-17-12:07:
  FN-509 removed the selectable task-id order from the LIVE Complete lane, so this case no longer has
  a sort mode to page through. What survives is the part that still matters: the single arrival order
  is applied in SQL before the keyset, and a cursor minted under the retired contract is refused
  rather than replayed into a different total order (which is what would produce gaps or duplicates).
  */
  it("pages the single arrival order in SQL and refuses a cursor from the retired contract", async () => {
    const store = h.store();
    const high = await store.createTaskWithReservedId(
      { description: "high id", column: "done" },
      { taskId: "FN-29520", applyDefaultWorkflowSteps: false },
    );
    const low = await store.createTaskWithReservedId(
      { description: "low id", column: "done" },
      { taskId: "FN-29503", applyDefaultWorkflowSteps: false },
    );
    const middle = await store.createTaskWithReservedId(
      { description: "middle id", column: "done" },
      { taskId: "FN-29511", applyDefaultWorkflowSteps: false },
    );

    const pageOne = await store.listCompletedTasks({ limit: 2 });
    const pageTwo = await store.listCompletedTasks({ limit: 2, cursor: pageOne.nextCursor! });
    const paged = [...pageOne.tasks, ...pageTwo.tasks].map((task) => task.id);

    // Every row appears exactly once across the two pages — no gap, no duplicate.
    expect(paged).toHaveLength(3);
    expect(new Set(paged).size).toBe(3);
    expect(new Set(paged)).toEqual(new Set([high.id, middle.id, low.id]));

    await expect(store.listCompletedTasks({ cursor: "not-a-cursor" }))
      .rejects.toThrow("Invalid completed-task cursor");

    // A v1 cursor carrying the retired sort is rejected rather than interleaved into the new order.
    const legacyCursor = Buffer.from(JSON.stringify({
      v: 1, projectId: "", sort: "task-id-desc", numericSuffix: "29520", id: high.id,
    }), "utf8").toString("base64url");
    await expect(store.listCompletedTasks({ cursor: legacyCursor }))
      .rejects.toThrow("Invalid completed-task cursor");

    const foreignPayload = JSON.parse(Buffer.from(pageOne.nextCursor!, "base64url").toString("utf8"));
    foreignPayload.projectId = "another-project";
    const foreignCursor = Buffer.from(JSON.stringify(foreignPayload), "utf8").toString("base64url");
    await expect(store.listCompletedTasks({ cursor: foreignCursor }))
      .rejects.toThrow("Invalid completed-task cursor");
  });

  it("reports exact column and workflow counts with absent selections on the effective default", async () => {
    const store = h.store();
    const inherited = await store.createTask({ description: "default workflow", column: "done" });
    const selected = await store.createTask({ description: "selected workflow", column: "done" });
    const [selectedRow] = await h.layer().db.select({ projectId: schema.project.tasks.projectId }).from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, selected.id));
    await h.layer().db.delete(schema.project.taskWorkflowSelection)
      .where(eq(schema.project.taskWorkflowSelection.taskId, inherited.id));
    await h.layer().db.update(schema.project.taskWorkflowSelection)
      .set({ workflowId: "WF-OTHER", updatedAt: "2026-09-08T00:00:00.000Z" })
      .where(and(
        eq(schema.project.taskWorkflowSelection.projectId, selectedRow!.projectId),
        eq(schema.project.taskWorkflowSelection.taskId, selected.id),
      ));

    const page = await store.listCompletedTasks();
    expect(page.counts.byColumn.done).toBe(2);
    expect(page.counts.byWorkflow["builtin:coding"]?.done).toBe(1);
    expect(page.counts.byWorkflow["WF-OTHER"]?.done).toBe(1);
    expect(page.tasks.map((task) => task.id)).toEqual(expect.arrayContaining([inherited.id, selected.id]));
  });

  it("keeps full-text search pages bounded and rejects a cursor from another query", async () => {
    const store = h.store();
    const rows = Array.from({ length: 21 }, (_, index) => {
      const id = `FN-${51000 + index}`;
      const timestamp = "2026-09-07T01:00:00.000Z";
      return buildTaskInsertValues({
        id, description: `searchable incident ${index}`, column: "todo", dependencies: [], steps: [], currentStep: 0, log: [],
        createdAt: timestamp, updatedAt: timestamp, columnMovedAt: timestamp,
      }, { lineageId: `lineage-${id}` }, h.layer().projectId);
    });
    await h.layer().db.insert(schema.project.tasks).values(rows as never);

    const first = await store.listCurrentTasksPage({ limit: 10, query: "searchable" });
    const second = await store.listCurrentTasksPage({ limit: 10, query: "searchable", cursor: first.nextCursor! });
    const third = await store.listCurrentTasksPage({ limit: 10, query: "searchable", cursor: second.nextCursor! });

    expect(first.total).toBe(21);
    expect([...first.tasks, ...second.tasks, ...third.tasks]).toHaveLength(21);
    expect(new Set([...first.tasks, ...second.tasks, ...third.tasks].map((task) => task.id)).size).toBe(21);
    await expect(store.listCurrentTasksPage({ limit: 10, query: "different", cursor: first.nextCursor! }))
      .rejects.toThrow("Invalid task list cursor");
  });

  it("ships board lanes without step bodies or summary while full store reads keep them", async () => {
    /*
    FNXC:BoardFeedCompaction 2026-09-17-14:49:
    The Board/search feed renders step identity/status only; reviewer bodies (output/notes/
    findings/priorAttempts) and the never-rendered summary were 61 % of the live Done-lane bytes.
    Pin all three feed guarantees in one pass: lanes and search drop the bodies, identity/timing
    survive for badges and the memo comparator, and engine-facing store reads stay byte-full.
    */
    const store = h.store();
    const task = await store.createTaskWithReservedId(
      { title: "Compaction probe", description: "compaction probe lane", column: "todo" },
      { taskId: "FN-51500", applyDefaultWorkflowSteps: false },
    );
    await h.layer().db.update(schema.project.tasks).set({
      summary: "board-invisible completion summary",
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "review",
        status: "failed",
        verdict: "REVISE",
        output: "reviewer body that the board never renders",
        notes: "reviewer notes body",
        findings: [{ severity: "high", detail: "body" }],
        priorAttempts: [{ workflowStepId: "code-review", workflowStepName: "Code Review", phase: "review", status: "failed", verdict: "REVISE", output: "older body" }],
        startedAt: "2026-09-17T00:00:00.000Z",
        completedAt: "2026-09-17T00:05:00.000Z",
      }],
    } as never).where(eq(schema.project.tasks.id, task.id));

    const lanePage = await store.listCurrentTasksPage({ limit: 10, columns: ["todo"] });
    const laneRow = lanePage.tasks.find((candidate) => candidate.id === task.id)!;
    const carried = laneRow.workflowStepResults?.[0] as Record<string, unknown> | undefined;
    expect(carried?.workflowStepId).toBe("code-review");
    expect(carried?.status).toBe("failed");
    expect(carried?.verdict).toBe("REVISE");
    expect(carried?.startedAt).toBe("2026-09-17T00:00:00.000Z");
    expect("output" in (carried ?? {})).toBe(false);
    expect("notes" in (carried ?? {})).toBe(false);
    expect("findings" in (carried ?? {})).toBe(false);
    expect("priorAttempts" in (carried ?? {})).toBe(false);
    expect(laneRow.summary).toBeUndefined();

    const searched = await store.listCurrentTasksPage({ limit: 10, query: "compaction probe" });
    const searchRow = searched.tasks.find((candidate) => candidate.id === task.id)!;
    expect(searchRow.workflowStepResults?.[0]?.output).toBeUndefined();
    expect(searchRow.summary).toBeUndefined();

    const [fullRow] = await store.listTasks({ slim: true, columns: ["todo"] });
    expect(fullRow.workflowStepResults?.[0]?.output).toContain("reviewer body");
    expect(fullRow.summary).toBe("board-invisible completion summary");
  });


  it("keeps literal suffix and punctuation membership exact across search pages", async () => {
    const store = h.store();
    const suffixRows = Array.from({ length: 12 }, (_, index) => {
      const id = `SEARCH-${index.toString().padStart(2, "0")}-52`;
      const timestamp = new Date(Date.UTC(2026, 8, 8, 0, 0, index)).toISOString();
      return buildTaskInsertValues({
        id, title: `Suffix result ${index}`, description: "pagination fixture", column: "todo", dependencies: [], steps: [], currentStep: 0, log: [],
        createdAt: timestamp, updatedAt: timestamp, columnMovedAt: timestamp,
      }, { lineageId: `lineage-${id}` }, h.layer().projectId);
    });
    await h.layer().db.insert(schema.project.tasks).values(suffixRows as never);
    await store.createTaskWithReservedId(
      { title: "retire de fichier txt", description: "plain punctuation fixture" },
      { taskId: "FN-901", applyDefaultWorkflowSteps: false },
    );
    await store.createTaskWithReservedId(
      { title: "Add the bonjour.txt file", description: "literal punctuation fixture" },
      { taskId: "FN-902", applyDefaultWorkflowSteps: false },
    );

    const first = await store.listCurrentTasksPage({ limit: 5, query: "52" });
    const second = await store.listCurrentTasksPage({ limit: 5, query: "52", cursor: first.nextCursor! });
    const third = await store.listCurrentTasksPage({ limit: 5, query: "52", cursor: second.nextCursor! });
    const suffixIds = [...first.tasks, ...second.tasks, ...third.tasks].map((task) => task.id);
    expect(first.total).toBe(12);
    expect(suffixIds).toHaveLength(12);
    expect(new Set(suffixIds).size).toBe(12);

    const punctuation = await store.listCurrentTasksPage({ limit: 5, query: ".TXT" });
    expect(punctuation.total).toBe(1);
    expect(punctuation.tasks.map((task) => task.id)).toEqual(["FN-902"]);
    await expect(store.listCurrentTasksPage({ limit: 5, query: "different", cursor: first.nextCursor! }))
      .rejects.toThrow("Invalid task list cursor");
  });

  it("continues current-task pages by an exclusive created-at and id cursor", async () => {
    const store = h.store();
    const rows = Array.from({ length: 205 }, (_, index) => {
      const id = `FN-${50000 + index}`;
      const timestamp = "2026-09-07T00:00:00.000Z";
      return buildTaskInsertValues({
        id, description: `current ${index}`, column: "todo", dependencies: [], steps: [], currentStep: 0, log: [],
        createdAt: timestamp, updatedAt: timestamp, columnMovedAt: timestamp,
      }, { lineageId: `lineage-${id}` }, h.layer().projectId);
    });
    await h.layer().db.insert(schema.project.tasks).values(rows as never);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listCurrentTasksPage({ limit: 50, cursor });
      expect(page.total).toBe(205);
      seen.push(...page.tasks.map((task) => task.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(205);
    expect(new Set(seen).size).toBe(205);
  });

  /*
  FNXC:BoardLanePagination 2026-09-10-19:26:
  Each Board column pages its own lane with a small page (RUFU-214). The lane scope has to be real —
  it must count only that column, keep other columns' rows (including completed ones) out of the
  page, and bind its cursor so a cursor cut for one column can never continue another column's page
  and silently drop rows in between.
  */
  it("cuts a Board page against one named lane and refuses a cursor cut for another lane", async () => {
    const store = h.store();
    for (let index = 0; index < 3; index += 1) {
      await store.createTask({ description: `review ${index}`, column: "in-review" });
    }
    for (let index = 0; index < 3; index += 1) {
      await store.createTask({ description: `todo ${index}`, column: "todo" });
    }
    await store.createTask({ description: "completed", column: "done" });

    const first = await store.listCurrentTasksPage({ limit: 2, columns: ["in-review"] });
    expect(first.total).toBe(3);
    expect(first.hasMore).toBe(true);
    expect(first.tasks).toHaveLength(2);
    expect(first.tasks.every((task) => task.column === "in-review")).toBe(true);

    const second = await store.listCurrentTasksPage({ limit: 2, columns: ["in-review"], cursor: first.nextCursor! });
    expect(second.total).toBe(3);
    expect(second.hasMore).toBe(false);
    expect(second.tasks).toHaveLength(1);
    expect(second.tasks[0]!.column).toBe("in-review");

    await expect(store.listCurrentTasksPage({ limit: 2, columns: ["todo"], cursor: first.nextCursor! }))
      .rejects.toThrow("Invalid task list cursor");
    await expect(store.listCurrentTasksPage({ limit: 2, cursor: first.nextCursor! }))
      .rejects.toThrow("Invalid task list cursor");
  });

  it("names more lanes than the board has columns only up to the bounded scope", async () => {
    const store = h.store();
    await store.createTask({ description: "todo", column: "todo" });

    await expect(store.listCurrentTasksPage({
      limit: 2,
      columns: Array.from({ length: 21 }, (_, index) => `lane-${index}`),
    })).rejects.toThrow("Invalid task list lane scope");

    const page = await store.listCurrentTasksPage({ limit: 2, columns: ["todo", "todo", " "] });
    expect(page.total).toBe(1);
    expect(page.tasks).toHaveLength(1);
  });

  /*
  FNXC:TaskSearchPagination 2026-09-17-08:46:
  FN-497 end-to-end symptom proof: the header search text lane must start at the most recently created
  match and keep getting older across every cursor page, with no duplicate and no lost row, while board
  table pagination (no query) stays ascending.
  */
  it("presents search pages newest-first and stays strictly descending across cursor pages", async () => {
    const store = h.store();
    const rows = Array.from({ length: 12 }, (_, index) => {
      const id = `FN-${53000 + index}`;
      const timestamp = new Date(Date.UTC(2026, 8, 1 + index)).toISOString();
      return buildTaskInsertValues({
        id, description: `recency fixture ${index}`, column: "todo", dependencies: [], steps: [], currentStep: 0, log: [],
        createdAt: timestamp, updatedAt: timestamp, columnMovedAt: timestamp,
      }, { lineageId: `lineage-${id}` }, h.layer().projectId);
    });
    await h.layer().db.insert(schema.project.tasks).values(rows as never);

    const seen: { id: string; createdAt: string }[] = [];
    let cursor: string | undefined;
    let total = 0;
    do {
      const page = await store.listCurrentTasksPage({ limit: 5, query: "recency", cursor });
      total = page.total;
      seen.push(...page.tasks.map((task) => ({ id: task.id, createdAt: task.createdAt })));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(total).toBe(12);
    expect(seen).toHaveLength(12);
    expect(new Set(seen.map((row) => row.id)).size).toBe(12);
    expect(seen[0]!.id).toBe("FN-53011");
    const timestamps = seen.map((row) => Date.parse(row.createdAt));
    expect(timestamps.every((value, index) => index === 0 || value < timestamps[index - 1]!)).toBe(true);
  });

  it("keeps board table pagination ascending when no query is supplied", async () => {
    const store = h.store();
    const rows = Array.from({ length: 12 }, (_, index) => {
      const id = `FN-${54000 + index}`;
      const timestamp = new Date(Date.UTC(2026, 8, 1 + index)).toISOString();
      return buildTaskInsertValues({
        id, description: `table fixture ${index}`, column: "todo", dependencies: [], steps: [], currentStep: 0, log: [],
        createdAt: timestamp, updatedAt: timestamp, columnMovedAt: timestamp,
      }, { lineageId: `lineage-${id}` }, h.layer().projectId);
    });
    await h.layer().db.insert(schema.project.tasks).values(rows as never);

    const page = await store.listCurrentTasksPage({ limit: 5 });
    const timestamps = page.tasks.map((task) => Date.parse(task.createdAt));
    expect(timestamps.every((value, index) => index === 0 || value >= timestamps[index - 1]!)).toBe(true);
  });

  it("returns no row and no cursor for a query without any match", async () => {
    const store = h.store();
    await store.createTask({ description: "unrelated fixture", column: "todo" });

    const page = await store.listCurrentTasksPage({ limit: 5, query: "zzzz-no-such-match-zzzz" });
    expect(page.tasks).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("breaks identical creation timestamps deterministically without duplicates across pages", async () => {
    const store = h.store();
    const timestamp = "2026-09-07T02:00:00.000Z";
    const rows = Array.from({ length: 9 }, (_, index) => {
      const id = `FN-${55000 + index}`;
      return buildTaskInsertValues({
        id, description: `tiebreak fixture ${index}`, column: "todo", dependencies: [], steps: [], currentStep: 0, log: [],
        createdAt: timestamp, updatedAt: timestamp, columnMovedAt: timestamp,
      }, { lineageId: `lineage-${id}` }, h.layer().projectId);
    });
    await h.layer().db.insert(schema.project.tasks).values(rows as never);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listCurrentTasksPage({ limit: 3, query: "tiebreak", cursor });
      seen.push(...page.tasks.map((task) => task.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it("rejects a search cursor issued for a different query", async () => {
    const store = h.store();
    const rows = Array.from({ length: 6 }, (_, index) => {
      const id = `FN-${56000 + index}`;
      const stamp = new Date(Date.UTC(2026, 8, 1 + index)).toISOString();
      return buildTaskInsertValues({
        id, description: `binding fixture ${index}`, column: "todo", dependencies: [], steps: [], currentStep: 0, log: [],
        createdAt: stamp, updatedAt: stamp, columnMovedAt: stamp,
      }, { lineageId: `lineage-${id}` }, h.layer().projectId);
    });
    await h.layer().db.insert(schema.project.tasks).values(rows as never);

    const first = await store.listCurrentTasksPage({ limit: 3, query: "binding" });
    expect(first.nextCursor).toBeTruthy();
    await expect(store.listCurrentTasksPage({ limit: 3, query: "other", cursor: first.nextCursor! }))
      .rejects.toThrow("Invalid task list cursor");
  });
  /*
  FNXC:BoardFeedCompaction 2026-09-27-20:52 (RUFU-378):
  The Done lane is a `TaskCard` surface fed by `GET /api/tasks/done`, and that route never went
  through `compactBoardFeedRow` even though the paged board feed had been compacting since 2026-09-17.
  Measured live: 2.35 MB for 50 Done cards (47 KB each), and in `GET /api/tasks` the Done lane alone
  carried 2.35 MB of step bodies plus 2.26 MB of `summary`. Pin the parity: the compacted Done page
  carries step identity/status and no bodies/summary, and the un-opted call keeps the full row.
  */
  it("compacts the Done lane to the board row shape and keeps the full row for callers that did not opt in", async () => {
    const store = h.store();
    const done = await store.createTaskWithReservedId(
      { title: "Done compaction probe", description: "done lane compaction", column: "done" },
      { taskId: "FN-51501", applyDefaultWorkflowSteps: false },
    );
    await h.layer().db.update(schema.project.tasks).set({
      summary: "done-lane summary the board never renders",
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "review",
        status: "approved",
        verdict: "APPROVE",
        output: "done-lane reviewer body",
        notes: "done-lane reviewer notes",
        findings: [{ severity: "low", detail: "body" }],
        priorAttempts: [{ workflowStepId: "code-review", workflowStepName: "Code Review", phase: "review", status: "failed", verdict: "REVISE", output: "older body" }],
        startedAt: "2026-09-27T00:00:00.000Z",
        completedAt: "2026-09-27T00:05:00.000Z",
      }],
    } as never).where(eq(schema.project.tasks.id, done.id));

    const compacted = (await store.listCompletedTasks({ limit: 50, slim: true, compactBoardFeed: true }))
      .tasks.find((candidate) => candidate.id === done.id)!;
    const carried = compacted.workflowStepResults?.[0] as Record<string, unknown> | undefined;
    expect(carried?.workflowStepId).toBe("code-review");
    expect(carried?.status).toBe("approved");
    expect(carried?.verdict).toBe("APPROVE");
    expect(carried?.completedAt).toBe("2026-09-27T00:05:00.000Z");
    expect("output" in (carried ?? {})).toBe(false);
    expect("notes" in (carried ?? {})).toBe(false);
    expect("findings" in (carried ?? {})).toBe(false);
    expect("priorAttempts" in (carried ?? {})).toBe(false);
    expect(compacted.summary).toBeUndefined();

    const full = (await store.listCompletedTasks({ limit: 50, slim: true }))
      .tasks.find((candidate) => candidate.id === done.id)!;
    expect(full.workflowStepResults?.[0]?.output).toContain("done-lane reviewer body");
    expect(full.summary).toBe("done-lane summary the board never renders");
  });
});
