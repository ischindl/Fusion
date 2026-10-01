/*
FNXC:TaskRetryReleaseIntent 2026-09-22-09:07 (RUFU-261):
The hold-lane park predicate in `applyResetOnEntryEffects` keyed on REQUESTER
(`moveSource === "user"`) when the durable question is INTENT. An operator Retry is also
operator-attributed (FNXC:ToolPermissionGates keeps `"user"` on `fn_task_retry` for the audit
trail), so the retry rebound dragged the card it was asked to run into the scheduler's durable
operator-stop (`userPaused = true`) — and nothing on the retry path ever clears it. 11 real
cards sat dispatch-refused for 2–14 days. The seam now reads `options.parkOnHold`:
`parkOnHold: false` is the explicit RELEASE statement every Retry surface carries, and any
other move shape (board drag, menu move, engine rebound, intake creation) keeps the park.

This is the STORE-LEVEL invariant across the one writer of `userPaused = true`:
  - a genuine user drag back to the queue parks (control — the KTD-9 gesture stays intact);
  - the retry-shaped move (user source + parkOnHold:false) does not park;
  - a retry-shaped move CLEARS a stale park, so a re-retry self-heals a card an earlier
    pre-fix retry or drag had parked;
  - engine rebounds still never park (KTD-9: "Engine rebounds must not set userPaused");
  - `preservePause` keeps FN-7851 precedence: parkOnHold:false never fabricates a release
    across a pause that the move was told to preserve;
  - the release move banks an open pause segment (FN-457 accounting), proving the row is
    genuinely released, not merely non-parking.

Surface note: every board drag, context-menu move, CLI `fn task move`, and tool re-queue
funnels through `store.moveTask`, so asserting the two option shapes here covers all of them;
the per-surface intent wiring (Retry says `parkOnHold:false`, drags don't) is pinned in the
cli/dashboard test files.

Runs on the shared PostgreSQL harness; pgDescribe auto-skips when PostgreSQL is unreachable.
*/
import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
} from "../__test-utils__/pg-test-harness.js";

pgDescribe("retry release vs drag park on the hold lane (RUFU-261)", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_retry_release_park" });
  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  /** Put a card on the board in the WIP lane, ready to be re-queued. */
  async function seedWipTask(store: ReturnType<typeof harness.store>, title: string) {
    const task = await store.createTask({ description: title });
    return store.moveTask(task.id, "in-progress", { moveSource: "engine" });
  }

  it("parks a genuine user drag back to the queue lane (KTD-9 control)", async () => {
    const store = harness.store();
    const wip = await seedWipTask(store, "drag-to-queue parks");

    const moved = await store.moveTask(wip.id, "todo", { moveSource: "user" });

    expect(moved.column).toBe("todo");
    expect(moved.userPaused).toBe(true);
  });

  it("does NOT park the retry-shaped re-queue (user source + parkOnHold:false)", async () => {
    const store = harness.store();
    const wip = await seedWipTask(store, "retry must not self-park");

    const moved = await store.moveTask(wip.id, "todo", { moveSource: "user", parkOnHold: false });

    expect(moved.column).toBe("todo");
    // The whole RUFU-261 symptom: pre-fix this was `true` and the scheduler refused the card
    // the operator had just asked to run.
    expect(moved.userPaused).toBeUndefined();
  });

  it("a retry-shaped re-queue CLEARS a stale park, so a re-retry self-heals", async () => {
    const store = harness.store();
    const wip = await seedWipTask(store, "drag-parked then retried");

    // 1. An operator drag parks the card (genuine gesture).
    const dragged = await store.moveTask(wip.id, "todo", { moveSource: "user" });
    expect(dragged.userPaused).toBe(true);

    // 2. The card re-runs and lands in the WIP lane again...
    await store.moveTask(wip.id, "in-progress", { moveSource: "engine" });

    // 3. ...and a retry-shaped re-queue lifts the stale park instead of re-parking.
    const retried = await store.moveTask(wip.id, "todo", { moveSource: "user", parkOnHold: false });
    expect(retried.userPaused).toBeUndefined();
  });

  it("keeps engine rebounds out of the park entirely (KTD-9)", async () => {
    const store = harness.store();
    const wip = await seedWipTask(store, "engine rebound never parks");

    // The sanctioned automatic rebound shape (F5: a WIP card returns to planning only for
    // `plan-review-revise-replan`). Hooks run for it — it is not guard-bypassed — and it must
    // not park, with or without the release flag, because the park keys on the user source.
    const withoutFlag = await store.moveTask(wip.id, "todo", {
      moveSource: "engine",
      lifecycleReason: "plan-review-revise-replan",
      preserveProgress: true,
    });
    expect(withoutFlag.column).toBe("todo");
    expect(withoutFlag.userPaused).toBeUndefined();

    await store.moveTask(wip.id, "in-progress", { moveSource: "engine" });
    const withFlag = await store.moveTask(wip.id, "todo", {
      moveSource: "engine",
      lifecycleReason: "plan-review-revise-replan",
      preserveProgress: true,
      parkOnHold: false,
    });
    expect(withFlag.userPaused).toBeUndefined();

    // A park a human created stays owned by the clear branch for non-user moves: the rebound
    // lifts it rather than re-parking, which is what keeps the scheduler's durable stop from
    // outliving the gesture that set it.
    await store.moveTask(wip.id, "in-progress", { moveSource: "engine" });
    const drag = await store.moveTask(wip.id, "todo", { moveSource: "user" });
    expect(drag.userPaused).toBe(true);
    await store.moveTask(wip.id, "in-progress", { moveSource: "engine" });
    const rebound = await store.moveTask(wip.id, "todo", {
      moveSource: "engine",
      lifecycleReason: "plan-review-revise-replan",
      preserveProgress: true,
    });
    expect(rebound.userPaused).toBeUndefined();
  });

  it("parkOnHold:false does not override preservePause (FN-7851 precedence)", async () => {
    const store = harness.store();
    const wip = await seedWipTask(store, "preservePause wins over release");

    // The FN-7851 precondition: an operator pause of a RUNNING card is what carries
    // `userPaused` into a live-work lane (a WIP entry itself clears the park), and the
    // teardown re-queue must preserve that park so the row stays parked until an explicit
    // unpause. `parkOnHold: false` on that same move must not fabricate a release across a
    // pause the caller told the store to keep.
    await store.pauseTask(wip.id, true, undefined, { userPaused: true });

    const preserved = await store.moveTask(wip.id, "todo", {
      preserveProgress: true,
      preservePause: true,
      moveSource: "user",
      parkOnHold: false,
    });
    expect(preserved.userPaused).toBe(true);
    expect(preserved.paused).toBeTruthy();

    // Control for the control: the same card, same park, without `preservePause` the release
    // statement does lift it — so the assertion above is about precedence, not unreachability.
    await store.moveTask(wip.id, "in-progress", { moveSource: "engine" });
    const reParked = await store.pauseTask(wip.id, true, undefined, { userPaused: true });
    expect(reParked.userPaused).toBe(true);
    const moved = await store.moveTask(wip.id, "todo", {
      preserveProgress: true,
      moveSource: "user",
      parkOnHold: false,
    });
    expect(moved.userPaused).toBeUndefined();
  });

  it("the release move banks an open pause segment (row genuinely released, FN-457)", async () => {
    const store = harness.store();
    const wip = await seedWipTask(store, "release banks the pause segment");

    // `pauseTask` is the seam that opens the segment; the anchor is then rewound so the banked
    // amount is observable instead of sub-millisecond (`updateTask` does not accept
    // `pausedStartedAt`, so the rewind goes through the harness's admin SQL).
    await store.pauseTask(wip.id, true);
    const sixSecondsAgo = new Date(Date.now() - 6000).toISOString();
    await harness.adminSql()`
      UPDATE project.tasks SET paused_started_at = ${sixSecondsAgo} WHERE id = ${wip.id}
    `;

    const moved = await store.moveTask(wip.id, "todo", { moveSource: "user", parkOnHold: false });

    expect(moved.userPaused).toBeUndefined();
    expect(moved.paused).toBeFalsy();
    expect(moved.pausedStartedAt).toBeUndefined();
    expect(moved.cumulativePausedMs ?? 0).toBeGreaterThanOrEqual(6000);
  });
});
