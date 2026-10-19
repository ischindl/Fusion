import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoRecoveryContext, AutoRecoveryDecision, AutoRecoveryFailure } from "../healing/auto-recovery.js";
import { BranchWorktreeAutoRecoveryHandler } from "../auto-recovery-handlers/branch-worktree.js";

/*
FNXC:BranchPhantomEcho 2026-10-19 (RUFU-376):
The second half of the phantom-echo defect is not cosmetic. `activeSessionRegistry.isPathActive()`
answers "does some live session hold this directory open?", and the recovery fence uses a true answer to
DECLINE a repair (FN-4811: never yank a filesystem another task is working in). Handing that probe a
path the caller merely *wanted* therefore does worse than report a false checkout: when the desired path
coincidentally names a directory another session has open, the phantom becomes a fabricated owner and a
legitimate recovery is refused over a directory the conflicting task never touched.

These cases pin the probe to proven checkouts: the bare `foreign-unmerged` collision never reaches the
probe at all, and the live-foreign arm probes the path Git itself reported.
*/

const DESIRED = "/tmp/rufu-376/desired-fn-4536";
const LIVE = "/tmp/rufu-376/live-other-fn-4536";

const branchConflictMocks = vi.hoisted(() => ({
  inspectBareBranchCollision: vi.fn(),
  inspectBranchConflict: vi.fn(),
  classifyBootstrapMisbinding: vi.fn(),
  reanchorBranchToBase: vi.fn(),
}));

vi.mock("../execution/branch-conflicts.js", () => ({
  inspectBareBranchCollision: branchConflictMocks.inspectBareBranchCollision,
  inspectBranchConflict: branchConflictMocks.inspectBranchConflict,
  classifyBootstrapMisbinding: branchConflictMocks.classifyBootstrapMisbinding,
  reanchorBranchToBase: branchConflictMocks.reanchorBranchToBase,
}));

const registryMocks = vi.hoisted(() => ({ isPathActive: vi.fn(() => false) }));
vi.mock("../agents/active-session-registry.js", () => ({
  activeSessionRegistry: { isPathActive: registryMocks.isPathActive },
}));

function createFixtures(taskOverrides: Record<string, unknown> = {}) {
  const task = {
    id: "FN-4536",
    column: "in-progress",
    branch: "fusion/fn-4536",
    worktree: null,
    baseCommitSha: "main",
    pausedReason: null,
    userPaused: false,
    ...taskOverrides,
  } as any;
  let current = { ...task };
  const taskStore = {
    updateTask: vi.fn(async () => undefined),
    updateTaskAtomic: vi.fn(async (_id: string, update: (currentTask: any) => Record<string, unknown> | null) => {
      const patch = update(current);
      if (patch) current = { ...current, ...patch };
      return current;
    }),
    moveTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
  } as any;
  const runAudit = { database: vi.fn(async () => undefined), git: vi.fn(), filesystem: vi.fn() } as any;
  const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn() } as any;
  const reserveFreshBranch = vi.fn(async () => true);
  const handler = new BranchWorktreeAutoRecoveryHandler({
    taskStore,
    runAudit,
    logger,
    reserveFreshBranch,
    spawnAiRecoverySession: vi.fn(async () => ({ outcome: "exhausted" as const })),
  });
  const failure: AutoRecoveryFailure = {
    class: "branch-conflict-unrecoverable",
    taskId: task.id,
    pausedReason: "branch-conflict-unrecoverable",
    evidence: {},
  };
  const decision: AutoRecoveryDecision = {
    action: "retry",
    rationale: "mode",
    legacyPausedReason: "branch-conflict-unrecoverable",
    auditMetadata: { mode: "programmatic" },
  };
  const ctx: AutoRecoveryContext = { task, retryCount: 0, settings: { mode: "programmatic", maxRetries: 3 } as any };
  return { task, taskStore, runAudit, reserveFreshBranch, handler, failure, decision, ctx };
}

beforeEach(() => {
  vi.clearAllMocks();
  registryMocks.isPathActive.mockReturnValue(false);
});

describe("branch-conflict liveness probes never see a desired path", () => {
  it("skips the ownership probe entirely for a bare foreign-unmerged collision", async () => {
    const f = createFixtures();
    f.failure.evidence = { branchName: "fusion/fn-4536", desiredWorktreePath: DESIRED, collisionKind: "foreign-unmerged" };
    branchConflictMocks.inspectBareBranchCollision.mockResolvedValue({
      kind: "foreign-unmerged",
      tipSha: "preserved-tip",
      uniqueCommitCount: 2,
    });

    await f.handler.issueRetry(f.failure, f.decision, f.ctx);

    // The recovery did run, so the absence of a probe is a decision and not an early return.
    expect(f.reserveFreshBranch).toHaveBeenCalledWith(expect.any(String), "fusion/fn-4536-2", "main");
    expect(registryMocks.isPathActive).not.toHaveBeenCalled();
    const requeue = f.runAudit.database.mock.calls
      .map(([event]) => event)
      .find((event: any) => event.type === "branch-worktree:auto-requeue");
    expect(requeue?.metadata?.evidence).toMatchObject({ desiredWorktreePath: DESIRED });
    expect(Object.keys(requeue?.metadata?.evidence ?? {})).not.toContain("conflictingWorktreePath");
  });

  it("probes the path Git reported as holding the branch, never the path the acquire wanted", async () => {
    const f = createFixtures({ worktree: LIVE });
    f.failure.evidence = {
      branchName: "fusion/fn-4536",
      conflictingWorktreePath: LIVE,
      desiredWorktreePath: DESIRED,
      collisionKind: "live-foreign",
    };
    branchConflictMocks.inspectBranchConflict.mockResolvedValue({
      kind: "live-foreign",
      livePath: LIVE,
      error: { strandedCommits: [] },
    });

    await f.handler.issueRetry(f.failure, f.decision, f.ctx);

    expect(registryMocks.isPathActive).toHaveBeenCalledWith(LIVE);
    const probed = registryMocks.isPathActive.mock.calls.map(([path]) => path);
    expect(probed).not.toContain(DESIRED);
  });

  it("still withholds the destructive discard when a live session really does hold the proven path", async () => {
    /*
    FNXC:BranchPhantomEcho 2026-10-19: the FN-4811 guard must stay armed for a PROVEN checkout —
    RUFU-376 narrows what may be PROBED, never what a positive answer protects. A true reading keeps the
    worktree and its branch intact and records the reason on the discard row.
    */
    const f = createFixtures({ worktree: LIVE });
    registryMocks.isPathActive.mockImplementation((path: string) => path === LIVE);
    f.failure.evidence = { branchName: "fusion/fn-4536", conflictingWorktreePath: LIVE, collisionKind: "live-foreign" };
    branchConflictMocks.inspectBranchConflict.mockResolvedValue({
      kind: "live-foreign",
      livePath: LIVE,
      error: { strandedCommits: [] },
    });

    await f.handler.issueRetry(f.failure, f.decision, f.ctx);

    expect(registryMocks.isPathActive).toHaveBeenCalledWith(LIVE);
    const discarded = f.runAudit.database.mock.calls
      .map(([event]) => event)
      .find((event: any) => event.type === "branch-worktree:foreign-branch-discarded");
    expect(discarded?.metadata).toMatchObject({
      isLiveOwned: true,
      branchDeleted: false,
      worktreeRemoved: false,
      conflictingWorktreePath: LIVE,
    });
  });
});
