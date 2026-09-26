/*
FNXC:TaskQueueOrder 2026-09-26-21:42:

A QUEUE READ THAT CANNOT SEE ITS OWN ORDER TABLE MUST FAIL LOUDLY, AND A TEST MUST BE ABLE TO SEE IT.

`MERGE_QUEUE_ORDER_BY` is assembled entirely from `project.tasks` columns — the effective Boost
sequence, `created_at`, and the numeric id suffix. Every query that applies it therefore has to carry
`tasks` in its FROM/JOIN. `peekMergeQueue()` selected only `merge_queue`, so PostgreSQL rejected the
statement with `missing FROM-clause entry for table "tasks"` and the read threw on EVERY call, in every
project, for as long as FN-509's Boost ordering had existed.

Nothing noticed because the only production caller swallows the failure by design:
`SelfHealingManager.isMergeLaneOwned()` catches, logs one `warn`, and answers "nobody owns the merge
lane". A broken read was indistinguishable from an empty queue — and the answer it produced was the one
that lets recovery act on a card whose merge may already be in flight. That is the shape this file
exists to make impossible: it asserts the RESOLVED LIST, not the absence of a throw.

WHY A LIVE STORE. The defect is a FROM-clause fact evaluated by PostgreSQL. A mocked layer returns
whatever the fake was told to return and has no FROM clause at all, so every conceivable unit test of
this function passes on the broken code.

LANE. `.pg.test.ts`, skipped by `pgDescribe` when PostgreSQL is unreachable; throwaway per-file
database; never port 4040.
*/

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { resolveTaskColumnEntryAt } from "../../tasks/task-queue-order.js";

pgDescribe("merge queue peek — ORDER BY over the joined tasks row", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_mq_peek",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** A card walked into its board's review lane and enqueued for merge. */
  async function seedQueuedTask(title: string): Promise<string> {
    const store = h.store();
    const task = await store.createTask({ title, description: "test", column: "todo" });
    for (const step of ["in-progress", "in-review"]) await store.moveTask(task.id, step as never);
    store.taskCache.delete(task.id);

    /* Prove the fixture: an unqueued card would make "peek returned it" true by accident elsewhere. */
    const entry = await store.enqueueMergeQueue(task.id);
    expect(entry.taskId).toBe(task.id);
    return task.id;
  }

  const boostArgs = (task: { column: string; createdAt: string; columnMovedAt?: string }, requestId: string) => ({
    requestId,
    workflowId: "builtin:coding",
    expectedColumn: task.column,
    expectedColumnEntryAt: resolveTaskColumnEntryAt(task),
  });

  /*
  The defect itself. Before the fix this statement was rejected by the parser-analyser, so the promise
  rejected and `isMergeLaneOwned()` never saw a list at all.
  */
  it("peek resolves and reports every queued card", async () => {
    const first = await seedQueuedTask("first to review");
    const second = await seedQueuedTask("second to review");

    const queue = await h.store().peekMergeQueue();

    expect(queue.map((entry) => entry.taskId).sort()).toEqual([first, second].sort());
    // The lease fields are part of the answer: ownership is the reason this read exists.
    for (const entry of queue) {
      expect(entry.leasedBy).toBeNull();
      expect(entry.attemptCount).toBe(0);
    }
  });

  /*
  The reason the join is not decoration: without the tasks row the ordering has no input, so a test
  that only asserted "resolves" would let a join-free rewrite (drop the ORDER BY, or an inner join that
  silently narrows the set) pass. The boosted card must be at the head, and the rest in arrival order.
  */
  it("peek returns the queue in the shared queue order, boosted card first", async () => {
    const arrival1 = await seedQueuedTask("arrived first");
    const arrival2 = await seedQueuedTask("arrived second");

    const store = h.store();
    const lateButBoosted = await store.createTask({
      title: "boosted from the back",
      description: "test",
      column: "todo",
    });
    for (const step of ["in-progress", "in-review"]) await store.moveTask(lateButBoosted.id, step as never);
    store.taskCache.delete(lateButBoosted.id);
    await store.enqueueMergeQueue(lateButBoosted.id);

    // Boost is a move-to-head WITHIN a column stay, so its preconditions name the CURRENT stay.
    const inReview = await store.getTask(lateButBoosted.id);
    const boost = await store.boostTask(inReview.id, boostArgs(inReview, "peek-boost-1"));
    expect(boost.ok).toBe(true);

    const queue = await store.peekMergeQueue();
    expect(queue.map((entry) => entry.taskId)).toEqual([lateButBoosted.id, arrival1, arrival2]);

    // Parity with the head read: same rows, same order, so the merger and recovery agree on the head.
    const head = await store.peekMergeQueueHead();
    expect(head?.taskId).toBe(queue[0]?.taskId);
  });

  /*
  The paired negative, and the invariant the broken read was accidentally claiming. A leased row stays
  visible WITH its holder — that holder is what `isMergeLaneOwned()` exists to report — while a card
  that LEFT the review lane is dequeued atomically with the move. "Owned" and "queued" must stay
  distinct answers instead of collapsing into whatever the exception said.
  */
  it("peek distinguishes a leased row from an unqueued card", async () => {
    const leased = await seedQueuedTask("lease held");
    const leaving = await seedQueuedTask("pulled back for rework");
    const notQueued = await h.store().createTask({
      title: "never enqueued",
      description: "test",
      column: "in-review",
    });

    const lease = await h.store().acquireMergeQueueLease("worker-peek", {
      leaseDurationMs: 60_000,
      targetTaskId: leased,
    });
    expect(lease?.taskId).toBe(leased);

    const queue = await h.store().peekMergeQueue();
    expect(queue.map((entry) => entry.taskId)).toContain(leased);
    expect(queue.find((entry) => entry.taskId === leased)?.leasedBy).toBe("worker-peek");
    expect(queue.map((entry) => entry.taskId)).not.toContain(notQueued.id);

    // Leaving the review lane dequeues atomically with the move (VAL-DATA-013's counterpart).
    await h.store().moveTask(leaving, "in-progress" as never);
    h.store().taskCache.delete(leaving);
    const afterExit = await h.store().peekMergeQueue();
    expect(afterExit.map((entry) => entry.taskId)).not.toContain(leaving);
    expect(afterExit.map((entry) => entry.taskId)).toContain(leased);
  });
});
