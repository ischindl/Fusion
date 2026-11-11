import { describe, expect, it, vi, beforeEach } from "vitest";

const recovery = vi.hoisted(() => ({
  capture: vi.fn(),
  reroute: vi.fn(),
  resolveColumns: vi.fn(),
  resolveWorkflow: vi.fn(),
  resolveGate: vi.fn(),
  blocker: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  resolveProjectColumnsForRoles: recovery.resolveColumns,
  resolveWorkflowIrForTaskWithProvenance: recovery.resolveWorkflow,
  resolvePreMergeGateForTask: recovery.resolveGate,
  getTaskMergeBlocker: recovery.blocker,
}));
vi.mock("../merge/merge-content-capture.js", () => ({ captureMergeContentDescriptor: recovery.capture }));
vi.mock("../merge/stale-content-review-reroute.js", () => ({ rerouteSingularStaleContentToReview: recovery.reroute }));

import { STALE_CONTENT_APPROVAL_BLOCKER, IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON, type Task } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { AUTO_MERGE_RETRY_REJECTED_PREFIX, classifyStaleContentPark } from "../merge/stale-content-park.js";

const blocker = `Cannot merge FN-1: ${STALE_CONTENT_APPROVAL_BLOCKER}`;

beforeEach(() => {
  recovery.resolveColumns.mockResolvedValue(new Set(["in-review"]));
  recovery.resolveWorkflow.mockResolvedValue({
    source: "task",
    ir: { nodes: [{ id: "security-review", kind: "step-review", column: "in-review", config: { reviewKind: "code" } }] },
  });
  recovery.resolveGate.mockResolvedValue({ provenance: "task", selectionAbsent: false, requiredPreMergeStepIds: new Set(["security-review"]) });
  recovery.blocker.mockReturnValue(STALE_CONTENT_APPROVAL_BLOCKER);
  recovery.capture.mockResolvedValue({ kind: "singular", diff: { state: "fingerprint", fingerprint: "current" } });
  recovery.reroute.mockResolvedValue({ rerouted: true, reason: "seeded", nodeId: "security-review", workflowStepId: "security-review" });
});

function createRecoveryStore(task: Task, raceRefusesClear = false) {
  const store = {
    getSettings: vi.fn().mockResolvedValue({ autoMerge: true, globalPause: false, enginePaused: false }),
    listTasks: vi.fn().mockResolvedValue([task]),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (live: Task) => Partial<Task> | null) => {
      const live = raceRefusesClear ? { ...task, paused: true } : task;
      const patch = updater(live);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    /*
    FNXC:WorkflowPassCacheFixture 2026-11-02-03:45 (RUFU-318):
    RUFU-584 (`58d561b1c1`) made `SelfHealingManager.batchWorkflowIrCache()` read `store.workflowDefinitionEpoch()`
    unconditionally, so this fake's missing method threw on the sweep's first cache read and the outer catch
    reduced the whole pass to a `log.warn` — all four hidden-arm cases here were green-looking no-ops on a sweep
    that never ran. A constant epoch is the honest fake: no case writes a workflow definition or selection
    mid-pass (the workflow resolution is mocked outright), so cache invalidation is never the subject.
    */
    workflowDefinitionEpoch: vi.fn(() => 0),
    workflowSelectionEpoch: vi.fn(() => 0),
  };
  return store as any;
}

function hiddenTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1", column: "in-review", status: "failed", error: blocker, autoMerge: true,
    worktree: "/tmp/fn-1", workflowStepResults: [], ...overrides,
  } as Task;
}

describe("classifyStaleContentPark", () => {
  it("recognizes every stale-content terminal shape", () => {
    expect(classifyStaleContentPark({ status: "failed", error: `${AUTO_MERGE_RETRY_REJECTED_PREFIX} ${blocker}` })).toBe("retry-rejected");
    expect(classifyStaleContentPark({ status: "failed", error: blocker })).toBe("raw-blocker");
    expect(classifyStaleContentPark({ status: null, error: blocker })).toBe("retry-exhausted");
    /*
    FNXC:StaleContentParkAdmission 2026-10-09-20:04 (RUFU-343): the engine's own stall park is a
    terminal shape of its own, and its wrapped retry marker must not be read as the shape.
    */
    expect(classifyStaleContentPark({
      status: "failed",
      error: `In-review stall deadlock: merge-blocker — 4 identical in-review stall observations in one unchanged episode (stall observations, not merge attempts). ${AUTO_MERGE_RETRY_REJECTED_PREFIX} ${blocker}`,
      paused: true,
      pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
    })).toBe("stall-deadlock");
  });

  it("excludes unrelated, active, and operator-held cards", () => {
    expect(classifyStaleContentPark({ status: "failed", error: "AUTO_MERGE_RETRY_FAILED: nope" })).toBeUndefined();
    expect(classifyStaleContentPark({ status: "failed", error: "AUTO_MERGE_RETRY_REJECTED: Cannot merge FN-1: task is marked 'needs-replan'" })).toBeUndefined();
    expect(classifyStaleContentPark({ status: "merging", error: blocker })).toBeUndefined();
    // A bare pause carries no provenance, so it stays an operator veto (RUFU-343 admits ONLY the
    // named engine deadlock park — see stale-content-park-classification.test.ts for that matrix).
    expect(classifyStaleContentPark({ status: "failed", error: blocker, paused: true })).toBeUndefined();
    expect(classifyStaleContentPark({ status: "failed", error: blocker, userPaused: true })).toBeUndefined();
    expect(classifyStaleContentPark({ status: "failed", error: blocker, deletedAt: "2026-01-01" })).toBeUndefined();
    expect(classifyStaleContentPark({ status: "failed", error: undefined })).toBeUndefined();
    expect(classifyStaleContentPark({ status: "failed", error: 42 })).toBeUndefined();
  });
});

describe("hidden stale-content park recovery", () => {
  it.each([
    ["retry-rejected", { error: `${AUTO_MERGE_RETRY_REJECTED_PREFIX} ${blocker}`, status: "failed" }],
    ["raw-blocker", { error: blocker, status: "failed" }],
  ] as const)("seeds and truthfully audits the %s park", async (parkShape, patch) => {
    const task = hiddenTask(patch);
    const store = createRecoveryStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await expect(manager.recoverMergeableReviewTasks()).resolves.toBe(0);

    expect(recovery.reroute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: task.id }), expect.anything());
    expect(store.updateTaskAtomic).toHaveBeenCalledOnce();
    expect(task).toMatchObject({ status: null, error: null, mergeRetries: 0 });
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:merge-stale-content-review-rerouted",
      metadata: expect.objectContaining({ source: "self-healing", parkShape, parkCleared: true, mergeRetriesReset: true }),
    }));
    manager.stop();
  });

  it("audits a refused atomic clear without un-parking the card", async () => {
    const task = hiddenTask();
    const store = createRecoveryStore(task, true);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.recoverMergeableReviewTasks();

    expect(task).toMatchObject({ status: "failed", error: blocker });
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ parkShape: "raw-blocker", parkCleared: false, mergeRetriesReset: false }),
    }));
    manager.stop();
  });

  it("re-arms the bounded recovery budget after the hidden park disappears", async () => {
    const task = hiddenTask();
    const store = createRecoveryStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const attempts = (manager as any).staleContentParkRecoveryAttempts as Map<string, number>;
    const warned = (manager as any).staleContentParkRecoveryBudgetLogged as Set<string>;
    attempts.set(task.id, 3);
    warned.add(task.id);

    store.listTasks.mockResolvedValueOnce([]);
    await manager.recoverMergeableReviewTasks();
    expect(attempts.has(task.id)).toBe(false);
    expect(warned.has(task.id)).toBe(false);

    await manager.recoverMergeableReviewTasks();
    expect(recovery.reroute).toHaveBeenCalled();
    manager.stop();
  });
});

/*
FNXC:StaleContentParkAdmission 2026-10-09-21:16 (RUFU-343 remediation):
`staleContentParkReleasePatch` is the single fence every release of this lane passes, and its job is to
answer one question about the LIVE row: is the pause you are about to lift the one the engine authored
for itself? All three guards in this lane (classifier, seed-lane admission, this fence) now ask the
canonical `isEngineAuthoredInReviewStallPark`, so the fence is pinned directly — the route above can
only reach it through the classifier, which would hide which rule answered.
*/
describe("staleContentParkReleasePatch fence", () => {
  const deadlockError = `In-review stall deadlock: completed-review-status-none — 4 identical in-review stall observations in one unchanged episode (stall observations, not merge attempts). ${blocker}`;

  const fence = () => {
    const manager = new SelfHealingManager({} as any, { rootDir: "/tmp/test-project" });
    return (live: Task, shape: ReturnType<typeof classifyStaleContentPark>) => {
      const patch = (manager as any).staleContentParkReleasePatch(live, shape);
      manager.stop();
      return patch;
    };
  };

  it("clears the pause pair for the engine's own stall park", () => {
    const live = hiddenTask({
      status: "failed", error: deadlockError, paused: true,
      pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON, mergeRetries: 3,
    });
    expect(classifyStaleContentPark(live)).toBe("stall-deadlock");
    expect(fence()(live, "stall-deadlock")).toEqual({
      status: null, error: null, paused: false, pausedReason: null, mergeRetries: 0,
    });
  });

  it("keeps admitting a stall park an operator already un-parked, and releases only what it holds", () => {
    // The watchdog sentence is still on the row, but `paused` is gone, so the classifier reports the
    // merge terminal it can prove (raw-blocker) and the patch carries no pause pair. The fence therefore
    // cannot be written as the bare canonical predicate, which requires a card to be paused right now.
    const live = hiddenTask({ status: "failed", error: deadlockError, pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON });
    expect(classifyStaleContentPark(live)).toBe("raw-blocker");
    expect(fence()(live, "raw-blocker")).toEqual({ status: null, error: null, mergeRetries: 0 });
  });

  it("refuses a pause marker whose watchdog sentence a later terminal replaced", () => {
    // The stale-content claim is still true, so only provenance separates this row from the one above:
    // the newer failure's sentence is the operator's only view of it, and this lane must not null it.
    const live = hiddenTask({
      status: "failed", paused: true, pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
      error: `In-review merge deferred (retry 3/3): ${blocker}`,
    });
    expect(fence()(live, "stall-deadlock")).toBeNull();
    expect(fence()(live, "raw-blocker")).toBeNull();
  });

  it("refuses an operator hold and leaves an unpaused terminal's patch byte-identical", () => {
    expect(fence()(hiddenTask({ paused: true, pausedReason: "operator-pause" }), "raw-blocker")).toBeNull();
    expect(fence()(hiddenTask({ userPaused: true }), "raw-blocker")).toBeNull();
    expect(fence()(hiddenTask({ deletedAt: new Date().toISOString() }), "raw-blocker")).toBeNull();
    expect(fence()(hiddenTask(), "raw-blocker")).toEqual({ status: null, error: null, mergeRetries: 0 });
  });
});
