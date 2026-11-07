/*
FNXC:TaskListReadProjectScope 2026-11-07-01:34 (RUFU-871):
`project.tasks` is one table shared by every project and partitioned by `project_id`, and
task identity is project-local — the same id legitimately exists in several partitions. A
store bound to one project that omits the partition from a LIST read therefore hydrates
other projects' cards: the low-heap census measured 72,815 hydrated task-row objects
against 3,167 `tasks` rows in a 25-project database, the retained strings belonging to
projects the serving process had no business reading.

These tests seed TWO projects with colliding ids in one database and hold the boundary.
The harness connects as the table owner, so forced RLS is bypassed and every app-level
predicate is load-bearing here — exactly the shape `project-ownership-runtime-scope.pg.test.ts`
relies on for the satellite tables. The unbound layer must keep reading across projects:
that is the documented project-agnostic (analytics / migration) contract, not an accident.
*/
import { afterEach, beforeAll, afterAll, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import * as schema from "../../postgres/schema/index.js";
import { TaskStore } from "../../store.js";
import {
  buildTaskInsertValues,
  countLiveTasks,
  readLiveTaskRows,
} from "../../task-store/async/async-persistence.js";
import {
  clearTransitionPendingAsync,
  listTransitionPendingTaskIdsAsync,
  readTransitionPendingAsync,
} from "../../task-store/async/async-transition-pending.js";
import { makeTransitionPending } from "../../tasks/transition-types.js";
import { DEFAULT_WORKFLOW_POOL_ID } from "../../workflows/workflow-capacity.js";

const pgTest = pgDescribe;

const PROJECT_A = "list-scope-a";
const PROJECT_B = "list-scope-b";

/** A past stamp so the stranded-refinement age gate is satisfied without any waiting. */
const OLD_ISO = "2026-01-01T00:00:00.000Z";

pgTest("task list reads are scoped to the store's project", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_task_list_project_scope",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);

  /** A layer over the harness session with a project binding grafted on. */
  const bind = (projectId: string): AsyncDataLayer => ({ ...h.layer(), projectId });
  const storeFor = (layer: AsyncDataLayer): TaskStore =>
    new TaskStore(h.rootDir(), undefined, { asyncLayer: layer });

  /** Seed one task row into `projectId`'s partition (ids collide across partitions on purpose). */
  const seedTask = async (
    projectId: string,
    id: string,
    overrides: Record<string, unknown> = {},
  ): Promise<void> => {
    const { transitionPending, ...record } = overrides;
    const values = buildTaskInsertValues({
      id,
      description: `scoped read ${projectId}/${id}`,
      column: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: OLD_ISO,
      updatedAt: OLD_ISO,
      ...record,
    }, { lineageId: `lineage-${projectId}-${id}` }, projectId);
    // `transition_pending` is not a serialization-descriptor column, so it travels
    // beside the descriptor output rather than through it.
    await h.layer().db.insert(schema.project.tasks).values({
      ...values,
      projectId,
      ...(transitionPending === undefined ? {} : { transitionPending }),
    } as never);
  };

  const seedSelection = async (projectId: string, taskId: string, workflowId: string): Promise<void> => {
    await h.layer().db.insert(schema.project.taskWorkflowSelection).values({
      projectId,
      taskId,
      workflowId,
      updatedAt: OLD_ISO,
    } as never);
  };

  it("the board list read, the raw list read, and the live count stay in one project", async () => {
    await seedTask(PROJECT_A, "FN-SCOPE-1");
    await seedTask(PROJECT_B, "FN-SCOPE-1");
    await seedTask(PROJECT_B, "FN-SCOPE-2");

    const a = bind(PROJECT_A);
    const b = bind(PROJECT_B);
    const unbound: AsyncDataLayer = { ...h.layer(), projectId: undefined };

    expect((await readLiveTaskRows(a, {})).map((row) => String(row.projectId)))
      .toEqual([PROJECT_A]);
    expect(await countLiveTasks(a)).toBe(1);
    expect(await countLiveTasks(b)).toBe(2);

    expect((await storeFor(a).listTasks()).map((task) => task.id)).toEqual(["FN-SCOPE-1"]);
    expect((await storeFor(b).listTasks()).map((task) => task.id)).toEqual([
      "FN-SCOPE-1",
      "FN-SCOPE-2",
    ]);

    // The deliberate project-agnostic reader still sees every partition.
    expect(await countLiveTasks(unbound)).toBe(3);
  });

  it("the stranded-refinement list read stays in one project", async () => {
    await seedTask(PROJECT_A, "FN-REFINE-1", { column: "triage", sourceType: "task_refine" });
    await seedTask(PROJECT_B, "FN-REFINE-1", { column: "triage", sourceType: "task_refine" });
    await seedTask(PROJECT_B, "FN-REFINE-2", { column: "triage", sourceType: "task_refine" });

    const strandedForA = await storeFor(bind(PROJECT_A))
      .listStrandedRefinements({ freshnessThresholdMs: 0 });

    expect(strandedForA.map((item) => item.task.id)).toEqual(["FN-REFINE-1"]);
    // Proof the foreign rows were really present: the same query across both partitions is 3.
    const strandedUnscoped = await storeFor({ ...h.layer(), projectId: undefined } as AsyncDataLayer)
      .listStrandedRefinements({ freshnessThresholdMs: 0 });
    expect(strandedUnscoped).toHaveLength(3);
  });

  it("the capacity candidate scan counts only this project's occupants", async () => {
    /*
     * A: two default-pool occupants (no selection row) and one whose only colliding
     *    selection row belongs to B.
     * B: the same two ids, one of them carrying a selection row for another workflow,
     *    plus a third occupant.
     * A correct scan counts A's two. Without the WHERE scope it counts B's rows too;
     * without the project-correlated join, A's own occupant is stolen by B's selection
     * row and lands in the wrong pool. Either half failing changes the answer.
     */
    await seedTask(PROJECT_A, "FN-CAP-1", { column: "in-progress" });
    await seedTask(PROJECT_A, "FN-CAP-2", { column: "in-progress" });
    await seedTask(PROJECT_B, "FN-CAP-1", { column: "in-progress" });
    await seedTask(PROJECT_B, "FN-CAP-2", { column: "in-progress" });
    await seedTask(PROJECT_B, "FN-CAP-3", { column: "in-progress" });
    await seedSelection(PROJECT_B, "FN-CAP-1", "wf-foreign-pool");

    const a = bind(PROJECT_A);
    const counted = await a.transaction(async (tx) => storeFor(a).countActiveInCapacitySlotAsync({
      tx,
      targetColumn: "in-progress",
      workflowId: DEFAULT_WORKFLOW_POOL_ID,
      countPending: true,
      excludeTaskId: "FN-NOT-SEEDED",
    }));
    expect(counted).toBe(2);

    const b = bind(PROJECT_B);
    const countedForB = await b.transaction(async (tx) => storeFor(b).countActiveInCapacitySlotAsync({
      tx,
      targetColumn: "in-progress",
      workflowId: DEFAULT_WORKFLOW_POOL_ID,
      countPending: true,
      excludeTaskId: "FN-NOT-SEEDED",
    }));
    // B's FN-CAP-1 sits in the `wf-foreign-pool` bucket, not the default one.
    expect(countedForB).toBe(2);
  });

  it("the pending-marker scan, read, and clear stay inside the bound partition", async () => {
    const markerToInProgress = JSON.stringify(
      makeTransitionPending("in-progress", ["default-workflow:postCommit"], Date.now()),
    );
    const markerToReview = JSON.stringify(
      makeTransitionPending("in-review", ["default-workflow:postCommit"], Date.now()),
    );
    await seedTask(PROJECT_A, "FN-PEND-1", { transitionPending: markerToInProgress });
    await seedTask(PROJECT_B, "FN-PEND-1", { transitionPending: markerToReview });

    const a = bind(PROJECT_A);
    const b = bind(PROJECT_B);

    // The scan names the colliding id once per partition: a bound scan yields one entry.
    expect(await listTransitionPendingTaskIdsAsync(a.db, PROJECT_A)).toEqual([
      "FN-PEND-1",
    ]);
    const unboundScan = await listTransitionPendingTaskIdsAsync(h.layer().db, undefined);
    expect(unboundScan).toEqual(["FN-PEND-1", "FN-PEND-1"]);

    // The by-id read must answer with THIS partition's marker, not whichever row
    // PostgreSQL happens to return first for a shared id.
    expect((await readTransitionPendingAsync(a.db, "FN-PEND-1", PROJECT_A))?.toColumn)
      .toBe("in-progress");
    expect((await readTransitionPendingAsync(b.db, "FN-PEND-1", PROJECT_B))?.toColumn)
      .toBe("in-review");

    // Clearing A's marker may not clear B's.
    await clearTransitionPendingAsync(a.db, "FN-PEND-1", PROJECT_A);
    expect((await readTransitionPendingAsync(a.db, "FN-PEND-1", PROJECT_A))).toBeNull();
    expect((await readTransitionPendingAsync(b.db, "FN-PEND-1", PROJECT_B))?.toColumn)
      .toBe("in-review");
    const stillPending = await h.adminDb()
      .select({ projectId: schema.project.tasks.projectId })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, "FN-PEND-1"));
    // Both physical rows still exist; only A's marker went away.
    expect(stillPending).toHaveLength(2);
  });
});
