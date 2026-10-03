import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  existsSyncMock,
  rmdirSyncMock,
  removeWorktreeMock,
  describeRegisteredWorktreesMock,
  ActiveSessionWorktreeRemovalErrorMock,
} = vi.hoisted(() => {
  class ActiveSessionWorktreeRemovalErrorMock extends Error {
    constructor() {
      super("cannot remove active-session worktree");
      this.name = "ActiveSessionWorktreeRemovalError";
    }
  }
  return {
    existsSyncMock: vi.fn(),
    rmdirSyncMock: vi.fn(),
    removeWorktreeMock: vi.fn(),
    describeRegisteredWorktreesMock: vi.fn(),
    ActiveSessionWorktreeRemovalErrorMock,
  };
});

vi.mock("node:fs", () => ({ existsSync: existsSyncMock, rmdirSync: rmdirSyncMock }));
vi.mock("../worktree/worktree-backend.js", () => ({
  ActiveSessionWorktreeRemovalError: ActiveSessionWorktreeRemovalErrorMock,
  RemovalReason: { CompletionLandedCleanup: "completion-landed-cleanup" },
  removeWorktree: removeWorktreeMock,
}));
/*
FNXC:TempWorktreeSweep 2026-10-02-19:55 (RUFU-290):
RUFU-290 added a descendant-registration leg to this lane, and that leg reads `git worktree list
--porcelain` through `describeRegisteredWorktrees`. Only that one export is replaced, so the real
containment, deepest-first ordering, and veto logic under test still run while no git process is
spawned against this file's fixture cwd (`/repo`, which does not exist). Every other export — notably
`canonicalizePath`, which the lane uses for its own path identity — stays the real implementation.
*/
vi.mock("../worktree/worktree-pool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../worktree/worktree-pool.js")>()),
  describeRegisteredWorktrees: describeRegisteredWorktreesMock,
}));

import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";
import { cleanupLandedTaskWorktree, cleanupLandedWorkspaceTaskWorktrees } from "../merge/post-landing-worktree-cleanup.js";
import { activeSessionRegistry } from "../agents/active-session-registry.js";

/** Reset the shared registration inventory and session registry to a clean, empty baseline. */
function resetRegistrationBaseline() {
  describeRegisteredWorktreesMock.mockReset();
  describeRegisteredWorktreesMock.mockResolvedValue({ rawOutput: "", canonicalized: [] });
  activeSessionRegistry.clear();
}

function createFinalizationStore(options: { column?: string; worktree?: string | null } = {}) {
  const task: any = {
    id: "FN-251",
    column: options.column ?? "in-review",
    status: null,
    error: null,
    blockedBy: null,
    overlapBlockedBy: null,
    mergeRetries: 0,
    worktree: options.worktree === undefined ? "/repo/.worktrees/fn-251" : options.worktree,
    steps: [],
    /*
    FNXC:UnrunPostMergeGateRecovery 2026-09-25-15:35 (RUFU-306):
    This fixture's subject is WHEN the worktree is released relative to the complete-column move — it was
    never about post-merge evidence. Two later product changes moved that precondition and left these
    fixtures asserting the pre-change outcome (11 deterministic failures on the base commit, invisible to
    the thin gate because this file is not in it): `postMergeVerificationOptionalGroupNode` shipped with
    `defaultOn: true` + `gateMode: "gate"`, so a merge-capable built-in card now needs a reported gate;
    and terminal finalization moved behind `store.moveTaskIf`, which this fake never implemented, so the
    move threw `TypeError` and surfaced as `outcome: "blocked"`. Stating the evidence the product now
    requires is the honest fixture update; the UNREPORTED case is covered where it belongs, in
    `post-merge-gate-reseed.test.ts`.
    */
    workflowStepResults: [
      { workflowStepId: "post-merge-verification", status: "passed", verdict: "APPROVE", phase: "post-merge" },
    ],
    mergeDetails: { mergeConfirmed: true, commitSha: "abc123" },
  };
  const callOrder: string[] = [];
  const updateTask = vi.fn(async (_id: string, patch: Record<string, unknown>) => {
    if (patch.worktree === null) callOrder.push("cleanup");
    Object.assign(task, patch);
    return task;
  });
  const moveTask = vi.fn(async (_id: string, column: string) => {
    callOrder.push("move");
    task.column = column;
    return task;
  });
  const logEntry = vi.fn().mockResolvedValue(task);
  /*
  FNXC:UnrunPostMergeGateRecovery 2026-09-25-15:35 (RUFU-306): terminal finalization moved behind
  `moveTaskIf`, whose real implementation evaluates the predicate against the live row and only then
  delegates to `moveTaskInternal`. The fake mirrors that shape — including pushing the same "move"
  marker — so the ordering assertions below still describe the real sequence.
  */
  const moveTaskIf = vi.fn(async (
    _id: string,
    toColumn: string,
    predicate: (live: any) => boolean | Promise<boolean>,
    options?: Record<string, unknown>,
  ) => {
    if (!await predicate(task) || task.column === toColumn) return { task, moved: false };
    // The real implementation forwards the move options, and the ordering assertions below check
    // for that third argument, so the fake must forward them too.
    await moveTask(_id, toColumn, options);
    return { task, moved: true };
  });
  const updateTaskAtomic = vi.fn(async (_id: string, updater: (current: any) => Record<string, unknown> | null) => {
    const patch = updater(task);
    if (!patch) return null;
    Object.assign(task, patch);
    return task;
  });
  return {
    task,
    callOrder,
    updateTask,
    moveTask,
    moveTaskIf,
    logEntry,
    store: {
      getTask: vi.fn(async () => task),
      moveTaskIf,
      getSettings: vi.fn(async () => ({})),
      getTaskWorkflowSelection: vi.fn(() => undefined),
      getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
      getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
      updateTask,
      moveTask,
      updateTaskAtomic,
      logEntry,
      recordRunAuditEvent: vi.fn(),
    },
  };
}

function createStore(options: { withSettings?: boolean } = {}) {
  const updateTask = vi.fn().mockResolvedValue({ id: "FN-251" });
  const logEntry = vi.fn().mockResolvedValue({ id: "FN-251" });
  const getSettings = vi.fn().mockResolvedValue({});
  return {
    store: {
      updateTask,
      logEntry,
      ...(options.withSettings === false ? {} : { getSettings }),
    },
    updateTask,
    logEntry,
    getSettings,
  };
}

describe("cleanupLandedTaskWorktree", () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);
    rmdirSyncMock.mockReset();
    removeWorktreeMock.mockReset();
    removeWorktreeMock.mockResolvedValue({ removed: true, classification: "removed" });
    resetRegistrationBaseline();
  });

  it.each([
    { name: "has no worktree pointer", worktreePath: undefined, rootDir: "/repo" },
    { name: "has no root directory", worktreePath: "/repo/.worktrees/fn-251", rootDir: undefined },
  ])("returns nothing-to-remove when it $name", async ({ worktreePath, rootDir }) => {
    const { store, updateTask } = createStore();

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath,
      rootDir,
      source: "test",
    })).resolves.toEqual({ outcome: "nothing-to-remove", removed: false });

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("clears a stale worktree pointer when the path is already absent", async () => {
    const { store, updateTask } = createStore();
    existsSyncMock.mockReturnValue(false);

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      source: "test",
    })).resolves.toEqual({ outcome: "nothing-to-remove", removed: false });

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledWith("FN-251", { worktree: null });
  });

  it("clears only the worktree pointer after removal", async () => {
    const { store, updateTask, getSettings } = createStore();
    const fence = { assertOwned: vi.fn() };

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      landedSha: "abc123",
      source: "workflow-graph-merge-finalize",
      fence,
    })).resolves.toEqual({ outcome: "removed", removed: true });

    expect(getSettings).toHaveBeenCalledOnce();
    expect(removeWorktreeMock).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-251",
      taskId: "FN-251",
      reason: "completion-landed-cleanup",
      postLandingProof: { landedSha: "abc123", source: "workflow-graph-merge-finalize" },
    }));
    expect(fence.assertOwned).toHaveBeenCalledWith("finalization");
    expect(updateTask).toHaveBeenCalledWith("FN-251", { worktree: null });
  });

  it("does not report removal until a rejected pointer clear converges", async () => {
    const { store, updateTask, logEntry } = createStore();
    updateTask.mockRejectedValueOnce(new Error("transient task-store failure"));

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      source: "test",
    })).resolves.toEqual({ outcome: "nothing-to-remove", removed: false });

    expect(logEntry).toHaveBeenCalledWith(
      "FN-251",
      "Post-landing worktree cleanup pointer clear pending",
      expect.stringContaining("/repo/.worktrees/fn-251"),
    );
    expect(removeWorktreeMock).toHaveBeenCalledOnce();

    existsSyncMock.mockReturnValue(false);
    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      source: "self-healing-completion-convergence",
    })).resolves.toEqual({ outcome: "nothing-to-remove", removed: false });

    expect(removeWorktreeMock).toHaveBeenCalledOnce();
    expect(updateTask).toHaveBeenCalledTimes(2);
    expect(updateTask).toHaveBeenLastCalledWith("FN-251", { worktree: null });
  });

  it("keeps an active-session worktree while recording the preservation", async () => {
    const { store, updateTask, logEntry } = createStore();
    removeWorktreeMock.mockRejectedValueOnce(new ActiveSessionWorktreeRemovalErrorMock());

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      source: "test",
    })).resolves.toEqual({
      outcome: "preserved-active-session",
      removed: false,
      preservedReason: "active-session",
    });

    expect(updateTask).not.toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalledWith(
      "FN-251",
      "Post-landing worktree cleanup preserved",
      expect.stringContaining("/repo/.worktrees/fn-251: active-session"),
    );
  });

  it.each([
    {
      name: "deliverable content",
      error: new Error("preserving /repo/.worktrees/fn-251: uncommitted or ignored content present"),
      outcome: "preserved-deliverable",
      preservedReason: "deliverable",
    },
    {
      name: "an unverifiable checkout",
      error: new Error("preserving /repo/.worktrees/fn-251: status probe failed (broken registration)"),
      outcome: "preserved-unverifiable",
      preservedReason: "unverifiable",
    },
  ])("keeps $name and writes a durable log entry", async ({ error, outcome, preservedReason }) => {
    const { store, updateTask, logEntry } = createStore();
    removeWorktreeMock.mockRejectedValueOnce(error);

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      source: "test",
    })).resolves.toEqual({ outcome, removed: false, preservedReason });

    expect(updateTask).not.toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalledWith(
      "FN-251",
      "Post-landing worktree cleanup preserved",
      expect.stringContaining(`/repo/.worktrees/fn-251: ${preservedReason}`),
    );
  });

  it.each([
    "workflow-graph-merge-finalize",
    "merge-confirmed-fast-path",
    "self-healing",
    "direct-ai-merge",
  ])("cleans before the complete-column move for %s", async (source) => {
    const { store, task, callOrder, updateTask, moveTask } = createFinalizationStore();
    removeWorktreeMock.mockImplementationOnce(async () => {
      callOrder.push("remove");
      return { removed: true, classification: "removed" };
    });

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: source as never,
    });

    expect(result).toMatchObject({ outcome: "done" });
    expect(callOrder).toEqual(expect.arrayContaining(["remove", "cleanup", "move"]));
    expect(callOrder.indexOf("remove")).toBeLessThan(callOrder.indexOf("move"));
    expect(callOrder.indexOf("cleanup")).toBeLessThan(callOrder.indexOf("move"));
    expect(updateTask).toHaveBeenCalledWith(task.id, { worktree: null });
    expect(moveTask).toHaveBeenCalledWith(task.id, "done", expect.any(Object));
    expect(task.worktree).toBeNull();
  });

  it.each([
    new Error("preserving /repo/.worktrees/fn-251: uncommitted or ignored content present"),
    new Error("preserving /repo/.worktrees/fn-251: status probe failed (broken registration)"),
  ])("finalizes a durable landing when cleanup preserves content", async (error) => {
    const { store, task, moveTask } = createFinalizationStore();
    removeWorktreeMock.mockRejectedValueOnce(error);

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result).toMatchObject({ outcome: "done" });
    expect(moveTask).toHaveBeenCalledWith(task.id, "done", expect.any(Object));
    expect(task.worktree).toBe("/repo/.worktrees/fn-251");
  });

  it("skips cleanup without a root directory but still completes", async () => {
    const { store, task, moveTask } = createFinalizationStore();

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      source: "workflow-graph-merge-finalize",
    });

    expect(result).toMatchObject({ outcome: "done" });
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(moveTask).toHaveBeenCalledWith(task.id, "done", expect.any(Object));
  });

  it("does no git work for a workspace-shaped task without a singular worktree", async () => {
    const { store, task, moveTask } = createFinalizationStore({ worktree: null });
    task.workspaceWorktrees = [{ repoRelPath: "packages/a", worktreePath: "/repo/.worktrees/a" }];

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result).toMatchObject({ outcome: "done" });
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(moveTask).toHaveBeenCalledWith(task.id, "done", expect.any(Object));
  });

  it("keeps an active-session worktree while still moving the task to complete", async () => {
    const { store, task, moveTask, logEntry } = createFinalizationStore();
    removeWorktreeMock.mockRejectedValueOnce(new ActiveSessionWorktreeRemovalErrorMock());

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result).toMatchObject({ outcome: "done" });
    expect(task.worktree).toBe("/repo/.worktrees/fn-251");
    expect(moveTask).toHaveBeenCalledWith(task.id, "done", expect.any(Object));
    expect(logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("active-session"));
  });

  it("still completes when clearing a removed worktree pointer fails", async () => {
    const { store, task, updateTask, moveTask, logEntry } = createFinalizationStore();
    const update = updateTask.getMockImplementation()!;
    let rejectPointerClear = true;
    updateTask.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
      if (patch.worktree === null && rejectPointerClear) {
        rejectPointerClear = false;
        throw new Error("transient task-store failure");
      }
      return await update(id, patch);
    });

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result).toMatchObject({ outcome: "done" });
    expect(task.worktree).toBe("/repo/.worktrees/fn-251");
    expect(moveTask).toHaveBeenCalledWith(task.id, "done", expect.any(Object));
    expect(logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("pointer is pending"));
  });

  it("reclaims an already-complete task through the convergence path", async () => {
    const { store, task, moveTask, updateTask } = createFinalizationStore({ column: "done" });

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result.outcome).toBe("already-done");
    expect(updateTask).toHaveBeenCalledWith(task.id, { worktree: null });
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("uses empty settings when a minimal store has no settings reader", async () => {
    const { store, getSettings } = createStore({ withSettings: false });

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      source: "test",
    })).resolves.toEqual({ outcome: "removed", removed: true });

    expect(getSettings).not.toHaveBeenCalled();
    expect(removeWorktreeMock).toHaveBeenCalledWith(expect.objectContaining({ settings: {} }));
  });

  /*
  FNXC:ZeroCommitDeliveryProof 2026-09-27-01:01 (RUFU-274 Step 5):
  RUFU-262's work survived only as uncommitted files, and the cleanup lane is what deletes them. A row that
  carries the delivery-unproven hold must therefore be untouchable HERE, regardless of which lane reached
  cleanup — this is the last door before the tree is gone.
  */
  it("refuses to dispose a tree whose row carries the delivery-unproven hold", async () => {
    const { store, updateTask, logEntry } = createStore();

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      source: "test",
      task: {
        mergeDetails: {
          uncommittedWorkHold: {
            at: "2026-09-26T00:00:00.000Z",
            reason: "2 uncommitted file(s) survived on the branch; automatic merge refused",
            modifiedCount: 1,
            untrackedCount: 1,
            uncommittedPaths: ["src/a.ts", "src/b.ts"],
            code: "uncommitted-work",
            contentState: "deliverable",
            source: "merge-runner",
          },
        },
      } as never,
    })).resolves.toMatchObject({ outcome: "preserved-unverifiable", removed: false, preservedReason: "delivery-unproven" });

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    // The preservation is recorded in FN-251's existing vocabulary, with the reason naming this class.
    expect(logEntry).toHaveBeenCalledWith(
      "FN-251",
      "Post-landing worktree cleanup preserved",
      expect.stringContaining("delivery-unproven"),
    );
  });
});

/*
FNXC:TempWorktreeSweep 2026-10-02-19:55 (RUFU-290):
Measured against real git, a forced parent removal (`git worktree remove --force <parent>`) deletes the
parent tree recursively but leaves a worktree registered INSIDE it as a phantom entry in
`git worktree list --porcelain` — the child keeps a path that no longer exists, and nothing else in the
repo can enumerate it: the temp-merge sweep's containment is clean-room roots plus `os.tmpdir()`
prefixes, and a task worktree path is neither. These cases pin the landing lane's share of the fix: the
descendant pass runs only AFTER the parent removal and pointer clear, its containment is exactly the
removed path, and a leak it cannot clear is reported rather than turning a durable landing into a failed
merge.
*/
describe("cleanupLandedTaskWorktree — nested registration leg (RUFU-290)", () => {
  const LANDED = "/repo/.fusion/worktrees/fn-251";
  const NESTED = `${LANDED}/.fusion/worktrees/.ai-merge/probe-main`;
  const UNRELATED = "/repo/.fusion/worktrees/fn-999";

  /** The live inventory the mocked `git worktree list` answers with; each seam mutates it as it acts. */
  let registered: string[];

  beforeEach(() => {
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);
    rmdirSyncMock.mockReset();
    removeWorktreeMock.mockReset();
    removeWorktreeMock.mockResolvedValue({ removed: true, classification: "removed" });
    resetRegistrationBaseline();
    registered = ["/repo", LANDED, NESTED];
    describeRegisteredWorktreesMock.mockImplementation(async () => ({
      rawOutput: registered.map((path) => `worktree ${path}`).join("\n"),
      canonicalized: [...registered],
    }));
  });

  function createLane() {
    const { store, updateTask, logEntry } = createStore();
    const auditGit = vi.fn().mockResolvedValue(undefined);
    const deregister = (path: string) => { registered = registered.filter((candidate) => candidate !== path); };
    return {
      store,
      updateTask,
      logEntry,
      auditGit,
      removeRegistration: vi.fn(async (path: string) => { deregister(path); }),
      removeDirectory: vi.fn(async () => true),
      pruneAdminEntries: vi.fn(async () => { deregister(NESTED); }),
    };
  }

  /** Every nested case needs an audit lane and the filesystem-free seams, so share that shape. */
  function cleanupWithLane(lane: ReturnType<typeof createLane>, seams: Record<string, unknown> = {}) {
    return cleanupLandedTaskWorktree({
      store: lane.store as never,
      taskId: "FN-251",
      worktreePath: LANDED,
      rootDir: "/repo",
      source: "test",
      audit: { git: lane.auditGit } as never,
      nestedRegistrationSeams: {
        removeRegistration: lane.removeRegistration,
        removeDirectory: lane.removeDirectory,
        pruneAdminEntries: lane.pruneAdminEntries,
        ...seams,
      },
    });
  }

  it("clears the registration a forced parent removal left behind, without a git removal for a phantom path", async () => {
    const lane = createLane();

    await expect(cleanupWithLane(lane, {
      // The measured real-git shape: the forced parent removal deleted the child tree with the parent,
      // so only its registration survives and only `git worktree prune` can clear that record.
      pathExists: (path: string) => path !== NESTED,
    })).resolves.toEqual({
      outcome: "removed",
      removed: true,
      nestedRegistrations: { found: 1, removed: 0, residuePruned: 1, remaining: 0 },
    });

    expect(describeRegisteredWorktreesMock).toHaveBeenCalledWith("/repo");
    expect(lane.removeRegistration).not.toHaveBeenCalled();
    expect(lane.removeDirectory).not.toHaveBeenCalled();
    expect(lane.pruneAdminEntries).toHaveBeenCalledOnce();
    expect(lane.updateTask).toHaveBeenCalledWith("FN-251", { worktree: null });

    expect(lane.auditGit).toHaveBeenCalledWith(expect.objectContaining({
      type: "worktree:post-landing-nested-registration",
      target: "task:FN-251",
      metadata: expect.objectContaining({
        foundCount: 1,
        removedCount: 0,
        residuePrunedCount: 1,
        residueRemainingCount: 0,
        outcome: "cleared",
      }),
    }));
    // Audit metadata stays ids/counts-only: the surviving path belongs on the card log, never in the row.
    expect(JSON.stringify(lane.auditGit.mock.calls[0][0])).not.toContain("probe-main");
  });

  it("deregisters and sweeps a nested registration whose directory is still on disk", async () => {
    const lane = createLane();

    await expect(cleanupWithLane(lane)).resolves.toEqual({
      outcome: "removed",
      removed: true,
      nestedRegistrations: { found: 1, removed: 1, residuePruned: 0, remaining: 0 },
    });

    expect(lane.removeRegistration).toHaveBeenCalledWith(NESTED);
    expect(lane.removeDirectory).toHaveBeenCalledWith(NESTED);
    expect(lane.pruneAdminEntries).not.toHaveBeenCalled();
    expect(lane.auditGit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ removedCount: 1, outcome: "cleared" }),
    }));
  });

  it("leaves a nested registration a live session is still driving, and still reports the landing as removed", async () => {
    const lane = createLane();
    activeSessionRegistry.registerPath(NESTED, { taskId: "FN-251", kind: "workflow-step", ownerKey: "FN-251#step" });

    // The landing already succeeded; a child this lane may not touch defers, and must not rename the outcome.
    await expect(cleanupWithLane(lane)).resolves.toEqual({
      outcome: "removed",
      removed: true,
      nestedRegistrations: { found: 1, removed: 0, residuePruned: 0, remaining: 1 },
    });

    expect(lane.removeRegistration).not.toHaveBeenCalled();
    expect(lane.removeDirectory).not.toHaveBeenCalled();
    expect(registered).toContain(NESTED);
    expect(lane.auditGit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        foundCount: 1,
        deferredCount: 1,
        deferredReason: "active-session",
        outcome: "deferred",
      }),
    }));
  });

  it("does no nested work at all when a gate preserved the landed worktree", async () => {
    const lane = createLane();
    removeWorktreeMock.mockRejectedValueOnce(new ActiveSessionWorktreeRemovalErrorMock());

    await expect(cleanupWithLane(lane)).resolves.toMatchObject({ outcome: "preserved-active-session", removed: false });

    // The descendant leg runs only after a proven removal: a preserved tree still owns everything inside it.
    expect(describeRegisteredWorktreesMock).not.toHaveBeenCalled();
    expect(lane.removeRegistration).not.toHaveBeenCalled();
    expect(lane.pruneAdminEntries).not.toHaveBeenCalled();
    expect(lane.auditGit).not.toHaveBeenCalled();
  });

  it("leaves a registration outside the removed worktree path untouched", async () => {
    const lane = createLane();
    registered = ["/repo", LANDED, UNRELATED];

    // Nothing contained: the result carries no nested summary at all, so a clean landing stays quiet.
    await expect(cleanupWithLane(lane)).resolves.toEqual({ outcome: "removed", removed: true });

    expect(registered).toContain(UNRELATED);
    expect(lane.removeRegistration).not.toHaveBeenCalled();
    expect(lane.removeDirectory).not.toHaveBeenCalled();
    expect(lane.pruneAdminEntries).not.toHaveBeenCalled();
    expect(lane.auditGit).not.toHaveBeenCalled();
  });

  it("reports a leak it could not clear as a partial pass instead of failing the landing", async () => {
    const lane = createLane();
    lane.pruneAdminEntries.mockRejectedValue(new Error("prune refused by a locked admin directory"));

    await expect(cleanupWithLane(lane, { pathExists: (path: string) => path !== NESTED })).resolves.toEqual({
      outcome: "removed",
      removed: true,
      nestedRegistrations: { found: 1, removed: 0, residuePruned: 0, remaining: 1 },
    });

    // The commits are already on the default branch: the leak is recorded for an operator, not a merge failure.
    expect(lane.auditGit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ foundCount: 1, residuePrunedCount: 0, residueRemainingCount: 1, outcome: "partial" }),
    }));
  });
});

describe("cleanupLandedWorkspaceTaskWorktrees", () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);
    rmdirSyncMock.mockReset();
    removeWorktreeMock.mockReset();
    removeWorktreeMock.mockResolvedValue({ removed: true, classification: "removed" });
    resetRegistrationBaseline();
  });

  function workspaceTask(workspaceWorktrees: Record<string, { worktreePath: string; branch: string }>) {
    return { id: "FN-268", workspaceWorktrees } as any;
  }

  it("proof-cleans every repository once and retires the empty task directory", async () => {
    const { store } = createStore();
    const task = workspaceTask({
      api: { worktreePath: "/workspace/.fusion/worktrees/fn-268/api", branch: "fusion/fn-268" },
      "apps/web": { worktreePath: "/workspace/.fusion/worktrees/fn-268/apps/web", branch: "fusion/fn-268" },
    });

    await expect(cleanupLandedWorkspaceTaskWorktrees({
      store: store as never,
      task,
      workspaceRootDir: "/workspace",
      landedShas: { api: "api-sha", "apps/web": "web-sha" },
      source: "workspace-finalize",
    })).resolves.toEqual(expect.objectContaining({
      removedRepoRels: ["api", "apps/web"],
      preserved: [],
      taskDirectoryRemoved: true,
      removed: true,
    }));

    expect(removeWorktreeMock).toHaveBeenCalledTimes(2);
    expect(removeWorktreeMock).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: "/workspace/api",
      postLandingProof: { landedSha: "api-sha", source: "workspace-finalize" },
    }));
    expect(removeWorktreeMock).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: "/workspace/apps/web",
      postLandingProof: { landedSha: "web-sha", source: "workspace-finalize" },
    }));
    expect(rmdirSyncMock).toHaveBeenCalledWith("/workspace/.fusion/worktrees/fn-268");
  });

  it("preserves active and deliverable checkout paths without retiring their task directory", async () => {
    const { store, logEntry } = createStore();
    const task = workspaceTask({
      api: { worktreePath: "/workspace/.fusion/worktrees/fn-268/api", branch: "fusion/fn-268" },
      web: { worktreePath: "/workspace/.fusion/worktrees/fn-268/web", branch: "fusion/fn-268" },
    });
    removeWorktreeMock.mockRejectedValueOnce(new Error("preserving /workspace/.fusion/worktrees/fn-268/api: uncommitted content present"));
    removeWorktreeMock.mockRejectedValueOnce(new ActiveSessionWorktreeRemovalErrorMock());

    const result = await cleanupLandedWorkspaceTaskWorktrees({
      store: store as never,
      task,
      workspaceRootDir: "/workspace",
      source: "workspace-finalize",
    });

    expect(result).toEqual(expect.objectContaining({ taskDirectoryRemoved: false, removed: false }));
    expect(result.preserved).toEqual(expect.arrayContaining([
      expect.objectContaining({ repoRel: "api", reason: "deliverable" }),
      expect.objectContaining({ repoRel: "web", reason: "active-session" }),
    ]));
    expect(rmdirSyncMock).not.toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalledWith("FN-268", "Post-landing worktree cleanup preserved", expect.stringContaining("deliverable"));
  });

  /*
  FNXC:TempWorktreeSweep 2026-10-02-20:50 (RUFU-290):
  A workspace delivers as one unit, so one preserved member stops the task-directory retirement — but a
  sibling member WAS removed, and a registration its forced removal left behind is a leak the caller still
  has to see. This case pins that the nested tally rides out on the partial-landing result too.
  */
  it("reports a removed member's nested leak even when a sibling member was preserved", async () => {
    const { store } = createStore();
    const apiPath = "/workspace/.fusion/worktrees/fn-268/api";
    const nested = `${apiPath}/.fusion/worktrees/.ai-merge/probe`;
    let registered = ["/workspace", apiPath, nested];
    describeRegisteredWorktreesMock.mockImplementation(async () => ({
      rawOutput: registered.map((path) => `worktree ${path}`).join("\n"),
      canonicalized: [...registered],
    }));
    removeWorktreeMock.mockImplementation(async (opts: { rootDir: string }) => {
      if (opts.rootDir === "/workspace/web") throw new ActiveSessionWorktreeRemovalErrorMock();
      return { removed: true, classification: "removed" };
    });
    const task = workspaceTask({
      api: { worktreePath: apiPath, branch: "fusion/fn-268" },
      web: { worktreePath: "/workspace/.fusion/worktrees/fn-268/web", branch: "fusion/fn-268" },
    });

    const result = await cleanupLandedWorkspaceTaskWorktrees({
      store: store as never,
      task,
      workspaceRootDir: "/workspace",
      source: "workspace-finalize",
      nestedRegistrationSeams: {
        removeRegistration: async (path: string) => { registered = registered.filter((candidate) => candidate !== path); },
        removeDirectory: async () => true,
        pruneAdminEntries: async () => {},
      },
    });

    expect(result.removedRepoRels).toEqual(["api"]);
    // The retirement branch never runs, yet the removed member's leak is still on the result.
    expect(result.taskDirectoryRemoved).toBe(false);
    expect(result.nestedRegistrations).toEqual({ found: 1, removed: 1, residuePruned: 0, remaining: 0 });
    expect(registered).not.toContain(nested);
  });

  it("settles absent paths and removes a duplicate recorded path only once", async () => {
    const { store } = createStore();
    const shared = "/workspace/.fusion/worktrees/fn-268/shared";
    const task = workspaceTask({
      api: { worktreePath: shared, branch: "fusion/fn-268" },
      web: { worktreePath: shared, branch: "fusion/fn-268" },
      absent: { worktreePath: "/workspace/.fusion/worktrees/fn-268/absent", branch: "fusion/fn-268" },
    });
    existsSyncMock.mockImplementation((path: string) => path !== "/workspace/.fusion/worktrees/fn-268/absent");

    const result = await cleanupLandedWorkspaceTaskWorktrees({
      store: store as never,
      task,
      workspaceRootDir: "/workspace",
      source: "workspace-finalize",
    });

    expect(removeWorktreeMock).toHaveBeenCalledTimes(1);
    expect(result.removedRepoRels).toEqual(["api", "web"]);
    expect(result.preserved).toEqual([]);
    expect(result.taskDirectoryRemoved).toBe(true);
  });

  it("does not remove a legacy-layout task directory", async () => {
    const { store } = createStore();
    const task = workspaceTask({
      api: { worktreePath: "/workspace/api/.worktrees/fn-268", branch: "fusion/fn-268" },
    });

    const result = await cleanupLandedWorkspaceTaskWorktrees({
      store: store as never,
      task,
      workspaceRootDir: "/workspace",
      source: "workspace-finalize",
    });

    expect(result).toEqual(expect.objectContaining({ removedRepoRels: ["api"], taskDirectoryRemoved: false, removed: true }));
    expect(rmdirSyncMock).not.toHaveBeenCalled();
  });

  it("preserves every repository when the row carries the delivery-unproven hold", async () => {
    const { store } = createStore();
    const task = workspaceTask({
      api: { worktreePath: "/workspace/.fusion/worktrees/fn-268/api", branch: "fusion/fn-268" },
      "apps/web": { worktreePath: "/workspace/.fusion/worktrees/fn-268/apps/web", branch: "fusion/fn-268" },
    });
    task.mergeDetails = {
      uncommittedWorkHold: {
        at: "2026-09-26T00:00:00.000Z",
        reason: "1 uncommitted file(s) survived on the branch; automatic merge refused",
        modifiedCount: 1,
        untrackedCount: 0,
        uncommittedPaths: ["src/a.ts"],
        code: "uncommitted-work",
        contentState: "deliverable",
        source: "workspace-finalize",
      },
    };

    const result = await cleanupLandedWorkspaceTaskWorktrees({
      store: store as never,
      task,
      workspaceRootDir: "/workspace",
      landedShas: { api: "api-sha", "apps/web": "web-sha" },
      source: "workspace-finalize",
    });

    // One repository's content being at risk preserves ALL of them: a workspace task delivers as one unit.
    expect(result.removedRepoRels).toEqual([]);
    expect(result.preserved.map((entry) => [entry.repoRel, entry.outcome, entry.reason])).toEqual([
      ["api", "preserved-unverifiable", "delivery-unproven"],
      ["apps/web", "preserved-unverifiable", "delivery-unproven"],
    ]);
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });
});
