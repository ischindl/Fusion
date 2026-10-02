import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";

import { SelfHealingManager } from "../self-healing.js";
import { PLANNING_FENCE_PARK_ERROR_PREFIX } from "../planning-handoff-recovery.js";
import { MAX_RECOVERY_RETRIES } from "../healing/recovery-policy.js";

/*
FNXC:PlanningFenceRecovery 2026-10-02-02:05 (RUFU-288):
RUFU-287 was the motivating loss: a card terminalized by `PLANNING_FAILED_EXHAUSTED` after the durable
planning fence refused for a 5 s advisory-lock grant timeout. The lock recovered within seconds; the
card stayed failed for over two hours because NOTHING owned that park — triage re-admits a planning-lane
card only on `needs-replan`, and the sibling `reconcile-principal-held-planning` sweep requires a held
triage continuation this shape never wrote.

Invariants pinned here:
- a park past the grace window gets exactly one probe of the same lifecycle lock the planning handoff
  needs, and re-enters planning iff that probe succeeds;
- the probe refusing means no lifecycle write and no budget burn — an episode that waits out a
  degradation must not spend its restarts on the waiting;
- a repair is bounded by its OWN counter, so a permanently broken fence cannot loop a card forever;
- candidacy is a park SHAPE, not a retained marker, so the population already stranded before the
  marker existed (the real RUFU-287 row) is healed, while an ordinary authoring exhaustion is not;
- both audit types carry the identical ids/counts/fixed-outcome metadata, which is what makes the
  ratio between them the degradation metric this sweep exists to produce.
*/

const MIN = 60_000;
const stale = (ms: number) => new Date(Date.now() - ms).toISOString();
const FENCE_REFUSAL = "workflow-principal-fence-unavailable:triage (Planning lifecycle lock acquisition timed out after 5000ms)";
/** The stranded row RUFU-287 actually left behind — byte-for-byte, marker included. */
const LEGACY_EXHAUSTED_ROW = "PLANNING_FAILED_EXHAUSTED: specification failed 3 times — last error: workflow-principal-fence-unavailable:triage";

/** Trait-driven column model: `todo` is the planning lane, `wip` and `done` are not. */
function planningIr(): WorkflowIr {
  return {
    version: "v2",
    columns: [
      { id: "todo", name: "Planning", traits: [{ trait: "intake" }] },
      { id: "wip", name: "WIP", traits: [{ trait: "in-progress" }] },
      { id: "done", name: "Done", traits: [{ trait: "done" }] },
    ],
    nodes: [
      { id: "plan", type: "prompt", column: "todo" },
      { id: "execute", type: "prompt", column: "wip" },
    ],
    edges: [],
  } as unknown as WorkflowIr;
}

function fenceMarker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "triage",
    requirement: "lock-transport",
    detail: "Planning lifecycle lock acquisition timed out after 5000ms",
    firstAt: stale(20 * MIN),
    at: stale(20 * MIN),
    attempt: 3,
    ...overrides,
  };
}

function namedPark(overrides: Record<string, unknown> = {}): Task {
  return {
    id: "FN-288-PARK",
    title: "Recover a fence-parked planning card",
    description: "",
    column: "todo",
    status: "failed",
    error: `${PLANNING_FENCE_PARK_ERROR_PREFIX} durable planning handoff refused by the workflow-principal fence (role=triage) — planning lifecycle lock unavailable — 3 attempts exhausted.`,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: stale(30 * MIN),
    updatedAt: stale(2 * MIN),
    columnMovedAt: stale(30 * MIN),
    recoveryRetryCount: null,
    nextRecoveryAt: null,
    planningFailure: { principalFence: fenceMarker() },
    workflowStepResults: [],
    ...overrides,
  } as unknown as Task;
}

/**
 * The exact pre-fix stranded row: the exhausted sentence carried the fence, the marker never existed,
 * and nothing has touched the row since the terminalization — which is what makes it aged at all once
 * the marker-derived clock is unavailable.
 */
function legacyPark(overrides: Record<string, unknown> = {}): Task {
  return namedPark({
    error: LEGACY_EXHAUSTED_ROW,
    planningFailure: null,
    updatedAt: stale(20 * MIN),
    ...overrides,
  });
}

interface HarnessOptions {
  settings?: Partial<Settings>;
  lockBehavior?: "available" | "refusing" | "unrelated";
  ir?: WorkflowIr | null;
  isTaskActive?: (taskId: string) => boolean;
}

function harness(task: Task, options: HarnessOptions = {}) {
  const logged: string[] = [];
  const audit: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const ir = options.ir === undefined ? planningIr() : options.ir;
  const probe = async () => {
    if (options.lockBehavior === "refusing") throw new Error(FENCE_REFUSAL);
    if (options.lockBehavior === "unrelated") throw new Error("connection reset by peer");
  };
  const store = {
    getSettings: async () => ({ globalPause: false, enginePaused: false, ...options.settings } as Settings),
    listTasks: async () => [task],
    getTask: async (id: string) => (id === task.id ? task : undefined),
    updateTask: async (_id: string, patch: Record<string, unknown>) => {
      updates.push(patch);
      Object.assign(task, patch);
      task.updatedAt = new Date().toISOString();
    },
    // Real semantics that matter here: the updater runs against the live row, and returning `null`
    // aborts the write and hands back the unchanged row.
    updateTaskAtomic: async (_id: string, updater: (live: Task) => unknown) => {
      const patch = await updater(task);
      if (patch) {
        updates.push(patch as Record<string, unknown>);
        Object.assign(task, patch);
        task.updatedAt = new Date().toISOString();
      }
      return task;
    },
    logEntry: async (_id: string, message: string) => { logged.push(message); },
    recordRunAuditEvent: async (event: Record<string, unknown>) => { audit.push(event); },
    withPlanningLifecycleLock: async (_id: string, operation: () => Promise<unknown>) => {
      await probe();
      return operation();
    },
    getTaskWorkflowSelection: () => (ir ? { workflowId: "wf-288" } : null),
    getWorkflowDefinition: async (id: string) => (id === "wf-288" && ir ? { ir } : undefined),
    listWorkflowDefinitions: async () => (ir ? [{ ir }] : []),
    getRootDir: () => "fence-park-project",
    getTasksDir: () => "",
  } as unknown as TaskStore;
  return {
    task,
    store,
    logged,
    audit,
    updates,
    manager: new SelfHealingManager(store, { rootDir: "/repo", isTaskActive: options.isTaskActive }),
  };
}

const rowsOf = (audit: Array<Record<string, unknown>>, mutationType: string) =>
  audit.filter((event) => event.mutationType === mutationType);

describe("reconcilePlanningFenceParks (RUFU-288)", () => {
  it("re-queues planning for a named park whose fence probe now succeeds, keeping the evidence", async () => {
    const { task, logged, audit, manager } = harness(namedPark());

    await expect(manager.reconcilePlanningFenceParks()).resolves.toBe(1);

    expect(task.status).toBe("needs-replan");
    expect(task.error).toBeNull();
    expect(task.recoveryRetryCount).toBeNull();
    expect(task.nextRecoveryAt).toBeNull();
    // The episode evidence survives the repair, the budget carries its count, and triage's own
    // in-dispatch attempt counter is handed back with the fresh dispatch.
    expect(task.planningFailure?.principalFence).toMatchObject({
      requirement: "lock-transport",
      firstAt: expect.any(String),
      attempt: null,
      requeueCount: 1,
    });
    expect(logged.join(" ")).toContain("fence re-probe succeeded");
    const requeued = rowsOf(audit, "task:reconcile-planning-fence-park");
    expect(requeued).toHaveLength(1);
    expect(requeued[0]).toMatchObject({
      target: "FN-288-PARK",
      domain: "database",
      metadata: {
        taskId: "FN-288-PARK",
        column: "todo",
        requeueCount: 0,
        requirement: "lock-transport",
        outcome: "requeued",
      },
    });
    expect(Object.keys(requeued[0]!.metadata as object).sort()).toEqual(
      ["column", "outcome", "requeueCount", "requirement", "stalenessMs", "taskId"].sort(),
    );
  });

  it("heals the exact stranded row RUFU-287 left behind, which predates the marker", async () => {
    const { task, audit, manager } = harness(legacyPark());

    await expect(manager.reconcilePlanningFenceParks()).resolves.toBe(1);

    expect(task.status).toBe("needs-replan");
    expect(task.error).toBeNull();
    /*
    No marker existed, so the repair re-seeds the episode from the sentence that carried it — the only
    durable evidence of WHY that card failed left on the row. The bare `...:triage` tail names the
    fence FAMILY but no cause, so the honest requirement is `cause-unknown`: the audit axis still
    separates an infrastructure park from a spec refusal (which never reaches this code at all), it
    just cannot invent a transport cause the pre-marker writer never recorded.
    */
    expect(task.planningFailure?.principalFence).toMatchObject({
      role: "triage",
      requirement: "cause-unknown",
      requeueCount: 1,
    });
    expect(rowsOf(audit, "task:reconcile-planning-fence-park")[0]).toMatchObject({
      metadata: { requirement: "cause-unknown", outcome: "requeued", requeueCount: 0 },
    });
  });

  it("recovers the transport requirement for an aged park whose sentence carried its cause", async () => {
    // The real RUFU-318-era message: the fence wrapper appends the inner lock error's canonical text.
    const carried = "PLANNING_FAILED_EXHAUSTED: specification failed 3 times — last error: workflow-principal-fence-unavailable:triage (Planning lifecycle lock acquisition timed out after 5000ms)";
    const { task, manager } = harness(legacyPark({ error: carried }));

    await expect(manager.reconcilePlanningFenceParks()).resolves.toBe(1);

    // The same classifier triage writes with runs on the carried text, so a park's requirement is
    // readable even when the row was terminalized by a build that persisted no marker.
    expect(task.planningFailure?.principalFence).toMatchObject({
      requirement: "lock-transport",
      detail: "Planning lifecycle lock acquisition timed out after 5000ms",
    });
  });

  it("leaves the park intact and counts the refusal when the fence still refuses", async () => {
    const { task, updates, audit, manager } = harness(namedPark(), { lockBehavior: "refusing" });

    await expect(manager.reconcilePlanningFenceParks()).resolves.toBe(0);

    expect(task.status).toBe("failed");
    expect(task.error).toContain(PLANNING_FENCE_PARK_ERROR_PREFIX);
    // Waiting out a degradation is not a restart: neither the row nor the budget moves.
    expect(updates).toHaveLength(0);
    const noAction = rowsOf(audit, "task:reconcile-planning-fence-park-no-action");
    expect(noAction).toHaveLength(1);
    expect(noAction[0]).toMatchObject({
      metadata: { outcome: "fence-still-unavailable", requirement: "lock-transport", requeueCount: 0 },
    });
  });

  it("dedupes a sustained refusal to one row until a pass actually repairs the card", async () => {
    const { manager, audit } = harness(namedPark(), { lockBehavior: "refusing" });

    await manager.reconcilePlanningFenceParks();
    await manager.reconcilePlanningFenceParks();
    expect(audit).toHaveLength(1);

    // The counter survives in the park's own signature, so a repair clears the dedupe for the next
    // episode rather than swallowing it forever.
    const repairing = harness(namedPark(), { lockBehavior: "available" });
    await expect(repairing.manager.reconcilePlanningFenceParks()).resolves.toBe(1);
  });

  it("does not launder an unrelated probe failure into a fence requeue", async () => {
    const { task, updates, audit, manager } = harness(namedPark(), { lockBehavior: "unrelated" });

    await expect(manager.reconcilePlanningFenceParks()).resolves.toBe(0);

    // A store fault is neither proof the fence recovered nor this sweep's to repair.
    expect(task.status).toBe("failed");
    expect(updates).toHaveLength(0);
    expect(rowsOf(audit, "task:reconcile-planning-fence-park")).toHaveLength(0);
  });

  it("waits out the grace window without writing or auditing a young park", async () => {
    const { task, updates, audit, manager } = harness(namedPark({
      planningFailure: { principalFence: fenceMarker({ firstAt: stale(MIN), at: stale(MIN) }) },
    }));

    await expect(manager.reconcilePlanningFenceParks()).resolves.toBe(0);

    // A just-parked card already advertises its own operator-visible retry.
    expect(task.status).toBe("failed");
    expect(updates).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it("yields to a live planning or execution session", async () => {
    const { task, updates, audit, manager } = harness(namedPark(), { isTaskActive: () => true });

    await expect(manager.reconcilePlanningFenceParks()).resolves.toBe(0);

    expect(task.status).toBe("failed");
    expect(updates).toHaveLength(0);
    expect(rowsOf(audit, "task:reconcile-planning-fence-park-no-action")[0])
      .toMatchObject({ metadata: { outcome: "live-session" } });
  });

  it("defers to an operator hold, a paused card, and a global/engine pause", async () => {
    for (const overrides of [{ paused: true }, { userPaused: true }]) {
      const { updates, audit, manager } = harness(namedPark(overrides));
      await expect(manager.reconcilePlanningFenceParks()).resolves.toBe(0);
      expect(updates).toHaveLength(0);
      expect(rowsOf(audit, "task:reconcile-planning-fence-park-no-action")[0])
        .toMatchObject({ metadata: { outcome: "operator-held" } });
    }

    for (const settings of [{ globalPause: true }, { enginePaused: true }]) {
      const { updates, audit, manager } = harness(namedPark(), { settings });
      await expect(manager.reconcilePlanningFenceParks()).resolves.toBe(0);
      expect(updates).toHaveLength(0);
      // A paused engine audits nothing — the pause is itself the record.
      expect(audit).toHaveLength(0);
    }
  });

  it("leaves a human-review terminal contract untouched when auto-merge is off", async () => {
    const { updates, audit, manager } = harness(namedPark({ autoMerge: false }));

    await expect(manager.reconcilePlanningFenceParks()).resolves.toBe(0);

    expect(updates).toHaveLength(0);
    expect(rowsOf(audit, "task:reconcile-planning-fence-park-no-action")[0])
      .toMatchObject({ metadata: { outcome: "auto-merge-off" } });
  });

  it("does not re-queue a card that has left the planning lane", async () => {
    const { task, updates, audit, manager } = harness(namedPark({ column: "wip" }));

    await expect(manager.reconcilePlanningFenceParks()).resolves.toBe(0);

    // `needs-replan` is a planning-lane signal; writing it onto a WIP card would park real work.
    expect(task.status).toBe("failed");
    expect(updates).toHaveLength(0);
    expect(rowsOf(audit, "task:reconcile-planning-fence-park-no-action")[0])
      .toMatchObject({ metadata: { outcome: "left-planning-lane" } });
  });

  it("under-acts when the card's graph declares no column model", async () => {
    // A v1 graph upgrades with trait-less columns: it answers "no planning lanes" the same way a v2
    // board that deliberately declares none does, and for a WRITE that changes lane state the safe
    // direction is to leave the card in its honest failed state rather than guess.
    const v1Ir = { nodes: [{ id: "plan", type: "prompt" }], edges: [] } as unknown as WorkflowIr;
    const { task, updates, audit, manager } = harness(namedPark(), { ir: v1Ir });

    await expect(manager.reconcilePlanningFenceParks()).resolves.toBe(0);

    expect(task.status).toBe("failed");
    expect(updates).toHaveLength(0);
    expect(rowsOf(audit, "task:reconcile-planning-fence-park-no-action")[0])
      .toMatchObject({ metadata: { outcome: "lane-vocabulary-unreadable" } });
  });

  it("stops re-queueing once the card's own budget is spent, without probing the fence", async () => {
    const { updates, audit, manager } = harness(namedPark({
      planningFailure: { principalFence: fenceMarker({ requeueCount: MAX_RECOVERY_RETRIES }) },
    }), { lockBehavior: "unrelated" });

    await expect(manager.reconcilePlanningFenceParks()).resolves.toBe(0);

    // Exhaustion is terminal for the AUTOMATIC path only — the operator's Retry is untouched — and
    // the pass spends nothing to discover it: no lock probe happened, so an unrelated store fault
    // could not have been laundered into a repair.
    expect(updates).toHaveLength(0);
    const noAction = rowsOf(audit, "task:reconcile-planning-fence-park-no-action");
    expect(noAction).toHaveLength(1);
    expect(noAction[0]).toMatchObject({
      metadata: { outcome: "requeue-budget-exhausted", requeueCount: MAX_RECOVERY_RETRIES },
    });
  });

  it("never selects a genuine authoring exhaustion or a stale retained marker", async () => {
    const cases: Array<[string, Task]> = [
      // Exhaustion whose carried cause is the spec, not the fence — stays the generic failed card.
      ["authoring exhaustion", legacyPark({ error: "PLANNING_FAILED_EXHAUSTED: specification failed 3 times — last error: spec missing acceptance criteria" })],
      // Evidence kept after a real recovery must stay inert: a marker with no park sentence.
      ["recovered card", namedPark({ status: null, error: null })],
      // Prose that merely mentions the fence is not a park shape.
      ["prose mention", namedPark({ error: "The workflow-principal-fence-unavailable note was ruled out.", planningFailure: null })],
    ];
    for (const [label, task] of cases) {
      const { updates, audit, manager } = harness(task);
      await expect(manager.reconcilePlanningFenceParks()).resolves.toBe(0);
      expect(updates, label).toHaveLength(0);
      expect(audit, label).toHaveLength(0);
    }
  });

  it("is registered in startup recovery and the maintenance planning-family batch", () => {
    const source = readFileSync("src/self-healing.ts", "utf8");
    const startup = source.slice(source.indexOf("async runStartupRecovery"), source.indexOf("  stop(): void"));
    expect(startup).toContain('name: "reconcile-planning-fence-park"');
    expect(startup).toContain("reconcilePlanningFenceParks");
    const maintenance = source.slice(source.indexOf("const batch2Fns"));
    expect(maintenance).toContain('name: "reconcile-planning-fence-park"');
    expect(maintenance).toContain("reconcilePlanningFenceParks");
  });
});
