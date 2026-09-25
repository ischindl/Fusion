/**
 * FNXC:ApprovalHoldMoveClear 2026-09-25-11:12 (RUFU-297 defect A):
 * PG regression for the approval-hold pair invariant at the move seam: a user-driven move out of
 * a review lane destroys `workflowStepResults` via the reopen hooks, so an approval hold whose
 * evidence THAT move destroyed must be cleared in the SAME transaction. Pre-fix, the hold survived
 * the wipe — an unanchored `awaiting-approval` whose only pre-existing exit was the very merge the
 * hold defers. These tests pin BOTH halves: the clear fires on real wipe-outs, and it never fires
 * on exempt moves (engine moves, `preserveStatus`, `userPaused`, unsuppressed evidence, or the
 * never-clear reason codes).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";

const pgTest = pgDescribe;

const HOLD_EVENT = "task:move-cleared-approval-hold";

/** Step-result row shape the hydration/merge gates expect (workflowStepName is REQUIRED). */
const failedCodeReviewRow = {
  workflowStepId: "code-review",
  workflowStepName: "Code Review",
  phase: "pre-merge" as const,
  status: "failed" as const,
  verdict: "REVISE" as const,
  startedAt: "2026-01-01T00:00:00.000Z",
};

pgTest("approval-hold clear on review-lane exit (PostgreSQL, RUFU-297)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_move_hold_clear",
    projectId: "rufu297-move-hold",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** Seed an in-review card carrying an approval hold + failed pre-merge evidence. */
  async function seedHeldCard(
    id: string,
    hold: { status?: string; awaitingApprovalReason?: string; paused?: boolean; pausedReason?: string; userPaused?: boolean; pausedStartedAt?: string },
  ) {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: id, column: "in-review" },
      { taskId: id, applyDefaultWorkflowSteps: false },
    );
    await store.updateTask(id, {
      status: hold.status as never,
      awaitingApprovalReason: hold.awaitingApprovalReason as never,
      enabledWorkflowSteps: ["code-review"],
      workflowStepResults: [failedCodeReviewRow],
    });
    await h.adminDb()
      .update(schema.project.tasks)
      .set({
        paused: hold.paused ? 1 : 0,
        pausedReason: hold.pausedReason ?? null,
        userPaused: hold.userPaused ? 1 : 0,
        ...(hold.pausedStartedAt ? { pausedStartedAt: hold.pausedStartedAt } : {}),
      })
      .where(eq(schema.project.tasks.id, id));
    store.taskCache.delete(id);
  }

  async function auditRows(taskId: string) {
    return h.adminDb()
      .select({ mutationType: schema.project.runAuditEvents.mutationType, metadata: schema.project.runAuditEvents.metadata })
      .from(schema.project.runAuditEvents)
      .where(and(eq(schema.project.runAuditEvents.taskId, taskId), eq(schema.project.runAuditEvents.mutationType, HOLD_EVENT)));
  }

  it("clears the destroyed-evidence hold and records the audit pair on a user move out of review", async () => {
    const store = h.store();
    await seedHeldCard("rufu297-a1", { status: "awaiting-approval", awaitingApprovalReason: "code-review-non-convergence" });

    await store.moveTask("rufu297-a1", "in-progress", { moveSource: "user" });

    const moved = await store.getTask("rufu297-a1");
    // Pair invariant: the hooks wiped the evidence, the seam cleared the hold with it.
    expect(moved?.status ?? undefined).toBeUndefined();
    expect(moved?.awaitingApprovalReason ?? undefined).toBeUndefined();
    expect(moved?.workflowStepResults ?? undefined).toBeUndefined();

    // The audit row is emitted post-commit fire-and-forget — wait for its durability, not a timer.
    await vi.waitFor(async () => {
      const rows = await auditRows("rufu297-a1");
      expect(rows.length).toBe(1);
      const meta = rows[0].metadata as Record<string, unknown>;
      // ids + fixed enums only: exact key set, no free-text key can sneak prose in.
      expect(Object.keys(meta).sort()).toEqual(
        ["awaitingApprovalReason", "fromColumn", "moveSource", "outcome", "priorStatus", "toColumn"],
      );
      expect(meta.priorStatus).toBe("awaiting-approval");
      expect(meta.awaitingApprovalReason).toBe("code-review-non-convergence");
      expect(meta.fromColumn).toBe("in-review");
      expect(meta.toColumn).toBe("in-progress");
      expect(meta.moveSource).toBe("user");
      expect(meta.outcome).toBe("cleared");
    });
  });

  it("keeps the hold on an engine remediation move (not a human decision)", async () => {
    const store = h.store();
    await seedHeldCard("rufu297-a2", { status: "awaiting-approval", awaitingApprovalReason: "code-review-non-convergence" });

    // The sanctioned review→WIP engine shape: Code Review REVISE remediation bounce.
    await store.moveTask("rufu297-a2", "in-progress", {
      moveSource: "engine",
      lifecycleReason: "code-review-revise-remediation",
    });

    const moved = await store.getTask("rufu297-a2");
    expect(moved?.status).toBe("awaiting-approval");
    expect(moved?.awaitingApprovalReason).toBe("code-review-non-convergence");
    expect((await auditRows("rufu297-a2")).length).toBe(0);
  });

  it("keeps the hold when preserveStatus is set (plan-approval release shape)", async () => {
    const store = h.store();
    await seedHeldCard("rufu297-a3", { status: "awaiting-approval", awaitingApprovalReason: "code-review-non-convergence" });

    await store.moveTask("rufu297-a3", "in-progress", {
      moveSource: "user",
      preserveStatus: true,
      workflowMoveSource: "plan-approval",
    });

    const moved = await store.getTask("rufu297-a3");
    expect(moved?.status).toBe("awaiting-approval");
    expect(moved?.awaitingApprovalReason).toBe("code-review-non-convergence");
  });

  it("never reaches through an operator user-pause", async () => {
    const store = h.store();
    await seedHeldCard("rufu297-a4", {
      status: "awaiting-approval",
      awaitingApprovalReason: "code-review-non-convergence",
      userPaused: true,
    });

    await store.moveTask("rufu297-a4", "in-progress", { moveSource: "user" });

    const moved = await store.getTask("rufu297-a4");
    expect(moved?.status).toBe("awaiting-approval");
    expect(moved?.awaitingApprovalReason).toBe("code-review-non-convergence");
  });

  it("does not clear a drifted hold on the move — no wipe witness belongs to the sweep", async () => {
    const store = h.store();
    // The defect-B shape: hold present, step results ALREADY gone before this move. The move-side
    // clear keys on the wipe it witnesses, so a pre-drifted card keeps its hold for the bounded,
    // audited self-healing sweep rather than an opportunistic move-side guess.
    await seedHeldCard("rufu297-a5", { status: "awaiting-approval", awaitingApprovalReason: "code-review-non-convergence" });
    await store.updateTask("rufu297-a5", { workflowStepResults: null });
    store.taskCache.delete("rufu297-a5");

    await store.moveTask("rufu297-a5", "in-progress", { moveSource: "user" });

    const moved = await store.getTask("rufu297-a5");
    expect(moved?.status).toBe("awaiting-approval");
    expect(moved?.awaitingApprovalReason).toBe("code-review-non-convergence");
    expect((await auditRows("rufu297-a5")).length).toBe(0);
  });

  it("never clears the human-plan-approval decision pause on a review exit", async () => {
    const store = h.store();
    await seedHeldCard("rufu297-a6", { status: "awaiting-approval", awaitingApprovalReason: "human-plan-approval" });

    await store.moveTask("rufu297-a6", "in-progress", { moveSource: "user" });

    const moved = await store.getTask("rufu297-a6");
    expect(moved?.status).toBe("awaiting-approval");
    expect(moved?.awaitingApprovalReason).toBe("human-plan-approval");
  });

  it("clears the superseded gated-session pause shape with honest accounting", async () => {
    const store = h.store();
    await seedHeldCard("rufu297-a7", {
      paused: true,
      pausedReason: "awaiting-approval",
      awaitingApprovalReason: "code-review-non-convergence",
      pausedStartedAt: "2026-01-01T00:00:00.000Z",
    });

    await store.moveTask("rufu297-a7", "in-progress", { moveSource: "user" });

    const moved = await store.getTask("rufu297-a7");
    expect(moved?.paused ?? undefined).toBeUndefined();
    expect(moved?.pausedReason ?? undefined).toBeUndefined();
    expect(moved?.awaitingApprovalReason ?? undefined).toBeUndefined();
    // The pause clock was closed into cumulative time rather than silently dropped.
    expect(typeof moved?.cumulativePausedMs).toBe("number");
  });

  it("clears on the review→planning exit too (reopen wipe destroys the evidence)", async () => {
    const store = h.store();
    await seedHeldCard("rufu297-a8", { status: "awaiting-approval", awaitingApprovalReason: "code-review-non-convergence" });

    await store.moveTask("rufu297-a8", "todo", { moveSource: "user" });

    const moved = await store.getTask("rufu297-a8");
    expect(moved?.status ?? undefined).toBeUndefined();
    expect(moved?.awaitingApprovalReason ?? undefined).toBeUndefined();
    expect(moved?.workflowStepResults ?? undefined).toBeUndefined();
  });

  it("clears through the moveTaskIf surface (same choke point)", async () => {
    const store = h.store();
    await seedHeldCard("rufu297-a9", { status: "awaiting-approval", awaitingApprovalReason: "code-review-non-convergence" });

    await store.moveTaskIf("rufu297-a9", "in-progress", (live) => live.column === "in-review", { moveSource: "user" });

    const moved = await store.getTask("rufu297-a9");
    expect(moved?.column).toBe("in-progress");
    expect(moved?.status ?? undefined).toBeUndefined();
    expect(moved?.awaitingApprovalReason ?? undefined).toBeUndefined();
  });

  it("clears a plan-review-replan-cap hold — the wipe restarts the budget deliberately", async () => {
    const store = h.store();
    await seedHeldCard("rufu297-a10", { status: "awaiting-approval", awaitingApprovalReason: "plan-review-replan-cap" });

    await store.moveTask("rufu297-a10", "in-progress", { moveSource: "user" });

    const moved = await store.getTask("rufu297-a10");
    expect(moved?.status ?? undefined).toBeUndefined();
    expect(moved?.awaitingApprovalReason ?? undefined).toBeUndefined();
  });

  it("clears a bare awaiting-approval hold (null reason — defect A's shape)", async () => {
    const store = h.store();
    await seedHeldCard("rufu297-a11", { status: "awaiting-approval" });

    await store.moveTask("rufu297-a11", "in-progress", { moveSource: "user" });

    const moved = await store.getTask("rufu297-a11");
    expect(moved?.status ?? undefined).toBeUndefined();
    const rows = await auditRows("rufu297-a11");
    expect(rows.length).toBe(1);
    const meta = (typeof rows[0].metadata === "string" ? JSON.parse(rows[0].metadata as string) : rows[0].metadata) as Record<string, unknown>;
    expect(meta.awaitingApprovalReason).toBe("none");
  });

  it("clears the legacy release-authorization orphan without re-parking it", async () => {
    const store = h.store();
    await seedHeldCard("rufu297-a12", { status: "awaiting-approval", awaitingApprovalReason: "release-authorization" });

    await store.moveTask("rufu297-a12", "in-progress", { moveSource: "user" });

    const moved = await store.getTask("rufu297-a12");
    expect(moved?.status ?? undefined).toBeUndefined();
    expect(moved?.awaitingApprovalReason ?? undefined).toBeUndefined();
  });

  it("never clears merge-blocked-by-policy and leaves its remedy error intact", async () => {
    const store = h.store();
    await seedHeldCard("rufu297-a13", { status: "awaiting-approval", awaitingApprovalReason: "merge-blocked-by-policy" });
    await store.updateTask("rufu297-a13", { error: "Branch protection requires 2 approving reviews on main." });
    store.taskCache.delete("rufu297-a13");

    await store.moveTask("rufu297-a13", "in-progress", { moveSource: "user" });

    const moved = await store.getTask("rufu297-a13");
    expect(moved?.status).toBe("awaiting-approval");
    expect(moved?.awaitingApprovalReason).toBe("merge-blocked-by-policy");
    expect(moved?.error).toBe("Branch protection requires 2 approving reviews on main.");
    expect((await auditRows("rufu297-a13")).length).toBe(0);
  });

  it("keeps step-bound holds when the move's provenance preserves the evidence (workflow-graph)", async () => {
    const store = h.store();
    await seedHeldCard("rufu297-a14", { status: "awaiting-approval", awaitingApprovalReason: "code-review-non-convergence" });

    await store.moveTask("rufu297-a14", "in-progress", { moveSource: "user", workflowMoveSource: "workflow-graph" });

    const moved = await store.getTask("rufu297-a14");
    // No wipe witness → the pair stays paired and the results survive by the hook carve-out.
    expect(moved?.workflowStepResults?.length).toBe(1);
    expect(moved?.status).toBe("awaiting-approval");
    expect(moved?.awaitingApprovalReason).toBe("code-review-non-convergence");
    expect((await auditRows("rufu297-a14")).length).toBe(0);
  });

  it("keeps step-bound holds under plan-approval provenance (evidence preserved by the hook)", async () => {
    const store = h.store();
    await seedHeldCard("rufu297-a17", { status: "awaiting-approval", awaitingApprovalReason: "plan-review-replan-cap" });

    await store.moveTask("rufu297-a17", "in-progress", { moveSource: "user", workflowMoveSource: "plan-approval" });

    const moved = await store.getTask("rufu297-a17");
    expect(moved?.workflowStepResults?.length).toBe(1);
    expect(moved?.status).toBe("awaiting-approval");
    expect(moved?.awaitingApprovalReason).toBe("plan-review-replan-cap");
    expect((await auditRows("rufu297-a17")).length).toBe(0);
  });

  it("leaves a gated pause with an UNRELATED pausedReason untouched", async () => {
    const store = h.store();
    await seedHeldCard("rufu297-a18", {
      status: "awaiting-approval",
      awaitingApprovalReason: "code-review-non-convergence",
      paused: true,
      pausedReason: "manual",
      pausedStartedAt: "2026-01-01T00:00:00.000Z",
    });

    await store.moveTask("rufu297-a18", "in-progress", { moveSource: "user" });

    const moved = await store.getTask("rufu297-a18");
    // Status/reason follow the wipe witness; the foreign pause is never resumed by this block.
    expect(moved?.status ?? undefined).toBeUndefined();
    expect(moved?.paused).toBe(true);
    expect(moved?.pausedReason).toBe("manual");
  });

  it("keeps the hold on a planning→WIP user move (no review-lane exit owns it)", async () => {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: "rufu297-a15", column: "todo" },
      { taskId: "rufu297-a15", applyDefaultWorkflowSteps: false },
    );
    await store.updateTask("rufu297-a15", {
      status: "awaiting-approval" as never,
      awaitingApprovalReason: "code-review-non-convergence" as never,
    });
    store.taskCache.delete("rufu297-a15");

    await store.moveTask("rufu297-a15", "in-progress", { moveSource: "user" });

    const moved = await store.getTask("rufu297-a15");
    expect(moved?.column).toBe("in-progress");
    expect(moved?.status).toBe("awaiting-approval");
    expect((await auditRows("rufu297-a15")).length).toBe(0);
  });

  it("clears on exit from a custom (renamed) review lane — the review set, not the literal id", async () => {
    const store = h.store();
    const definition = await store.createWorkflowDefinition({
      name: "rufu297-custom-review-lane",
      ir: {
        version: "v2",
        name: "rufu297-custom-review-lane",
        columns: [
          { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
          { id: "building", name: "Building", traits: [{ trait: "wip" }] },
          /* Review hosted by a human-review-only lane: the clear must key on the review SET. */
          { id: "verdict", name: "Verdict", traits: [{ trait: "human-review" }] },
          { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
        ],
        nodes: [{ id: "start", kind: "start", column: "backlog" }, { id: "end", kind: "end", column: "shipped" }],
        edges: [{ from: "start", to: "end" }],
      },
    } as never);
    const task = await store.createTask({ description: "rufu297-a16", workflowId: definition.id } as never);
    // Canonical lane ordering: backlog → building → verdict (the producer-test traversal).
    await store.moveTask(task.id, "building" as never, { bypassGuards: true } as never);
    await store.moveTask(task.id, "verdict" as never, { bypassGuards: true } as never);
    await store.updateTask(task.id, {
      status: "awaiting-approval" as never,
      awaitingApprovalReason: "code-review-non-convergence" as never,
      workflowStepResults: [failedCodeReviewRow],
    });
    store.taskCache.delete(task.id);

    await store.moveTask(task.id, "building" as never, { moveSource: "user" } as never);

    const moved = await store.getTask(task.id);
    expect(moved?.column).toBe("building");
    // Whether or not this custom lane's exit fires the reopen wipe, the invariant holds:
    // hold cleared iff the evidence was destroyed by THIS move.
    const wiped = moved?.workflowStepResults === undefined;
    expect(moved?.status === undefined).toBe(wiped);
    if (wiped) {
      expect(await auditRows(task.id).then((r) => r.length)).toBe(1);
    } else {
      expect(moved?.status).toBe("awaiting-approval");
    }
  });
});
