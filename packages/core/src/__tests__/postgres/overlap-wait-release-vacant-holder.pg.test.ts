/*
FNXC:OverlapWaitRelease 2026-11-18-01:03 (RUFU-1043):
Wiring acceptance for the `vacant` release face, in the layer where it is actually wired.

The pure predicate has its own unit test, but the two inputs that make the face SAFE are not readable from
the row: whether the holder still owns graph work (`workflow_work_items`) and whether the holder's own lane
vocabulary resolved. Both are read inside the reconciliation transaction, and neither is exercised by the
`delivered`-face suite — that suite only pairs `delivery: "none"` with review or WIP lanes, which this face
refuses by design. Without these cases the face would ship with its safety conjuncts untested.

Measured need (RunFusion, 2026-11-17/18): 549 of 595 open overlap edges were held by blockers with no
worktree pointer; 82 cards' last log line named an `active file-scope lease` for a blocker sitting in `todo`
with no checkout; one such holder had zero files of its own against `main`.
*/

import { sql } from "drizzle-orm";
import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const PROJECT_ID = "project-ow-vacant-holder";

const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
  prefix: "fusion_ow_vacant_holder",
  projectId: PROJECT_ID,
});

beforeAll(h.beforeAll);
beforeEach(h.beforeEach);
afterEach(h.afterEach);
afterAll(h.afterAll);

pgDescribe("the vacant holder release face is wired to liveness and lane vocabulary (RUFU-1043)", () => {
  /**
   * One holder resting in a planning lane with no delivery and no checkout, plus one waiter parked by the
   * scheduler's own writer. The case decides whether the holder still owns graph work.
   */
  async function seed(options: { liveWorkItem?: boolean; worktree?: string | null } = {}) {
    const store = h.store();
    const holder = await store.createTask({ description: "predecessor that never executed" });
    const waiter = await store.createTask({ description: "dependent parked behind a lease nobody holds" });
    await h.layer().db.execute(sql`UPDATE project.tasks SET "column"='todo' WHERE id=${waiter.id}`);

    await store.transitionQueuedEpisode(waiter.id, {
      signature: `file-scope:${holder.id}`,
      blockedBy: null,
      overlapBlockedBy: holder.id,
      action: `File-scope overlap: waiting for lease held by ${holder.id}`,
    });

    // No delivery of any form: this is the shape the `delivered` face can never answer.
    await store.updateTask(holder.id, {
      worktree: options.worktree === undefined ? null : options.worktree,
      mergeDetails: null,
    });

    if (options.liveWorkItem) {
      await h.layer().db.execute(sql`
        INSERT INTO project.workflow_work_items
          (project_id, id, run_id, task_id, node_id, kind, state, attempt, created_at, updated_at)
        VALUES
          (${PROJECT_ID}, 'wi-vacant-holder-1', 'run-vacant-holder', ${holder.id},
           'step-execute', 'node', 'runnable', 0, now()::text, now()::text)
      `);
    }
    return { holder, waiter };
  }

  const HELD = (holderId: string) => ({ overlapBlockedBy: holderId, status: "queued" });
  const RELEASED = { overlapBlockedBy: null, status: null };

  it("releases the waiter when the holder owns no checkout, no delivery and no graph work", async () => {
    const { holder, waiter } = await seed();
    expect(await h.store().getTask(waiter.id)).toMatchObject(HELD(holder.id));

    const outcome = await h.store().reconcileTaskOverlapWaits(waiter.id);
    expect(outcome.clearedBlockerIds).toContain(holder.id);
    expect(await h.store().getTask(waiter.id)).toMatchObject(RELEASED);

    // The release must be attributable to the new face, not to an accidental `delivered` match.
    const [row] = await h.layer().db.execute(sql`
      SELECT observation ->> 'releaseReason' AS reason FROM project.task_overlap_waits
      WHERE task_id=${waiter.id} AND blocker_task_id=${holder.id} AND phase='cancelled'
    `) as { reason: string | null }[];
    expect(row?.reason).toBe("vacant");
  });

  it("refuses while the holder still owns a work item — the conjunct that makes the face safe", async () => {
    const { holder, waiter } = await seed({ liveWorkItem: true });

    expect(await h.store().reconcileTaskOverlapWaits(waiter.id)).toMatchObject({ clearedBlockerIds: [] });
    expect(await h.store().getTask(waiter.id)).toMatchObject(HELD(holder.id));
  });

  it("refuses while the holder retains a checkout pointer", async () => {
    const { holder, waiter } = await seed({ worktree: "/tmp/fusion-vacant-holder-checkout" });

    expect(await h.store().reconcileTaskOverlapWaits(waiter.id)).toMatchObject({ clearedBlockerIds: [] });
    expect(await h.store().getTask(waiter.id)).toMatchObject(HELD(holder.id));
  });
});
