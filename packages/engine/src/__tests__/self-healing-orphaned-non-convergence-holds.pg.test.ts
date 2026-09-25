/**
 * FNXC:ApprovalHoldMoveClear 2026-09-25-11:12 (RUFU-297 defect B):
 * PG regression for `reconcile-orphaned-non-convergence-holds`: a `code-review-non-convergence`
 * approval hold left behind by a PRE-RUFU-297 build (hold present, step results already destroyed)
 * is cleared IN PLACE. The hold is legitimate only while its evidence — a `failed`/
 * `advisory_failure` result on a required pre-merge gate — exists; while that survives, the
 * human-decision contract must not be swept away. Skips follow the FN-8356 rule set (user pauses,
 * live sessions) and the reason-code gate never reaches another owner's hold.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { SelfHealingManager } from "../self-healing.js";

const pgTest = pgDescribe;

const HOLD_EVENT = "task:reconcile-orphaned-non-convergence-hold";

const failedCodeReviewRow = {
  workflowStepId: "code-review",
  workflowStepName: "Code Review",
  phase: "pre-merge" as const,
  status: "failed" as const,
  verdict: "REVISE" as const,
  startedAt: "2026-01-01T00:00:00.000Z",
};

pgTest("self-healing reconcileOrphanedNonConvergenceHolds (PostgreSQL, RUFU-297)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_orphan_nc_hold",
    projectId: "rufu297-sweep",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** Seed an in-review card on the exact drifted pair: non-convergence hold + step-list state. */
  async function seedDrifted(
    id: string,
    shape: {
      stepResults?: Array<Record<string, unknown>> | null;
      reason?: string;
      pausedShape?: boolean;
      userPaused?: boolean;
    } = {},
  ) {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: id, column: "in-review" },
      { taskId: id, applyDefaultWorkflowSteps: false },
    );
    await store.updateTask(id, {
      status: shape.pausedShape ? (undefined as never) : ("awaiting-approval" as never),
      awaitingApprovalReason: (shape.reason ?? "code-review-non-convergence") as never,
      enabledWorkflowSteps: ["code-review"],
      workflowStepResults: (shape.stepResults ?? null) as never,
    });
    if (shape.pausedShape) {
      await h.adminSql()`UPDATE project.tasks SET paused = 1, paused_reason = 'awaiting-approval', paused_started_at = '2026-01-01T00:00:00.000Z' WHERE id = ${id}`;
      store.taskCache.delete(id);
    }
    if (shape.userPaused) {
      await h.adminSql()`UPDATE project.tasks SET user_paused = 1 WHERE id = ${id}`;
      store.taskCache.delete(id);
    }
  }

  async function auditRows(taskId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await h.adminSql()`SELECT metadata FROM project.run_audit_events WHERE task_id = ${taskId} AND mutation_type = ${HOLD_EVENT}`;
    return rows.map((r: { metadata: unknown }) =>
      (typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata) as Record<string, unknown>);
  }

  it("clears a drifted hold whose step results are null, in place, with audit + log", async () => {
    const store = h.store();
    await seedDrifted("rufu297-b1", { stepResults: null });

    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });
    const cleared = await manager.reconcileOrphanedNonConvergenceHolds();
    expect(cleared).toBe(1);

    const repaired = await store.getTask("rufu297-b1");
    // In-place clear: hold gone, lane untouched (no lifecycle move).
    expect(repaired?.status ?? undefined).toBeUndefined();
    expect(repaired?.awaitingApprovalReason ?? undefined).toBeUndefined();
    expect(repaired?.column).toBe("in-review");
    expect((repaired?.log ?? []).some((entry) => /drifted code-review-non-convergence/i.test(entry.action))).toBe(true);

    const rows = await auditRows("rufu297-b1");
    expect(rows.length).toBe(1);
    const meta = rows[0];
    // The auditor envelope adds only its fixed context keys (phase/taskLineageId) to the stored
    // jsonb; the sweep's own payload must stay a closed ids/enums set — no prose key can hide in it.
    expect(meta.phase).toBe("reconcile-orphaned-non-convergence-holds");
    const payload = { ...meta };
    delete payload.phase;
    delete payload.taskLineageId;
    expect(Object.keys(payload).sort()).toEqual(
      ["column", "outcome", "priorStatus", "reasonCode", "taskId"],
    );
    expect(meta.taskId).toBe("rufu297-b1");
    expect(meta.column).toBe("in-review");
    expect(meta.priorStatus).toBe("awaiting-approval");
    expect(meta.reasonCode).toBe("code-review-non-convergence");
    expect(meta.outcome).toBe("cleared");
  });

  it("clears the drifted hold when only unrelated (non-required) results survived the wipe", async () => {
    const store = h.store();
    await seedDrifted("rufu297-b2", {
      stepResults: [{
        workflowStepId: "browser-verification",
        workflowStepName: "Browser Verification",
        phase: "pre-merge",
        status: "failed",
        startedAt: "2026-01-01T00:00:00.000Z",
      }],
    });

    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });
    expect(await manager.reconcileOrphanedNonConvergenceHolds()).toBe(1);
    const repaired = await store.getTask("rufu297-b2");
    expect(repaired?.awaitingApprovalReason ?? undefined).toBeUndefined();
  });

  it("leaves the hold alone while the failed pre-merge evidence survives", async () => {
    const store = h.store();
    await seedDrifted("rufu297-b3", { stepResults: [failedCodeReviewRow] });

    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });
    expect(await manager.reconcileOrphanedNonConvergenceHolds()).toBe(0);
    const kept = await store.getTask("rufu297-b3");
    expect(kept?.status).toBe("awaiting-approval");
    expect(kept?.awaitingApprovalReason).toBe("code-review-non-convergence");
    expect((await auditRows("rufu297-b3")).length).toBe(0);
  });

  it("never reaches through an operator user-pause", async () => {
    const store = h.store();
    await seedDrifted("rufu297-b4", { stepResults: null, userPaused: true });

    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });
    expect(await manager.reconcileOrphanedNonConvergenceHolds()).toBe(0);
    const kept = await store.getTask("rufu297-b4");
    expect(kept?.status).toBe("awaiting-approval");
  });

  it("never clears another owner's hold (human-plan-approval decision pause)", async () => {
    const store = h.store();
    await seedDrifted("rufu297-b5", { stepResults: null, reason: "human-plan-approval" });

    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });
    expect(await manager.reconcileOrphanedNonConvergenceHolds()).toBe(0);
    const kept = await store.getTask("rufu297-b5");
    expect(kept?.status).toBe("awaiting-approval");
    expect(kept?.awaitingApprovalReason).toBe("human-plan-approval");
  });

  it("clears the gated-session pause shape with pause accounting", async () => {
    const store = h.store();
    await seedDrifted("rufu297-b6", { stepResults: null, pausedShape: true });

    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });
    expect(await manager.reconcileOrphanedNonConvergenceHolds()).toBe(1);
    const repaired = await store.getTask("rufu297-b6");
    expect(repaired?.paused ?? false).toBe(false);
    expect(repaired?.pausedReason ?? undefined).toBeUndefined();
    expect(repaired?.awaitingApprovalReason ?? undefined).toBeUndefined();
    expect(typeof repaired?.cumulativePausedMs).toBe("number");
  });

  it("skips a card with a live session (FN-8492 canonical liveness triple)", async () => {
    const store = h.store();
    await seedDrifted("rufu297-b7", { stepResults: null });

    const manager = new SelfHealingManager(store, {
      rootDir: h.rootDir(),
      isTaskActive: (id: string) => id === "rufu297-b7",
    });
    expect(await manager.reconcileOrphanedNonConvergenceHolds()).toBe(0);
    const kept = await store.getTask("rufu297-b7");
    expect(kept?.status).toBe("awaiting-approval");
  });
});
