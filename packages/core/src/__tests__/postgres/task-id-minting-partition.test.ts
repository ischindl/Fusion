/**
 * Two-project task-ID minting partition test (RUFU-320).
 *
 * FNXC:TaskIdMintingPartition 2026-11-08-09:30 (RUFU-320):
 * The reported defect: cards created by the CEO agent from agent chat with no explicit project
 * landed on the `vllm-rocm` board (proj_ab8b3ac6277e43a0) carrying the `RUFU` prefix owned by the
 * RunFusion project, while RunFusion held its own RUFU-002 ("Codebase Health Audit", done) and
 * RUFU-003 ("Build Pipeline Audit", done). Two distinct live rows, one ID string, distinguished
 * only by project_id. `fn task show RUFU-003` then resolved by default project to the OTHER card.
 *
 * This file states the invariant the fix must hold, expressed as the two reproductions named in
 * the task's Symptom Verification, against ONE PostgreSQL database hosting TWO bound projects:
 *
 *  (1) a create scoped to project B mints B's own prefix and B's own next number — and a mint
 *      whose target partition cannot be proven agrees with the settings/counter partition is
 *      REFUSED with the named reason and creates no row (never silently minted foreign);
 *  (2) two projects sharing one prefix never produce the same ID string, proven DB-wide by the
 *      central claim table holding no task id claimed under two project ids.
 *
 * RED on `main` before RUFU-320: leg 2 minted the same string in both partitions (allocator state
 * is keyed per project and the tasks primary key is (project_id, id), so the duplicate was legal
 * and `allocator-cross-project.test.ts` pinned it as a feature), and leg 1 minted the calling
 * store's prefix for a card destined for another project.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1), matching the other pg suites.
 */

import { it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { TaskStore } from "../../store.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import { writeProjectConfig } from "../../task-store/async/async-settings.js";
import { insertTaskRow } from "../../task-store/async/async-persistence.js";
import * as schema from "../../postgres/schema/index.js";
import {
  pgDescribe,
  createTaskStoreForTest,
} from "../../__test-utils__/pg-test-harness.js";

const PROJECT_A = "proj_mint_a";
const PROJECT_B = "proj_mint_b";

/*
One database, two bound project stores. The harness supplies the schema substrate (its own
store runs project-agnostic on the legacy partition and is closed here); each project store is
built the way the startup factory builds one — a project-bound connection set (session GUC +
forced RLS + runtime role) plus an AsyncDataLayer carrying the SAME project id — because the
invariant under test is precisely that those two identity sources agree.

Each store gets its own empty global-settings directory so the merged settings read cannot pick
up a taskPrefix from the developer's real ~/.fusion/settings.json: a minting-namespace test must
not depend on the machine it runs on.
*/
interface ProjectStore {
  store: TaskStore;
  layer: AsyncDataLayer;
  connections: PostgresConnections;
}

interface TestCtx {
  teardownBase: () => Promise<void>;
  testUrl: string;
  admin: AsyncDataLayer;
  adminClose: () => Promise<void>;
  a: ProjectStore;
  b: ProjectStore;
}

/**
 * A project-scoped global-settings directory pre-seeded with `taskPrefix`.
 *
 * `getSettingsFast()` merges `{...DEFAULT_SETTINGS, ...globalSettings, ...projectSettings}` and the
 * global file is shared by EVERY project the daemon boots, so a `taskPrefix` written there decides
 * the minting namespace of any project that has no project-level value of its own. This is the
 * concrete field mechanism behind the reported cards: the row's `project_id` is stamped from the
 * bound data layer (the DESTINATION project), while the prefix came from settings the destination
 * project never owned.
 */
async function openProjectStore(
  backend: ResolvedBackend,
  projectId: string,
  prefixDir: string,
  globalSettings?: Record<string, unknown>,
): Promise<ProjectStore> {
  const connections = await createConnectionSetFromUrl(backend, {
    poolMax: 4,
    connectTimeoutSeconds: 5,
    projectId,
    useRuntimeRole: true,
  });
  const layer = createAsyncDataLayer(connections, { projectId });
  const rootDir = await mkdtemp(join(tmpdir(), `${prefixDir}-root-`));
  const globalSettingsDir = await mkdtemp(join(tmpdir(), `${prefixDir}-global-`));
  if (globalSettings) {
    await writeFile(join(globalSettingsDir, "settings.json"), JSON.stringify(globalSettings), "utf8");
  }
  const store = new TaskStore(rootDir, globalSettingsDir, { asyncLayer: layer });
  await store.init();
  return { store, layer, connections };
}

async function setupCtx(): Promise<TestCtx> {
  const base = await createTaskStoreForTest({
    prefix: "fusion_mintpart",
    copyFromGolden: true,
  });
  const backend: ResolvedBackend = {
    mode: "external",
    runtimeUrl: base.testUrl,
    migrationUrl: base.testUrl,
    migrationUrlOverridden: false,
  };
  // Administrative (RLS-bypassing) view, used to read BOTH projects' partitions in one query.
  const adminConnections = await createConnectionSetFromUrl(backend, { poolMax: 2, connectTimeoutSeconds: 5 });
  const admin = createAsyncDataLayer(adminConnections);

  const a = await openProjectStore(backend, PROJECT_A, "mintpart-a");
  const b = await openProjectStore(backend, PROJECT_B, "mintpart-b");
  return {
    teardownBase: base.teardown,
    testUrl: base.testUrl,
    admin,
    adminClose: () => adminConnections.close(),
    a,
    b,
  };
}

async function teardownCtx(ctx: TestCtx | null): Promise<void> {
  if (!ctx) return;
  const closers = [ctx.a, ctx.b];
  for (const project of closers) {
    try {
      project.store.stopWatching();
    } catch {
      // best-effort
    }
    try {
      await project.store.close();
    } catch {
      // best-effort
    }
    try {
      await project.layer.close();
    } catch {
      // best-effort
    }
  }
  try {
    await ctx.adminClose();
  } catch {
    // best-effort
  }
  try {
    await ctx.teardownBase();
  } catch {
    // best-effort
  }
}

/** Give a project its own minting namespace (its config row, under its own RLS partition). */
async function setProjectPrefix(project: ProjectStore, taskPrefix: string): Promise<void> {
  await writeProjectConfig(project.layer, { taskPrefix });
}

/** Read every (project_id, id) row of the live tasks table across ALL projects. */
async function allTaskRows(ctx: TestCtx): Promise<Array<{ projectId: string; id: string }>> {
  return ctx.admin.db
    .select({ projectId: schema.project.tasks.projectId, id: schema.project.tasks.id })
    .from(schema.project.tasks) as Promise<Array<{ projectId: string; id: string }>>;
}

/** Read the DB-wide id claim registry; absent table means the fix has not landed yet. */
async function claimRows(ctx: TestCtx): Promise<Array<{ taskId: string; projectId: string }>> {
  const table = "central.global_task_id_claim";
  const exists = (await ctx.admin.db.execute(
    sql`SELECT to_regclass(${table}) AS reg`,
  )) as unknown as Array<{ reg: string | null }>;
  if (!exists[0]?.reg) return [];
  return ctx.admin.db.execute(
    sql`SELECT task_id AS "taskId", project_id AS "projectId" FROM ${sql.raw(table)}`,
  ) as unknown as Promise<Array<{ taskId: string; projectId: string }>>;
}

pgDescribe("task-ID minting partition (two projects, one database, RUFU-320)", () => {
  let ctx: TestCtx | null = null;

  afterEach(async () => {
    await teardownCtx(ctx);
    ctx = null;
  });

  /**
   * Symptom Verification (2) — the reported duplicate pair.
   *
   * Both projects mint from the SAME prefix (the report's two cards both carried RUFU-). The
   * invariant is that the ID STRING is a database-wide namespace: three cards from A and three
   * from B produce six distinct strings, and the central claim table proves it independently of
   * the row scan.
   *
   * On `main` before the fix both projects started at FN-001 (allocator state is keyed per
   * project and the floor scan is RLS-scoped to one project), so this leg was RED with three
   * colliding strings.
   */
  it("two projects sharing one prefix mint disjoint ID strings DB-wide", async () => {
    ctx = await setupCtx();
    await setProjectPrefix(ctx.a, "FN");
    await setProjectPrefix(ctx.b, "FN");

    const idsA: string[] = [];
    const idsB: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      idsA.push((await ctx.a.store.createTask({ description: `project A card ${i + 1}` })).id);
      idsB.push((await ctx.b.store.createTask({ description: `project B card ${i + 1}` })).id);
    }

    const all = [...idsA, ...idsB];
    expect(new Set(all).size).toBe(6);
    expect(idsA.every((id) => id.startsWith("FN-"))).toBe(true);
    expect(idsB.every((id) => id.startsWith("FN-"))).toBe(true);

    // Every card is in its OWN partition — the minting fix must not move rows between projects.
    const rows = await allTaskRows(ctx);
    const partitionOf = (id: string) => rows.filter((r) => r.id === id).map((r) => r.projectId);
    for (const id of idsA) expect(partitionOf(id)).toEqual([PROJECT_A]);
    for (const id of idsB) expect(partitionOf(id)).toEqual([PROJECT_B]);

    // The DB-wide claim registry holds each minted string exactly once.
    const claims = await claimRows(ctx);
    const duplicated = claims
      .map((c) => c.taskId)
      .filter((taskId, index, ids) => ids.indexOf(taskId) !== index);
    expect(duplicated).toEqual([]);
    const claimedIds = new Set(claims.map((c) => c.taskId));
    for (const id of all) expect(claimedIds.has(id)).toBe(true);
  });

  /**
   * Symptom Verification (1) — the foreign-namespace mint.
   *
   * A create that NAMES project B as its destination while reaching project A's store must not
   * mint A's namespace onto a card destined for B. The honest outcomes are: mint B's own prefix
   * through B's partition (the transfer precedent — create through the target store), or REFUSE
   * with the named reason. What is never acceptable is what `main` did: silently mint `RUFU-…`
   * for a card the caller scoped to the other project.
   */
  it("a create scoped to another project never mints the calling project's namespace", async () => {
    ctx = await setupCtx();
    await setProjectPrefix(ctx.a, "RUFU");
    await setProjectPrefix(ctx.b, "VLLM");

    let mintedId: string | undefined;
    let refusal: unknown;
    try {
      // `targetProjectId` is the minting-context assertion of RUFU-320. Before the fix the field
      // does not exist, so the create ignores it and mints project A's namespace — the defect.
      const scopedInput = {
        description: "card the caller destined for the other project",
        targetProjectId: PROJECT_B,
      } satisfies Record<string, unknown> as Parameters<TaskStore["createTask"]>[0];
      mintedId = (await ctx.a.store.createTask(scopedInput)).id;
    } catch (error) {
      refusal = error;
    }

    const rows = await allTaskRows(ctx);
    const aRows = rows.filter((r) => r.projectId === PROJECT_A);
    const bRows = rows.filter((r) => r.projectId === PROJECT_B);

    if (refusal) {
      // Refused honestly: no row anywhere, and the reason names the partition disagreement.
      expect(aRows).toHaveLength(0);
      expect(bRows).toHaveLength(0);
      expect(String(refusal)).toContain("task-id-minting-partition-mismatch");
      return;
    }

    // If a row was created, it must carry the DESTINATION project's namespace, not the caller's.
    expect(mintedId).toBeDefined();
    expect(mintedId!.startsWith("RUFU-")).toBe(false);
    expect(bRows.map((r) => r.id)).toContain(mintedId);
  });

  /**
   * Must-stay-green: distinct prefixes keep minting their own namespace and their own counter.
   * This leg is green before and after — it is the regression guard that the new DB-wide rule did
   * not turn ordinary single-project minting into a refusal.
   */
  it("each project still mints its own prefix and its own next number", async () => {
    ctx = await setupCtx();
    await setProjectPrefix(ctx.a, "RUFU");
    await setProjectPrefix(ctx.b, "VLLM");

    const first = await ctx.a.store.createTask({ description: "first A card" });
    const second = await ctx.a.store.createTask({ description: "second A card" });
    const other = await ctx.b.store.createTask({ description: "first B card" });

    expect(first.id.startsWith("RUFU-")).toBe(true);
    expect(second.id.startsWith("RUFU-")).toBe(true);
    expect(other.id.startsWith("VLLM-")).toBe(true);
    expect(Number(second.id.split("-")[1])).toBeGreaterThan(Number(first.id.split("-")[1]));
    // B counts from its own floor; it is not forced to continue A's sequence by one.
    expect(Number(other.id.split("-")[1])).toBeGreaterThanOrEqual(1);

    const rows = await allTaskRows(ctx);
    expect(rows.filter((r) => r.projectId === PROJECT_A).map((r) => r.id).sort())
      .toEqual([first.id, second.id].sort());
    expect(rows.filter((r) => r.projectId === PROJECT_B).map((r) => r.id)).toEqual([other.id]);
  });

  /**
   * The demonstrated field mechanism: the shared global-settings tier decides a bound project's
   * minting namespace.
   *
   * The destination project owns NO `taskPrefix` of its own; the daemon-wide `settings.json` carries
   * one that belongs to a different project's namespace. Today the merged settings read hands that
   * foreign prefix to the minting site while the inserted row is stamped with the destination
   * project's id — the reported `RUFU-…` card on the `vllm-rocm` board, reproduced from a config
   * shape rather than by guessing which file the operator's daemon held.
   */
  it("the shared global-settings tier cannot decide a bound project's minting namespace", async () => {
    ctx = await setupCtx();
    // Project B has no prefix of its own; the global file claims namespace ZZZ.
    const backend: ResolvedBackend = {
      mode: "external",
      runtimeUrl: ctx.testUrl,
      migrationUrl: ctx.testUrl,
      migrationUrlOverridden: false,
    };
    const leaked = await openProjectStore(backend, "proj_mint_c", "mintpart-c", { taskPrefix: "ZZZ" });
    try {
      const task = await leaked.store.createTask({ description: "global tier must not mint" });
      expect(task.id.startsWith("ZZZ-")).toBe(false);
      expect(/^(FN|KB)-\d{3,}$/u.test(task.id)).toBe(true);

      const rows = await allTaskRows(ctx);
      expect(rows.filter((r) => r.id === task.id).map((r) => r.projectId)).toEqual(["proj_mint_c"]);
    } finally {
      leaked.store.stopWatching();
      await leaked.store.close().catch(() => undefined);
      await leaked.layer.close().catch(() => undefined);
    }
  });

  /**
   * Exclusion evidence for the named leak candidate "the allocator's fallback to the legacy
   * singleton config row leaks another project's prefix".
   *
   * The fallback is real (`configScope` reads `id = 1` when the layer is unbound), but under
   * enforced RLS a project-bound session cannot SEE the legacy row, so the fallback can only ever
   * yield the path-specific hard-coded default — never a foreign project's prefix. This leg pins
   * that so the diagnosis is measured rather than assumed, and keeps the fallback itself working
   * for the genuinely unbound single-project case.
   */
  it("the legacy config-row fallback cannot supply another project's prefix", async () => {
    ctx = await setupCtx();
    // A real prefix on project A, and a foreign prefix on the legacy singleton partition, written
    // through an administrative (bypass) layer so the row physically exists.
    await setProjectPrefix(ctx.a, "RUFU");
    await writeProjectConfig(ctx.admin, { taskPrefix: "ZZZ" });

    const prefixA = await ctx.a.layer.db
      .select({ settings: schema.project.config.settings })
      .from(schema.project.config)
      .where(eq(schema.project.config.projectId, PROJECT_A));
    expect((prefixA[0]?.settings as { taskPrefix?: string } | undefined)?.taskPrefix).toBe("RUFU");

    // Project A's session cannot read the legacy partition at all: RLS filters it out.
    const visibleLegacy = (await ctx.a.store.asyncLayer!.db.execute(
      sql`SELECT project_id FROM ${sql.raw("project.config")} WHERE id = 1`,
    )) as unknown as Array<{ project_id: string }>;
    expect(visibleLegacy.map((r) => r.project_id).includes("__legacy_unscoped__")).toBe(false);

    // So a create in A mints A's own namespace, never the legacy row's ZZZ.
    const task = await ctx.a.store.createTask({ description: "legacy fallback cannot leak" });
    expect(task.id.startsWith("RUFU-")).toBe(true);
    expect(task.id.startsWith("ZZZ-")).toBe(false);

    // And the legacy partition stays where it belongs: no row filed into it.
    const rows = await allTaskRows(ctx);
    expect(rows.filter((r) => r.projectId === "__legacy_unscoped__")).toEqual([]);
    expect(rows.filter((r) => and(eq(schema.project.tasks.projectId, PROJECT_A))).length).toBe(1);
  });
});
