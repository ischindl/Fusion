/*
FNXC:PlanningLifecycleOrphanReclaim 2026-11-11-17:35 (RUFU-600 Step 5) — the reclaim owner's invariants.

A planning-lifecycle advisory key can outlive its acquirer: the acquisition path used to *request* its own
teardown without awaiting or verifying it, so a session that stalled on the grant could stay connected and
keep holding the key while every later card for that task was refused by a holder nobody could name. This
file pins the pass that ends such a session and, more importantly, the veto list that keeps it from
becoming a lane that destroys live work.

Everything is in-memory fakes. The real `emitBoundedRunAudit` seam and the real live-session registry are
exercised — a mocked seam would test the wrong code — while the three PostgreSQL advisory surfaces are
table-driven, because their SQL is proven against a real server in
`packages/core/src/__tests__/postgres/planning-lifecycle-lock-leak.pg.test.ts`.

Non-vacuity rule: every refusal is asserted as a ZERO RELEASE CALL, and each veto is paired with the same
harness without the veto, where the reclaim must happen. A candidacy predicate that excludes everything
passes every negative and reclaims nothing.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { registerPlanningLifecycleSession, unregisterPlanningLifecycleSession } from "@fusion/core";

import { SelfHealingManager, type SelfHealingOptions } from "../self-healing.js";

const FIFTEEN_MINUTES = 15 * 60_000;

type Holder = { label: string; pid: number; state: string; ageMs: number; taskId: string | null; ours: boolean };

interface HarnessOptions {
  holders?: Holder[] | null;
  populationReason?: "ok" | "transport-unavailable" | "holder-query-failed";
  diagnosis?: { reason: string; holder?: { pid: number } | null };
  releaseOutcome?: { released: boolean; reason: string };
  isTaskActive?: boolean;
  globalPause?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const auditRows: Array<Record<string, unknown>> = [];
  const history: Array<{ taskId: string; message: string }> = [];
  const diagnoseCalls: string[] = [];
  const releaseCalls: Array<{ taskId: string; confirm: boolean; livenessProbe: boolean }> = [];
  const populationReason = options.populationReason ?? "ok";

  const store = {
    getSettings: vi.fn(async () => ({ globalPause: options.globalPause === true, enginePaused: false })),
    listPlanningLifecycleHolderSessions: vi.fn(async () => ({
      sessions: options.holders ?? [],
      reason: populationReason,
    })),
    diagnosePlanningLifecycleLock: vi.fn(async (taskId: string) => {
      diagnoseCalls.push(taskId);
      // The default diagnosis names the same pid the population reported for that card, so a test that
      // wants a moving holder says so explicitly rather than relying on a constant.
      const holderPid = options.holders?.find((holder) => holder.taskId === taskId)?.pid ?? 4242;
      const diagnosis = options.diagnosis ?? { reason: "held", holder: { pid: holderPid } };
      return { key: `fusion:planning-lifecycle:project:${taskId}`, transport: { available: true }, budgetMs: 20_000, holders: [], holdersReason: "ok", ...diagnosis };
    }),
    releasePlanningLifecycleLock: vi.fn(async (taskId: string, input: { confirm: boolean; isCardLive?: unknown }) => {
      // The probe's PRESENCE is the P0 contract: the shared release surface refuses to terminate anything
      // without it, so a sweep that stopped handing it over would silently stop protecting live work.
      releaseCalls.push({ taskId, confirm: input.confirm, livenessProbe: typeof input.isCardLive === "function" });
      return options.releaseOutcome ?? { released: true, reason: "released", holder: { pid: 4242 }, terminated: true };
    }),
    logEntryOnce: vi.fn(async (input: { taskId: string; message: string }) => { history.push(input); return true; }),
    logEntry: vi.fn(async (taskId: string, message: string) => { history.push({ taskId, message }); }),
    updateTask: vi.fn(async () => { throw new Error("the reclaim pass must never write a task row"); }),
    moveTask: vi.fn(async () => { throw new Error("the reclaim pass must never move a card"); }),
    recordRunAuditEvent: vi.fn(async (row: Record<string, unknown>) => { auditRows.push(row); }),
  };

  const manager = new SelfHealingManager(store as unknown as TaskStore, {
    isTaskActive: () => options.isTaskActive === true,
    getPlanningTaskIds: () => new Set<string>(),
  } as SelfHealingOptions);

  const rowsFor = (prefix: string) => auditRows.filter((row) => String(row.mutationType).startsWith(prefix));
  return { store, manager, auditRows, history, diagnoseCalls, releaseCalls, rowsFor };
}

/**
 * One abandoned holder of a named card, older than the floor, idle, and opened by this product.
 *
 * `ours: true` is part of "abandoned", not decoration: `ours` is the flag the release surface sets from the
 * `fusion-planning:` prefix on the holder's `application_name`, and a holder without that prefix is a client
 * this product has no right to end.
 */
function abandonedHolder(overrides: Partial<Holder> = {}): Holder {
  return { label: "retry", pid: 4242, state: "idle", ageMs: FIFTEEN_MINUTES + 60_000, taskId: "RUFU-600", ours: true, ...overrides };
}

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(() => {
  vi.restoreAllMocks();
  unregisterPlanningLifecycleSession(4242);
});

describe("reconcilePlanningLifecycleOrphanHolders — the reclaim", () => {
  it("ends an abandoned named holder, records it, and writes no task state", async () => {
    const { manager, store, history, releaseCalls, rowsFor } = harness({ holders: [abandonedHolder()] });

    await expect(manager.reconcilePlanningLifecycleOrphanHolders()).resolves.toBe(1);

    expect(releaseCalls).toEqual([{ taskId: "RUFU-600", confirm: true, livenessProbe: true }]);
    const [row] = rowsFor("task:planning-lifecycle-orphan-reclaimed");
    expect(row).toBeDefined();
    expect(row!.agentId).toBe("self-healing");
    expect(Object.keys((row!.metadata ?? {}) as object).sort()).toEqual([
      "ageMs", "holderLabel", "holderState", "outcome", "pid", "taskId",
    ]);
    expect((row!.metadata as Record<string, unknown>).outcome).toBe("reclaimed");
    expect((row!.metadata as Record<string, unknown>).holderLabel).toBe("retry");
    // The card is where the operator reads: one History sentence, and no lifecycle write of any kind.
    expect(history).toHaveLength(1);
    expect(history[0]!.message).toContain("Planning lock reclaimed");
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("leaves a holder younger than the floor untouched and says nothing", async () => {
    const { manager, releaseCalls, auditRows } = harness({ holders: [abandonedHolder({ ageMs: FIFTEEN_MINUTES - 60_000 })] });

    await expect(manager.reconcilePlanningLifecycleOrphanHolders()).resolves.toBe(0);
    expect(releaseCalls).toEqual([]);
    expect(auditRows).toEqual([]);
  });

  /*
  FNXC:PlanningLifecycleOrphanReclaim 2026-11-11-19:14 (RUFU-600 code-review P0):
  The floor and the liveness probe are now enforced by the shared release surface itself, so the two
  candidate vetoes below are the sweep's own cheap pre-filters. What this pair proves is the part only the
  sweep owns: a session this product never opened is not a candidate at all, at any age.
  */
  it("never treats a session this product did not open as a reclaim candidate", async () => {
    const { manager, releaseCalls, auditRows } = harness({ holders: [abandonedHolder({ ours: false })] });

    await expect(manager.reconcilePlanningLifecycleOrphanHolders()).resolves.toBe(0);
    expect(releaseCalls).toEqual([]);
    expect(auditRows).toEqual([]);
  });

  it("refuses a holder that names no card, because an unnamed holder cannot be checked", async () => {
    const { manager, releaseCalls, auditRows } = harness({ holders: [abandonedHolder({ taskId: null })] });

    await expect(manager.reconcilePlanningLifecycleOrphanHolders()).resolves.toBe(0);
    expect(releaseCalls).toEqual([]);
    expect(auditRows).toEqual([]);
  });

  it("refuses a session this process registered as live and reports the veto", async () => {
    registerPlanningLifecycleSession(4242, "fusion:planning-lifecycle:project:RUFU-600", "retry");
    const { manager, releaseCalls, rowsFor } = harness({ holders: [abandonedHolder()] });

    await expect(manager.reconcilePlanningLifecycleOrphanHolders()).resolves.toBe(0);
    expect(releaseCalls).toEqual([]);
    const [row] = rowsFor("task:planning-lifecycle-orphan-withheld");
    expect((row!.metadata as Record<string, unknown>).outcome).toBe("session-live");
  });

  it("refuses a holder whose card is still live", async () => {
    const { manager, releaseCalls, rowsFor } = harness({ holders: [abandonedHolder()], isTaskActive: true });

    await expect(manager.reconcilePlanningLifecycleOrphanHolders()).resolves.toBe(0);
    expect(releaseCalls).toEqual([]);
    expect((rowsFor("task:planning-lifecycle-orphan-withheld")[0]!.metadata as Record<string, unknown>).outcome).toBe("card-live");
  });

  it("re-reads the key and refuses when the holder has moved on", async () => {
    const { manager, releaseCalls, diagnoseCalls, rowsFor } = harness({
      holders: [abandonedHolder()],
      diagnosis: { reason: "held", holder: { pid: 9999 } },
    });

    await expect(manager.reconcilePlanningLifecycleOrphanHolders()).resolves.toBe(0);
    expect(diagnoseCalls).toEqual(["RUFU-600"]);
    expect(releaseCalls).toEqual([]);
    expect((rowsFor("task:planning-lifecycle-orphan-withheld")[0]!.metadata as Record<string, unknown>).outcome).toBe("holder-moved");
  });

  it("treats an unreadable holder population as no information, not as an empty population", async () => {
    const { manager, store, releaseCalls, auditRows } = harness({ holders: [abandonedHolder()], populationReason: "holder-query-failed" });

    await expect(manager.reconcilePlanningLifecycleOrphanHolders()).resolves.toBe(0);
    expect(store.listPlanningLifecycleHolderSessions).toHaveBeenCalledTimes(1);
    expect(releaseCalls).toEqual([]);
    expect(auditRows).toEqual([]);
  });

  it("reports a release it could not verify instead of claiming one", async () => {
    const { manager, history, rowsFor } = harness({
      holders: [abandonedHolder()],
      releaseOutcome: { released: false, reason: "release-unproven" },
    });

    await expect(manager.reconcilePlanningLifecycleOrphanHolders()).resolves.toBe(0);
    expect((rowsFor("task:planning-lifecycle-orphan-withheld")[0]!.metadata as Record<string, unknown>).outcome).toBe("release-unproven");
    expect(history).toEqual([]);
  });

  /*
  Every withheld verdict the shared release surface can answer with has to land in this pass's fixed outcome
  vocabulary. A refusal flattened into `release-unproven` would read as "we tried and could not measure",
  when the truth is "we refused before trying" - which is the difference between a lane that protects work
  and a lane that lost a race.
  */
  it.each([
    ["card-live", "card-live"],
    ["liveness-unproven", "card-live"],
    ["below-age-floor", "session-live"],
    ["foreign-holder", "holder-moved"],
  ] as const)("maps a withheld release (%s) onto the outcome the operator reads (%s)", async (reason, outcome) => {
    const { manager, releaseCalls, rowsFor } = harness({
      holders: [abandonedHolder()],
      releaseOutcome: { released: false, reason },
    });

    await expect(manager.reconcilePlanningLifecycleOrphanHolders()).resolves.toBe(0);
    expect(releaseCalls).toHaveLength(1);
    expect((rowsFor("task:planning-lifecycle-orphan-withheld")[0]!.metadata as Record<string, unknown>).outcome).toBe(outcome);
  });

  it("announces a sustained refusal once, not once per pass", async () => {
    const { manager, rowsFor } = harness({ holders: [abandonedHolder()], isTaskActive: true });

    await manager.reconcilePlanningLifecycleOrphanHolders();
    await manager.reconcilePlanningLifecycleOrphanHolders();

    expect(rowsFor("task:planning-lifecycle-orphan-withheld")).toHaveLength(1);
  });

  it("does nothing while the engine or the project is paused", async () => {
    const { manager, store } = harness({ holders: [abandonedHolder()], globalPause: true });

    await expect(manager.reconcilePlanningLifecycleOrphanHolders()).resolves.toBe(0);
    expect(store.listPlanningLifecycleHolderSessions).not.toHaveBeenCalled();
  });

  it("declines silently on a store without the advisory surface", async () => {
    const store = { getSettings: async () => ({ globalPause: false, enginePaused: false }) };
    const manager = new SelfHealingManager(store as unknown as TaskStore, {} as SelfHealingOptions);

    await expect(manager.reconcilePlanningLifecycleOrphanHolders()).resolves.toBe(0);
  });

  it("caps how many sessions one pass may end", async () => {
    const holders = Array.from({ length: 9 }, (_, index) => abandonedHolder({ pid: 4242 + index, taskId: `CARD-${index}` }));
    const { manager, releaseCalls } = harness({ holders });

    await manager.reconcilePlanningLifecycleOrphanHolders();

    expect(releaseCalls).toHaveLength(5);
  });
});
