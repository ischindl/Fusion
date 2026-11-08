/**
 * FNXC:WakeDeltaPhantomIds 2026-11-05-08:05 (RUFU-455):
 * THE NON-TAUTONOMY AUTHORITY for the wake-delta phantom-id guard.
 *
 * The defect: a heartbeat wake delta published `RUFU-454` and `RUFU-455` to `agent-5683bf15` as
 * `ready_todo (tier 1)` assignments carrying that agent as owner, while `fn_task_show` answered
 * `Task RUFU-454 not found.` for both — and an operator issued a routing command against a third id
 * the same class of surface named. The agent's write-up of the incident was the only forensic trail.
 *
 * Why this file exists at all rather than only an engine-side test: the guard validates through the
 * SAME `TaskStore` instance whose list read produced the rows, so on that instance the two reads agree
 * BY CONSTRUCTION. A guard tested only against that instance proves nothing about the one thing an
 * operator needs to know — whether the guard's predicate is the same predicate the user-visible lookup
 * uses. So the equivalence is asserted here, against real rows and a real bound layer, on all four
 * states a task id can be in:
 *   live            -> `getTask` returns;        presence row with `deletedAt: null`
 *   soft-deleted    -> `getTask` throws 404;     presence row WITH `deletedAt`  (outcome `tombstone`)
 *   other project   -> `getTask` throws 404;     NO presence row                (outcome `absent`)
 *   absent          -> `getTask` throws 404;     NO presence row                (outcome `absent`)
 * Those two negatives are distinguishable ONLY because the presence read deliberately omits
 * `ACTIVE_TASK_FILTER`; with the filter applied the tombstone arm below would fail, which is the point
 * of asserting all four rather than "presence finds live rows".
 *
 * It also pins the shipped `outcome` vocabulary to what real rows can actually produce. There is no
 * `scope-mismatch` arm and there never can be: `Task` carries no project identity, so nothing can
 * observe "this row belongs to another project" — a foreign row and a missing row are one measurement
 * (`absent`) under the binding that made it. Inventing the fourth value would be a claim, not a reading.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import { TaskNotFoundError } from "../../task-store/errors.js";
import { TaskStore } from "../../store.js";

const OWNER_AGENT_ID = "agent-5683bf15";

/** The exact id set the report named, so this file stays readable against the incident. */
const LIVE_ID = "RUFU-454";
const TOMBSTONE_ID = "RUFU-455";
const FOREIGN_ID = "RUFU-456";
const ABSENT_ID = "RUFU-457";

const PROJECT_A = "rufu455-parity-a";
const PROJECT_B = "rufu455-parity-b";

pgDescribe("getTaskPresence agrees with getTask on every real row state (RUFU-455)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "rufu455_parity" });
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** A store bound to one project — the shape `createTaskStoreForBackend` builds per project. */
  const boundStore = (projectId: string): TaskStore =>
    new TaskStore(h.rootDir(), undefined, { asyncLayer: { ...h.layer(), projectId } as AsyncDataLayer });

  /**
   * The per-`<id>` task mirror directory is created by the store's own bootstrap, which these extra
   * bound stores do not run (only `h.store()` does), so the shared tasks root is made here. Without it a
   * `createTask` through a second bound store dies on `ENOENT … /tasks/<id>/task.json`, which is a
   * harness-artifact, not a product fact.
   */
  const ensureTasksRoot = (): void => {
    mkdirSync(join(h.rootDir(), ".fusion", "tasks"), { recursive: true });
  };

  /**
   * Seed named ids under one project partition through the bound store, so every row is written by
   * production paths. `assignedAgentId` is stamped after insert because intake-time assignment runs the
   * intake owner resolver, which needs a registered agent row — seeded here as a real executor, the role
   * the report's owner held. `softDeleteIds` are removed through production `deleteTask` so `deleted_at`
   * is written by the same path that writes it live.
   */
  const seedProject = async (
    store: TaskStore,
    projectId: string,
    ids: { live: string[]; tombstoned: string[] },
  ): Promise<void> => {
    const now = new Date().toISOString();
    await store.asyncLayer!.db.insert(schema.project.agents).values({
      projectId,
      id: OWNER_AGENT_ID,
      name: OWNER_AGENT_ID,
      role: "executor",
      roles: ["executor"],
      state: "idle",
      taskId: null,
      createdAt: now,
      updatedAt: now,
    });

    for (const id of [...ids.live, ...ids.tombstoned]) {
      /*
      `createTaskWithReservedId` is the sanctioned explicit-id path on PostgreSQL: it routes the whole
      create through the reserved-id transaction, so the `task.json` compatibility mirror lands where the
      store expects it. A bare `createTask({ id })` writes a staging dir and leaves the mirror unreadable
      for a store that never ran `init()` — a harness artifact, not a product fact.
      */
      await store.createTaskWithReservedId(
        {
          title: `${id} parity fixture`,
          description: "RUFU-455 presence parity",
          column: "todo",
        } as never,
        { taskId: id, applyDefaultWorkflowSteps: false },
      );
      await store.updateTask(id, { assignedAgentId: OWNER_AGENT_ID });
    }
    for (const id of ids.tombstoned) {
      await store.deleteTask(id);
    }
  };

  /**
   * The four states the guard must be able to tell apart, seeded across TWO project partitions of the
   * same shared cluster: `FOREIGN_ID` exists only under PROJECT_B, which the composite
   * `(project_id, id)` primary key makes a legitimate state — and the state the report's disk probe
   * implies, since its board named ids its own store could not resolve.
   */
  const seedAll = async (storeA: TaskStore, storeB: TaskStore): Promise<void> => {
    ensureTasksRoot();
    await seedProject(storeA, PROJECT_A, { live: [LIVE_ID], tombstoned: [TOMBSTONE_ID] });
    await seedProject(storeB, PROJECT_B, { live: [FOREIGN_ID], tombstoned: [] });
  };

  /** Read the tombstone marker straight off the table: the parity claim must not rest on the probe. */
  const rawDeletedAt = async (projectId: string, id: string): Promise<string | null> => {
    const rows = await h.adminDb()
      .select({ deletedAt: schema.project.tasks.deletedAt })
      .from(schema.project.tasks)
      .where(and(
        eq(schema.project.tasks.projectId, projectId),
        eq(schema.project.tasks.id, id),
      ));
    return rows[0]?.deletedAt ?? null;
  };

  describe("presence/lookup equivalence on real rows", () => {
    let storeA: TaskStore;

    beforeEach(async () => {
      storeA = boundStore(PROJECT_A);
      await seedAll(storeA, boundStore(PROJECT_B));
    });

    it("live row: getTask returns and presence reports a live row", async () => {
      const task = await storeA.getTask(LIVE_ID);
      expect(task.id).toBe(LIVE_ID);

      const presence = await storeA.getTaskPresence([LIVE_ID]);
      expect(presence).toEqual([{ id: LIVE_ID, deletedAt: null }]);
    });

    it("soft-deleted row: getTask throws and presence reports deletedAt (outcome 'tombstone')", async () => {
      // The tombstone is a real durable fact, not a fixture artifact.
      expect(await rawDeletedAt(PROJECT_A, TOMBSTONE_ID)).toBeTruthy();

      await expect(storeA.getTask(TOMBSTONE_ID)).rejects.toBeInstanceOf(TaskNotFoundError);

      const presence = await storeA.getTaskPresence([TOMBSTONE_ID]);
      expect(presence).toHaveLength(1);
      expect(presence[0]!.id).toBe(TOMBSTONE_ID);
      expect(presence[0]!.deletedAt).toBeTruthy();
    });

    it("row only under another project_id: getTask throws AND presence reports no row (outcome 'absent')", async () => {
      // The row genuinely exists in the shared cluster, under the other partition.
      const foreignStore = boundStore(PROJECT_B);
      await expect(foreignStore.getTask(FOREIGN_ID)).resolves.toMatchObject({ id: FOREIGN_ID });

      // Under THIS project's binding it resolves to nothing, through both authorities.
      await expect(storeA.getTask(FOREIGN_ID)).rejects.toBeInstanceOf(TaskNotFoundError);
      const presence = await storeA.getTaskPresence([FOREIGN_ID]);
      expect(presence).toEqual([]);
    });

    it("absent id: both authorities say no, identically to the foreign-project case", async () => {
      await expect(storeA.getTask(ABSENT_ID)).rejects.toBeInstanceOf(TaskNotFoundError);
      expect(await storeA.getTaskPresence([ABSENT_ID])).toEqual([]);
    });

    it("a foreign row and a missing row are ONE measurement, so no 'scope-mismatch' outcome is producible", async () => {
      // This is the assertion that keeps the shipped enum honest: whatever the two ids' underlying
      // states differ in, the predicate the guard runs cannot tell them apart. If a future change made
      // them distinguishable, this fails and the enum gains a value with a producing predicate.
      const [foreign, missing] = await Promise.all([
        storeA.getTaskPresence([FOREIGN_ID]),
        storeA.getTaskPresence([ABSENT_ID]),
      ]);
      expect(foreign).toEqual(missing);
    });

    it("one round trip answers the whole id set, and answers every id it was given", async () => {
      const presence = await storeA.getTaskPresence([
        LIVE_ID, TOMBSTONE_ID, FOREIGN_ID, ABSENT_ID,
      ]);
      // Only ids THIS binding holds come back; the other two are absent by omission, not by a null.
      expect(presence.map((row) => row.id).sort()).toEqual([LIVE_ID, TOMBSTONE_ID]);
    });

    it("the assignment population and the presence read can disagree, which is why the guard is not a tautology", async () => {
      /*
      The guard's whole purpose is the case where the population handed to it names an id this store
      cannot resolve. A real store never produces that from its own live list read — so the disagreement
      is constructed the way the report observed it, from a population that came from somewhere else
      (another binding, another deployment, or a stale caller). Presence must refuse it. This is also
      the shape a forensic-shaped read produces, which is how a tombstone reaches the guard.
      */
      const population = [LIVE_ID, TOMBSTONE_ID, FOREIGN_ID, ABSENT_ID];
      const presence = await storeA.getTaskPresence(population);
      const unresolvable = population.filter((id) => !presence.some((row) => row.id === id));
      expect(unresolvable).toEqual([FOREIGN_ID, ABSENT_ID]);

      // And each withheld id's outcome is decided by real rows, matching the two shipped enum values:
      // the one row this binding holds that is present-but-deleted is exactly the `tombstone` arm.
      const tombstones = presence.filter((row) => row.deletedAt !== null).map((row) => row.id);
      expect(tombstones).toEqual([TOMBSTONE_ID]);
    });
  });

  describe("scope binding is what distinguishes a phantom from someone else's card", () => {
    it("an unbound layer spans projects, so it resolves the foreign row the bound layer cannot", async () => {
      /*
      This is the E1 consequence the audit row reports as `storeBound: false`. On a project-agnostic
      layer `taskProjectScope` no-ops, so BOTH the list read and the presence read span every project
      on the shared cluster and they still agree with each other — which is exactly why the guard cannot
      catch a cross-binding phantom and must report the binding instead of pretending otherwise.
      */
      const bound = boundStore(PROJECT_A);
      await seedAll(bound, boundStore(PROJECT_B));

      const unbound = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
      const unboundPresence = await unbound.getTaskPresence([FOREIGN_ID]);
      expect(unboundPresence.map((row) => row.id)).toEqual([FOREIGN_ID]);

      const boundPresence = await bound.getTaskPresence([FOREIGN_ID]);
      expect(boundPresence).toEqual([]);
    });
  });
});
