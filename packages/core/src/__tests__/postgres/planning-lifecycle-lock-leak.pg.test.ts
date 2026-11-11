import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:net";

/*
RUFU-600 — planning-lifecycle lock: identity, one deadline, proven teardown.
Symptom under test: an operator pressed Retry and got HTTP 500 while an idle PostgreSQL session kept the
task's planning-lifecycle advisory key. These tests run against the SAME PostgreSQL major the product
ships against (pgvector/pg16 via the shared harness) and assert the operator-visible contract:
a contention refusal names its holder and its measured wait, the message the classifier anchors stays
canonical, a key whose holder vanished is re-acquirable inside one grant, and nothing may terminate a
session this process is holding.

Deliberately NOT a mock: `pg_locks.classid`/`objid` are `regclass` columns PostgreSQL fills from
`hashtext()`, and the mock store never executes them. A mock-the-world seam here would prove nothing about
the one predicate every diagnosis and every release depends on.
*/
import postgres from "postgres";

import {
  PlanningLifecycleLockTransportError,
  PLANNING_LIFECYCLE_RELEASE_AGE_FLOOR_MS,
  diagnosePlanningLifecycleAdvisoryKey,
  clearPlanningLifecycleUnprovenTeardown,
  getPlanningLifecycleLiveSessionPids,
  getPlanningLifecycleUnprovenTeardowns,
  listPlanningLifecycleHolderSessions,
  parsePlanningLifecycleApplicationName,
  planningLifecycleApplicationName,
  registerPlanningLifecycleSession,
  releasePlanningLifecycleAdvisoryKey,
  terminatePlanningLifecycleSession,
  unregisterPlanningLifecycleSession,
  withPlanningLifecycleAdvisoryLock,
  withPlanningLifecycleAdvisoryLocks,
} from "../../postgres/advisory-locks.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
  prefix: "fusion_planning_leak",
  poolMax: 1,
});

type Transport = {
  projectId: string;
  directSessionUrl: string | null;
  provenance: "migration-override";
  runtimeUrl: string;
  migrationUrl: string;
  timeoutMs?: number;
};

function transport(timeoutMs = 800): Transport {
  const url = h.testUrl();
  return { projectId: "project-a", directSessionUrl: url, provenance: "migration-override", runtimeUrl: url, migrationUrl: url, timeoutMs };
}

function lock<T>(taskId: string, callback: () => Promise<T>, timeoutMs = 800, extra: Record<string, unknown> = {}): Promise<T> {
  return withPlanningLifecycleAdvisoryLock({ ...transport(timeoutMs), taskId, ...extra } as never, callback);
}

function sessionInput(taskId: string, timeoutMs = 1_500) {
  return { ...transport(timeoutMs), taskId };
}

/**
 * The product's key shape, spelled here rather than imported, so every assertion in this file is about
 * behaviour a directly-connected PostgreSQL either exhibits or does not — never about whether a helper
 * happens to be exported.
 */
function taskKey(projectId: string, taskId: string): string {
  return `fusion:planning-lifecycle:${projectId}:${taskId}`;
}

/** A second, foreign session that takes the task's key and stays holding it, labelled with a lane. */
async function acquireForeignHolder(
  label: string,
  key: string,
  applicationName = `fusion-planning:${label}`,
): Promise<{ client: ReturnType<typeof postgres>; pid: number }> {
  const client = postgres(h.testUrl(), { max: 1, prepare: false });
  await client`SELECT set_config('application_name', ${applicationName}, false)`;
  const rows = await client`SELECT pg_backend_pid() AS pid`;
  await client`SELECT pg_advisory_lock(hashtext(${key}))`;
  return { client, pid: Number(rows[0]?.pid) };
}

/*
 * The proof a caller must supply before the release surface will end anything (RUFU-600 code-review P0).
 * `ageFloorMs: 0` is the harness lowering the floor, not a product lane doing it: `ageMs` is PostgreSQL's
 * own `now() - state_change`, which no test can rewind, and AGENTS.md refuses a test that sleeps 15 minutes
 * to age one. Every other assertion in this file leaves the floor alone and expects the refusal.
 */
const PROVEN_IDLE_HOLDER = { ageFloorMs: 0, isCardLive: () => false as const };

async function releaseForeignHolder(holder: { client: ReturnType<typeof postgres> }, key: string): Promise<void> {
  await holder.client`SELECT pg_advisory_unlock(hashtext(${key})::bigint)`;
  await holder.client.end({ timeout: 2 });
}

/** An endpoint that accepts the TCP connection and never answers the handshake: session setup cannot end. */
async function startStalledEndpoint(): Promise<{ url: string; close: () => void }> {
  const server = createServer((socket) => { socket.on("error", () => undefined); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `postgresql://postgres:postgres@127.0.0.1:${port}/fusion`, close: () => server.close() };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the acquisition to refuse");
}

const elapsed = async (run: () => Promise<unknown>): Promise<number> => {
  const startedAt = Date.now();
  await run().catch(() => undefined);
  return Date.now() - startedAt;
};

pgDescribe("planning lifecycle lock leak and holder identity", () => {
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  afterEach(h.afterEach);

  it("names the labelled holder and the measured wait on a contention refusal", async () => {
    const taskId = "RUFU-600-A";
    const key = taskKey("project-a", taskId);
    const holder = await acquireForeignHolder("retry", key);
    try {
      const error = await rejectionOf(lock(taskId, async () => undefined, 800));
      expect(error).toBeInstanceOf(PlanningLifecycleLockTransportError);
      const lockError = error as PlanningLifecycleLockTransportError;
      expect(lockError.reason).toBe("contention");
      expect(lockError.budgetMs).toBe(800);
      expect(lockError.waitedMs).toBeGreaterThanOrEqual(300);
      expect(lockError.waitedMs).toBeLessThanOrEqual(800 + 1_500);
      expect(lockError.holder?.pid).toBe(holder.pid);
      expect(lockError.holder?.label).toBe("retry");
      expect(lockError.holder?.ageMs).toBeGreaterThanOrEqual(0);
    } finally {
      await releaseForeignHolder(holder, key);
    }
  });

  it("keeps the classified message canonical and carries the diagnosis only as fields", async () => {
    const taskId = "RUFU-600-B";
    const key = taskKey("project-a", taskId);
    const holder = await acquireForeignHolder("planning", key);
    try {
      const error = await rejectionOf(lock(taskId, async () => undefined, 500)) as PlanningLifecycleLockTransportError;
      /* The engine classifier anchors these messages with `$`; appended detail would un-classify the
         executor's transport retry, so the number in the sentence is the budget and nothing else. */
      expect(error.message).toMatch(/^Planning lifecycle lock acquisition timed out after 500ms$/);
      expect(error.message).not.toMatch(/pid|project-a|RUFU-600/);
      expect(error.holder?.pid).toBeGreaterThan(0);
    } finally {
      await releaseForeignHolder(holder, key);
    }
  });

  it("distinguishes held from not-held and proves the hashtext key mapping against a real lock", async () => {
    const taskId = "RUFU-600-C";
    const key = taskKey("project-a", taskId);
    const free = await diagnosePlanningLifecycleAdvisoryKey({ ...transport(), taskId });
    expect(free.key).toBe(key);
    expect(free.reason).toBe("not-held");

    const holder = await acquireForeignHolder("merge-queue", key);
    try {
      const held = await diagnosePlanningLifecycleAdvisoryKey({ ...transport(), taskId });
      expect(held.reason).toBe("held");
      expect(held.holder).toMatchObject({ label: "merge-queue", pid: holder.pid, state: "idle" });
      expect(held.heldByThisProcess).toBe(false);
    } finally {
      await releaseForeignHolder(holder, key);
    }
    await expect(diagnosePlanningLifecycleAdvisoryKey({ ...transport(), taskId })).resolves.toMatchObject({ reason: "not-held" });
  });

  it("lists a labelled holder session for the bounded reclaim sweep to consider", async () => {
    const taskId = "RUFU-600-D";
    const key = taskKey("project-a", taskId);
    const holder = await acquireForeignHolder("sweep", key);
    try {
      const sessions = await listPlanningLifecycleHolderSessions(transport());
      expect(sessions.reason).toBe("ok");
      expect(sessions.sessions.some((session) => session.pid === holder.pid && session.label === "sweep")).toBe(true);
    } finally {
      await releaseForeignHolder(holder, key);
    }
  });

  it("refuses to terminate a session this process is holding, and terminates one that is not ours", async () => {
    const taskId = "RUFU-600-E";
    const key = taskKey("project-a", taskId);
    const holder = await acquireForeignHolder("lineage", key);
    try {
      registerPlanningLifecycleSession(holder.pid, key, "lineage");
      await expect(terminatePlanningLifecycleSession(transport(), holder.pid)).resolves.toEqual({ outcome: "refused" });
      unregisterPlanningLifecycleSession(holder.pid);
      await expect(terminatePlanningLifecycleSession(transport(), holder.pid)).resolves.toEqual({ outcome: "terminated" });
      await expect(diagnosePlanningLifecycleAdvisoryKey({ ...transport(), taskId })).resolves.toMatchObject({ reason: "not-held" });
    } finally {
      unregisterPlanningLifecycleSession(holder.pid);
      await holder.client.end({ timeout: 2 }).catch(() => undefined);
      clearPlanningLifecycleUnprovenTeardown(key);
    }
  });

  it("leaves the key immediately re-acquirable after a deadline abandonment", async () => {
    const taskId = "RUFU-600-F";
    const key = taskKey("project-a", taskId);
    const holder = await acquireForeignHolder("retry", key);
    await lock(taskId, async () => undefined, 300).catch(() => undefined);
    await releaseForeignHolder(holder, key);

    const reAcquireMs = await elapsed(() => lock(taskId, async () => "granted", 1_000));
    expect(reAcquireMs).toBeLessThan(900);
    expect(getPlanningLifecycleUnprovenTeardowns().some((entry) => entry.key === key)).toBe(false);
    expect(await diagnosePlanningLifecycleAdvisoryKey({ ...transport(), taskId })).toMatchObject({ reason: "not-held" });
  });

  it("ends a hold that outlives its bound and frees the key for the next acquirer", async () => {
    const taskId = "RUFU-600-G";
    const key = taskKey("project-a", taskId);
    let releaseStall!: () => void;
    const stalled = new Promise<void>((resolve) => { releaseStall = resolve; });
    try {
      const error = await rejectionOf(lock(taskId, async () => {
        await stalled;
        return "late";
      }, 2_000, { maxHoldMs: 250, holderLabel: "retry" })) as PlanningLifecycleLockTransportError;
      expect(error).toBeInstanceOf(PlanningLifecycleLockTransportError);
      expect(error.reason).toBe("hold-exceeded");
      expect(error.maxHoldMs).toBe(250);
      expect(error.heldMs).toBeGreaterThanOrEqual(250);

      const regranted = await lock(taskId, async () => "granted", 1_500);
      expect(regranted).toBe("granted");
      expect(getPlanningLifecycleUnprovenTeardowns().some((entry) => entry.key === key)).toBe(false);
    } finally {
      releaseStall();
    }
  });

  it("settles inside the one deadline it was given when its session cannot be established", async () => {
    const stalled = await startStalledEndpoint();
    const taskId = "RUFU-600-H";
    try {
      const startedAt = Date.now();
      const error = await rejectionOf(withPlanningLifecycleAdvisoryLock({
        projectId: "project-a",
        taskId,
        directSessionUrl: stalled.url,
        provenance: "migration-override",
        runtimeUrl: stalled.url,
        migrationUrl: stalled.url,
        timeoutMs: 400,
      }, async () => undefined)) as PlanningLifecycleLockTransportError;
      const tookMs = Date.now() - startedAt;
      expect(error).toBeInstanceOf(PlanningLifecycleLockTransportError);
      expect(error.reason).toBe("transport-unavailable");
      expect(error.phase).not.toBe("acquisition");
      /* The whole acquisition — every phase and the bounded teardown — stays inside the deadline plus
         the teardown bound, not one fresh budget per phase. */
      expect(tookMs).toBeLessThanOrEqual(400 + 2_500);
    } finally {
      stalled.close();
    }
  });

  it("keeps every phase of a multi-key acquisition inside the one shared deadline", async () => {
    const first = "RUFU-600-I-1";
    const second = "RUFU-600-I-2";
    const keyOne = taskKey("project-a", first);
    const keyTwo = taskKey("project-a", second);
    const holderOne = await acquireForeignHolder("dependency", keyOne);
    const holderTwo = await acquireForeignHolder("dependency", keyTwo);
    try {
      const tookMs = await elapsed(() => withPlanningLifecycleAdvisoryLocks({
        ...transport(700),
        taskIds: [first, second],
        holderLabel: "dependency",
      }, async () => "granted"));
      expect(tookMs).toBeLessThanOrEqual(700 + 2_500);
    } finally {
      await releaseForeignHolder(holderOne, keyOne);
      await releaseForeignHolder(holderTwo, keyTwo);
    }
    expect(getPlanningLifecycleLiveSessionPids()).toEqual([]);
  });

  it("refuses to release without a confirmation and touches nothing", async () => {
    const taskId = "RUFU-600-J";
    const key = taskKey("project-a", taskId);
    const holder = await acquireForeignHolder("planning", key);
    try {
      const refused = await releasePlanningLifecycleAdvisoryKey(sessionInput(taskId), false);
      expect(refused).toMatchObject({ key, released: false, reason: "confirmation-required", holder: null, terminated: false });
      expect(await diagnosePlanningLifecycleAdvisoryKey(sessionInput(taskId))).toMatchObject({ reason: "held" });
    } finally {
      await releaseForeignHolder(holder, key);
    }
  });

  it("reports there is nothing to release for a key no session holds", async () => {
    const report = await releasePlanningLifecycleAdvisoryKey(sessionInput("RUFU-600-K"), true);
    expect(report).toMatchObject({ released: false, reason: "not-held", terminated: false });
  });

  it("refuses a holder that has not passed the age floor, and releases one proven past it", async () => {
    const taskId = "RUFU-600-L";
    const key = taskKey("project-a", taskId);
    const holder = await acquireForeignHolder("retry", key);
    try {
      // A session idle for a second is NOT a dead session: a planning callback holds its session idle for
      // nearly the whole hold, so ending this one would free the key while that lane's writes are landing.
      const tooYoung = await releasePlanningLifecycleAdvisoryKey(sessionInput(taskId), true, { isCardLive: () => false });
      expect(tooYoung).toMatchObject({ key, released: false, reason: "below-age-floor", terminated: false });
      expect(tooYoung.holder?.ours).toBe(true);
      expect(tooYoung.holder?.ageMs).toBeLessThan(PLANNING_LIFECYCLE_RELEASE_AGE_FLOOR_MS);
      expect(await diagnosePlanningLifecycleAdvisoryKey(sessionInput(taskId))).toMatchObject({ reason: "held" });

      // Past the floor (lowered for the harness, see PROVEN_IDLE_HOLDER) the same act is permitted, and the
      // key's freedom is measured rather than asserted.
      const report = await releasePlanningLifecycleAdvisoryKey(sessionInput(taskId), true, PROVEN_IDLE_HOLDER);
      expect(report).toMatchObject({ released: true, reason: "released", terminated: true });
      expect(report.holder?.pid).toBe(holder.pid);
      expect(await diagnosePlanningLifecycleAdvisoryKey(sessionInput(taskId))).toMatchObject({ reason: "not-held" });
      const regranted = await lock(taskId, async () => "granted", 1_500);
      expect(regranted).toBe("granted");
    } finally {
      await holder.client.end({ timeout: 2 }).catch(() => undefined);
      clearPlanningLifecycleUnprovenTeardown(key);
    }
  });

  it("refuses to end a holder on a card that shows planning or execution liveness", async () => {
    const taskId = "RUFU-600-Q";
    const key = taskKey("project-a", taskId);
    const holder = await acquireForeignHolder("planning", key);
    try {
      const report = await releasePlanningLifecycleAdvisoryKey(sessionInput(taskId), true, {
        ageFloorMs: 0,
        isCardLive: () => true,
      });
      expect(report).toMatchObject({ key, released: false, reason: "card-live", terminated: false });
      expect(report.holder?.pid).toBe(holder.pid);
      expect(await diagnosePlanningLifecycleAdvisoryKey(sessionInput(taskId))).toMatchObject({ reason: "held" });
    } finally {
      await releaseForeignHolder(holder, key);
    }
  });

  it("refuses when no caller can prove the card is idle, rather than assuming it", async () => {
    const taskId = "RUFU-600-R";
    const key = taskKey("project-a", taskId);
    const holder = await acquireForeignHolder("dependency", key);
    try {
      // Only the floor is lowered here: with no liveness probe the conjunction is unprovable, and an
      // unprovable conjunction may not buy a pg_terminate_backend.
      const report = await releasePlanningLifecycleAdvisoryKey(sessionInput(taskId), true, { ageFloorMs: 0 });
      expect(report).toMatchObject({ key, released: false, reason: "liveness-unproven", terminated: false });
      expect(await diagnosePlanningLifecycleAdvisoryKey(sessionInput(taskId))).toMatchObject({ reason: "held" });

      // A probe that throws is a probe that says "busy", not a probe that says "go ahead".
      const throwing = await releasePlanningLifecycleAdvisoryKey(sessionInput(taskId), true, {
        ageFloorMs: 0,
        isCardLive: () => { throw new Error("liveness registry unreadable"); },
      });
      expect(throwing).toMatchObject({ released: false, reason: "card-live", terminated: false });
    } finally {
      await releaseForeignHolder(holder, key);
    }
  });

  it("never ends a session this product did not open, even past every other bound", async () => {
    const taskId = "RUFU-600-S";
    const key = taskKey("project-a", taskId);
    // A client outside this product that happens to take a colliding advisory key: no `fusion-planning:`
    // prefix, so this product has no idea what that session is doing and no right to end it.
    const holder = await acquireForeignHolder("retry", key, "psql");
    try {
      const diagnosis = await diagnosePlanningLifecycleAdvisoryKey(sessionInput(taskId));
      expect(diagnosis.reason).toBe("held");
      expect(diagnosis.holder).toMatchObject({ ours: false, label: "unknown" });

      const report = await releasePlanningLifecycleAdvisoryKey(sessionInput(taskId), true, PROVEN_IDLE_HOLDER);
      expect(report).toMatchObject({ key, released: false, reason: "foreign-holder", terminated: false });
      expect(await diagnosePlanningLifecycleAdvisoryKey(sessionInput(taskId))).toMatchObject({ reason: "held" });
    } finally {
      await releaseForeignHolder(holder, key);
    }
  });

  it("refuses to end a session this process registered as live", async () => {
    const taskId = "RUFU-600-M";
    const key = taskKey("project-a", taskId);
    const holder = await acquireForeignHolder("planning", key);
    try {
      registerPlanningLifecycleSession(holder.pid, key, "planning");
      const report = await releasePlanningLifecycleAdvisoryKey(sessionInput(taskId), true, PROVEN_IDLE_HOLDER);
      expect(report).toMatchObject({ released: false, reason: "live-session", terminated: false });
      expect(report.holder?.pid).toBe(holder.pid);
      expect(await diagnosePlanningLifecycleAdvisoryKey(sessionInput(taskId))).toMatchObject({ reason: "held" });
    } finally {
      unregisterPlanningLifecycleSession(holder.pid);
      await releaseForeignHolder(holder, key);
    }
  });

  it("refuses to end a holder that is running a statement", async () => {
    const taskId = "RUFU-600-N";
    const key = taskKey("project-a", taskId);
    const client = postgres(h.testUrl(), { max: 1, prepare: false });
    try {
      await client`SELECT set_config('application_name', ${"fusion-planning:dependency"}, false)`;
      const rows = await client`SELECT pg_backend_pid() AS pid`;
      const pid = Number(rows[0]?.pid);
      await client`SELECT pg_advisory_lock(hashtext(${key}))`;
      // Fire a long statement without awaiting it: the session's own state becomes `active`. The `.then`
      // is load-bearing — a postgres.js query is a lazy thenable and does not reach the server until it is
      // consumed, so an un-consumed `pg_sleep` leaves the session idle and the veto untested.
      const running = client`SELECT pg_sleep(5)`.then(() => undefined);
      let observed: Awaited<ReturnType<typeof diagnosePlanningLifecycleAdvisoryKey>> = { key, heldByThisProcess: false, holder: null, reason: "not-held" };
      for (let attempt = 0; attempt < 12; attempt += 1) {
        observed = await diagnosePlanningLifecycleAdvisoryKey(sessionInput(taskId));
        if (observed.holder?.state === "active") break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      expect(observed.holder?.state).toBe("active");
      const report = await releasePlanningLifecycleAdvisoryKey(sessionInput(taskId), true, PROVEN_IDLE_HOLDER);
      expect(report).toMatchObject({ released: false, reason: "holder-active", terminated: false });
      await running;
    } finally {
      await client`SELECT pg_advisory_unlock_all()`;
      await client.end({ timeout: 2 }).catch(() => undefined);
      clearPlanningLifecycleUnprovenTeardown(key);
    }
  });

  it("reports the card a holder stamped itself as, which pg_locks cannot name", async () => {
    const taskId = "RUFU-600-P";
    const key = taskKey("project-a", taskId);
    const client = postgres(h.testUrl(), { max: 1, prepare: false });
    try {
      // Stamped exactly the way the acquisition path stamps it, through the exported builder.
      await client`SELECT set_config('application_name', ${planningLifecycleApplicationName("retry", taskId)}, false)`;
      await client`SELECT pg_advisory_lock(hashtext(${key}))`;
      const diagnosis = await diagnosePlanningLifecycleAdvisoryKey(sessionInput(taskId));
      expect(diagnosis.reason).toBe("held");
      expect(diagnosis.holder).toMatchObject({ label: "retry", taskId });
      const population = await listPlanningLifecycleHolderSessions(sessionInput(taskId));
      expect(population.sessions.filter((session) => session.taskId === taskId).length).toBeGreaterThan(0);
    } finally {
      await client`SELECT pg_advisory_unlock_all()`;
      await client.end({ timeout: 2 }).catch(() => undefined);
    }
  });

  it("diagnoses the whole labelled population alongside one key's verdict", async () => {
    const taskId = "RUFU-600-O";
    const key = taskKey("project-a", taskId);
    const holder = await acquireForeignHolder("lineage", key);
    try {
      const diagnosis = await diagnosePlanningLifecycleAdvisoryKey(sessionInput(taskId));
      expect(diagnosis.reason).toBe("held");
      const population = await listPlanningLifecycleHolderSessions(sessionInput(taskId));
      expect(population.reason).toBe("ok");
      expect(population.sessions.some((session) => session.pid === holder.pid && session.label === "lineage")).toBe(true);
      expect(population.sessions.every((session) => session.ageMs >= 0)).toBe(true);
    } finally {
      await releaseForeignHolder(holder, key);
    }
  });
});
