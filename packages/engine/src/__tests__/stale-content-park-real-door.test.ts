import { describe, expect, it, vi, beforeEach } from "vitest";

/*
FNXC:StaleContentParkRecovery 2026-10-09-20:04 (RUFU-343):
This file exists because the class RUFU-343 repairs was invisible to an existing green suite.
`stale-content-park-recovery.test.ts` mocks `getTaskMergeBlocker` and stubs
`rerouteSingularStaleContentToReview`, so the assertion "recovery cleared the park" was proven
against a door the production lane never called. That is precisely how a card could sit parked
forever while every test in the lane stayed green: the bare `task.paused` veto lived INSIDE the
door's answer ("task is paused"), and a mocked door never had to produce that answer.

So nothing here mocks the door and nothing here stubs the seed. The only seams are the ones that
read the outside world: merge-content capture (git), the workflow-IR / review-lane / pre-merge-gate
resolution (store reads the sweep performs per candidate), and the continuation-seed write itself.
`getTaskMergeBlocker`, `evaluatePreMergeApprovals`, `classifyStaleContentPark`, and
`rerouteSingularStaleContentToReview` all run for real on fixture-shaped rows.
*/
const seam = vi.hoisted(() => ({
  capture: vi.fn(),
  resolveColumns: vi.fn(),
  resolveIr: vi.fn(),
  resolveIrWithProvenance: vi.fn(),
  resolveGate: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  resolveProjectColumnsForRoles: seam.resolveColumns,
  resolveWorkflowIrForTask: seam.resolveIr,
  resolveWorkflowIrForTaskWithProvenance: seam.resolveIrWithProvenance,
  resolvePreMergeGateForTask: seam.resolveGate,
}));
vi.mock("../merge/merge-content-capture.js", () => ({ captureMergeContentDescriptor: seam.capture }));

import {
  getTaskMergeBlocker,
  STALE_CONTENT_APPROVAL_BLOCKER,
  IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
  type Task,
} from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

/** The fingerprint the live merge door recomputes for the branch to be merged. */
const LIVE_FINGERPRINT = "git-diff-tip-current";
/** What an earlier review recorded, i.e. content that is no longer the tip. */
const STALE_FINGERPRINT = "git-diff-tip-older";

const staleParkError = (code = "completed-review-status-none") =>
  `In-review stall deadlock: ${code} — 4 identical in-review stall observations in one unchanged episode (stall observations, not merge attempts). Cannot merge RUFU-301: ${STALE_CONTENT_APPROVAL_BLOCKER}`;

function approvedCodeReviewRow(reviewInputFingerprint: string) {
  return {
    phase: "pre-merge",
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    status: "passed",
    verdict: "APPROVE",
    reviewKind: "code",
    reviewInputFingerprint,
    startedAt: "2026-10-04T00:00:00.000Z",
    completedAt: "2026-10-04T00:05:00.000Z",
  };
}

/** RUFU-301's measured shape: parked by the watchdog over a stale-content refusal. */
function parkedTask(overrides: Record<string, unknown> = {}): Task {
  return {
    id: "RUFU-301",
    column: "in-review",
    status: "failed",
    error: staleParkError(),
    paused: true,
    pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
    autoMerge: true,
    steps: [],
    worktree: "/tmp/rufu-301",
    branch: "fusion/rufu-301",
    mergeRetries: 2,
    workflowStepResults: [approvedCodeReviewRow(STALE_FINGERPRINT)],
    ...overrides,
  } as Task;
}

function createDoorStore(task: Task, seedResult = { seeded: true }) {
  const store = {
    getSettings: vi.fn().mockResolvedValue({ autoMerge: true, globalPause: false, enginePaused: false }),
    listTasks: vi.fn().mockResolvedValue([task]),
    getTask: vi.fn(async () => task),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (live: Task) => Record<string, unknown> | null) => {
      const patch = updater(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "wf-door", stepIds: ["code-review"] })),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    /*
    FNXC:ReviewAdmissionOwnership 2026-11-05-10:35 (RUFU-448 fixture drift):
    The recovery's admission gate stands down while the merge queue owns the card, so it reads the queue
    before touching the row. This fake declared no queue at all, the read threw, and the lane bailed with
    zero writes — the fixture silently kept the shape of a pre-RUFU-448 world. An empty queue is the
    intent this fixture always had: nobody else owns the card, the recovery may run.
    */
    peekMergeQueue: vi.fn(async () => []),
    /*
    FNXC:ReviewAdmissionOwnership 2026-11-05-10:35 (same drift, second missing surface):
    The maintenance batch builds `new EpochedWorkflowIrCache(() => store.workflowDefinitionEpoch())`, so a
    reduced fake without this method rejects the whole recovery pass (`is not a function`), not just the
    cache. Epoch 0 is the same value the sibling self-healing fakes state.
    */
    workflowDefinitionEpoch: vi.fn(() => 0),
    seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async () => seedResult),
  };
  return store as any;
}

const doorOptions = {
  reviewColumns: new Set(["in-review"]),
  requiredPreMergeStepIds: new Set(["code-review"]),
  mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: LIVE_FINGERPRINT } } as any,
};

beforeEach(() => {
  seam.resolveColumns.mockResolvedValue(new Set(["in-review"]));
  seam.resolveIr.mockResolvedValue(seamIr());
  seam.resolveIrWithProvenance.mockResolvedValue({ source: "task", ir: seamIr() });
  seam.resolveGate.mockResolvedValue({
    provenance: "task",
    selectionAbsent: false,
    requiredPreMergeStepIds: new Set(["code-review"]),
  });
  seam.capture.mockResolvedValue({ kind: "singular", diff: { state: "fingerprint", fingerprint: LIVE_FINGERPRINT } });
});

function seamIr() {
  return {
    name: "door-fixture",
    nodes: [{ id: "code-review", kind: "step-review", column: "in-review", config: { reviewKind: "code", defaultOn: true } }],
    edges: [],
  } as any;
}

describe("stale-content park recovery against the real merge door", () => {
  it("the raw door still refuses the parked card, which is why recovery needs its own view", () => {
    const task = parkedTask();

    const answer = getTaskMergeBlocker(task as any, doorOptions);
    expect(answer).toBe("task is paused");
    // The door cannot see the class the recovery is named for: the pause arm answers first, so the
    // stale-content sentence the park itself carries never reaches the caller. That tautology is what
    // made every consumer report progress forever.
    expect(answer).not.toContain(STALE_CONTENT_APPROVAL_BLOCKER);
  });

  it("seeds review and releases the engine's own stall park when the real door names stale content", async () => {
    const task = parkedTask();
    const store = createDoorStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.recoverMergeableReviewTasks();

    // The real seed lane ran for real under the engine's own park.
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id, nodeId: "code-review" }),
    );
    expect(task).toMatchObject({
      status: null,
      error: null,
      paused: false,
      pausedReason: null,
      mergeRetries: 0,
    });
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:merge-stale-content-review-rerouted",
      metadata: expect.objectContaining({
        source: "self-healing",
        reason: "seeded",
        workflowStepId: "code-review",
        parkShape: "stall-deadlock",
        parkCleared: true,
        mergeRetriesReset: true,
      }),
    }));
    manager.stop();
  });

  it("releases by writing the release, not by leaking the recovery's stripped door view", async () => {
    /*
    FNXC:StaleContentParkRecovery 2026-10-09-22:41 (RUFU-343):
    The park-stripped view (`{ ...task, status: undefined, paused: false }`) is a local value object
    handed to the door by this one lane; it must never reach the store, or every other consumer
    (`project-engine.canMergeTask` resolves the same door answer) would see merge eligibility the
    operator's card does not have. Asserted by snapshotting the live row at every `updateTaskAtomic`
    call: the only write this lane makes arrives while the row is still the parked row, and after it
    the real door finally names the class the park had been hiding.
    */
    const task = parkedTask();
    const store = createDoorStore(task);
    const innerWrite = store.updateTaskAtomic.getMockImplementation()!;
    const liveAtWrite: Array<{ paused: unknown; status: unknown }> = [];
    store.updateTaskAtomic.mockImplementation(async (id: string, updater: any) => {
      liveAtWrite.push({ paused: task.paused, status: task.status });
      return (innerWrite as any)(id, updater);
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.recoverMergeableReviewTasks();

    // Every write this lane made arrived while the row was still the parked row: the recovery never
    // persisted its stripped view ahead of the release.
    expect(liveAtWrite).toEqual([{ paused: true, status: "failed" }]);
    // And the release is what re-opened the door — the real door now sees the stale-content class
    // the pause arm had been masking for every consumer.
    const after = getTaskMergeBlocker(task as any, doorOptions);
    expect(after).not.toBe("task is paused");
    expect(after).toContain(STALE_CONTENT_APPROVAL_BLOCKER);
    manager.stop();
  });

  it("releases a disproven park without burning a review cycle when the real door finds nothing", async () => {
    // RUFU-301's actual artifact: the approval fingerprint equals the freshly recomputed one,
    // so the parked sentence names a blocker the door no longer finds.
    const task = parkedTask({ workflowStepResults: [approvedCodeReviewRow(LIVE_FINGERPRINT)] });
    const store = createDoorStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.recoverMergeableReviewTasks();

    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(task).toMatchObject({ status: null, error: null, paused: false, pausedReason: null, mergeRetries: 0 });
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:merge-stale-content-review-rerouted",
      metadata: expect.objectContaining({
        reason: "park-release",
        parkShape: "stall-deadlock",
        parkCleared: true,
        mergeRetriesReset: true,
      }),
    }));
    manager.stop();
  });

  it("refuses to touch the park when the door is closed for a reason that is not stale content", async () => {
    // Same park sentence, but the live row says the gate REVISEd: the remediation lane owns it.
    const task = parkedTask({
      workflowStepResults: [{
        ...approvedCodeReviewRow(STALE_FINGERPRINT),
        status: "failed",
        verdict: "REVISE",
        reviewInputFingerprint: LIVE_FINGERPRINT,
      }],
    });
    const store = createDoorStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.recoverMergeableReviewTasks();

    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:merge-stale-content-review-rerouted",
    }));
    expect(task).toMatchObject({ status: "failed", paused: true, pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON });
    manager.stop();
  });

  it("leaves an operator hand pause alone even when the door would name stale content", async () => {
    const task = parkedTask({ pausedReason: "manual-hold" });
    const store = createDoorStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.recoverMergeableReviewTasks();

    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(task).toMatchObject({ status: "failed", paused: true, pausedReason: "manual-hold" });
    manager.stop();
  });
});
