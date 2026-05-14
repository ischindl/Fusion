import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, mockedCreateFnAgent, mockedExec, resetExecutorMocks } from "./executor-test-helpers.js";
import * as branchConflicts from "../branch-conflicts.js";

/**
 * FN-4417 regression: the contamination check must compute its own fresh
 * merge-base against the integration branch, not reuse `task.baseCommitSha`.
 */
describe("resolveContaminationBaseRef (FN-4417)", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("returns the current merge-base with origin/main, ignoring task.baseCommitSha", async () => {
    const calls: string[] = [];
    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      calls.push(String(cmd));
      if (String(cmd).includes("merge-base")) cb(null, "fresh_main_sha\n");
      else cb(null, "");
      return {} as any;
    }) as any);

    const executor = new TaskExecutor(createMockStore(), "/tmp/test");
    const result = await (executor as any).resolveContaminationBaseRef("/tmp/test/.worktrees/swift-delta");

    expect(result).toBe("fresh_main_sha");
    const mergeBaseCall = calls.find((c) => c.includes("merge-base"));
    expect(mergeBaseCall).toBeDefined();
    const localMainIdx = mergeBaseCall!.indexOf("merge-base HEAD main");
    const originMainIdx = mergeBaseCall!.indexOf("merge-base HEAD origin/main");
    expect(localMainIdx).toBeGreaterThanOrEqual(0);
    expect(localMainIdx).toBeLessThan(originMainIdx === -1 ? Number.MAX_SAFE_INTEGER : originMainIdx);
    expect(calls.some((c) => c.includes("HEAD~1"))).toBe(false);
  });

  it("returns undefined when neither origin/main nor main resolves", async () => {
    mockedExec.mockImplementation(((_cmd: any, _opts: any, cb: any) => {
      cb(new Error("fatal: no main"), "", "fatal: no main");
      return {} as any;
    }) as any);

    const executor = new TaskExecutor(createMockStore(), "/tmp/test");
    const result = await (executor as any).resolveContaminationBaseRef("/tmp/test/.worktrees/swift-delta");
    expect(result).toBeUndefined();
  });

  it("does NOT fall back to task.baseCommitSha (FN-4417 false-positive guard)", async () => {
    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      cb(null, String(cmd).includes("merge-base") ? "currentMainSHA\n" : "");
      return {} as any;
    }) as any);

    const executor = new TaskExecutor(createMockStore(), "/tmp/test");
    const result = await (executor as any).resolveContaminationBaseRef("/tmp/test/.worktrees/swift-delta");

    expect(result).toBe("currentMainSHA");
    expect((executor as any).resolveContaminationBaseRef.length).toBe(1);
  });
});

describe("branch cross-contamination recovery (FN-4428)", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExec.mockImplementation(((_cmd: any, _opts: any, cb: any) => {
      cb(null, "");
      return {} as any;
    }) as any);
    mockedCreateFnAgent.mockResolvedValue({ session: { prompt: vi.fn(), close: vi.fn(), dispose: vi.fn() }, sessionFile: null } as any);
  });

  function makeTask(recoveryRetryCount?: number) {
    return {
      id: "FN-4428",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      recoveryRetryCount,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;
  }

  it("auto-recovers when all foreign commits are already-upstream", async () => {
    const store = createMockStore();
    const contamination = new branchConflicts.BranchCrossContaminationError({
      branchName: "fusion/fn-4428",
      baseSha: "abc123",
      taskId: "FN-4428",
      foreignCommits: [{ sha: "1111111111111111111111111111111111111111", subject: "feat(FN-4412): upstream", foreignTaskId: "FN-4412" }],
    });

    mockedCreateFnAgent.mockRejectedValueOnce(contamination);
    vi.spyOn(branchConflicts, "classifyForeignCommits").mockResolvedValueOnce({ alreadyUpstream: contamination.foreignCommits, unique: [] });
    vi.spyOn(branchConflicts, "autoRecoverCrossContamination").mockResolvedValueOnce({
      newTipSha: "2222222222222222222222222222222222222222",
      droppedShas: ["1111111111111111111111111111111111111111"],
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    expect(store.moveTask).toHaveBeenCalledWith("FN-4428", "todo", { preserveResumeState: true });
    expect(store.updateTask).toHaveBeenCalledWith("FN-4428", expect.objectContaining({ paused: false, pausedReason: null, recoveryRetryCount: 1 }));
    expect(store.logEntry).toHaveBeenCalledWith("FN-4428", expect.stringContaining("auto-recovered branch-cross-contamination"), undefined, expect.any(Object));
  });

  it("escalates to paused failure when unique foreign commits remain", async () => {
    const store = createMockStore();
    const contamination = new branchConflicts.BranchCrossContaminationError({
      branchName: "fusion/fn-4428",
      baseSha: "abc123",
      taskId: "FN-4428",
      foreignCommits: [{ sha: "3333333333333333333333333333333333333333", subject: "feat(FN-4410): unique", foreignTaskId: "FN-4410" }],
    });

    mockedCreateFnAgent.mockRejectedValueOnce(contamination);
    vi.spyOn(branchConflicts, "classifyForeignCommits").mockResolvedValueOnce({ alreadyUpstream: [], unique: contamination.foreignCommits });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    expect(store.updateTask).toHaveBeenCalledWith("FN-4428", expect.objectContaining({ status: "failed", paused: true, pausedReason: "branch-cross-contamination" }));
  });

  it("escalates immediately when auto-recovery was already attempted", async () => {
    const store = createMockStore();
    const contamination = new branchConflicts.BranchCrossContaminationError({
      branchName: "fusion/fn-4428",
      baseSha: "abc123",
      taskId: "FN-4428",
      foreignCommits: [{ sha: "4444444444444444444444444444444444444444", subject: "feat(FN-4412): upstream", foreignTaskId: "FN-4412" }],
    });

    mockedCreateFnAgent.mockRejectedValueOnce(contamination);
    vi.spyOn(branchConflicts, "classifyForeignCommits").mockResolvedValueOnce({ alreadyUpstream: contamination.foreignCommits, unique: [] });
    const autoRecoverSpy = vi.spyOn(branchConflicts, "autoRecoverCrossContamination");

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask(1));

    expect(autoRecoverSpy).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith("FN-4428", expect.stringContaining("auto-recovery already attempted"), undefined, expect.objectContaining({ agentId: "executor" }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-4428", expect.objectContaining({ status: "failed", paused: true, pausedReason: "branch-cross-contamination" }));
  });
});
