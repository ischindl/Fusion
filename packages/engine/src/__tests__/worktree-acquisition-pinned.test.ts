import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { acquireTaskWorktree } from "../worktree/worktree-acquisition.js";
import { pinnedWorktreePathForTask } from "../worktree/worktree-pinning.js";
import { resolveWorktreesDir, WORKTREE_RECOVERY_DIRNAME } from "../worktree/worktree-paths.js";

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
    // FNXC:WorktreeCleanup 2026-09-26-01:29: RUFU-298 — pinned reclaim decides from the classification probe
    // and prunes the vacated registration explicitly; both pool seams are enumerable mock surface here.
    probeWorktreeRemovalContent: vi.fn().mockResolvedValue({ classification: "clean", entryCount: 0, uncommittedPaths: [], modifiedCount: 0, untrackedCount: 0, status: "classified" }),
    pruneWorktreeAdminEntries: vi.fn().mockResolvedValue(undefined),
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
import { classifyTaskWorktree, probeWorktreeRemovalContent, pruneWorktreeAdminEntries, getRegisteredWorktreeBranches, removeWorktree, type DefensiveRemovalContentProbe } from "../worktree/worktree-pool.js";

/*
FNXC:WorktreeCleanup 2026-10-02-15:56 (RUFU-298 sync with main's shipped probe): RUFU-274's probe returns a full
removal-notice shape and reports an unreadable tree as `status: "probe-failed"` rather than rejecting, so every
mock here states the whole record. `unverifiable` therefore means a status the caller must not decide from — never
a thrown error — and the helper makes the classified/unverifiable pair explicit at each decision-table row.
*/
function probe(classification: DefensiveRemovalContentProbe["classification"], entryCount: number, over: Partial<DefensiveRemovalContentProbe> = {}): DefensiveRemovalContentProbe {
  return {
    classification,
    entryCount,
    uncommittedPaths: classification === "deliverable" ? ["wip.ts"] : [],
    modifiedCount: 0,
    untrackedCount: classification === "deliverable" ? 1 : 0,
    status: "classified",
    ...over,
  };
}

function unverifiableProbe(): DefensiveRemovalContentProbe {
  return probe("ignored-only", 0, { status: "probe-failed", probeError: "git status probe failed: not a git repository" });
}


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
    // RUFU-298: `vi.clearAllMocks()` clears call records but keeps implementations, so a probe class set by an
    // earlier case would leak into later ones. Re-establish the clean baseline every test.
    vi.mocked(probeWorktreeRemovalContent).mockResolvedValue(probe("clean", 0));
    vi.mocked(pruneWorktreeAdminEntries).mockResolvedValue(undefined);
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
    vi.mocked(probeWorktreeRemovalContent).mockResolvedValue(probe("deliverable", 2));
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
    // RUFU-298: the preserve rename must be followed by an explicit admin-entry prune so the recreation at
    // the same pinned path never depends on the branch-collision ladder's incidental prune.
    expect(pruneWorktreeAdminEntries).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: ROOT,
      reason: "task-pinned-preserving-reclaim",
      target: PINNED,
    }));
    expect(result.worktreePath).toBe(PINNED);
    expect(result.source).toBe("fresh");
    expect(audit.filesystem).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ taskId: "FN-7996", classification: "deliverable", reason: "task-pinned-content-preserved" }),
    }));
    const logCalls: unknown[][] = (store.logEntry as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    // RUFU-298: the task log names the class that caused preservation — "removal refused" was RUFU-278's
    // wording and is no longer true, because the reclaim now decides from the probe and never attempts a
    // removal it already knows will be refused.
    expect(logCalls.some(([, message]) => String(message).includes("deliverable content the removal policy will not delete"))).toBe(true);
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

  /*
  FNXC:WorktreeCleanup 2026-09-26-02:28 (RUFU-298 — the whole decision table, not only the preserved row):
  RUFU-260 was one instance of a class of card, and a fix proven on that instance alone is how the
  streamed-response and Show-hidden regressions happened three times over. The card that survives pinned
  reclaim is chosen by the FN-9233 class, so every row of that table is asserted here: the two removable
  classes must still go through `removeWorktree` (a preserve on allowlisted build output would strand
  gigabytes in the recovery root and hide the FN-9233 discard audit), and the two preserved classes must
  never reach it. The `unverifiable` row is the fail-closed contract: an unreadable tree is never moved,
  and the byte-identical removal refusal still surfaces.
  */
  describe("content-policy decision table", () => {
    const foreignRegistration = [{ branch: "fusion/fn-0000", worktreePath: PINNED }];

    function driveReclaim(createWorktree = vi.fn(async (branch: string, path: string) => ({ path, branch }))) {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: true } as any);
      vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue(foreignRegistration as any);
      return acquireTaskWorktree({
        task: { ...baseTask, worktree: PINNED, branch: "fusion/fn-7996" },
        rootDir: ROOT,
        store: makeStore(),
        settings: pinnedSettings,
        createWorktree,
        audit: { git: vi.fn().mockResolvedValue(undefined), filesystem: vi.fn() } as any,
      });
    }

    it.each([
      { name: "clean", entryCount: 0 },
      { name: "regenerable-ignored", entryCount: 1 },
    ])("removes $name in place instead of preserving it", async ({ name, entryCount }) => {
      vi.mocked(probeWorktreeRemovalContent).mockResolvedValue(probe(name as DefensiveRemovalContentProbe["classification"], entryCount));

      const result = await driveReclaim();

      expect(removeWorktree).toHaveBeenCalledTimes(1);
      expect(removeWorktree).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: PINNED, reason: "pool-prune" }));
      // The removal-side FN-9233 rows stay suppressed at this call site exactly as before the probe was shared.
      expect((removeWorktree.mock.calls[0] as unknown as [Record<string, unknown>])[0].audit).toBeUndefined();
      expect(rename).not.toHaveBeenCalled();
      expect(pruneWorktreeAdminEntries).not.toHaveBeenCalled();
      expect(result.worktreePath).toBe(PINNED);
      expect(result.source).toBe("fresh");
    });

    it.each(["ignored-only", "deliverable"])("preserves a %s checkout aside and recreates the pinned path", async (classification) => {
      vi.mocked(probeWorktreeRemovalContent).mockResolvedValue(probe(classification as any, 1));
      const audit = { git: vi.fn().mockResolvedValue(undefined), filesystem: vi.fn() } as any;
      vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: true } as any);
      vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue(foreignRegistration as any);
      vi.mocked(existsSync).mockReturnValue(true);
      const createWorktree = vi.fn(async (branch: string, path: string) => ({ path, branch }));

      const result = await acquireTaskWorktree({
        task: { ...baseTask, worktree: PINNED, branch: "fusion/fn-7996" },
        rootDir: ROOT,
        store: makeStore(),
        settings: pinnedSettings,
        createWorktree,
        audit,
      });

      expect(removeWorktree).not.toHaveBeenCalled();
      expect(rename).toHaveBeenCalledWith(PINNED, expect.stringContaining("/.fusion/recovery/worktrees/fn-7996-"));
      expect(pruneWorktreeAdminEntries).toHaveBeenCalledWith(expect.objectContaining({ reason: "task-pinned-preserving-reclaim", target: PINNED }));
      // The audit row carries the class that caused preservation — the opaque "content-preservation" label is gone.
      expect(audit.filesystem).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ taskId: "FN-7996", classification, reason: "task-pinned-content-preserved" }),
      }));
      expect(createWorktree).toHaveBeenCalledWith("fusion/fn-7996", PINNED, "FN-7996", "main", false);
      expect(result.worktreePath).toBe(PINNED);
    });

    /*
     * FNXC:WorktreeCleanup 2026-10-02-15:56 (RUFU-298 sync with main's shipped probe): `unverifiable` reaches this
     * call site in two shapes — RUFU-274's `status: "probe-failed"` record (the probe never rejects) and a
     * rejection at the probe seam (defence-in-depth for a probe that raises again). Both must decide NOTHING:
     * no preserve rename, no prune, and the byte-identical removal refusal still surfaces from removeWorktree.
     */
    it.each([
      { name: "probe reports an unreadable tree", probeResult: () => unverifiableProbe() },
      { name: "probe seam rejects", probeResult: () => { throw new Error("status probe failed: not a git repository"); } },
    ])("moves nothing when the $name and still surfaces the fail-closed removal refusal", async ({ probeResult }) => {
      vi.mocked(probeWorktreeRemovalContent).mockImplementation(async () => probeResult());
      vi.mocked(removeWorktree).mockRejectedValue(new Error("preserving /repo/.fusion/worktrees/fn-7996: uncommitted or ignored content present"));
      const createWorktree = vi.fn();
      vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: true } as any);
      vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue(foreignRegistration as any);
      vi.mocked(existsSync).mockReturnValue(true);

      await expect(acquireTaskWorktree({
        task: { ...baseTask, worktree: PINNED, branch: "fusion/fn-7996" },
        rootDir: ROOT,
        store: makeStore(),
        settings: pinnedSettings,
        createWorktree,
      })).rejects.toThrow(/preserving .*: uncommitted or ignored content present/);

      // `unverifiable` is not coerced into a preservable class: the destructive guard owns the decision.
      expect(removeWorktree).toHaveBeenCalledTimes(1);
      expect(rename).not.toHaveBeenCalled();
      expect(pruneWorktreeAdminEntries).not.toHaveBeenCalled();
      expect(createWorktree).not.toHaveBeenCalled();
    });

    /*
    FNXC:TaskPinnedWorktrees 2026-08-10-01:12 / RUFU-298 acceptance #6:
    A cross-filesystem rename falls back to preserving beside the CONFIGURED worktree root, and that root is
    resolved with the workspace context — a workspace card's preserved checkout must not land in the parent
    project's `.fusion/recovery`. The expected root is recomputed with production's own resolver so a layout
    change moves the test and the product together instead of stranding the assertion.
    */
    it("preserves beside the workspace-resolved worktree root when the rename crosses filesystems", async () => {
      const workspaceContext = { workspaceRootDir: "/ws", repoRelPath: "repos/app" } as any;
      const settings = { ...pinnedSettings, worktreesDir: undefined } as any;
      const pinnedPath = pinnedWorktreePathForTask("FN-7996", settings, ROOT, workspaceContext);
      const exdev = Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      vi.mocked(rename).mockRejectedValueOnce(exdev);
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: true } as any);
      vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue([{ branch: "fusion/fn-0000", worktreePath: pinnedPath }] as any);
      vi.mocked(probeWorktreeRemovalContent).mockResolvedValue(probe("ignored-only", 1));
      const createWorktree = vi.fn(async (branch: string, path: string) => ({ path, branch }));

      const result = await acquireTaskWorktree({
        task: { ...baseTask, worktree: pinnedPath, branch: "fusion/fn-7996" },
        rootDir: ROOT,
        store: makeStore(),
        settings,
        createWorktree,
        workspaceContext,
      });

      const workspaceRecoveryRoot = join(resolveWorktreesDir(ROOT, settings, workspaceContext), WORKTREE_RECOVERY_DIRNAME, "worktrees");
      const targets = (rename as unknown as { mock: { calls: string[][] } }).mock.calls.map(([from, to]) => to);
      expect(targets.some((target) => target.startsWith(workspaceRecoveryRoot) && target.includes("fn-7996-"))).toBe(true);
      expect(removeWorktree).not.toHaveBeenCalled();
      expect(result.worktreePath).toBe(pinnedPath);
      expect(result.source).toBe("fresh");
    });
  });
});
