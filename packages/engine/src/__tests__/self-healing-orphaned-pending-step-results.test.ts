import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore, WorkflowStepResult } from "@fusion/core";

/*
FNXC:StaleReviewCallbackWaiver 2026-10-01-06:20 (upstream FN-9429 port):
The waiver branch of this sweep reads the merge-content descriptor before it may issue a receipt,
so the module is mocked for the whole file. Every pre-existing FN-8492 case here lacks a review-lane
gate, an eligible selection, or an auto-merge resolution, so it still falls through to the
rewrite-to-failed path — the mock cannot turn a historic case into a waiver.
*/
const { captureMergeContentDescriptorMock } = vi.hoisted(() => ({
  captureMergeContentDescriptorMock: vi.fn(async () => ({ kind: "singular", diff: { state: "empty" } })),
}));

vi.mock("../merge/merge-content-capture.js", () => ({
  captureMergeContentDescriptor: captureMergeContentDescriptorMock,
}));

/*
FNXC:OrphanedPendingSteps 2026-08-22-14:19 (RUFU-151):
Audit assertions target the CURRENT emit path (createRunAuditor → emitBoundedRunAudit →
store `recordRunAuditEvent`, FN-9175) instead of a module mock. The previous top-level
`vi.mock` factory replaced `createRunAuditor` for a root-level module path production no
longer imports (the sweep imports the auditor from the `./util` subtree), so the factory
never engaged: the audited mock stayed at 0 calls while the real emission went unobserved.
The event at the store sink is the `RunAuditEventInput` shape (`mutationType`/`domain`/
merged metadata that also carries `phase` and `needsOperatorBypass`), not the raw
database-input shape — assertions pin the ids/counts-only subset, never a raw-input
`type` key.
*/

import { SelfHealingManager } from "../self-healing.js";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";

/*
FNXC:OrphanedPendingSteps 2026-07-22-16:20 (FN-8492 incident):
An engine restart killed an in-flight pre-merge Code Review session, leaving its
`pending` workflowStepResult with no live session behind it. The merge gate read that as
"incomplete pre-merge workflow steps" and after 3 identical 30-minute stalls the deadlock
disposer parked the task `failed`. These tests pin the sweep that recovers such orphans —
and the liveness veto that keeps it from eating a genuinely live session.

FNXC:OrphanedPendingSteps 2026-07-22-16:35 (review follow-up):
The sweep REWRITES orphans to status:"failed" — it must never delete them. Deleting a
pending review entry silently satisfied the merge gate (an enabled step with no result
does not block) and FN-8492 merged with Code Review skipped. The rewrite keeps the gate
closed and routes re-run/bypass through the failed-pre-merge-steps paths.
*/

function stepResult(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    phase: "pre-merge",
    source: "optional-group",
    status: "passed",
    workflowStepId: "plan-review",
    workflowStepName: "Plan Review",
    ...overrides,
  } as WorkflowStepResult;
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function storeFor(tasks: Task[]): TaskStore & EventEmitter {
  const tasksById = new Map(tasks.map((entry) => [entry.id, entry]));
  return Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false } as Settings)),
    // Honors limit/offset so the >500-row pagination path is actually exercised.
    listTasks: vi.fn(async (options?: { limit?: number; offset?: number }) => {
      const all = [...tasksById.values()];
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? all.length;
      return all.slice(offset, offset + limit);
    }),
    getTask: vi.fn(async (id: string) => tasksById.get(id)),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const next = { ...tasksById.get(id)!, ...patch } as Task;
      tasksById.set(id, next);
      return next;
    }),
    /* FN-9175 sink: the real createRunAuditor → emitBoundedRunAudit path writes here;
       without it createRunAuditor no-ops and audit assertions would be vacuous. */
    recordRunAuditEvent: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
}

/** Run-audit sink accessor for assertions — mirrors the file's vi.fn cast idiom. */
function auditSink(store: TaskStore & EventEmitter) {
  return store.recordRunAuditEvent as ReturnType<typeof vi.fn>;
}

describe("FN-8492: reconcile orphaned pending step results", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    executingTaskLock._clearForTest();
    for (const path of ["/wt/registry-live"]) activeSessionRegistry.unregisterPath(path);
  });

  it("rewrites a dead-session pending result to failed (never deletes) and audits ids/counts only", async () => {
    const stranded = task("FN-1", {
      workflowStepResults: [
        stepResult({ status: "passed", verdict: "APPROVE" }),
        stepResult({ status: "pending", workflowStepId: "code-review", workflowStepName: "Code Review" }),
      ],
    });
    const store = storeFor([stranded]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(1);
    const recovered = await store.getTask("FN-1");
    // Rewrite-to-failed: same length, gate stays closed via the failed entry.
    expect(recovered?.workflowStepResults).toHaveLength(2);
    expect(recovered?.workflowStepResults?.[0]?.status).toBe("passed");
    expect(recovered?.workflowStepResults?.[1]?.status).toBe("failed");
    expect(recovered?.workflowStepResults?.[1]?.completedAt).toBeTruthy();
    expect(recovered?.workflowStepResults?.[1]?.output).toBe("Pending step result had no live session or lease; marked failed by self-healing (FN-8492).");
    expect(recovered?.workflowStepResults?.[1]?.output).not.toMatch(/restart|crash/i);
    /*
    FNXC:OrphanedPendingSteps 2026-09-07-00:40:
    Upstream added these output-text assertions (FN-8492 user-facing copy must not claim
    a restart/crash); they are kept and paired with the real-store-sink harness above
    (RUFU-151) rather than upstream's module mock, whose createRunAuditor path no longer
    matches production imports.
    */
    const audit = auditSink(store);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:reconcile-orphaned-pending-step-results",
      target: "FN-1",
      domain: "database",
      metadata: expect.objectContaining({ taskId: "FN-1", orphanedCount: 1, resultCount: 2 }),
    }));
  });

  /*
  FNXC:StaleReviewCallbackWaiver 2026-10-01-06:20 (upstream FN-9429 port):
  A receipt-backed waiver is only ever issued inside the resolved review lane. Outside it, the
  candidate keeps the historic FN-8492 failed rewrite, because silently waiving a callback the merge
  door never required would approve work no gate asked for.
  */
  it("does not issue a stale-callback waiver outside the resolved custom review lane", async () => {
    const outsideReviewLane = task("FN-OUTSIDE-REVIEW", {
      column: "custom-hold",
      autoMerge: true,
      workflowStepResults: [stepResult({
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        status: "pending",
        reviewKind: "code",
        startedAt: new Date(Date.now() - 16 * 60_000).toISOString(),
      })],
    });
    const store = storeFor([outsideReviewLane]);
    const issueStaleReviewCallbackWaiver = vi.fn();
    Object.assign(store, {
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["code-review"] })),
      issueStaleReviewCallbackWaiver,
    });
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    await manager.reconcileOrphanedPendingStepResults();

    expect(captureMergeContentDescriptorMock).toHaveBeenCalled();
    expect(issueStaleReviewCallbackWaiver).not.toHaveBeenCalled();
    expect((await store.getTask("FN-OUTSIDE-REVIEW"))?.workflowStepResults?.[0]?.status).toBe("failed");
  });

  /*
  FNXC:StaleReviewCallbackWaiver 2026-10-01-06:20 (upstream FN-9429 port):
  PostgreSQL receipt coverage proves transaction durability; these manager-path assertions prove the
  production sweep selects the exact stale attempt and delegates it — instead of failing the row and
  then reseeding it — for both stale shapes (`pending` and a verdict-less `failed` callback).
  */
  it.each(["pending", "failed"] as const)("routes an eligible stale %s code-review callback to one receipt issuance instead of failing or reseeding it", async (status) => {
    const startedAt = new Date(Date.now() - 16 * 60_000).toISOString();
    const candidate = task(`FN-WAIVE-${status}`, {
      autoMerge: true,
      enabledWorkflowSteps: ["code-review"],
      workflowStepResults: [stepResult({
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        reviewKind: "code",
        status,
        startedAt,
      })],
    });
    const store = storeFor([candidate]);
    const issueStaleReviewCallbackWaiver = vi.fn(async (id: string, issue: { workflowStepId: string; attemptId: string }) => {
      const current = await store.getTask(id);
      const prior = current!.workflowStepResults![0]!;
      const issuedAt = new Date().toISOString();
      const receipt = {
        id: `receipt-${status}`,
        projectId: "test-project",
        taskId: id,
        workflowStepId: issue.workflowStepId,
        attemptId: issue.attemptId,
        policyVersion: "fn-9429-v1" as const,
        actor: "system:stale-review-callback-waiver" as const,
        reason: "proven-stale-code-review-callback" as const,
        issuedAt,
        state: "issued" as const,
      };
      await store.updateTask(id, {
        workflowStepResults: [{
          ...prior,
          status: "skipped",
          completedAt: issuedAt,
          priorAttempts: [prior],
          automatedStaleCallbackWaiver: {
            receiptId: receipt.id,
            policyVersion: receipt.policyVersion,
            actor: receipt.actor,
            reason: receipt.reason,
            issuedAt,
            priorStatus: status,
            attemptId: issue.attemptId,
          },
        }],
      });
      return { applied: true as const, task: (await store.getTask(id))!, receipt };
    });
    Object.assign(store, {
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, autoMerge: true } as Settings)),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["code-review"] })),
      issueStaleReviewCallbackWaiver,
    });
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(1);
    expect(issueStaleReviewCallbackWaiver).toHaveBeenCalledTimes(1);
    expect(issueStaleReviewCallbackWaiver).toHaveBeenCalledWith(candidate.id, expect.objectContaining({
      workflowStepId: "code-review",
      expectedStatus: status,
      expectedStartedAt: startedAt,
    }));
    // The row is waived (skipped + receipt marker), not rewritten to failed, and the sweep's own
    // rewrite event is not emitted; the only audit row is the waiver receipt event.
    const waived = await store.getTask(candidate.id);
    expect(waived?.workflowStepResults?.[0]?.status).toBe("skipped");
    expect(waived?.workflowStepResults?.[0]?.automatedStaleCallbackWaiver?.receiptId).toBe(`receipt-${status}`);
    const audit = auditSink(store);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:stale-review-callback-waived",
      target: candidate.id,
      metadata: expect.objectContaining({
        taskId: candidate.id,
        workflowStepId: "code-review",
        receiptIssued: true,
        priorStatus: status,
        threshold: "15-minutes",
      }),
    }));
  });

  it("vetoes on every leg of the liveness triple: isTaskActive, registry path, executing lock", async () => {
    const viaCallback = task("FN-CB", { workflowStepResults: [stepResult({ status: "pending" })] });
    const viaRegistry = task("FN-REG", { workflowStepResults: [stepResult({ status: "pending" })] });
    const viaLock = task("FN-LOCK", { workflowStepResults: [stepResult({ status: "pending" })] });
    activeSessionRegistry.registerPath("/wt/registry-live", { taskId: "FN-REG", kind: "workflow-step", ownerKey: "test" });
    expect(executingTaskLock.tryClaim("FN-LOCK")).toBe(true);
    const store = storeFor([viaCallback, viaRegistry, viaLock]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      isTaskActive: (id: string) => id === "FN-CB",
    });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(0);
    for (const id of ["FN-CB", "FN-REG", "FN-LOCK"]) {
      expect((await store.getTask(id))?.workflowStepResults?.[0]?.status).toBe("pending");
    }
    expect(auditSink(store)).not.toHaveBeenCalled();
  });

  it("skips user-paused and in-progress rows, and tasks with no pending results", async () => {
    const userPaused = task("FN-PAUSED", {
      userPaused: true,
      paused: true,
      workflowStepResults: [stepResult({ status: "pending" })],
    });
    // Executor-owned: resumeOrphaned re-attaches its session on a deferred timer, so
    // startup liveness is unprovable — the sweep must never judge in-progress rows.
    const inProgress = task("FN-INPROG", {
      column: "in-progress",
      workflowStepResults: [stepResult({ status: "pending" })],
    });
    const complete = task("FN-DONE-STEPS", {
      workflowStepResults: [stepResult({ status: "passed" }), stepResult({ status: "failed" })],
    });
    const noResults = task("FN-NONE");
    const store = storeFor([userPaused, inProgress, complete, noResults]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(0);
    expect((await store.getTask("FN-PAUSED"))?.workflowStepResults?.[0]?.status).toBe("pending");
    expect((await store.getTask("FN-INPROG"))?.workflowStepResults?.[0]?.status).toBe("pending");
    expect((await store.getTask("FN-DONE-STEPS"))?.workflowStepResults).toHaveLength(2);
    expect(auditSink(store)).not.toHaveBeenCalled();
  });

  it("paginates past 500 rows and recovers orphans on every page", async () => {
    const many = Array.from({ length: 502 }, (_, i) =>
      task(`FN-P${i}`, { workflowStepResults: [stepResult({ status: "pending" })] }));
    const store = storeFor(many);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(502);
    expect((await store.getTask("FN-P501"))?.workflowStepResults?.[0]?.status).toBe("failed");
    // Two pages of 500 + the short page signalling the end.
    expect((store.listTasks as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("isolates a per-task updateTask failure: the other orphan is still recovered and counted", async () => {
    const failing = task("FN-FAILS", { workflowStepResults: [stepResult({ status: "pending" })] });
    const healthy = task("FN-OK", { workflowStepResults: [stepResult({ status: "pending" })] });
    const store = storeFor([failing, healthy]);
    const passthrough = (store.updateTask as ReturnType<typeof vi.fn>).getMockImplementation()! as
      (id: string, patch: Partial<Task>) => Promise<Task>;
    (store.updateTask as ReturnType<typeof vi.fn>).mockImplementation(async (id: string, patch: Partial<Task>) => {
      if (id === "FN-FAILS") throw new Error("write refused");
      return passthrough(id, patch);
    });
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(1);
    expect((await store.getTask("FN-OK"))?.workflowStepResults?.[0]?.status).toBe("failed");
    const audit = auditSink(store);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ target: "FN-OK" }));
  });
});

/*
FNXC:WorkflowReviewGates 2026-07-26-16:05:
The pre-merge review gates now run with the card in `in-review`, so this sweep judges them where it
previously skipped them (it skips `in-progress` rows outright). Because it also runs from PERIODIC
maintenance — in the same live process as an active graph run — a tick landing between the gate's
`pending` lease write and its session-registry registration could stamp a genuinely running gate as
`failed`, closing the merge gate on a healthy task. A within-floor lease (`leaseOwner` + recent
`startedAt`) therefore counts as live, matching the semantics Plan Review already had via
`classifyReviewLease`.

The second case is the one that keeps FN-8492 intact: this must DELAY cleanup by the staleness
floor, not defeat it. A lease past the floor is still rewritten to `failed`.
*/
describe("review-gate lease liveness (in-review gates)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => executingTaskLock._clearForTest());

  const leaseResult = (startedAt: string) => stepResult({
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    status: "pending",
    leaseOwner: "run-abc",
    startedAt,
  });

  it("leaves a code-review gate alone while its lease is still within the staleness floor", async () => {
    const live = task("FN-LEASE-LIVE", {
      workflowStepResults: [leaseResult(new Date(Date.now() - 60_000).toISOString())],
    });
    const store = storeFor([live]);
    const manager = new SelfHealingManager(store, "/repo", {} as never);

    const recovered = await manager.reconcileOrphanedPendingStepResults();

    expect(recovered).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    const after = await store.getTask("FN-LEASE-LIVE");
    expect(after?.workflowStepResults?.[0]?.status).toBe("pending");
  });

  it("still fails a code-review gate whose lease has aged past the floor (FN-8492 preserved)", async () => {
    const stale = task("FN-LEASE-STALE", {
      workflowStepResults: [leaseResult(new Date(Date.now() - 60 * 60_000).toISOString())],
    });
    const store = storeFor([stale]);
    const manager = new SelfHealingManager(store, "/repo", {} as never);

    const recovered = await manager.reconcileOrphanedPendingStepResults();

    expect(recovered).toBe(1);
    const after = await store.getTask("FN-LEASE-STALE");
    expect(after?.workflowStepResults?.[0]?.status).toBe("failed");
  });

  it("still fails an ownerless pending result — no leaseOwner means no lease to honor", async () => {
    const ownerless = task("FN-NO-OWNER", {
      workflowStepResults: [stepResult({
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        status: "pending",
        startedAt: new Date().toISOString(),
      })],
    });
    const store = storeFor([ownerless]);
    const manager = new SelfHealingManager(store, "/repo", {} as never);

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(1);
    const after = await store.getTask("FN-NO-OWNER");
    expect(after?.workflowStepResults?.[0]?.status).toBe("failed");
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-17:40:
  THE EXECUTOR-OWNED SKIP IS A WIP-ROLE QUESTION, and it was asked with the id `in-progress`.

  On a board whose execution lane is named anything else, the skip never fired: this sweep reached a
  card an executor is actively running and rewrote its `pending` step results to `failed` — the one
  thing the header above says it must never do. The liveness triple does not save it either, because
  those legs prove an in-process session, and an executor on another node or between session handles
  is exactly the case the column skip exists to cover.

  Every other test in this file uses `in-review`/`in-progress`, where the literal is correct — which
  is why 204 self-healing tests passed with this conversion reverted.
  */
  const RENAMED_WIP_IR = {
    version: "v2", id: "custom:renamed", nodes: [], edges: [],
    columns: [
      { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "checking", name: "checking", traits: [{ trait: "merge" }] },
    ],
  };

  it("skips an executor-owned card resting in a RENAMED wip lane", async () => {
    const executing = task("FN-WIP", {
      column: "building",
      workflowStepResults: [stepResult({ status: "pending", workflowStepId: "code-review", workflowStepName: "Code Review" })],
    });
    const store = storeFor([executing]);
    (store as unknown as { listWorkflowDefinitions: unknown }).listWorkflowDefinitions =
      vi.fn(async () => [{ ir: RENAMED_WIP_IR }]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(0);
    /* The executor's lease is untouched. */
    expect((await store.getTask("FN-WIP"))?.workflowStepResults?.[0]?.status).toBe("pending");
    expect(auditSink(store)).not.toHaveBeenCalled();
  });

  it("still recovers a genuine orphan on that same renamed board", async () => {
    /* The skip must narrow, not disable: a card in the REVIEW lane is not executor-owned. */
    const stranded = task("FN-REV", {
      column: "checking",
      workflowStepResults: [stepResult({ status: "pending", workflowStepId: "code-review", workflowStepName: "Code Review" })],
    });
    const store = storeFor([stranded]);
    (store as unknown as { listWorkflowDefinitions: unknown }).listWorkflowDefinitions =
      vi.fn(async () => [{ ir: RENAMED_WIP_IR }]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(1);
    expect((await store.getTask("FN-REV"))?.workflowStepResults?.[0]?.status).toBe("failed");
  });
});
