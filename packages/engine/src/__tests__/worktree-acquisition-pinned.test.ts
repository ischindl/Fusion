import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { acquireTaskWorktree } from "../worktree/worktree-acquisition.js";

/*
FNXC:TaskPinnedWorktrees 2026-07-16-12:30:
The pinned-mode branch is validated in isolation with mocked git/liveness seams so the tests stay fast and
deterministic (no real-git worktree creation). classifyTaskWorktree / branch lookup / fs existence are the
observable inputs to derive→validate→reuse-or-recreate; we drive each of them.
*/
/*
FNXC:TestHarnessIntegrity 2026-08-12-01:04:
A moved `vi.mock` target and its `importActual` sibling must change together; guarding only the mock target
leaves the factory broken at runtime.
*/
vi.mock("../worktree/worktree-pool.js", async () => {
  const actual = await vi.importActual<any>("../worktree/worktree-pool.js");
  return {
    ...actual,
    classifyTaskWorktree: vi.fn().mockResolvedValue({ ok: true }),
    isInsideWorktreesDir: vi.fn().mockReturnValue(true),
    getRegisteredWorktreeBranches: vi.fn().mockResolvedValue([]),
    canonicalizePath: (p: string) => p,
    defensiveRemovalWouldPreserve: vi.fn().mockResolvedValue(false),
    removeWorktree: vi.fn().mockResolvedValue({ removed: true, classification: "removed" }),
  };
});

/*
FNXC:TestHarnessIntegrity 2026-08-12-01:04:
A moved `vi.mock` target and its `importActual` sibling must change together; guarding only the mock target
leaves the factory broken at runtime.
*/
vi.mock("../execution/branch-conflicts.js", async () => {
  const actual = await vi.importActual<any>("../execution/branch-conflicts.js");
  return {
    ...actual,
    classifyBootstrapMisbinding: vi.fn().mockResolvedValue({
      isBootstrapMisbinding: false,
      ownCommitCount: 0,
      foreignCommitCount: 0,
      nonAttributedCount: 0,
    }),
  };
});

/*
FNXC:TestHarnessIntegrity 2026-08-12-01:04:
The real worktree-pool factory now loads after its sibling path is repaired. Keep this pinned-path suite
filesystem-free by isolating the reservation seam rather than relying on the nonexistent `/repo` fixture root.
*/
vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    canonicalizeWorktreePath: vi.fn(async (path: string) => path),
    acquireWorktreePathReservation: vi.fn(async () => ({
      canonicalPath: "/repo/.fusion/worktrees/fn-7996",
      token: "test-reservation",
      previousState: "free",
      state: "held",
      release: vi.fn(async () => undefined),
      quarantine: vi.fn(async () => undefined),
    })),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: vi.fn(async () => undefined),
    realpath: vi.fn(async (path: string) => path),
    rename: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ isDirectory: () => true })),
  };
});

vi.mock("../worktree/worktree-db-hydrate.js", () => ({
  hydrateWorktreeDb: vi.fn().mockResolvedValue({ degraded: false, tasksCopied: 0, documentsCopied: 0, artifactsCopied: 0 }),
}));

vi.mock("../worktree/worktree-desktop-artifacts.js", () => ({
  removeDesktopBuildArtifacts: vi.fn().mockResolvedValue({ removed: [], skipped: [], failures: [] }),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<any>("node:fs");
  return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
});

import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { classifyTaskWorktree, defensiveRemovalWouldPreserve, getRegisteredWorktreeBranches, removeWorktree } from "../worktree/worktree-pool.js";

const ROOT = "/repo";
const PINNED = join(ROOT, ".fusion", "worktrees", "fn-7996");

function makeStore() {
  return {
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as any;
}

const baseTask = {
  id: "FN-7996",
  title: "Task",
  description: "Desc",
  branch: null,
  worktree: null,
} as any;

const pinnedSettings = { worktreeNaming: "task-id" } as any;

describe("acquireTaskWorktree — task-pinned mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: true } as any);
    vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue([]);
    vi.mocked(removeWorktree).mockResolvedValue({ removed: true, classification: "removed" } as any);
  });

  it("creates fresh at the derived <task-id> path when absent, never suffixed", async () => {
    const createWorktree = vi.fn(async (branch: string, path: string) => ({ path, branch }));
    const result = await acquireTaskWorktree({
      task: baseTask,
      rootDir: ROOT,
      store: makeStore(),
      settings: pinnedSettings,
      createWorktree,
    });

    expect(result.source).toBe("fresh");
    expect(result.worktreePath).toBe(PINNED);
    expect(createWorktree).toHaveBeenCalledWith("fusion/fn-7996", PINNED, "FN-7996", "main", false);
  });

  it("acceptance #2: task B's pinned acquisition yields fn-<B>, never task A's dir", async () => {
    const createWorktree = vi.fn(async (branch: string, path: string) => ({ path, branch }));
    const result = await acquireTaskWorktree({
      task: { ...baseTask, id: "FN-8069" },
      rootDir: ROOT,
      store: makeStore(),
      settings: pinnedSettings,
      createWorktree,
    } as any);

    expect(result.worktreePath).toBe(join(ROOT, ".fusion", "worktrees", "fn-8069"));
    expect(createWorktree).toHaveBeenCalledWith("fusion/fn-8069", join(ROOT, ".fusion", "worktrees", "fn-8069"), "FN-8069", "main", false);
  });

  it("ignores persisted legacy naming and recycle settings while retaining the task-id path", async () => {
    const acquire = vi.fn(() => null);
    const createWorktree = vi.fn(async (branch: string, path: string) => ({ path, branch }));

    const result = await acquireTaskWorktree({
      task: baseTask,
      rootDir: ROOT,
      store: makeStore(),
      settings: { worktreeNaming: "task-id", recycleWorktrees: true } as any,
      // Legacy callers may still supply this unknown option; native acquisition must ignore it.
      pool: { acquire, prepareForTask: vi.fn(), release: vi.fn() } as any,
      createWorktree,
    } as any);

    expect(acquire).not.toHaveBeenCalled();
    expect(result.worktreePath).toBe(PINNED);
  });

  it("warm-reuses the pinned dir when it is usable and on the task branch", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: true } as any);
    vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue([{ branch: "fusion/fn-7996", worktreePath: PINNED }]);
    const createWorktree = vi.fn();

    const result = await acquireTaskWorktree({
      task: { ...baseTask, worktree: PINNED, branch: "fusion/fn-7996" },
      rootDir: ROOT,
      store: makeStore(),
      settings: pinnedSettings,
      createWorktree,
    });

    expect(result.source).toBe("existing");
    expect(result.isResume).toBe(true);
    expect(result.worktreePath).toBe(PINNED);
    expect(createWorktree).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("adopts an orphaned pinned dir (task.worktree null) and persists worktree+branch metadata", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: true } as any);
    vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue([{ branch: "fusion/fn-7996", worktreePath: PINNED }]);
    const store = makeStore();
    const createWorktree = vi.fn();

    const result = await acquireTaskWorktree({
      task: { ...baseTask, worktree: null, branch: null },
      rootDir: ROOT,
      store,
      settings: pinnedSettings,
      createWorktree,
    });

    expect(result.source).toBe("existing");
    expect(result.worktreePath).toBe(PINNED);
    // The successful acquisition must leave the task assigned, not orphaned.
    expect(store.updateTask).toHaveBeenCalledWith("FN-7996", { worktree: PINNED, branch: "fusion/fn-7996", branchWriteOrigin: "engine" });
    expect(createWorktree).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("fails safe (no destructive reclaim) when the branch probe is untrustworthy (empty enumeration)", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: true } as any);
    // classifyTaskWorktree proved the path is a registered usable worktree, yet the branch enumeration is
    // empty — a transient `git worktree list` failure. Must throw rather than reclaim a valid warm worktree.
    vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue([]);
    const createWorktree = vi.fn();

    await expect(
      acquireTaskWorktree({
        task: { ...baseTask, worktree: PINNED, branch: "fusion/fn-7996" },
        rootDir: ROOT,
        store: makeStore(),
        settings: pinnedSettings,
        createWorktree,
      }),
    ).rejects.toThrow(/cannot confirm branch/);

    expect(removeWorktree).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("acceptance #5: reclaims a same-name dir on a foreign branch in place (no suffix)", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: true } as any);
    // Registered, usable — but checked out on a foreign branch.
    vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue([{ branch: "fusion/fn-0000", worktreePath: PINNED }]);
    const createWorktree = vi.fn(async (branch: string, path: string) => ({ path, branch }));
    const audit = { git: vi.fn().mockResolvedValue(undefined), filesystem: vi.fn() } as any;

    const result = await acquireTaskWorktree({
      task: { ...baseTask, worktree: PINNED, branch: "fusion/fn-7996" },
      rootDir: ROOT,
      store: makeStore(),
      settings: pinnedSettings,
      createWorktree,
      audit,
    });

    expect(removeWorktree).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: PINNED }));
    expect(createWorktree).toHaveBeenCalledWith("fusion/fn-7996", PINNED, "FN-7996", "main", false);
    expect(result.worktreePath).toBe(PINNED);
    expect(result.source).toBe("fresh");
    expect(audit.git).toHaveBeenCalledWith(expect.objectContaining({
      type: "worktree:incomplete-detected",
      metadata: expect.objectContaining({ classification: "foreign-branch", source: "pinned-acquire" }),
    }));
  });

  it("preserves an unregistered same-name dir before recreating in place", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: false, classification: "unregistered", reason: "not registered" } as any);
    const createWorktree = vi.fn(async (branch: string, path: string) => ({ path, branch }));

    const result = await acquireTaskWorktree({
      task: baseTask,
      rootDir: ROOT,
      store: makeStore(),
      settings: pinnedSettings,
      createWorktree,
    });

    expect(removeWorktree).not.toHaveBeenCalled();
    expect(rename).toHaveBeenCalledWith(PINNED, expect.stringContaining("/.fusion/recovery/worktrees/fn-7996-"));
    expect(createWorktree).toHaveBeenCalledWith("fusion/fn-7996", PINNED, "FN-7996", "main", false);
    expect(result.worktreePath).toBe(PINNED);
  });

  /*
  FNXC:WorktreeCleanup 2026-09-25-19:30:
  RUFU-278 symptom verification. A checkout whose content the preservation policy refuses to delete must be
  moved aside while the card keeps running. The old shape had no third outcome: remove, or throw and let the
  executor terminalize the card — which is how RUFU-260 parked with
  "Worktree acquisition failed after 3 heartbeat attempts ...: preserving <path>: uncommitted or ignored content
  present" while its retained checkout head-of-line blocked 14 other RunFusion cards at the file-scope gate.
  The assertion set is the invariant, not the repro: nothing is deleted, the path is vacated by rename, the
  pinned path is recreated, the audit row names the reason, and acquisition resolves instead of rejecting.
  */
  it("RUFU-278: preserves a checkout removal refuses to delete, recreates the pinned path, does not fail the card", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: true } as any);
    // Registered and usable, but on a foreign branch -> reclaim, so the removal strategy is chosen here.
    vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue([{ branch: "fusion/fn-0000", worktreePath: PINNED }]);
    vi.mocked(defensiveRemovalWouldPreserve).mockResolvedValue(true);
    const createWorktree = vi.fn(async (branch: string, path: string) => ({ path, branch }));
    const store = makeStore();
    const audit = { git: vi.fn().mockResolvedValue(undefined), filesystem: vi.fn() } as any;

    const result = await acquireTaskWorktree({
      task: { ...baseTask, worktree: PINNED, branch: "fusion/fn-7996" },
      rootDir: ROOT,
      store,
      settings: pinnedSettings,
      createWorktree,
      audit,
    });

    // The refusal is predicted up front, so the destructive call is never attempted.
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(rename).toHaveBeenCalledWith(PINNED, expect.stringContaining("/.fusion/recovery/worktrees/fn-7996-"));
    expect(result.worktreePath).toBe(PINNED);
    expect(result.source).toBe("fresh");
    expect(audit.filesystem).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ taskId: "FN-7996", classification: "content-preservation" }),
    }));
    const logCalls: unknown[][] = (store.logEntry as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(logCalls.some(([, message]) => String(message).includes("removal refused"))).toBe(true);
  });

  it("acceptance #3: self-corrects a stale/foreign task.worktree pointer and emits worktree:pin-rederived", async () => {
    // FN-7996 shape: task.worktree points at a foreign, removed pool dir; pinned dir itself is absent.
    vi.mocked(existsSync).mockReturnValue(false);
    const createWorktree = vi.fn(async (branch: string, path: string) => ({ path, branch }));
    const audit = { git: vi.fn().mockResolvedValue(undefined), filesystem: vi.fn() } as any;
    const store = makeStore();

    const result = await acquireTaskWorktree({
      task: { ...baseTask, worktree: join(ROOT, ".worktrees", "grand-ridge"), branch: "fusion/fn-7996" },
      rootDir: ROOT,
      store,
      settings: pinnedSettings,
      createWorktree,
      audit,
    });

    expect(audit.git).toHaveBeenCalledWith(expect.objectContaining({
      type: "worktree:pin-rederived",
      metadata: expect.objectContaining({ taskId: "FN-7996", derived: PINNED }),
    }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-7996", { worktree: PINNED });
    expect(result.worktreePath).toBe(PINNED);
    expect(result.source).toBe("fresh");
  });
});
