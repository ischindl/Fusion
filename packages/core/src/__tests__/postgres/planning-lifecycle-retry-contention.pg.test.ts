import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/*
RUFU-600 Step 6 — the reporter's concurrent case, end to end.

The report was two acquires of one card's planning key overlapping: the planning pass held the key while
idle in transaction, and the operator's Retry refused. Two things had to stay true and neither was asserted
anywhere before this file, so both had regressed unnoticed once already:

  1. a waiter whose holder finishes INSIDE its budget is granted the key and runs its work (the refusal
     path must not become the only path), and
  2. a waiter that runs out of budget refuses with a message the planning-handoff classifier still
     recognises, carrying holder identity and measured durations as STRUCTURED fields only, and walks away
     without leaving a session of its own holding the key.

This is the store surface (`TaskStore.withPlanningLifecycleLock`) — the one every engine and dashboard lane
actually calls — against a second real session holding the same advisory key. A mock cannot stand in: the
grant, the refusal, and the release-on-disconnect semantics are PostgreSQL's, and the bug being guarded is
precisely a session that outlived the code that opened it.
*/
import postgres from "postgres";

import { PlanningLifecycleLockTransportError, diagnosePlanningLifecycleAdvisoryKey, planningLifecycleApplicationName } from "../../postgres/advisory-locks.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const PROJECT_ID = "project-rufu600";

const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
  prefix: "fusion_planning_race",
  poolMax: 3,
  // Bound a project so the store's key derivation is a value this file can name, instead of the
  // project-agnostic harness falling back to its temp rootDir.
  projectId: PROJECT_ID,
});

/** The product's key shape, spelled here so the assertions are about behaviour, not about helpers. */
function taskKey(projectId: string, taskId: string): string {
  return `fusion:planning-lifecycle:${projectId}:${taskId}`;
}

/** A second session that takes the card's key and keeps holding it, stamped with the lane that took it. */
async function acquireForeignHolder(taskId: string): Promise<{ client: ReturnType<typeof postgres>; pid: number }> {
  const client = postgres(h.testUrl(), { max: 1, prepare: false });
  await client`SELECT set_config('application_name', ${planningLifecycleApplicationName("planning", taskId)}, false)`;
  const rows = await client`SELECT pg_backend_pid() AS pid`;
  await client`SELECT pg_advisory_lock(hashtext(${taskKey(PROJECT_ID, taskId)}))`;
  return { client, pid: Number(rows[0]?.pid) };
}

async function releaseForeignHolder(holder: { client: ReturnType<typeof postgres> }, taskId: string): Promise<void> {
  await holder.client`SELECT pg_advisory_unlock(hashtext(${taskKey(PROJECT_ID, taskId)}))`;
  await holder.client.end({ timeout: 2 });
}

async function rejectionOf(promise: Promise<unknown>): Promise<PlanningLifecycleLockTransportError> {
  try {
    await promise;
  } catch (error) {
    return error as PlanningLifecycleLockTransportError;
  }
  throw new Error("expected the contended acquisition to refuse");
}

const settleDetail = (error: unknown) => error as PlanningLifecycleLockTransportError;

pgDescribe("planning lifecycle lock — the reporter's concurrent acquire", () => {
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  afterEach(h.afterEach);

  it("grants the key to the waiter once the real holder finishes inside its budget", async () => {
    const taskId = "RUFU-600-RACE-A";
    const store = h.store();
    const holder = await acquireForeignHolder(taskId);

    // Let the holder idle in transaction the way a slow planning pass does, then finish.
    const holderFinishes = new Promise<void>((resolve) => setTimeout(resolve, 150));
    const startedAt = Date.now();
    const acquired = store.withPlanningLifecycleLock(taskId, async () => "granted", {
      holderLabel: "retry",
      timeoutMs: 6_000,
      maxHoldMs: 5_000,
    });
    await holderFinishes;
    await releaseForeignHolder(holder, taskId);

    await expect(acquired).resolves.toBe("granted");
    expect(Date.now() - startedAt).toBeLessThan(6_000);

    // The grant left nothing behind: the key is free for the next acquirer.
    const after = await diagnosePlanningLifecycleAdvisoryKey({ ...transportFields(), taskId } as never);
    expect(after.reason).toBe("not-held");
  });

  it("refuses a waiter whose holder will not finish, naming the holder in structured fields only", async () => {
    const taskId = "RUFU-600-RACE-B";
    const store = h.store();
    const holder = await acquireForeignHolder(taskId);
    try {
      const budgetMs = 500;
      const error = await rejectionOf(
        store.withPlanningLifecycleLock(taskId, async () => "must not run", { holderLabel: "retry", timeoutMs: budgetMs }),
      );
      const detail = settleDetail(error);

      expect(error).toBeInstanceOf(PlanningLifecycleLockTransportError);
      expect(detail.reason).toBe("contention");
      expect(detail.phase).toBe("acquisition");
      // The operator-facing identity: which lane, which session, how long it has been sitting there.
      expect(detail.holder).toMatchObject({
        label: "planning",
        taskId,
        pid: holder.pid,
      });
      expect(Number(detail.holder?.ageMs)).toBeGreaterThanOrEqual(0);
      // Both measurements the reporter had to derive from log lines by hand.
      expect(detail.budgetMs).toBe(budgetMs);
      expect(Number(detail.waitedMs)).toBeGreaterThanOrEqual(budgetMs);

      /*
      FNXC:PlanningLifecycleLockMessageContract 2026-11-11-17:35:
      `planning-handoff-recovery.ts` anchors the five canonical planning-lock sentences with `$`. Appending
      holder or duration prose to the message would silently un-classify every recovery path that reads it,
      which is why the identity above must live in fields. Asserted against the real refusal, not a fixture.
      */
      expect(error.message).toMatch(/^Planning lifecycle lock (acquisition|cleanup) (timed out after \d+ms|failed)$/);
      expect(error.message).not.toMatch(/pid \d+/);
      expect(error.message).not.toContain(planningLifecycleApplicationName("planning", taskId));
    } finally {
      await releaseForeignHolder(holder, taskId);
    }
  });

  it("walks away from a refused acquire without leaving its own session holding the key", async () => {
    const taskId = "RUFU-600-RACE-C";
    const store = h.store();
    const holder = await acquireForeignHolder(taskId);
    try {
      await rejectionOf(store.withPlanningLifecycleLock(taskId, async () => "must not run", { holderLabel: "retry", timeoutMs: 400 }));
      const during = await diagnosePlanningLifecycleAdvisoryKey({ ...transportFields(), taskId } as never);
      // Exactly one holder: the waiter's own session is gone, not parked holding nothing useful.
      expect(during.reason).toBe("held");
      expect(during.holder?.pid).toBe(holder.pid);
    } finally {
      await releaseForeignHolder(holder, taskId);
    }

    // And the refusal cost the next acquirer nothing: the key grants inside a fresh short budget.
    const grantStartedAt = Date.now();
    await expect(store.withPlanningLifecycleLock(taskId, async () => "granted", { holderLabel: "retry", timeoutMs: 1_000 })).resolves.toBe("granted");
    expect(Date.now() - grantStartedAt).toBeLessThan(1_000);
  });

  it("serializes two live acquires of one card instead of letting both work at once", async () => {
    const taskId = "RUFU-600-RACE-D";
    const store = h.store();
    const windows: Record<string, { enteredAt: number; exitedAt: number }> = {};
    const hold = (name: string, ms: number) =>
      store.withPlanningLifecycleLock(taskId, async () => {
        const enteredAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, ms));
        windows[name] = { enteredAt, exitedAt: Date.now() };
        return name;
      }, { holderLabel: "planning", timeoutMs: 6_000, maxHoldMs: 5_000 });

    const [first, second] = await Promise.all([hold("first", 150), hold("second", 20)]);

    expect([first, second].sort()).toEqual(["first", "second"]);
    /*
    The invariant is mutual exclusion, not arrival order: PostgreSQL chooses which blocked advisory waiter
    it wakes, so asserting who entered first would assert a scheduler detail instead of the promise.

    FNXC:PlanningLifecycleSerialization 2026-11-11-19:14 (RUFU-600 Step 10):
    The line this replaces did exactly what the sentence above forbids - `Object.keys(windows)` is entry
    order, so `toEqual(["first", "second"])` asserted that the session that asked first was woken first. It
    passed until it did not: observed failing on the ephemeral cluster with `['second', 'first']`, with the
    mutual-exclusion assertion two lines below still green. Both halves of the real promise stay pinned here:
    both acquirers ran, and their critical windows never overlap.
    */
    expect(Object.keys(windows).sort()).toEqual(["first", "second"]);
    const [earlier, later] = Object.values(windows).sort((a, b) => a.enteredAt - b.enteredAt);
    expect(later!.enteredAt).toBeGreaterThanOrEqual(earlier!.exitedAt);
  });
});

function transportFields() {
  const url = h.testUrl();
  return { projectId: PROJECT_ID, directSessionUrl: url, provenance: "migration-override" as const, runtimeUrl: url, migrationUrl: url, timeoutMs: 800 };
}
