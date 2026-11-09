/**
 * The DB-wide task-id claim registry (RUFU-320).
 *
 * FNXC:TaskIdGlobalUniqueness 2026-11-08-10:44:
 * `project.tasks` is keyed `(project_id, id)`, so one id string can exist in two projects and both are
 * live cards — which is what made `fn task show RUFU-003` ambiguous. `central.global_task_id_claim` is
 * keyed on the id string ALONE, so a minted string has exactly one owner database-wide. This file proves
 * the four rules that make that safe:
 *
 *  1. a second project cannot take a string another project owns, through ANY write seam (plain insert,
 *     the in-transaction insert used by create, or the upsert used by re-import/restore);
 *  2. a rolled-back create leaves no claim behind — an id is only consumed by work that committed;
 *  3. the OWNING project may re-claim its own string forever (archive/restore, soft-deleted reuse,
 *     tombstone resurrection), and a reservation that never produced a card releases its pending claim;
 *  4. the `fusion_runtime` role can read and write the table, because every production write runs as it.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1), like the other pg suites.
 */

import { it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import { pgDescribe, createTaskStoreForTest } from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import { centralTableNames } from "../../postgres/schema/central.js";
import {
  TaskIdAddressAmbiguousError,
  TaskIdClaimOwnershipError,
  TASK_ID_CLAIM_OWNED_BY_ANOTHER_PROJECT,
  claimTaskIdInTransaction,
  insertTaskRow,
  insertTaskRowInTransaction,
  readTaskRow,
  upsertTaskRowInTransaction,
} from "../../task-store/async/async-persistence.js";import {
  createAsyncDistributedTaskIdAllocator,
  reconcileTaskIdStateAsync,
} from "../../task-store/async/async-allocator.js";
import { detectTaskIdIntegrityAnomaliesAsync } from "../../postgres/async-task-id-integrity.js";
import { seedPreExistingTaskIdDuplicate } from "../../__test-utils__/pg-test-harness.js";

/*
FNXC:PgTestHarnessAdoption 2026-11-08-10:44 (RUFU-320):
One database, two project-bound runtime-role sessions — the same shape `allocator-cross-project.test.ts`
uses, because the subject is what one partition can and cannot do to another's id. The harness store's
own unbound init rows live outside proj_a/proj_b, so the assertions below never trip over them.
*/
type BaseHarness = Awaited<ReturnType<typeof createTaskStoreForTest>>;

interface Ctx {
  baseTeardown: () => Promise<void>;
  adminSql: BaseHarness["adminSql"];
  adminDb: BaseHarness["adminDb"];
  /** The harness store's own layer: no project partition, so its by-id reads span projects. */
  baseLayer: BaseHarness["layer"];
  connections: PostgresConnections[];
  layerA: AsyncDataLayer;
  layerB: AsyncDataLayer;
}

let ctx: Ctx | null = null;

async function setupCtx(): Promise<Ctx> {
  const base = await createTaskStoreForTest({ prefix: "fusion_claim_test", copyFromGolden: true });
  const backend: ResolvedBackend = {
    mode: "external",
    runtimeUrl: base.testUrl,
    migrationUrl: base.testUrl,
    migrationUrlOverridden: false,
  };
  const connections: PostgresConnections[] = [];
  const open = async (projectId: string): Promise<AsyncDataLayer> => {
    const connectionsForProject = await createConnectionSetFromUrl(backend, {
      poolMax: 4,
      connectTimeoutSeconds: 5,
      projectId,
      useRuntimeRole: true,
    });
    connections.push(connectionsForProject);
    return createAsyncDataLayer(connectionsForProject, { projectId });
  };
  const layerA = await open("proj_a");
  const layerB = await open("proj_b");
  return {
    baseTeardown: base.teardown,
    adminSql: base.adminSql,
    adminDb: base.adminDb,
    baseLayer: base.layer,
    connections,
    layerA,
    layerB,
  };
}

async function teardownCtx(): Promise<void> {
  if (!ctx) return;
  const current = ctx;
  ctx = null;
  await Promise.all(current.connections.map((c) => c.close().catch(() => {})));
  await current.baseTeardown().catch(() => {});
}

function taskRecord(id: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return { id, description: `claim test ${id}`, column: "todo", currentStep: 0, createdAt: now, updatedAt: now };
}

async function claimOwners(adminSql: Ctx["adminSql"], taskId: string): Promise<Array<{ taskId: string; projectId: string; reservationId: string | null }>> {
  return (await adminSql`
    SELECT task_id AS "taskId", project_id AS "projectId", reservation_id AS "reservationId"
    FROM central.global_task_id_claim WHERE task_id = ${taskId}
  `) as unknown as Array<{ taskId: string; projectId: string; reservationId: string | null }>;
}

async function rowCount(layer: AsyncDataLayer, taskId: string): Promise<number> {
  const rows = await layer.db
    .select({ id: schema.project.tasks.id })
    .from(schema.project.tasks)
    .where(eq(schema.project.tasks.id, taskId));
  return rows.length;
}

pgDescribe("central.global_task_id_claim (RUFU-320)", () => {
  afterEach(async () => {
    await teardownCtx();
  });

  it("registers the table in the central schema and never in the project schema", async () => {
    ctx = await setupCtx();
    expect(centralTableNames).toContain("global_task_id_claim");

    const schemas = (await ctx.adminSql`
      SELECT schemaname FROM pg_tables WHERE tablename = 'global_task_id_claim'
    `) as unknown as Array<{ schemaname: string }>;
    expect(schemas.map((row) => row.schemaname)).toEqual(["central"]);

    /*
    The primary key is the id string ALONE. A composite `(project_id, task_id)` key would be accepted by
    the project-isolation guards and would permit exactly the state this table exists to forbid, so the
    column list of the primary key is the assertion that survives refactoring.
    */
    const pkColumns = (await ctx.adminSql`
      SELECT a.attname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = 'central' AND c.relname = 'global_task_id_claim' AND i.indisprimary
    `) as unknown as Array<{ attname: string }>;
    expect(pkColumns.map((row) => row.attname)).toEqual(["task_id"]);
  });

  it("refuses a second project's write of a claimed id through every seam and creates no row", async () => {
    ctx = await setupCtx();
    const { layerA, layerB, adminSql } = ctx;

    await insertTaskRow(layerA, taskRecord("KB-700"), { lineageId: null });
    expect(await claimOwners(adminSql, "KB-700")).toEqual([
      { taskId: "KB-700", projectId: "proj_a", reservationId: null },
    ]);

    // Seam 1: the plain insert used by store-level writes.
    await expect(insertTaskRow(layerB, taskRecord("KB-700"), { lineageId: null })).rejects.toThrowError(
      TaskIdClaimOwnershipError,
    );
    // Seam 2: the in-transaction insert the create path uses.
    await expect(
      layerB.transactionImmediate(async (tx) => {
        await insertTaskRowInTransaction(tx, taskRecord("KB-700"), { lineageId: null }, layerB.projectId);
      }),
    ).rejects.toThrowError(TASK_ID_CLAIM_OWNED_BY_ANOTHER_PROJECT);
    // Seam 3: the upsert used by re-import and restore, which must not overwrite an owner either.
    await expect(
      layerB.transactionImmediate(async (tx) => {
        await upsertTaskRowInTransaction(tx, taskRecord("KB-700"), { lineageId: null }, layerB.projectId);
      }),
    ).rejects.toThrowError(TASK_ID_CLAIM_OWNED_BY_ANOTHER_PROJECT);

    expect(await rowCount(layerB, "KB-700")).toBe(0);
    // The refusal is ids-and-projects only, and never rewrites the owner.
    expect(await claimOwners(adminSql, "KB-700")).toEqual([
      { taskId: "KB-700", projectId: "proj_a", reservationId: null },
    ]);
    expect(await rowCount(layerA, "KB-700")).toBe(1);
  });

  it("rolls the claim back with a rolled-back create, so no id is half-consumed", async () => {
    ctx = await setupCtx();
    const { layerA, adminSql } = ctx;

    await expect(
      layerA.transactionImmediate(async (tx) => {
        await claimTaskIdInTransaction(tx, layerA.projectId, "KB-701");
        await insertTaskRowInTransaction(tx, taskRecord("KB-701"), { lineageId: null }, layerA.projectId);
        throw new Error("simulated create failure");
      }),
    ).rejects.toThrow("simulated create failure");

    expect(await claimOwners(adminSql, "KB-701")).toEqual([]);
    expect(await rowCount(layerA, "KB-701")).toBe(0);

    // The number is genuinely free again: the same id can be created by the same project afterwards.
    await insertTaskRow(layerA, taskRecord("KB-701"), { lineageId: null });
    expect(await claimOwners(adminSql, "KB-701")).toEqual([
      { taskId: "KB-701", projectId: "proj_a", reservationId: null },
    ]);
  });

  it("lets the owning project re-claim its own id, which is what archive/restore needs", async () => {
    ctx = await setupCtx();
    const { layerA, adminSql } = ctx;

    await insertTaskRow(layerA, taskRecord("KB-702"), { lineageId: null });
    // A re-import or restore re-writes a row its owner already claimed: same project, same string, and
    // it stays legal on repeat writes. An unscoped refusal here would lock a card out of its own id.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await layerA.transactionImmediate(async (tx) => {
        await upsertTaskRowInTransaction(tx, taskRecord("KB-702"), { lineageId: null }, layerA.projectId);
      });
    }
    expect(await claimOwners(adminSql, "KB-702")).toEqual([
      { taskId: "KB-702", projectId: "proj_a", reservationId: null },
    ]);
    expect(await rowCount(layerA, "KB-702")).toBe(1);
  });

  it("holds a reservation's claim pending and releases it when no card was created", async () => {
    ctx = await setupCtx();
    const { layerA, layerB, adminSql } = ctx;
    await reconcileTaskIdStateAsync(layerA);
    const allocatorA = createAsyncDistributedTaskIdAllocator(layerA);
    const allocatorB = createAsyncDistributedTaskIdAllocator(layerB);

    const reserved = await allocatorA.reserveDistributedTaskId({ prefix: "KB", nodeId: "node-a" });
    // Pending: the claim exists and names the reservation that wrote it.
    expect(await claimOwners(adminSql, reserved.taskId)).toEqual([
      { taskId: reserved.taskId, projectId: "proj_a", reservationId: reserved.reservationId },
    ]);

    // A sibling project must not be able to hand out the same string while it is only reserved.
    const reservedB = await allocatorB.reserveDistributedTaskId({ prefix: "KB", nodeId: "node-b" });
    expect(reservedB.taskId).not.toBe(reserved.taskId);

    // Aborting releases the pending claim, so a create that never happened consumes nothing.
    await allocatorA.abortDistributedTaskIdReservation({ reservationId: reserved.reservationId, reason: "abort", nodeId: "node-a" });
    expect(await claimOwners(adminSql, reserved.taskId)).toEqual([]);

    // Committing instead finalises it: the same call leaves the claim, without the pending marker.
    const committed = await allocatorA.reserveDistributedTaskId({ prefix: "KB", nodeId: "node-a" });
    await allocatorA.commitDistributedTaskIdReservation({ reservationId: committed.reservationId, nodeId: "node-a" });
    expect(await claimOwners(adminSql, committed.taskId)).toEqual([
      { taskId: committed.taskId, projectId: "proj_a", reservationId: null },
    ]);
  });

  /*
  FNXC:TaskIdGlobalUniqueness 2026-11-08-10:46 (RUFU-320):
  Migration 0096 records how many cross-project duplicates it found and refuses to renumber them, so the
  state has to stay visible from the card's own side as well: the partition whose row does NOT own the
  DB-wide claim is the one that sees the sibling's id string. `detectTaskIdIntegrityAnomaliesAsync` is the
  store-open/health surface the operator reads, so it is the assertion target.

  FNXC:TaskIdClaimScope 2026-11-09-08:57 (RUFU-904):
  This case asserted `status: "anomaly"` for that pair. Against production that verdict fires on 74 ids
  created 2026-07-04..2026-09-27 across RunFusion (proj_9326d74a133b421a), alfawise (proj_87bc5b3f35624449)
  and vllm-rocm (proj_ab8b3ac6277e43a0) — none of them damaged, because `project.tasks` is keyed
  `(project_id, id)` and reads are RLS-bound. The pair is reported informationally now; both rows must still
  be readable afterwards, which is the part of the old assertion that named a real invariant.
  */
  it("reports a foreign-owned id informationally without disturbing either project's row", async () => {
    ctx = await setupCtx();
    const { layerA, layerB, adminDb } = ctx;

    await insertTaskRow(layerA, taskRecord("KB-704"), { lineageId: null });
    await seedPreExistingTaskIdDuplicate(adminDb, {
      taskId: "KB-704",
      fromProjectId: "proj_a",
      toProjectId: "proj_b",
    });

    const reportB = await detectTaskIdIntegrityAnomaliesAsync(layerB.db, { projectId: "proj_b" });
    const duplicateB = reportB.crossProjectDuplicates?.find((entry) => entry.prefix === "KB");
    expect(duplicateB?.affectedIds).toEqual(["KB-704"]);
    expect(duplicateB?.ownerProjectIds).toEqual(["proj_a"]);
    expect(reportB.status).toBe("ok");
    expect(reportB.anomalies).toEqual([]);
    // Neither copy is lost: the pair is a coincidence of numbering, not an overwrite.
    expect((await readTaskRow(layerB, "KB-704"))?.projectId).toBe("proj_b");
    expect((await readTaskRow(layerA, "KB-704"))?.projectId).toBe("proj_a");

    // The owner is not told it has a problem: its row is the one the claim names.
    const reportA = await detectTaskIdIntegrityAnomaliesAsync(layerA.db, { projectId: "proj_a" });
    expect(reportA.crossProjectDuplicates ?? []).toEqual([]);
  });

  it("refuses a bare id that spans partitions instead of returning whichever copy came first", async () => {
    ctx = await setupCtx();
    const { layerA, layerB, adminDb, baseLayer } = ctx;

    await insertTaskRow(layerA, taskRecord("KB-705"), { lineageId: null });
    await seedPreExistingTaskIdDuplicate(adminDb, {
      taskId: "KB-705",
      fromProjectId: "proj_a",
      toProjectId: "proj_b",
    });

    // A partitioned read is never ambiguous: each project sees exactly its own row.
    expect((await readTaskRow(layerA, "KB-705"))?.projectId).toBe("proj_a");
    expect((await readTaskRow(layerB, "KB-705"))?.projectId).toBe("proj_b");

    // The unpartitioned read is the one that used to guess.
    await expect(readTaskRow(baseLayer, "KB-705")).rejects.toThrowError(TaskIdAddressAmbiguousError);
    await expect(readTaskRow(baseLayer, "KB-705")).rejects.toThrow(/proj_a, proj_b/);
  });

  it("is readable and writable by fusion_runtime, the role every production write runs as", async () => {
    ctx = await setupCtx();
    const { layerA, layerB, adminSql } = ctx;

    // The layers above ARE runtime-role sessions, so a successful write proves INSERT; the raw read
    // proves SELECT, which the allocator's claimed-number scan depends on.
    await insertTaskRow(layerA, taskRecord("KB-703"), { lineageId: null });
    const visible = await layerB.db
      .select({ taskId: schema.central.globalTaskIdClaim.taskId })
      .from(schema.central.globalTaskIdClaim)
      .where(eq(schema.central.globalTaskIdClaim.taskId, "KB-703"));
    expect(visible).toEqual([{ taskId: "KB-703" }]);

    const granted = (await adminSql`
      SELECT has_table_privilege('fusion_runtime', 'central.global_task_id_claim', 'SELECT, INSERT, UPDATE, DELETE') AS granted
    `) as unknown as Array<{ granted: boolean }>;
    expect(granted[0]?.granted).toBe(true);
  });
});
