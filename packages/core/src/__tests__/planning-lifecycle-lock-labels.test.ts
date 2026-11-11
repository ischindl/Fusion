import { describe, expect, it } from "vitest";

/*
RUFU-600 Steps 1-2 unit seam.
The pure parts of holder identity and the one-deadline budget are asserted here so the PostgreSQL
dependency stays in the `.pg` file. These are the pieces an operator-facing 409 is built from: a label
derived from `application_name`, a diagnosis that distinguishes "no holder" from "cannot see", and a
deadline that stops handing out fresh budgets to later phases.
*/
import {
  AcquisitionBudget,
  PLANNING_LIFECYCLE_APPLICATION_NAME_PREFIX,
  PLANNING_LIFECYCLE_HOLDER_LABELS,
  parsePlanningLifecycleApplicationName,
  planningLifecycleApplicationName,
  registerPlanningLifecycleSession,
  resolvePlanningLifecycleHolderLabel,
  summarizeHolderRows,
  unregisterPlanningLifecycleSession,
} from "../postgres/advisory-locks.js";

describe("resolvePlanningLifecycleHolderLabel", () => {
  it("round-trips every declared vocabulary label through the stamped application_name", () => {
    for (const label of PLANNING_LIFECYCLE_HOLDER_LABELS) {
      expect(resolvePlanningLifecycleHolderLabel(planningLifecycleApplicationName(label))).toBe(label);
    }
  });

  it("accepts a bare label as well as the prefixed form", () => {
    expect(resolvePlanningLifecycleHolderLabel("retry")).toBe("retry");
    expect(resolvePlanningLifecycleHolderLabel("fusion-planning:retry")).toBe("retry");
  });

  it("reads anything it cannot name as unknown instead of inventing a lane", () => {
    expect(resolvePlanningLifecycleHolderLabel("pg-admin-cli")).toBe("unknown");
    expect(resolvePlanningLifecycleHolderLabel("fusion-planning:made-up-lane")).toBe("unknown");
    expect(resolvePlanningLifecycleHolderLabel("")).toBe("unknown");
    expect(resolvePlanningLifecycleHolderLabel(null)).toBe("unknown");
    expect(resolvePlanningLifecycleHolderLabel(undefined)).toBe("unknown");
  });

  it("keeps the stamped application_name inside a bounded, secret-free field", () => {
    const stamped = planningLifecycleApplicationName("merge-queue", "FN-600");
    expect(stamped.startsWith(PLANNING_LIFECYCLE_APPLICATION_NAME_PREFIX)).toBe(true);
    expect(stamped.length).toBeLessThanOrEqual(64);
    expect(stamped).not.toContain("postgres://");
  });

  it("carries the card identity that pg_locks cannot give back, and sanitises anything else", () => {
    expect(parsePlanningLifecycleApplicationName(planningLifecycleApplicationName("retry", "RUFU-600")))
      .toEqual({ label: "retry", taskId: "RUFU-600" });
    // A task id is not a control channel: characters outside the id alphabet are replaced, never passed
    // through, so the stamped name can only ever contain the alphabet the parser accepts.
    expect(parsePlanningLifecycleApplicationName(planningLifecycleApplicationName("planning", "a b:c`d")))
      .toEqual({ label: "planning", taskId: "a_b_c_d" });
    // A holder that predates the task segment, or belongs to another tool, reports no card rather than a guess.
    expect(parsePlanningLifecycleApplicationName("fusion-planning:planning")).toEqual({ label: "planning", taskId: null });
    expect(parsePlanningLifecycleApplicationName("psql")).toEqual({ label: "unknown", taskId: null });
    expect(parsePlanningLifecycleApplicationName(null)).toEqual({ label: "unknown", taskId: null });
    // An over-long id is truncated into the budget, never dropped along with the label.
    const truncated = planningLifecycleApplicationName("sweep", "X".repeat(200));
    expect(truncated.length).toBeLessThanOrEqual(64);
    expect(parsePlanningLifecycleApplicationName(truncated).label).toBe("sweep");
    expect(parsePlanningLifecycleApplicationName(truncated).taskId).toMatch(/^X+$/);
  });
});

describe("summarizeHolderRows", () => {
  const key = "fusion:planning-lifecycle:project-a:FN-600";

  it("answers not-held only when the query returned nothing", () => {
    expect(summarizeHolderRows(key, [])).toEqual({ key, heldByThisProcess: false, holder: null, reason: "not-held" });
  });

  it("reports a holder it cannot identify as identity-not-derivable rather than as free", () => {
    const rows = [{ pid: null, application_name: "fusion-planning:planning", state: "idle", age_ms: 10 }];
    expect(summarizeHolderRows(key, rows).reason).toBe("identity-not-derivable");
    expect(summarizeHolderRows(key, rows).holder).toBeNull();
  });

  it("names the oldest holder and maps its state", () => {
    const rows = [
      { pid: 41, application_name: "fusion-planning:planning", state: "idle", age_ms: 120 },
      { pid: 42, application_name: "fusion-planning:retry", state: "idle in transaction", age_ms: 9_000 },
    ];
    const diagnosis = summarizeHolderRows(key, rows);
    expect(diagnosis.reason).toBe("held");
    /*
    FNXC:PlanningLifecycleHolderOwnership 2026-11-11-19:14 (RUFU-600 code-review P0):
    `ours` is part of the holder identity a reader now has to see: it is what a release may not act without,
    and it is derived here from the `fusion-planning:` prefix rather than from a lock row.
    */
    expect(diagnosis.holder).toEqual({ label: "retry", pid: 42, state: "idle-in-transaction", ageMs: 9_000, taskId: null, ours: true });
  });

  it("marks a session that carries no fusion planning prefix as not ours to end", () => {
    // A psql shell (or any other client) that happens to sit on a colliding hashtext() key.
    const rows = [{ pid: 77, application_name: "psql", state: "idle", age_ms: 600_000 }];
    const diagnosis = summarizeHolderRows(key, rows);
    expect(diagnosis.reason).toBe("held");
    expect(diagnosis.holder).toMatchObject({ label: "unknown", pid: 77, ours: false });
  });

  it("flags a holder this process is holding, which is what a reclaim must never terminate", () => {
    const pid = 900_123;
    registerPlanningLifecycleSession(pid, key, "retry");
    try {
      const rows = [{ pid, application_name: "fusion-planning:retry", state: "idle", age_ms: 10_000 }];
      expect(summarizeHolderRows(key, rows).heldByThisProcess).toBe(true);
    } finally {
      unregisterPlanningLifecycleSession(pid);
    }
    const rows = [{ pid, application_name: "fusion-planning:retry", state: "idle", age_ms: 10_000 }];
    expect(summarizeHolderRows(key, rows).heldByThisProcess).toBe(false);
  });
});

describe("AcquisitionBudget", () => {
  it("hands each phase the remaining deadline, never a fresh copy of the total", async () => {
    const budget = new AcquisitionBudget(200);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const afterFirstPhase = budget.remainingMs();
    expect(afterFirstPhase).toBeLessThan(200);
    expect(budget.elapsedMs).toBeGreaterThanOrEqual(60);
    expect(budget.totalMs).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(budget.remainingMs()).toBe(0);
    expect(budget.expired()).toBe(true);
  });

  it("never reports a negative remainder a later phase could bound itself by", async () => {
    const budget = new AcquisitionBudget(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(budget.remainingMs()).toBe(0);
  });
});
