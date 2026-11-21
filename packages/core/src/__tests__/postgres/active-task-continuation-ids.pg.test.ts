/*
FNXC:HoldReleaseArmedPriority 2026-11-21-03:36 (RUFU-807 Step 1):
`TaskStore.listActiveTaskContinuationTaskIds` is the read that lets the hold/release sweep put
continuation-backed ("armed") cards inside its evaluated set instead of budget-truncating past them. The
field evidence behind it is `budget-truncated unevaluated=700, scanned=873` on a project whose WIP slots
were mostly free — the sweep was the gate, and it never reached the armed card.

This is a pg-backed test on purpose. The three properties the sweep depends on are storage properties
that a fake cannot have:
  - the ACTIVE/terminal split comes from `ACTIVE_WORKFLOW_WORK_ITEM_STATES`, the same closed set the
    continuation seeders bail on, so "armed" must mean here what it means there;
  - the `kind` filter must exclude `merge` rows, which live in the SAME table and would otherwise make
    every review-lane card look armed to a planning-lane decision;
  - project isolation is enforced by `projectScopeFor` against a real `project_id` column in a shared
    database, where a foreign row is invisible rather than merely unrequested.

The positive/negative pairs are exhaustive over the row shapes that can be planted for one candidate set:
active-task (reported), terminal-task, active-merge, and foreign-project (all three not reported).
*/

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import { listActiveTaskContinuationTaskIdsImpl } from "../../task-store/workflow-task-create-ops.js";
import type { TaskStore, WorkflowWorkItemState } from "../../types.js";

const OWN_PROJECT = "proj_active_continuation_ids";
const PROJECT_B = "fn-807-foreign-project";

pgDescribe("TaskStore.listActiveTaskContinuationTaskIds", () => {
  /*
  A BOUND projectId is required, not cosmetic: the shared harness defaults to the project-agnostic
  (`projectId: ""`) shape, and `projectScopeFor` answers `undefined` for a blank id — so on an unbound
  harness this read would carry no `project_id` predicate at all and the cross-project case below could
  not fail for any reason. Binding is what makes the isolation assertion a real assertion.
  */
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_active_continuation_ids",
    projectId: OWN_PROJECT,
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** Plant one work-item row for a task through the real upsert seam. */
  const plant = async (
    taskId: string,
    over: { kind: "task" | "merge"; state: WorkflowWorkItemState },
  ): Promise<void> => {
    await h.store().upsertWorkflowWorkItem({
      runId: `${taskId}:run:${over.kind}`,
      taskId,
      nodeId: over.kind === "task" ? "plan-review" : "code-review",
      kind: over.kind,
      state: over.state,
    });
  };

  /** Plant a whole (foreign task, foreign work item) pair through the ADMIN connection. */
  const plantForeign = async (taskId: string, state: WorkflowWorkItemState): Promise<void> => {
    const now = new Date().toISOString();
    await h.adminDb().insert(schema.project.tasks).values({
      projectId: PROJECT_B,
      id: taskId,
      title: "foreign armed task",
      description: "RUFU-807 cross-project fixture",
      column: "todo",
      createdAt: now,
      updatedAt: now,
    });
    await h.adminDb().insert(schema.project.workflowWorkItems).values({
      projectId: PROJECT_B,
      id: `${taskId}-item`,
      runId: `${taskId}:run:task`,
      taskId,
      nodeId: "plan-review",
      kind: "task",
      state,
      createdAt: now,
      updatedAt: now,
    });
  };

  it("reports a card that owns an active task-kind continuation", async () => {
    const store = h.store();
    const armed = await h.createTestTask();
    await plant(armed.id, { kind: "task", state: "held" });

    const ids = await store.listActiveTaskContinuationTaskIds([armed.id]);

    expect(ids.has(armed.id)).toBe(true);
    // A Set of ids, not rows: the reader's only contract is membership.
    expect([...ids]).toEqual([armed.id]);
  });

  it("does not report a card whose only task-kind row is terminal", async () => {
    const store = h.store();
    const finished = await h.createTestTask();
    await plant(finished.id, { kind: "task", state: "succeeded" });

    const ids = await store.listActiveTaskContinuationTaskIds([finished.id]);

    expect(ids.has(finished.id)).toBe(false);
  });

  it("does not report a card whose only active row is merge-kind", async () => {
    const store = h.store();
    const inReview = await h.createTestTask();
    await plant(inReview.id, { kind: "merge", state: "running" });

    const ids = await store.listActiveTaskContinuationTaskIds([inReview.id]);

    // The planning-lane release decision must not be steered by a review-lane continuation.
    expect(ids.has(inReview.id)).toBe(false);
  });

  it("does not report another project's active continuation for an id it shares", async () => {
    const store = h.store();
    const own = await h.createTestTask();
    // The foreign row carries its OWN task id (the id the caller never asked about), planted through the
    // admin connection so it is a genuinely co-resident row in the same database, not a mock.
    await plantForeign("RUFU-807-FOREIGN", "runnable");

    const ids = await store.listActiveTaskContinuationTaskIds([own.id, "RUFU-807-FOREIGN"]);

    expect(ids.has("RUFU-807-FOREIGN")).toBe(false);
    expect([...ids]).toEqual([]);
  });

  it("answers a mixed candidate set with exactly the armed subset and invents nothing", async () => {
    const store = h.store();
    const [active, terminal, mergeOnly, quiet] = await Promise.all([
      h.createTestTask(),
      h.createTestTask(),
      h.createTestTask(),
      h.createTestTask(),
    ]);
    await plant(active.id, { kind: "task", state: "runnable" });
    await plant(terminal.id, { kind: "task", state: "failed" });
    await plant(mergeOnly.id, { kind: "merge", state: "held" });
    // `retrying` is active too — the armed set is the whole closed set, not just runnable/held.
    await plant(quiet.id, { kind: "task", state: "retrying" });

    const ids = await store.listActiveTaskContinuationTaskIds([
      active.id, terminal.id, mergeOnly.id, quiet.id, "NOT-A-TASK-AT-ALL",
    ]);

    expect([...ids].sort()).toEqual([active.id, quiet.id].sort());
  });

  it("returns an empty set without consulting the database for an empty list or a store with no async backend", async () => {
    /*
    Both guards answer EMPTY rather than throwing, because the only thing this read can influence is the
    ORDER of an evaluation that is happening anyway: a store shape that cannot answer must fall back to
    today's ordering, never fail the sweep. Asserted through the impl with no usable layer at all — if
    either guard were missing, this call would throw on `layer.db` instead of answering.
    */
    const store = h.store();
    const armed = await h.createTestTask();
    await plant(armed.id, { kind: "task", state: "running" });
    const noBackend = { asyncLayer: null } as unknown as TaskStore;

    await expect(listActiveTaskContinuationTaskIdsImpl(store, [])).resolves.toEqual(new Set());
    await expect(listActiveTaskContinuationTaskIdsImpl(noBackend, [armed.id])).resolves.toEqual(new Set());
    // The real store still answers for the same id, so the two refusals above are the guards, not a
    // broken fixture.
    await expect(store.listActiveTaskContinuationTaskIds([armed.id])).resolves.toEqual(new Set([armed.id]));
  });
});
