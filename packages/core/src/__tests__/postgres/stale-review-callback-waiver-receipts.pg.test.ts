/*
FNXC:StaleReviewCallbackWaiver 2026-10-01-04:54:
A stale-callback waiver is merge authority only when its receipt and the replacement carrier commit
inside the same project-scoped task transaction. This production-store regression proves that a
matching task ID in another project cannot read or replay that authority.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  seedPreExistingTaskIdDuplicate,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { TaskStore } from "../../store.js";
import { deriveStaleReviewCallbackAttemptId } from "../../workflows/workflow-step-results.js";
import { hasValidStaleReviewCallbackWaiver } from "../../merge/pre-merge-approval.js";

pgDescribe("stale review callback waiver receipts (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_stale_review_callback_waivers",
    projectId: "project-a",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("atomically persists the carrier history, activity, and exact project receipt without cross-project replay", async () => {
    const storeA = h.store();
    const startedAt = new Date(Date.now() - 16 * 60_000).toISOString();
    const task = await storeA.createTask({ description: "stale code review" });
    await storeA.updateTask(task.id, {
      workflowStepResults: [{
        workflowStepId: "custom-code-review",
        workflowStepName: "Custom Code Review",
        phase: "pre-merge",
        reviewKind: "code",
        status: "pending",
        startedAt,
      }],
    });
    const attemptId = deriveStaleReviewCallbackAttemptId({ status: "pending", startedAt });
    expect(attemptId).toBeTruthy();

    const issued = await storeA.issueStaleReviewCallbackWaiver(task.id, {
      workflowStepId: "custom-code-review",
      attemptId: attemptId!,
      expectedStatus: "pending",
      expectedStartedAt: startedAt,
      canIssue: (current) => current.column === "todo",
    });

    expect(issued).toMatchObject({ applied: true, receipt: { projectId: "project-a", taskId: task.id, attemptId } });
    if (!issued.applied) throw new Error("expected stale callback waiver issuance");
    /*
    FNXC:StaleReviewCallbackWaiver 2026-10-01-04:54:
    The returned task comes from the receipt transaction's UPDATE ... RETURNING row rather than task
    JSON or a cache, so this assertion proves the carrier and receipt committed together.
    */
    const persisted = issued.task;
    const carrier = persisted.workflowStepResults?.[0];
    expect(carrier).toMatchObject({
      status: "skipped",
      automatedStaleCallbackWaiver: {
        receiptId: issued.receipt.id,
        attemptId,
        priorStatus: "pending",
      },
      priorAttempts: [{ status: "pending", startedAt }],
    });
    expect(persisted?.log).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "System waived a proven stale code-review callback after the safety wait." }),
    ]));
    const receiptsA = await storeA.getStaleReviewCallbackWaiverReceipts(task.id);
    expect(receiptsA).toEqual([issued.receipt]);

    const layerFor = (projectId: string): AsyncDataLayer => ({ ...h.layer(), projectId });
    const storeB = new TaskStore(h.rootDir(), undefined, { asyncLayer: layerFor("project-b") });
    /*
    FNXC:TaskIdGlobalUniqueness 2026-11-08-10:41 (RUFU-320):
    Project B's same-id row is copied in through the admin connection instead of inserted: the DB-wide id
    claim now refuses a NEW second project's write of a claimed id. The receipt-replay guard this test
    covers still has to hold for the duplicates that predate the claim table, which RUFU-320 leaves in
    place for the operator to reconcile.
    */
    await seedPreExistingTaskIdDuplicate(h.adminDb(), {
      taskId: task.id,
      fromProjectId: "project-a",
      toProjectId: "project-b",
    });

    expect(await storeB.getStaleReviewCallbackWaiverReceipts(task.id)).toEqual([]);
    expect(hasValidStaleReviewCallbackWaiver(carrier!, {
      projectId: "project-b",
      taskId: task.id,
      requiredPreMergeStepIds: new Set(["custom-code-review"]),
      singularScope: true,
      effectiveAutoMerge: true,
      hasOpenFindings: false,
      receipts: await storeB.getStaleReviewCallbackWaiverReceipts(task.id),
    })).toBe(false);
  });
});
