/**
 * FNXC:TaskLifecycleProjection 2026-11-13-00:37 (RUFU-583):
 * PostgreSQL-backed proof of the task lifecycle projection contract. These are the load-bearing
 * tests for RUFU-583 because every one of them runs a REAL `store.deleteTask` and then a REAL
 * `store.listTasks` against PostgreSQL — a fake-store fixture cannot pin them, since the defect was
 * a SQL predicate asymmetry, not a serialization oversight.
 *
 * The measured defect this file exists to keep dead:
 *  - A soft delete stamps `column: "archived"` together with `deletedAt`
 *    (`task-store/async/async-persistence.ts`, `softDeleteTaskRowInTransaction`), so a list read
 *    that does not opt into archived rows gets an implicit `excludeColumn: "archived"`
 *    (`task-store/reads.ts` `listTasksImpl`) and drops the tombstone on the LANE predicate before
 *    `includeDeleted` is ever consulted. `GET /api/tasks?includeDeleted=1` returned zero tombstones
 *    while accepting the flag.
 *  - Independently, `deletedAt` maps to `undefined` on live rows (`serialization.ts` `rowToTask`),
 *    so `JSON.stringify` omits the key entirely: a consumer's `deletedAt is falsy` filter is blind by
 *    construction, and a tombstone that DID surface (via `?excludeDone=1`, which suppresses the
 *    implicit exclusion) was indistinguishable from a live card.
 *
 * The contract pinned here, in the operator's words: "a deleted card is either absent from the list
 * or visibly marked", and a consumer never has to filter deleted ids itself because the projection
 * carries the state.
 */
import { afterEach, beforeEach, expect, it, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { TaskHasLineageChildrenError, type TaskStore } from "../../store.js";
import { deriveTaskLifecycle, withTaskLifecycleAll } from "../../task-store/lifecycle-projection.js";
import type { Task } from "../../types.js";

const pgTest = pgDescribe;

/** The default board-shaped read `GET /api/tasks` performs (register-task-workflow-routes.ts). */
const BOARD_READ = { slim: true, includeArchived: false } as const;
/** The same read with the forensic flag the HTTP route forwards from `?includeDeleted=1`. */
const FORENSIC_READ = { ...BOARD_READ, includeDeleted: true } as const;

/**
 * Moves a row into the historical sentinel lane WITHOUT a deletion timestamp. That shape is
 * reachable (the sentinel is a physical archive marker, and `getLiveTaskColumn` returns it as a
 * sentinel), and the forensic relaxation must NOT admit it: the forensic payload is
 * "live board union tombstones", not "live board union every row that ever touched the archive
 * lane". Written with raw SQL because no mutation path puts a live row in the sentinel lane.
 */
async function parkRowInSentinelLaneWithoutDeleting(store: TaskStore, taskId: string): Promise<void> {
  const layer = (store as unknown as { asyncLayer: { db: { execute: (q: unknown) => Promise<unknown> } } }).asyncLayer;
  await layer.db.execute(
    sql`UPDATE project.tasks SET "column" = 'archived' WHERE id = ${taskId} AND deleted_at IS NULL`,
  );
}

pgTest("task lifecycle projection (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_lifecycle_projection",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  let store: TaskStore;

  beforeEach(async () => {
    await h.beforeEach();
    store = h.store();
  });

  afterEach(h.afterEach);

  /** One plain live card in a normal lane, plus an optional reserved id. */
  async function seedLive(taskId?: string): Promise<Task> {
    return taskId
      ? store.createTaskWithReservedId(
        { description: `RUFU-583 probe ${taskId}`, column: "in-progress" },
        { taskId, applyDefaultWorkflowSteps: false },
      )
      : store.createTask({ description: "RUFU-583 probe", column: "in-progress" });
  }

  /** The invariant behind the whole task: no row on a non-forensic read may derive non-live. */
  function assertAllRowsDeriveLive(rows: Task[], label: string): void {
    for (const row of rows) {
      expect(deriveTaskLifecycle(row), `${label}: ${row.id}`).toBe("live");
    }
  }

  /*
  FNXC:TaskLifecycleProjection 2026-11-13-00:37 (RUFU-583): SYMPTOM REPLAY of the reported
  condition. The operator's monitoring filter was `deletedAt is falsy` over `GET /api/tasks`, and
  because the field was absent on live rows AND the tombstones were filtered out by the lane
  predicate, that filter reported "0 of the deleted cards still present" while five tombstones were
  being returned with live-looking columns. Assertion (a) is the half that keeps the board honest:
  the default read excludes the tombstone, keeps the live cards, and every row it returns derives
  `live` — so the absence of tombstones is provable from the payload, not assumed.
  */
  it("excludes a tombstone from the default board read and proves no returned row is non-live", async () => {
    const live = await seedLive("RUFU-5801");
    const doomed = await seedLive("RUFU-5802");
    await store.deleteTask(doomed.id);

    const rows = await store.listTasks({ ...BOARD_READ });

    expect(rows.map((t) => t.id)).toContain(live.id);
    expect(rows.map((t) => t.id)).not.toContain(doomed.id);
    assertAllRowsDeriveLive(rows, "default board read");
  });

  /*
  FNXC:TaskLifecycleProjection 2026-11-13-00:37 (RUFU-583): THE ROUND-1 BLOCKER, asserted as its
  direct negation. Before the fix this read returned ZERO tombstones: the tombstone's `column` is
  the very lane the implicit `excludeColumn: "archived"` removes, and that lane predicate ran before
  the `liveFilter` ternary could honor `includeDeleted`. A forensic option that silently returns
  nothing is worse than no option, because the caller believes they asked.
  */
  it("returns the tombstone on a forensic list read carrying its deletion timestamp", async () => {
    const doomed = await seedLive("RUFU-5803");
    const live = await seedLive("RUFU-5804");
    await store.deleteTask(doomed.id);

    const rows = await store.listTasks({ ...FORENSIC_READ });

    const tombstone = rows.find((t) => t.id === doomed.id);
    expect(tombstone, "forensic read must surface the soft-deleted card").toBeDefined();
    expect(tombstone!.deletedAt).toBeTruthy();
    expect(deriveTaskLifecycle(tombstone!)).toBe("deleted");
    // "Live board UNION tombstones": the forensic read loses nothing the board read had.
    expect(rows.map((t) => t.id)).toContain(live.id);
    assertAllRowsDeriveLive(
      rows.filter((t) => t.id !== doomed.id),
      "forensic read minus the tombstone",
    );
  });

  /*
  FNXC:TaskLifecycleProjection 2026-11-13-00:37 (RUFU-583): the relaxation's boundary, both
  directions. A caller that NAMES lanes stays authoritative even under `includeDeleted` (the
  RUFU-378 lane-authority note on `GET /api/tasks` relies on lane lists winning), and a row merely
  parked in the sentinel lane with no deletion timestamp is not a tombstone and must not leak.
  Without this pair the fix would be a leak dressed as a forensic read.
  */
  it("keeps explicit lane selections authoritative and never leaks a non-tombstone sentinel row", async () => {
    const doomed = await seedLive("RUFU-5805");
    await store.deleteTask(doomed.id);
    const sentinelOnly = await seedLive("RUFU-5806");
    await parkRowInSentinelLaneWithoutDeleting(store, sentinelOnly.id);

    // (1) An explicit single-lane forensic read stays lane-scoped: the tombstone's lane is
    // "archived", so naming a live lane must not resurrect it.
    const laneScoped = await store.listTasks({ ...FORENSIC_READ, column: "in-progress" });
    expect(laneScoped.map((t) => t.id)).not.toContain(doomed.id);

    // (2) An explicit `excludeColumns` forensic read keeps the exclusion authoritative. The tombstone
    // lives in the sentinel lane, so excluding that lane removes it even under `includeDeleted`.
    const excludeScoped = await store.listTasks({ ...FORENSIC_READ, excludeColumns: ["archived"] });
    expect(excludeScoped.map((t) => t.id)).not.toContain(doomed.id);

    // (3) A sentinel-lane row with NO deletion timestamp is not a tombstone: neither the board read
    // nor the forensic read may surface it. This is the clause that makes the `OR deleted_at IS NOT
    // NULL` widening honest rather than a blanket archive-lane opening.
    const board = await store.listTasks({ ...BOARD_READ });
    const forensic = await store.listTasks({ ...FORENSIC_READ });
    expect(board.map((t) => t.id)).not.toContain(sentinelOnly.id);
    expect(forensic.map((t) => t.id)).not.toContain(sentinelOnly.id);
    // The forensic read still returns its ONE legitimate tombstone, and nothing else is non-live —
    // i.e. the widening admitted `deleted_at IS NOT NULL` and no lane-only resident.
    expect(forensic.map((t) => deriveTaskLifecycle(t)).filter((s) => s !== "live")).toEqual(["deleted"]);
    assertAllRowsDeriveLive(
      forensic.filter((t) => t.id !== doomed.id),
      "forensic read with a sentinel-lane resident",
    );
  });

  /*
  FNXC:TaskLifecycleProjection 2026-11-13-00:37 (RUFU-583): the corroborating asymmetry that PROVED
  this was a predicate bug rather than a theory. `GET /api/tasks?excludeDone=1` builds
  `excludeColumns` from the project's `complete` role lanes, which suppresses the implicit
  `excludeColumn` entirely — so on that one combination `includeDeleted` dropped `ACTIVE_TASK_FILTER`
  with no lane predicate in the way and tombstones came back on HEAD already. One flag, two
  behaviors, one route. Membership there must NOT change (this card forbids changing default or
  existing-read membership); what changes is that every row it returns now self-marks.
  */
  it("self-marks every row an excludeColumns-scoped read returns, including the tombstone", async () => {
    const doomed = await seedLive("RUFU-5807");
    const live = await seedLive("RUFU-5808");
    await store.deleteTask(doomed.id);

    // `excludeColumns` naming the complete lanes: exactly the shape `?excludeDone=1` produces, and
    // the one that already returned the tombstone on HEAD because no implicit exclusion was set.
    const rows = await store.listTasks({ ...FORENSIC_READ, excludeColumns: ["done"] });

    expect(rows.map((t) => t.id)).toContain(doomed.id);
    expect(rows.map((t) => t.id)).toContain(live.id);
    const marked = rows.map((t) => [t.id, deriveTaskLifecycle(t)] as const);
    expect(marked.find(([id]) => id === doomed.id)?.[1]).toBe("deleted");
    expect(marked.find(([id]) => id === live.id)?.[1]).toBe("live");
  });

  /*
  FNXC:TaskLifecycleProjection 2026-11-13-00:37 (RUFU-583): the third pre-fix condition — "a row
  shape that hides the deletion timestamp must be impossible". `GET /api/tasks` asks for
  `compactBoardFeed: true`, and RUFU-902 additionally puts the board row's SELECT list behind
  `resolveBoardFeedProjection`. The relaxation is a WHERE-clause change and `deletedAt` is neither a
  `BOARD_FEED_DROPPED_COLUMNS` member nor a declarable `TaskListReadField`, so the tombstone must
  still arrive MARKED in the compacted board shape and in a declared-field shape. Pinned because a
  future board projection that dropped `deleted_at` would silently un-mark every tombstone.
  */
  it("keeps the tombstone marked through the compact board shape and a declared-field read", async () => {
    const doomed = await seedLive("RUFU-5809");
    const live = await seedLive("RUFU-5810");
    await store.deleteTask(doomed.id);

    const compact = await store.listTasks({ ...FORENSIC_READ, compactBoardFeed: true });
    const compactTombstone = compact.find((t) => t.id === doomed.id);
    expect(compactTombstone, "compact board shape must still carry the tombstone").toBeDefined();
    expect(compactTombstone!.deletedAt).toBeTruthy();
    expect(deriveTaskLifecycle(compactTombstone!)).toBe("deleted");
    expect(deriveTaskLifecycle(compact.find((t) => t.id === live.id)!)).toBe("live");

    // A declared field set is always a strict SUBSET of the row, and `deletedAt` is not declarable,
    // so it survives every declaration too.
    const declared = await store.listTasks({
      ...FORENSIC_READ,
      slim: false,
      fields: ["description"],
    });
    const declaredTombstone = declared.find((t) => t.id === doomed.id);
    expect(declaredTombstone, "declared-field shape must still carry the tombstone").toBeDefined();
    expect(deriveTaskLifecycle(declaredTombstone!)).toBe("deleted");
  });

  /*
  FNXC:TaskLifecycleProjection 2026-11-13-00:37 (RUFU-583): the SANE-531 half of the reported
  symptom. That card was never deleted at all — its delete was REFUSED for lineage references — and
  the naive `deletedAt is falsy` filter could see neither the tombstones nor the survivor, so a
  verification built on it wrongly reported that all five deletes had landed. The refusal must leave
  the parent demonstrably LIVE and still listed, so a caller that saw the 409 and then reads the
  board gets one consistent answer instead of a later 404/200 mismatch.
  */
  it("leaves a lineage-refused parent live and listed after the refusal", async () => {
    const parent = await seedLive("RUFU-5811");
    // Lineage is the `source.sourceParentTaskId` edge, which is what `findLiveLineageChildren`
    // selects on — a top-level field of the same name is a derived read, not the stored edge.
    const child = await store.createTask({
      description: "RUFU-583 lineage child",
      column: "todo",
      source: { sourceType: "api", sourceParentTaskId: parent.id },
    });

    await expect(store.deleteTask(parent.id)).rejects.toBeInstanceOf(TaskHasLineageChildrenError);

    const reloaded = await store.getTask(parent.id);
    expect(reloaded.deletedAt).toBeUndefined();
    expect(deriveTaskLifecycle(reloaded)).toBe("live");

    const board = await store.listTasks({ ...BOARD_READ });
    expect(board.map((t) => t.id)).toContain(parent.id);
    assertAllRowsDeriveLive(board, "board read after a refused delete");

    /*
    The refusal is the one delete outcome that leaves the row LIVE, and this asserts it stayed live in
    the SHAPE the board consumes: the real route hands rows to `withTaskLifecycleAll`, so the projected
    payload — not just the raw row — must state `live` for the refused parent. A projection that
    mistook a refused-delete row for a tombstone would show up here and nowhere else.
    */
    const projected = withTaskLifecycleAll(board) as Array<Task & { lifecycle?: string }>;
    const projectedParent = projected.find((row) => row.id === parent.id);
    expect(projectedParent?.lifecycle).toBe("live");
    expect(projectedParent?.deletedAt).toBeUndefined();

    // The refusal names the live children, which is the structured report the route turns into 409.
    await expect(store.deleteTask(parent.id)).rejects.toMatchObject({
      name: "TaskHasLineageChildrenError",
      childIds: expect.arrayContaining([child.id]),
    });
  });
});
