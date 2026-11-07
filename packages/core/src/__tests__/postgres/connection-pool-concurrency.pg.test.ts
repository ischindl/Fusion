/**
 * RUFU-483 — the shipped runtime pool default serialized the whole dashboard API behind the engine.
 *
 * Measured on the production RunFusion dashboard on 2026-10-02: `GET /tasks/page?limit=100` took
 * 10.8-17.1 s and `GET /tasks/board-workflows` took 26-32 s, while the same page as raw SQL in `psql`
 * cost 0.110 s and `GET /settings/global` answered in 0.01 s beside a still-running slow page request.
 * The decisive datum is that `limit=1` (13.1 s) was SLOWER than `limit=100` (10.8-17.1 s) — a
 * one-row read cannot lose to a hundred-row read on query cost, only on **connection wait**. Adding
 * `FUSION_PG_POOL_MAX=20` with nothing else changed brought them to 0.5-3.0 s and 3.3-3.9 s.
 *
 * This file reproduces that failure condition against a real PostgreSQL and asserts it is gone. The
 * regression is a LEG PAIR so it cannot be vacuous: the identical busy-lane shape runs against the
 * legacy ceiling and against the shipped constant, and the shipped leg is the one that must pass.
 *
 *   Leg A — BUG-SHAPE CONTROL (`poolMax = LEGACY_DEFAULT_POOL_MAX`, 3). Every slot held, the one-row
 *     read queues. This leg is GREEN on the buggy pre-RUFU-483 code on purpose: it proves the harness
 *     can observe queueing at all. It is not the guard.
 *   Leg B — SATURATION CONTROL (`poolMax = DEFAULT_POOL_MAX`, all slots held). Also queues. Without
 *     it, Leg C's fast pass would be vacuous — this proves postgres.js genuinely queues at the
 *     ceiling, so Leg C's speed is attributable to headroom rather than to a pool that never blocks.
 *   Leg C — SHIPPED-DEFAULT GUARD (`poolMax = DEFAULT_POOL_MAX`, only the LEGACY number of slots
 *     held — the exact Leg A shape). The one-row read is served while the lane holds are still
 *     sleeping. **Restoring `DEFAULT_POOL_MAX` to 3 makes this leg fail**, which is what ties the
 *     chosen 10 to the reported symptom instead of to a number.
 *   Leg D — ATTRIBUTION. The held backends are read on the dedicated `max: 1` health session and
 *     must be visible under their `fusion-runtime:<projectId>` application name — the dependency of
 *     the `/metrics` occupancy gauges, which parse that name into their `project`/`role` labels.
 *
 * Bounded per the no-slow-tests rule: `HOLD_MS = 1200` with wide assertion margins (>= 600 ms queued,
 * <= 400 ms served), no polling loops, no widened assertion timeouts, one live connection set at a
 * time, legs sequential, and every set closed in `afterEach` so no backend outlives its leg. The file
 * peaks at `DEFAULT_POOL_MAX + 2` backends (runtime pool + dedicated health + migration sessions).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import {
  PG_AVAILABLE,
  PG_TEST_URL_BASE,
  pgDescribe,
} from "../../__test-utils__/pg-test-harness.js";
import {
  createConnectionSetFromUrl,
  DEFAULT_POOL_MAX,
  type PostgresConnections,
  type ResolvedBackend,
} from "../../postgres/connection.js";

/*
FNXC:PostgresPool 2026-11-06-22:10 (RUFU-483):
Every leg passes an EXPLICIT `poolMax:` and never relies on the resolved default, because
`resolvePoolMax` falls through to `process.env.FUSION_PG_POOL_MAX` (`options.env?.[KEY] ??
process.env[KEY]`). An operator host that exports that key — the production RunFusion box exports 8 —
would otherwise silently retarget a leg and the leg would then measure whatever the host happens to
run, which is the vacuous-guard shape this pair exists to avoid. Leg C is the only leg that speaks
about the shipped constant, and it does so by importing `DEFAULT_POOL_MAX`, not by reading the
environment.
*/
const describeWhenPg = PG_AVAILABLE ? pgDescribe : describe.skip;

/** The value that produced the reported 10.8-17.1 s / 26-32 s board paints. */
const LEGACY_DEFAULT_POOL_MAX = 3;

/** Each hold sleeps this long; every margin below is a fraction or a multiple of it. */
const HOLD_MS = 1200;
/** Queued means "waited most of a hold", not "happened to be slow": >= half of HOLD_MS. */
const QUEUED_FLOOR_MS = 600;
/** Served means "a fresh connection, immediately": a third of HOLD_MS. */
const SERVED_CEILING_MS = 400;

const TEST_URL = `${PG_TEST_URL_BASE}/postgres`;

function backend(): ResolvedBackend {
  return {
    mode: "external",
    runtimeUrl: TEST_URL,
    migrationUrl: TEST_URL,
    migrationUrlOverridden: false,
  };
}

/** One measured dashboard-shaped read against a pool with `holdCount` lane holds in flight. */
interface Burst {
  /** Wall-clock latency of the one-row read. */
  latencyMs: number;
  /** Lane holds still running when the read was issued (the saturation premise). */
  holdsPendingAtIssue: boolean;
  /** Lane holds still running at the instant the read settled. */
  holdsPendingAtCompletion: boolean;
}

/**
 * Occupy `holdCount` runtime slots, then time one dashboard-shaped one-row read.
 *
 * Two phases on purpose. Phase 1 awaits `SELECT 1` on each slot so the connections are provably
 * established BEFORE the holds are fired; otherwise the measured read could win the race for a slot
 * that a hold had not claimed yet and Leg A would measure the scheduler, not the ceiling. Phase 2
 * fires the un-awaited holds and the read in the same tick — postgres.js dispatches its queue FIFO,
 * so the holds are served first. The holds run inside immediately-invoked async functions because a
 * drizzle `execute()` is a lazy thenable: holding the un-awaited promise would start nothing.
 */
async function readWhileHeld(
  set: PostgresConnections,
  holdCount: number,
): Promise<Burst> {
  await Promise.all(
    Array.from({ length: holdCount }, () => set.runtime.execute(sql`SELECT 1 AS warmup`)),
  );

  let pending = 0;
  const holds: Array<Promise<unknown>> = [];
  for (let index = 0; index < holdCount; index += 1) {
    pending += 1;
    holds.push(
      (async () => {
        try {
          await set.runtime.execute(sql`SELECT pg_sleep(${HOLD_MS / 1000}) AS hold`);
        } catch {
          // A holder that dies early would un-saturate the pool; the premise flags below catch that.
        } finally {
          pending -= 1;
        }
      })(),
    );
  }

  const holdsPendingAtIssue = pending > 0;
  const startedAt = performance.now();
  await set.runtime.execute(sql`SELECT 1 AS dashboard_read`);
  const latencyMs = performance.now() - startedAt;
  const holdsPendingAtCompletion = pending > 0;

  // Await every hold so the caller can never hand the next leg a pool with sleepers left behind.
  await Promise.allSettled(holds);
  return { latencyMs, holdsPendingAtIssue, holdsPendingAtCompletion };
}

/** Aggregate Fusion's own backends by `application_name`, read on the dedicated health session. */
async function fusionBackendsByName(
  set: PostgresConnections,
): Promise<Array<{ applicationName: string; state: string; count: number }>> {
  const rows = (await set.health.execute(sql`
    SELECT application_name, COALESCE(state, 'none') AS state, count(*)::int AS backend_count
    FROM pg_stat_activity
    WHERE application_name LIKE 'fusion-%'
    GROUP BY 1, 2
  `)) as unknown as Array<{
    application_name?: string;
    state?: string;
    backend_count?: number | string;
  }>;
  return (rows ?? []).map((row) => ({
    applicationName: String(row.application_name ?? ""),
    state: String(row.state ?? ""),
    count: Number(row.backend_count) || 0,
  }));
}

describeWhenPg("runtime pool concurrency (RUFU-483)", () => {
  let set: PostgresConnections | null = null;

  afterEach(async () => {
    // `close()` ends the runtime, health, and migration clients: no hold may survive into the next
    // leg, and no backend may survive into a sibling pg file's connection budget.
    await set?.close();
    set = null;
  });

  /** Build a production-shaped set: explicit ceiling, real project binding, dedicated sessions intact. */
  async function openSet(poolMax: number, projectId: string): Promise<PostgresConnections> {
    set = await createConnectionSetFromUrl(backend(), {
      poolMax,
      projectId,
      connectTimeoutSeconds: 5,
      idleTimeoutSeconds: 60,
    });
    expect(set.poolMax).toBe(poolMax);
    return set;
  }

  it("Leg A (bug-shape control): a one-row read queues behind every legacy pool slot", async () => {
    /*
    FNXC:PostgresPool 2026-11-06-22:10 (RUFU-483):
    THIS LEG IS THE BUG, NOT THE GUARD. It is expected to pass on the pre-RUFU-483 code — its whole job
    is to prove the harness can observe connection queueing, so that Leg C's speed means headroom and
    not a broken fixture. `poolMax` is pinned to the LEGACY constant explicitly, never to
    `DEFAULT_POOL_MAX`, so this leg keeps describing the historical shape after the constant moves.
    */
    const burst = await readWhileHeld(
      await openSet(LEGACY_DEFAULT_POOL_MAX, `rufu483-a-${randomUUID().slice(0, 8)}`),
      LEGACY_DEFAULT_POOL_MAX,
    );

    expect(burst.holdsPendingAtIssue).toBe(true);
    // The read could not settle while the holds were in flight: it waited most of a hold. That the
    // holds have usually just released by completion is why `holdsPendingAtCompletion` is NOT asserted
    // here — at the legacy ceiling the read is served exactly as the last hold frees, so that sample
    // is a coin flip, while the >= 600 ms latency IS the "it waited" proof.
    expect(burst.latencyMs).toBeGreaterThanOrEqual(QUEUED_FLOOR_MS);
  }, 15_000);

  it("Leg B (saturation control): the shipped ceiling still queues when fully occupied", async () => {
    /*
    FNXC:PostgresPool 2026-11-06-22:10 (RUFU-483):
    Without this leg Leg C could pass for the wrong reason. Occupying ALL `DEFAULT_POOL_MAX` slots
    proves postgres.js genuinely queues at the shipped ceiling, so any fast pass below is attributable
    to headroom rather than to a pool that never blocks.
    */
    const burst = await readWhileHeld(
      await openSet(DEFAULT_POOL_MAX, `rufu483-b-${randomUUID().slice(0, 8)}`),
      DEFAULT_POOL_MAX,
    );

    expect(burst.holdsPendingAtIssue).toBe(true);
    expect(burst.latencyMs).toBeGreaterThanOrEqual(QUEUED_FLOOR_MS);
  }, 15_000);

  it("Leg C (shipped-default guard): a one-row read is served while lane holds are still running", async () => {
    /*
    FNXC:PostgresPool 2026-11-06-22:10 (RUFU-483):
    THE GUARD. Byte-identical shape to Leg A — the same LEGACY_DEFAULT_POOL_MAX holds and the same
    one-row read — against `DEFAULT_POOL_MAX`. Restore `DEFAULT_POOL_MAX = 3` in
    `postgres/connection.ts` and this leg fails on both assertions, which is the property that ties
    the shipped 10 to the reported symptom (a `limit=1` board read slower than a `limit=100` one)
    rather than to an arbitrary number. The lane footprint this headroom is sized against is written
    in `connection.ts` and pinned numerically, without PostgreSQL, in `connection.test.ts`.
    */
    const burst = await readWhileHeld(
      await openSet(DEFAULT_POOL_MAX, `rufu483-c-${randomUUID().slice(0, 8)}`),
      LEGACY_DEFAULT_POOL_MAX,
    );

    expect(burst.holdsPendingAtIssue).toBe(true);
    expect(burst.latencyMs).toBeLessThanOrEqual(SERVED_CEILING_MS);
    expect(burst.holdsPendingAtCompletion).toBe(true);
  }, 15_000);

  it("Leg D (attribution): held runtime backends are named and readable on the health session", async () => {
    /*
    FNXC:PostgresPool 2026-11-06-22:10 (RUFU-483):
    The `/metrics` occupancy gauges parse `pg_stat_activity.application_name` into their
    `project`/`role`/`state` labels and read it on the dedicated `max: 1` health session, because a
    probe that queued behind the saturated pool it measures would be blind exactly when it mattered.
    This leg pins both halves of that dependency on the same server: the runtime backends carry the
    `fusion-runtime:<projectId>` name and move through the state buckets the gauge renders, the
    health session carries its OWN name (it is not a pool member), and the probe itself succeeds
    while every runtime slot is busy.

    The premise is proven from the server's own view rather than assumed — the same discipline
    `run-audit-sink-saturation.pg.test.ts` applies — because a fixture that quietly failed to
    saturate would make the bucket assertions measure nothing. The bounded `waitFor` below proves
    saturation; the assertion under it is the state-bucket flip, not the wait.
    */
    const projectId = `rufu483-d-${randomUUID().slice(0, 8)}`;
    const opened = await openSet(DEFAULT_POOL_MAX, projectId);
    const runtimeName = `fusion-runtime:${projectId}`;

    // Establish every pool member first, so the server already sees all of them before they sleep,
    // and touch the dedicated migration session so it too is present in pg_stat_activity.
    await Promise.all(
      Array.from({ length: DEFAULT_POOL_MAX }, () =>
        opened.runtime.execute(sql`SELECT 1 AS warmup`),
      ),
    );
    await opened.migration.execute(sql`SELECT 1 AS warmup`);

    const holds = Array.from({ length: DEFAULT_POOL_MAX }, () =>
      (async () => {
        try {
          await opened.runtime.execute(sql`SELECT pg_sleep(${HOLD_MS / 1000}) AS hold`);
        } catch {
          // Premise is asserted from the server's own view below, not from these promises.
        }
      })(),
    );

    const activeRuntimeBackends = async (): Promise<number> => {
      const rows = await fusionBackendsByName(opened);
      return rows
        .filter((row) => row.applicationName === runtimeName && row.state === "active")
        .reduce((sum, row) => sum + row.count, 0);
    };
    await vi.waitFor(async () => {
      expect(await activeRuntimeBackends()).toBe(DEFAULT_POOL_MAX);
    }, { timeout: 5_000, interval: 25 });

    const rows = await fusionBackendsByName(opened);
    await Promise.allSettled(holds);

    // (1) Every held runtime backend is attributable to ITS project, in the `active` bucket.
    const runtimeRows = rows.filter((row) => row.applicationName === runtimeName);
    expect(
      runtimeRows
        .filter((row) => row.state === "active")
        .reduce((sum, row) => sum + row.count, 0),
    ).toBe(DEFAULT_POOL_MAX);

    // (2) The dedicated sessions are attributed as themselves, never as pool members. The health
    // session answers this while the runtime pool is fully occupied — the whole reason it is a
    // separate `max: 1` session, and the reason the gauge probe may ride it.
    const healthRows = rows.filter((row) => row.applicationName === `fusion-health:${projectId}`);
    expect(healthRows.length).toBeGreaterThanOrEqual(1);
    expect(healthRows.reduce((sum, row) => sum + row.count, 0)).toBe(1);

    // (3) All THREE Fusion session classes answer under their own name, and only the two
    // project-bound ones carry the project suffix — the unbound migration session renders the
    // `project="unbound"` label the sampler specifies, never a guessed project. Presence, not an
    // exact cluster census: a shared PostgreSQL host also shows other Fusion deployments' backends,
    // and the closed-set rule the gauge applies to foreign names is pinned by sampler unit fixtures.
    expect(rows.some((row) => row.applicationName === "fusion-migration")).toBe(true);
    const seenRoles = new Set(
      rows
        .map((row) => row.applicationName.slice("fusion-".length).split(":")[0])
        .filter((role) => role.length > 0),
    );
    expect(["health", "migration", "runtime"].every((role) => seenRoles.has(role))).toBe(true);
  }, 15_000);
});
