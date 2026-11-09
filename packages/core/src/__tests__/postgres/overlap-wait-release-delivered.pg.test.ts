/*
FNXC:OverlapWaitRelease 2026-11-04-10:20 (RUFU-469 — 46 cards froze behind a holder that had already delivered):

Measured on the live board. A card landed its work on `main` (`mergedAt`/`mergeConfirmed`/`landedFiles`, and its
checkout was already gone — `worktree: null`) but stayed in a review lane, because a required pre-merge gate
carried zero result rows. Forty-six cards waited behind it, each stamped `overlapBlockedBy=<holder>` plus
`status="queued"` by the scheduler's own queued-episode writer — both admission gates. A 762-second read-only
sample of 67 cards found ZERO member-row rewrites, and the population was still 46 six hours later.

They were never released by the release decision. They drained 11.14 days later, at `2026-10-12T13:54:59Z`, the
second the holder's COLUMN changed — which is the defect stated as a duration: relief was conditioned on the
holder's lane, not on the holder's lease. The only releases recorded before that came from
`completeTaskOverlapWait` (40 History rows, `Overlap wait released behind <holder>`), a surface that requires the
waiter to already be executing — and a queued card carrying the marker is never dispatched, so that road out
was closed by the very state it needed. `getUnclaimableOverlapWaits` reported all 46 unclaimable.

The release predicate had exactly one face for a live predecessor — `completeColumns.has(blocker.column)` — and
the checkout helpers in `tasks/file-scope-lease.ts` and the delivery authority in `overlapDeliverySnapshots` /
`hasConcreteOverlapDelivery` were both invisible to it. This file pins the released face and its fail-closed
pairing. It drives the PRODUCTION seams only: the scheduler's queued-episode writer, the store's reconciliation
seam, and the self-healing sweep. No live board participates; every id comes from fixtures.
*/

import { sql } from "drizzle-orm";
import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { reconcileReleasedOverlapWaits } from "../../../../engine/src/self-healing/released-overlap-waits.js";

const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
  prefix: "fusion_ow_delivered",
  projectId: "project-ow-delivered-release",
});

/** The landed delivery the live holder carried: a sha, landed files, and the confirmation flag nested in
 *  `mergeDetails` (where `mergeConfirmed` actually lives — `task.mergeDetails?.mergeConfirmed`). */
const DELIVERED = {
  mergedAt: "2026-10-01T10:32:06.893Z",
  mergeDetails: {
    mergeConfirmed: true,
    commitSha: "a1b2c3d4e5f60718",
    landedFiles: ["packages/engine/src/agents/agent-heartbeat-error-recovery.ts"],
    mergeTargetBranch: "main",
  },
} as const;

beforeAll(h.beforeAll);
beforeEach(h.beforeEach);
afterEach(h.afterEach);
afterAll(h.afterAll);

pgDescribe("overlap wait released by a delivered, checkout-free holder (RUFU-469)", () => {
  /**
   * The reported shape, seeded through the seams that produced it: the scheduler's queued-episode writer
   * stamps `overlapBlockedBy` AND `status="queued"` in one write, and the holder then lands and releases its
   * checkout while resting in a review lane.
   */
  async function seedReportedShape(options: {
    waiterCount?: number;
    holderColumn?: string;
    retainedWorktree?: string | null;
    holder?: Partial<Parameters<ReturnType<SharedPgTaskStoreHarness["store"]>["updateTask"]>[1]>;
  } = {}) {
    const store = h.store();
    const holder = await store.createTask({ description: "holder whose work landed" });
    await store.updateTask(holder.id, {
      ...DELIVERED,
      worktree: options.retainedWorktree === undefined ? null : options.retainedWorktree,
      ...options.holder,
    } as never);
    await h.layer().db.execute(sql`UPDATE project.tasks SET "column"=${options.holderColumn ?? "in-review"} WHERE id=${holder.id}`);

    const waiters: string[] = [];
    for (let index = 0; index < (options.waiterCount ?? 46); index += 1) {
      const waiter = await store.createTask({ description: `waiter ${index}` });
      await h.layer().db.execute(sql`UPDATE project.tasks SET "column"='todo' WHERE id=${waiter.id}`);
      await store.transitionQueuedEpisode(waiter.id, {
        signature: `file-scope:${holder.id}`,
        blockedBy: null,
        overlapBlockedBy: holder.id,
        action: `File-scope overlap: waiting for lease held by ${holder.id}`,
      });
      waiters.push(waiter.id);
    }
    await store.updateSettings({ autoMerge: true, globalPause: false, enginePaused: false });
    return { holder, waiters };
  }

  async function readFrozen(waiterId: string) {
    const task = await h.store().getTask(waiterId);
    return { overlapBlockedBy: task.overlapBlockedBy ?? null, status: task.status ?? null, column: task.column };
  }

  it("reproduces the frozen shape before any repair: every waiter holds marker and queued status", async () => {
    const { holder, waiters } = await seedReportedShape();

    expect(waiters).toHaveLength(46);
    for (const waiterId of waiters) {
      expect(await readFrozen(waiterId)).toEqual({ overlapBlockedBy: holder.id, status: "queued", column: "todo" });
    }
    // The lease the markers name does not exist: landed, confirmed, and no checkout in either form.
    const holderTask = await h.store().getTask(holder.id);
    expect(holderTask.column).toBe("in-review");
    expect(holderTask.mergeDetails?.mergeConfirmed).toBe(true);
    expect(holderTask.worktree ?? null).toBeNull();
    expect(holderTask.workspaceWorktrees ?? {}).toEqual({});
  });

  it("releases all 46 waiters through the production store seam — marker AND queued status", async () => {
    const { holder, waiters } = await seedReportedShape();

    const result = await h.store().reconcileTaskOverlapWaits(waiters[0]!);
    expect(result.clearedBlockerIds).toContain(holder.id);

    const after = await readFrozen(waiters[0]!);
    expect(after.overlapBlockedBy).toBeNull();
    // A marker-only clear would leave this card unclaimable anyway: the backlog reporter excludes
    // `status === "queued"` independently of the marker.
    expect(after.status).toBeNull();
    // The delivery itself must survive for the Git freshness gate — release must not consume it.
    const episode = (await h.store().listTaskOverlapWaits(waiters[0]!))[0];
    expect(episode?.observation?.deliveries?.[0]).toMatchObject({ landedSha: DELIVERED.mergeDetails.commitSha });

    // The remaining 45 need no per-card operator action: the sweep discharges the whole population.
    expect(await reconcileReleasedOverlapWaits(h.store(), () => false)).toBeGreaterThan(1);
    const stillFrozen: string[] = [];
    const stillQueued: string[] = [];
    for (const waiterId of waiters) {
      const after = await readFrozen(waiterId);
      if (after.overlapBlockedBy !== null) stillFrozen.push(waiterId);
      if (after.status !== null) stillQueued.push(waiterId);
    }
    expect(stillFrozen).toEqual([]);
    expect(stillQueued).toEqual([]);
  });

  it("fails closed while the delivered holder still retains its checkout", async () => {
    const { holder, waiters } = await seedReportedShape({ waiterCount: 3, retainedWorktree: "/home/operator/.fusion/worktrees/rufu-286" });

    expect(await h.store().reconcileTaskOverlapWaits(waiters[0]!)).toMatchObject({ clearedBlockerIds: [] });
    for (const waiterId of waiters) {
      expect(await readFrozen(waiterId)).toEqual({ overlapBlockedBy: holder.id, status: "queued", column: "todo" });
    }
  });

  it("fails closed while the delivered holder still stands in its WIP lane", async () => {
    // A delivered card sitting in WIP is mid-execution: `acquireTaskCheckout` moves the card into WIP BEFORE
    // its checkout materializes, so the lane — not the checkout — is the liveness proof here.
    const { holder, waiters } = await seedReportedShape({ waiterCount: 3, holderColumn: "in-progress" });

    expect(await h.store().reconcileTaskOverlapWaits(waiters[0]!)).toMatchObject({ clearedBlockerIds: [] });
    expect(await readFrozen(waiters[0]!)).toEqual({ overlapBlockedBy: holder.id, status: "queued", column: "todo" });
  });

  it("fails closed for a holder with no concrete delivery at all", async () => {
    const { holder, waiters } = await seedReportedShape({
      waiterCount: 3,
      holder: { mergedAt: null, mergeDetails: null, status: "reviewing" },
    } as never);

    expect(await h.store().reconcileTaskOverlapWaits(waiters[0]!)).toMatchObject({ clearedBlockerIds: [] });
    expect(await readFrozen(waiters[0]!)).toEqual({ overlapBlockedBy: holder.id, status: "queued", column: "todo" });
  });
});
