/*
FNXC:OrphanedGitChildren 2026-09-12-09:20 (RUFU-210):
Sweep-level coverage for SelfHealingManager.reapOrphanedWorktreeGitChildren: audit row shape
(one row per deleted worktree path, ids/counts/outcomes-only metadata, pids capped at 20), the
once-idle no-action dedupe that re-arms after a real reap, the /proc-less host contract (zero
signals AND zero audit rows — the absent row is the signal), and hostile audit-sink isolation
(absent / throwing / rejecting / hanging-forever sinks must never change the reap count or throw
into the owning branch, per the FN-9175 emitBoundedRunAudit contract). The sweep is process
signals only — every assertion here also proves no task/worktree/lifecycle surface is consulted.
*/
import { EventEmitter } from "node:events";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SelfHealingManager } from "../self-healing.js";
import {
  ORPHANED_GIT_CHILD_GRACE_FLOOR_MS,
  type GitChildProcessProbe,
  type OrphanedGitChildCandidate,
} from "../util/orphaned-git-child-reaper.js";
import { resolveWorktreesDirScanRoots } from "../worktree/worktree-paths.js";

function createStore(sinkMode: "capture" | "absent" | "throw" | "reject" | "pending" = "capture") {
  const recordRunAuditEvent = sinkMode === "absent"
    ? undefined
    : vi.fn(() => {
      if (sinkMode === "throw") throw new Error("sync audit sink failure");
      if (sinkMode === "reject") return Promise.reject(new Error("rejected audit sink failure"));
      if (sinkMode === "pending") return new Promise<void>(() => undefined);
      return Promise.resolve();
    });
  const store: any = Object.assign(new EventEmitter(), {
    getAsyncLayer: vi.fn(() => ({ projectId: "proj-rufu210" })),
    getSettings: vi.fn().mockResolvedValue({}),
    listTasks: vi.fn().mockResolvedValue([]),
    walCheckpoint: vi.fn().mockReturnValue({ busy: 0, log: 0, checkpointed: 0 }),
    ...(recordRunAuditEvent ? { recordRunAuditEvent } : {}),
  });
  return { store, recordRunAuditEvent };
}

const rootDir = mkdtempSync(join(tmpdir(), "rufu210-sweep-"));
const scanRoots = resolveWorktreesDirScanRoots(rootDir, {});
const worktreesDir = scanRoots[0]!;

function orphan(pid: number, worktreeId: string, sub = "repo"): OrphanedGitChildCandidate {
  return {
    pid,
    ppid: 1,
    comm: "git",
    ageMs: ORPHANED_GIT_CHILD_GRACE_FLOOR_MS + 60_000,
    observedAtMs: Date.now(),
    cwd: join(worktreesDir, worktreeId, sub),
    cwdMissing: true,
    cwdMissingSource: "path-gone",
    ownedBySelf: true,
  };
}

function probeFor(candidates: OrphanedGitChildCandidate[], available = true): GitChildProcessProbe & {
  signals: Array<{ pid: number; signal: string }>;
} {
  const signals: Array<{ pid: number; signal: string }> = [];
  return {
    available,
    signals,
    async list() {
      return candidates;
    },
    isAlive: () => false,
    signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => {
      signals.push({ pid, signal });
    },
  };
}

const immediateSleep = async () => {};

describe("SelfHealingManager.reapOrphanedWorktreeGitChildren", () => {
  const managers: SelfHealingManager[] = [];

  function managerFor(sinkMode?: "capture" | "absent" | "throw" | "reject" | "pending") {
    const { store, recordRunAuditEvent } = createStore(sinkMode);
    const manager = new SelfHealingManager(store as any, { rootDir });
    managers.push(manager);
    return { manager, recordRunAuditEvent };
  }

  afterEach(() => {
    while (managers.length > 0) managers.pop()!.stop();
  });

  afterAll(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("reaps a proven orphan and emits one reaped row keyed by the deleted worktree path", async () => {
    const { manager, recordRunAuditEvent } = managerFor();
    const probe = probeFor([orphan(41001, "TASK-WT1")]);
    const reaped = await manager.reapOrphanedWorktreeGitChildren({ probe, killGraceMs: 0 });
    expect(reaped).toBe(1);
    expect(probe.signals).toEqual([{ pid: 41001, signal: "SIGTERM" }]);
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "self-healing",
      runId: "orphaned-git-child-reap",
      domain: "git",
      mutationType: "worktree:orphaned-git-child-reaped",
      target: join(worktreesDir, "TASK-WT1"),
      metadata: {
        count: 1,
        pids: [41001],
        ageMs: ORPHANED_GIT_CHILD_GRACE_FLOOR_MS + 60_000,
        reason: "deleted-worktree-cwd",
        outcome: "reaped",
      },
    }));
  });

  it("groups reaps into one audit row per deleted worktree path", async () => {
    const { manager, recordRunAuditEvent } = managerFor();
    const probe = probeFor([
      orphan(41011, "TASK-WT1", "repo"),
      orphan(41012, "TASK-WT1", "repo/sub"),
      orphan(41013, "TASK-WT2"),
    ]);
    const reaped = await manager.reapOrphanedWorktreeGitChildren({ probe, killGraceMs: 0 });
    expect(reaped).toBe(3);
    const rows = recordRunAuditEvent!.mock.calls.map(([row]: any[]) => row);
    expect(rows).toHaveLength(2);
    const wt1 = rows.find((row: any) => row.target === join(worktreesDir, "TASK-WT1"))!;
    const wt2 = rows.find((row: any) => row.target === join(worktreesDir, "TASK-WT2"))!;
    expect(wt1.metadata.count).toBe(2);
    expect(wt1.metadata.pids).toEqual([41011, 41012]);
    expect(wt2.metadata.count).toBe(1);
  });

  it("caps reaped pids at 20 in the audit row while reporting the full count", async () => {
    const { manager, recordRunAuditEvent } = managerFor();
    const many = Array.from({ length: 25 }, (_, i) => orphan(42001 + i, "TASK-WT1", `sub${i}`));
    const probe = probeFor(many);
    const reaped = await manager.reapOrphanedWorktreeGitChildren({ probe, killGraceMs: 0, maxReaps: 25 });
    expect(reaped).toBe(25);
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    const metadata = recordRunAuditEvent!.mock.calls[0]![0]!.metadata;
    expect(metadata.count).toBe(25);
    expect(metadata.pids).toHaveLength(20);
  });

  it("emits the no-action row once while idle and re-arms after a real reap", async () => {
    const { manager, recordRunAuditEvent } = managerFor();
    const idle = probeFor([]);
    expect(await manager.reapOrphanedWorktreeGitChildren({ probe: idle, killGraceMs: 0 })).toBe(0);
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "worktree:orphaned-git-child-reap-no-action",
      target: "orphaned-git-children",
      metadata: { count: 0, outcome: "no-action" },
    }));
    // Second consecutive idle sweep stays silent (per-manager dedupe, mirrors symbol-lock memo).
    expect(await manager.reapOrphanedWorktreeGitChildren({ probe: idle, killGraceMs: 0 })).toBe(0);
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    // A real reap re-arms the diagnostic.
    expect(await manager.reapOrphanedWorktreeGitChildren({ probe: probeFor([orphan(41051, "TASK-WT9")]), killGraceMs: 0 })).toBe(1);
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(2);
    expect(await manager.reapOrphanedWorktreeGitChildren({ probe: idle, killGraceMs: 0 })).toBe(0);
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(3);
    const third = recordRunAuditEvent!.mock.calls[2]![0]!;
    expect(third.mutationType).toBe("worktree:orphaned-git-child-reap-no-action");
  });

  it("sends no signals and writes no audit rows on a host without /proc", async () => {
    const { manager, recordRunAuditEvent } = managerFor();
    const probe = probeFor([orphan(41001, "TASK-WT1")], false);
    expect(await manager.reapOrphanedWorktreeGitChildren({ probe, killGraceMs: 0 })).toBe(0);
    expect(probe.signals).toHaveLength(0);
    // The absent no-action row IS the macOS-host signal: availability-gated before any emission.
    expect(recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it.each(["absent", "throw", "reject", "pending"] as const)(
    "hostile audit sink (%s) cannot change the reap count or throw into the owning branch",
    async (sinkMode) => {
      const { manager } = managerFor(sinkMode);
      const probe = probeFor([orphan(41071, "TASK-WT7")]);
      // "pending" waits out the bounded emit timeout (2s) — the seam, not the sweep, is bounded.
      const reaped = await manager.reapOrphanedWorktreeGitChildren({ probe, killGraceMs: 0 });
      expect(reaped).toBe(1);
      expect(probe.signals).toEqual([{ pid: 41071, signal: "SIGTERM" }]);
    },
    15_000,
  );
});
