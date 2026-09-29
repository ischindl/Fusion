import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isUncommittedWorkHold,
  type Task,
  type TaskStore,
} from "@fusion/core";

/*
FNXC:ZeroCommitDeliveryProof 2026-09-29-17:52 (RUFU-274, review finding 06a43111):
A review of the RUFU-274 tests found that the queue-drain coverage re-implemented the pump's counter inline
instead of driving it, so the assertions could not fail when a pump change broke the refusal. This file drives
the REAL seams instead: the production `ProjectEngine.drainMergeQueue` pump over two consecutive ticks, with
only the merge body (`runAiMerge`) faked, and the durable refusal written by the production
`applyZeroCommitUncommittedWorkHold` writer.

The contract under test is the interlock between two halves that live in different files:
  1. the guard writes `mergeDetails.uncommittedWorkHold` AND forces `mergeConfirmed: false`, and
  2. admission refuses any row whose `getTaskMergeBlocker` answer is the hold.
Either half alone is inert. `canMergeTask` returns TRUE for a `mergeConfirmed` row ABOVE its blocker check
(the fast-path finalizer's own contract), and the FN-5627 reachability fast path in the drain never asks the
blocker either — so a refusal that left the flag standing would send the card straight to `done`, which is
exactly RUFU-262's shape. The two-tick case is what proves the pair: tick 2's refusal comes from the ROW,
with no in-memory marker left anywhere in the process.

A control case (no hold anywhere → the pump DOES dispatch the merge body) keeps the refusal assertions
non-vacuous.
*/

const testState = vi.hoisted(() => ({
  currentStore: null as MockStore | null,
  runAiMerge: vi.fn(),
}));

vi.mock("../merger.js", () => ({
  sweepStaleAutostashes: vi.fn(async () => undefined),
  VerificationError: class extends Error {},
}));

// Only the merge BODY is faked; the real error classes stay real so the pump's instanceof guards evaluate.
vi.mock("../merge/merger-ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../merge/merger-ai.js")>();
  return { ...actual, runAiMerge: testState.runAiMerge };
});

vi.mock("../runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      getTaskStore: () => testState.currentStore,
      getAgentStore: vi.fn(),
      getMessageStore: vi.fn(),
      getRoutineStore: vi.fn(),
      getRoutineRunner: vi.fn(),
      getHeartbeatMonitor: vi.fn(),
      getTriggerScheduler: vi.fn(),
      configurePrMonitoring: vi.fn(),
      setActiveMergeTaskIdProvider: vi.fn(),
      setActiveMergeStartedAtMsProvider: vi.fn(),
      setActiveMergeAborter: vi.fn(),
      setMergeEnqueuer: vi.fn(),
      setMergeActiveClearer: vi.fn(),
      setMergePendingProvider: vi.fn(),
      setMergeRequester: vi.fn(),
      resumeAfterUnpause: vi.fn(async () => undefined),
      getPluginRunner: vi.fn(() => undefined),
    };
  }),
}));

import { ProjectEngine } from "../project-engine.js";
import { runAiMerge } from "../merge/merger-ai.js";
import { applyZeroCommitUncommittedWorkHold } from "../merge/zero-commit-finalization-guard.js";
import { runtimeLog } from "../logger.js";

const TASK_ID = "RUFU-274";

type MockStore = {
  getSettings: ReturnType<typeof vi.fn>;
  listTasks: ReturnType<typeof vi.fn>;
  getTask: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
  moveTask: ReturnType<typeof vi.fn>;
  logEntry: ReturnType<typeof vi.fn>;
  upsertMergeRequestRecord: ReturnType<typeof vi.fn>;
  appendAgentLog: ReturnType<typeof vi.fn>;
  addTaskComment: ReturnType<typeof vi.fn>;
  getActiveMergingTask: ReturnType<typeof vi.fn>;
  recordRunAuditEvent: ReturnType<typeof vi.fn>;
  getRootDir: () => string;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  __row: () => Record<string, unknown>;
};

/**
 * RUFU-262's row shape: review passed, the branch carries ZERO commits ahead of base, and the checkout
 * still holds the work. `mergeDetails` is deliberately not pre-confirmed — the card is queued for a merge
 * that the merge lane will discover it cannot land. A `mergeConfirmed: true` row never reaches this
 * admission at all (it takes the finalizer fast path), so asserting the refusal from that shape would be
 * vacuous; the flag's revocation is what tick 2 of the two-tick case checks.
 */
function mergeCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TASK_ID,
    title: "Zero-commit card whose work exists only as uncommitted files",
    column: "in-review",
    status: "review-pending",
    error: null,
    paused: false,
    mergeRetries: 0,
    branch: `fusion/${TASK_ID.toLowerCase()}`,
    worktree: `/worktrees/${TASK_ID.toLowerCase()}`,
    // `steps` must be an ARRAY: canMergeTask/resolveMergeGateBlocker return early for a non-array and never
    // ask getTaskMergeBlocker, which would make every hold assertion here vacuous.
    steps: [],
    enabledWorkflowSteps: [],
    mergeDetails: { mergeTargetBranch: "main", mergeSourceBranch: `fusion/${TASK_ID.toLowerCase()}` },
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
    log: [],
    ...overrides,
  };
}

function createStore(initialRow: Record<string, unknown>): MockStore {
  let row = { ...initialRow };
  const store: MockStore = {
    getSettings: vi.fn(async () => ({
      autoMerge: true,
      globalPause: false,
      enginePaused: false,
      baseBranch: "main",
      pollIntervalMs: 15_000,
    })),
    listTasks: vi.fn(async () => [row]),
    getTask: vi.fn(async () => row),
    // The real store REPLACES mergeDetails on an update, which is what lets the guard's forced
    // `mergeConfirmed: false` and a later clear be visible to the next admission pass.
    updateTask: vi.fn(async (_id: string, updates: Record<string, unknown>) => {
      row = { ...row, ...updates };
      return row;
    }),
    moveTask: vi.fn(async (_id: string, column: string) => {
      row = { ...row, column };
      return row;
    }),
    logEntry: vi.fn(async () => undefined),
    upsertMergeRequestRecord: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    addTaskComment: vi.fn(async () => undefined),
    getActiveMergingTask: vi.fn(() => null),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getRootDir: () => "/tmp/proj_test",
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    __row: () => row,
  };
  return store;
}

function createEngine(store: MockStore): ProjectEngine {
  testState.currentStore = store;
  return new ProjectEngine(
    {
      projectId: "proj_test",
      workingDirectory: "/tmp/proj_test",
      isolationMode: "in-process",
      maxConcurrent: 1,
      maxWorktrees: 1,
    } as never,
    {} as never,
    { skipNotifier: true },
  );
}

/** One pump tick, driven exactly the way the single-flight wake drives it. */
async function drainOnce(engine: ProjectEngine): Promise<void> {
  const privateEngine = engine as unknown as {
    mergeQueue: string[];
    mergeActive: Set<string>;
    drainMergeQueue: () => Promise<void>;
  };
  privateEngine.mergeActive.add(TASK_ID);
  privateEngine.mergeQueue.push(TASK_ID);
  await privateEngine.drainMergeQueue();
}

/** The production refusal write, with RUFU-262's evidence counts. */
async function writeRealHold(store: MockStore): Promise<void> {
  await applyZeroCommitUncommittedWorkHold({
    store: store as unknown as TaskStore,
    task: store.__row() as unknown as Task,
    source: "merge-ai-empty-lane",
    code: "uncommitted-work",
    refusal: "2 uncommitted change(s) survive in the worktree and a merge would drop them.",
    uncommittedPaths: ["tracked.txt", "brand-new.ts"],
    contentState: "deliverable",
    modifiedCount: 1,
    untrackedCount: 1,
    contentBasis: "clean",
    aheadCommitCount: 0,
  });
}

describe("merge-queue pump refuses a zero-commit card whose delivery is unproven", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runAiMerge).mockReset();
    testState.currentStore = null;
    vi.spyOn(runtimeLog, "log").mockImplementation(() => undefined);
    vi.spyOn(runtimeLog, "warn").mockImplementation(() => undefined);
    vi.spyOn(runtimeLog, "error").mockImplementation(() => undefined);
  });

  /*
  CONTROL. Same fixture, no refusal anywhere: the pump must reach the merge body. Without this green case
  the two hold cases below could be satisfied by a fixture the pump never admits at all.
  */
  it("dispatches the merge body for an otherwise identical card that is not held", async () => {
    const store = createStore(mergeCandidate());
    vi.mocked(runAiMerge).mockResolvedValue({
      merged: true,
      noOp: false,
      ok: true,
      branch: "fusion/rufu-274",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    });

    await drainOnce(createEngine(store));

    expect(runAiMerge).toHaveBeenCalledTimes(1);
    expect(store.moveTask).not.toHaveBeenCalledWith(TASK_ID, "failed", expect.anything());
  });

  it("holds the refusal across two consecutive drain ticks without burning retries or failing the card", async () => {
    const store = createStore(mergeCandidate());
    // Tick 1: the merge body comes back with nothing landed and stamps the DURABLE hold, exactly as
    // enforceZeroCommitLandingProof does before the lane returns `deliveryUnproven`.
    vi.mocked(runAiMerge).mockImplementation(async () => {
      await writeRealHold(store);
      const marker = (store.__row().mergeDetails as Record<string, unknown>).uncommittedWorkHold;
      return { merged: false, noOp: false, ok: false, deliveryUnproven: marker };
    });

    const engine = createEngine(store);
    await drainOnce(engine);

    expect(runAiMerge).toHaveBeenCalledTimes(1);
    let row = store.__row();
    expect(isUncommittedWorkHold(row.mergeDetails as Task["mergeDetails"])).toBe(true);
    // The claim is revoked with the refusal — this is the field that re-arms the admission fast path.
    expect((row.mergeDetails as Record<string, unknown>).mergeConfirmed).toBe(false);
    // The shipped row hold: the pause pair plus the machine-prefixed sentence, so an operator can classify
    // the card without opening History. `error` carries the refusal; `status` deliberately stays out of it.
    expect(row.paused).toBe(true);
    expect(row.pausedReason).toBe("manual-hold");
    expect(String(row.error)).toMatch(/^DELIVERY_UNPROVEN:/);
    // A delivery wait is neither a merge nor a merge failure: no done move, no failure status, no retry burn.
    expect(row.column).toBe("in-review");
    expect(row.status).toBe("review-pending");
    expect(row.mergeRetries).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalledWith(TASK_ID, expect.objectContaining({ status: expect.anything() }));
    expect(store.moveTask).not.toHaveBeenCalledWith(TASK_ID, "done", expect.anything());
    expect(store.moveTask).not.toHaveBeenCalledWith(TASK_ID, "failed", expect.anything());
    // The remedy lives on the worktree, so every delivery pointer must survive the refusal.
    expect(row.worktree).toBe("/worktrees/rufu-274");
    expect(row.branch).toBe("fusion/rufu-274");
    // The queue half of the hold is filed alongside the row half.
    expect(store.upsertMergeRequestRecord).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ state: "manual-required" }),
    );

    // Tick 2: a fresh enqueue of the same card. Nothing about the refusal is fixed by retrying the same
    // branch, so the pump must refuse at ADMISSION from the row alone — the in-memory result of tick 1 is
    // out of scope here, which is what makes this a cross-process-shaped claim.
    await drainOnce(engine);

    expect(runAiMerge).toHaveBeenCalledTimes(1);
    row = store.__row();
    expect(isUncommittedWorkHold(row.mergeDetails as Task["mergeDetails"])).toBe(true);
    expect(row.column).toBe("in-review");
    expect(row.mergeRetries).toBe(0);
    expect(row.status).toBe("review-pending");
    expect(row.worktree).toBe("/worktrees/rufu-274");
  });

  /*
  The shipped hold pairs its marker with `paused: true`, and the pump skips a paused card earlier than
  admission (`task.paused && !mergeConfirmed`). That pair is the operator-visible half, but it is NOT the
  authority: a card whose pause is lifted — an operator unpausing it to look at the card, which releases no
  landing-proof hold — must still be refused by the marker alone. This fixture is that reachable shape, and
  it is the case that fails when the hold arm is removed from getTaskMergeBlocker.
  */
  it("refuses on the marker alone once the paired pause is gone, so the pause is not the authority", async () => {
    const markerOnly = createStore(mergeCandidate({
      paused: false,
      error: null,
      mergeDetails: {
        mergeConfirmed: false,
        mergeTargetBranch: "main",
        uncommittedWorkHold: {
          at: "2026-09-29T00:00:00.000Z",
          code: "uncommitted-work",
          source: "merge-ai-empty-lane",
          reason: "2 uncommitted change(s) survive in the worktree and a merge would drop them.",
          pathCount: 2,
          paths: ["tracked.txt", "brand-new.ts"],
          contentState: "deliverable",
          modifiedCount: 1,
          untrackedCount: 1,
          aheadCommitCount: 0,
        },
      },
    }));

    await drainOnce(createEngine(markerOnly));

    expect(runAiMerge).not.toHaveBeenCalled();
    expect(markerOnly.updateTask).not.toHaveBeenCalled();
    const row = markerOnly.__row();
    expect(isUncommittedWorkHold(row.mergeDetails as Task["mergeDetails"])).toBe(true);
    expect(row.column).toBe("in-review");
    expect(row.mergeRetries).toBe(0);
    expect(row.status).toBe("review-pending");
  });

  it("refuses a card that arrives holding in the shipped paused shape, so a restart cannot re-merge it", async () => {
    // A brand-new engine = a new process. The only carry-over is the row the earlier refusal wrote.
    const held = createStore(mergeCandidate({
      paused: true,
      pausedReason: "manual-hold",
      pausedReasonSource: "zero-commit-landing-proof:merge-ai-empty-lane",
      error: "DELIVERY_UNPROVEN: 2 uncommitted change(s) survive in the worktree and a merge would drop them.",
      mergeDetails: {
        mergeConfirmed: false,
        mergeTargetBranch: "main",
        uncommittedWorkHold: {
          at: "2026-09-29T00:00:00.000Z",
          code: "uncommitted-work",
          source: "merge-ai-empty-lane",
          reason: "2 uncommitted change(s) survive in the worktree and a merge would drop them.",
          pathCount: 2,
          paths: ["tracked.txt", "brand-new.ts"],
          contentState: "deliverable",
          modifiedCount: 1,
          untrackedCount: 1,
          aheadCommitCount: 0,
        },
      },
    }));

    await drainOnce(createEngine(held));

    expect(runAiMerge).not.toHaveBeenCalled();
    expect(held.updateTask).not.toHaveBeenCalled();
    const row = held.__row();
    expect(isUncommittedWorkHold(row.mergeDetails as Task["mergeDetails"])).toBe(true);
    expect(row.column).toBe("in-review");
    expect(row.mergeRetries).toBe(0);
    expect(row.status).toBe("review-pending");
  });
});
