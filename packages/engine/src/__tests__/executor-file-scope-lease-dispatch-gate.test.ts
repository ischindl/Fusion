import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileScopeLeaseScopeFingerprint, type Settings, type Task, type TaskStore } from "@fusion/core";
import { blockOuterDispatchWhenFileScopeLeaseHeld } from "../executor/file-scope-lease-dispatch-gate.js";
import { resetCheckoutEmptinessProversForTesting } from "../worktree/checkout-emptiness.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-CANDIDATE",
    title: "candidate",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function createStore(
  tasks: Task[],
  scopes: Record<string, string[]>,
  settings: Partial<Settings> = {},
  opts: { rootDir?: string } = {},
): TaskStore {
  return {
    getSettings: vi.fn(async () => ({ groupOverlappingFiles: true, ...settings })),
    listTasks: vi.fn(async () => tasks),
    parseFileScopeFromPrompt: vi.fn(async (taskId: string) => scopes[taskId] ?? []),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getRootDir: vi.fn(() => opts.rootDir ?? "/nonexistent-fusion-root"),
    /*
    FNXC:OverlapScheduling 2026-09-09-01:55 (RUFU-200):
    The fake mirrors `transitionQueuedEpisodeImpl` (packages/core/src/task-store/audit-ops.ts) exactly on
    the ONE rule that decides whether an operator sees a queued announcement: a log entry is appended only
    when the (status=queued, blockedBy, overlapBlockedBy, signature) tuple changed. The authoritative
    per-episode dedupe stays pinned by queued-episode-transition.pg.test.ts against the real store; the
    mirror here lets gate tests count the announcements the operator would actually see across repeated
    dispatch passes instead of raw call counts.
    */
    transitionQueuedEpisode: vi.fn(async (taskId: string, transition: { blockedBy: string | null; overlapBlockedBy: string | null; signature: string; action: string; outcome: string }) => {
      const task = tasks.find((candidate) => candidate.id === taskId)!;
      const appended = !(
        task.status === "queued"
        && (task.blockedBy ?? null) === transition.blockedBy
        && (task.overlapBlockedBy ?? null) === transition.overlapBlockedBy
        && (task.queuedLogEpisodeSignature ?? null) === transition.signature
      );
      const log = Array.isArray(task.log) ? [...task.log] : [];
      if (appended) {
        log.push({ timestamp: new Date().toISOString(), action: transition.action, outcome: transition.outcome });
      }
      Object.assign(task, {
        status: "queued",
        blockedBy: transition.blockedBy,
        overlapBlockedBy: transition.overlapBlockedBy,
        queuedLogEpisodeSignature: transition.signature,
        log,
      });
      return { appended, task };
    }),
    updateTaskAtomic: vi.fn(async (taskId: string, update: (task: Task) => Partial<Task> | null) => {
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) return undefined;
      const patch = update(task);
      if (!patch) return undefined;
      Object.assign(task, patch);
      return task;
    }),
    moveTask: vi.fn(),
    moveTaskIf: vi.fn(),
  } as unknown as TaskStore;
}

describe("blockOuterDispatchWhenFileScopeLeaseHeld", () => {
  it.each(["singular", "workspace"])("does not block fresh work behind a landed %s checkout", async (kind) => {
    const holder = makeTask({
      id: "FN-HOLDER", column: "in-review", mergeDetails: { mergeConfirmed: true },
      ...(kind === "singular" ? { worktree: "/wt/retained" } : {
        workspaceWorktrees: { repo: { worktreePath: "/wt/repo" } } as Task["workspaceWorktrees"],
      }),
    });
    const candidate = makeTask();
    const store = createStore([holder, candidate], {
      [holder.id]: ["src/shared.ts"], [candidate.id]: ["src/shared.ts"],
    });
    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(false);
    expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
  });

  it("does not reacquire implementation scope for landed verification behind new work", async () => {
    const candidate = makeTask({ column: "in-review", worktree: "/wt/retained", mergeDetails: { mergeConfirmed: true } });
    const holder = makeTask({ id: "FN-HOLDER", column: "in-progress" });
    const store = createStore([holder, candidate], {
      [holder.id]: ["src/shared.ts"], [candidate.id]: ["src/shared.ts"],
    });
    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(false);
    expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
  });

  it.each(["prerequisite", "unrelated"])("admits a ready %s past an older dependency-blocked dormant holder", async (kind) => {
    const candidate = makeTask();
    const dependency = kind === "prerequisite" ? candidate : makeTask({ id: "FN-DEP" });
    const holder = makeTask({ id: "FN-HOLDER", worktree: "/wt/holder", dependencies: [dependency.id],
      blockedBy: dependency.id, createdAt: "2026-01-01T00:00:00Z" });
    const store = createStore([holder, candidate, ...(dependency === candidate ? [] : [dependency])], {
      [holder.id]: ["src/shared.ts"], [candidate.id]: ["src/shared.ts"],
    });
    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(false);
    expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
    expect(holder.worktree).toBe("/wt/holder");
  });

  it("reacquires and invalidates a stale scope receipt before outer dispatch", async () => {
    const holder = makeTask({
      id: "FN-HOLDER", lineageId: "holder-lineage", column: "in-progress", paused: true,
      fileScopeLeaseRelease: {
        holderId: "FN-HOLDER",
        holderLineageId: "holder-lineage",
        scopeFingerprint: fileScopeLeaseScopeFingerprint(["docs/old.md"]),
        releasedFollowerIds: ["FN-CANDIDATE"],
        checkoutIdentity: "no-checkout",
        inspectedAt: "2026-01-01T00:00:00.000Z",
        revision: 4,
      },
    });
    const candidate = makeTask();
    const store = createStore([holder, candidate], {
      [holder.id]: ["docs/current.md"],
      [candidate.id]: ["docs/current.md"],
    });

    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(true);

    expect(store.updateTaskAtomic).toHaveBeenCalledWith(holder.id, expect.any(Function));
    expect(holder.fileScopeLeaseRelease).toBeUndefined();
    expect(store.transitionQueuedEpisode).toHaveBeenCalledWith(candidate.id, expect.objectContaining({
      overlapBlockedBy: holder.id,
    }));
  });

  it("holds a fresh dispatch behind an overlapping active lease without moving its column", async () => {
    const holder = makeTask({ id: "FN-HOLDER", column: "in-progress", createdAt: "2026-01-01T00:00:00.000Z" });
    const candidate = makeTask({ blockedBy: "FN-DEP" });
    const store = createStore([holder, candidate], {
      [holder.id]: ["packages/core/src/store.ts"],
      [candidate.id]: ["packages/core/src/store.ts"],
    });

    const blocked = await blockOuterDispatchWhenFileScopeLeaseHeld({
      store,
      getRunContextFor: () => undefined,
    }, candidate);

    expect(blocked).toBe(true);
    expect(store.transitionQueuedEpisode).toHaveBeenCalledWith(candidate.id, expect.objectContaining({
      signature: `file-scope:${holder.id}`,
      blockedBy: "FN-DEP",
      overlapBlockedBy: holder.id,
    }));
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });

  it("does not hold a task that already owns a worktree", async () => {
    const holder = makeTask({ id: "FN-HOLDER", column: "in-progress" });
    const candidate = makeTask({ worktree: "/wt/fn-candidate" });
    const store = createStore([holder, candidate], {
      [holder.id]: ["packages/core/src/store.ts"],
      [candidate.id]: ["packages/core/src/store.ts"],
    });

    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(false);
    expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
  });

  it("does not re-hold a workspace task that already owns repository checkouts", async () => {
    const holder = makeTask({ id: "FN-HOLDER", column: "in-progress" });
    const candidate = makeTask({ workspaceWorktrees: { "repo-a": { worktreePath: "/wt/fn-candidate/repo-a" } } as Task["workspaceWorktrees"] });
    const store = createStore([holder, candidate], {
      [holder.id]: ["repo-a/src/shared.ts"],
      [candidate.id]: ["repo-a/src/shared.ts"],
    });

    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(false);
    expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
  });

  it("holds a fresh workspace task with no repository checkouts", async () => {
    const holder = makeTask({ id: "FN-HOLDER", column: "in-progress" });
    const candidate = makeTask({ workspaceWorktrees: {} });
    const store = createStore([holder, candidate], {
      [holder.id]: ["repo-a/src/shared.ts"],
      [candidate.id]: ["repo-a/src/shared.ts"],
    });

    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(true);
    expect(store.transitionQueuedEpisode).toHaveBeenCalledOnce();
  });

  /*
  FNXC:OverlapScheduling 2026-11-21-10:26 (RUFU-832): this case used to prove a workspace REVIEW checkout
  was an active holder. A review-trait lane releases its claim now, so the pair states both halves of the
  new truth: a review-lane workspace holder admits the candidate, while a workspace-only holder in the
  WIP lane - a card with no singular `task.worktree` - is still registered as a claimant. What stays
  under test is that the gate reads the WORKSPACE checkout form, not just the singular one.
  */
  it("releases a candidate behind a workspace review holder while a workspace WIP holder still claims", async () => {
    const workspaceWorktrees = { "repo-a": { worktreePath: "/wt/fn-holder/repo-a" } } as Task["workspaceWorktrees"];
    const reviewHolder = makeTask({ id: "FN-HOLDER", column: "in-review", workspaceWorktrees });
    const candidate = makeTask();
    const reviewStore = createStore([reviewHolder, candidate], {
      [reviewHolder.id]: ["repo-a/src/shared.ts"],
      [candidate.id]: ["repo-a/src/shared.ts"],
    });

    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store: reviewStore, getRunContextFor: () => undefined }, candidate)).resolves.toBe(false);
    expect(reviewStore.transitionQueuedEpisode).not.toHaveBeenCalled();

    const wipHolder = makeTask({ id: "FN-HOLDER", column: "in-progress", workspaceWorktrees });
    const wipCandidate = makeTask({ id: "FN-CANDIDATE" });
    const wipStore = createStore([wipHolder, wipCandidate], {
      [wipHolder.id]: ["repo-a/src/shared.ts"],
      [wipCandidate.id]: ["repo-a/src/shared.ts"],
    });

    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store: wipStore, getRunContextFor: () => undefined }, wipCandidate)).resolves.toBe(true);
    expect(wipStore.transitionQueuedEpisode).toHaveBeenCalledWith(wipCandidate.id, expect.objectContaining({ overlapBlockedBy: wipHolder.id }));
  });

  it("does not apply overlap admission when grouping is disabled", async () => {
    const holder = makeTask({ id: "FN-HOLDER", column: "in-progress" });
    const candidate = makeTask();
    const store = createStore([holder, candidate], {
      [holder.id]: ["packages/core/src/store.ts"],
      [candidate.id]: ["packages/core/src/store.ts"],
    }, { groupOverlappingFiles: false });

    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(false);
    expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
  });

  it("does not hold a candidate whose only shared entry with a WIP holder is the core barrel (RUFU-226)", async () => {
    /*
    FNXC:OverlapScheduling 2026-09-11-22:56:
    The measured incident at the dispatch door: holder parked in review with its worktree retained
    (`autoMerge:false`) whose scope shares ONLY `packages/core/src/index.ts` with the candidate.
    Barrel lines are append-only shared traffic — dispatch must proceed without a queue stamp or a
    settings change; the paired test below proves a real shared file still holds.

    FNXC:OverlapScheduling 2026-11-21-10:26 (RUFU-832):
    The holder here moved from `in-review` to the WIP lane on purpose. RUFU-832 releases the whole
    review lane, so a review holder would make BOTH arms of this pair pass for the wrong reason (no
    lease at all, barrel matcher never consulted). A WIP holder still claims the files, so the barrel
    exemption and its guard keep discriminating exactly as they did.
    */
    const holder = makeTask({ id: "FN-HOLDER", column: "in-progress", worktree: "/wt/fn-holder", autoMerge: false, createdAt: "2026-01-01T00:00:00.000Z" });
    const candidate = makeTask({ id: "FN-CANDIDATE", createdAt: "2026-01-02T00:00:00.000Z" });
    const store = createStore([holder, candidate], {
      [holder.id]: ["packages/core/src/index.ts", "packages/core/src/store.ts"],
      [candidate.id]: ["packages/core/src/index.ts", "packages/engine/src/scheduler.ts"],
    });

    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(false);
    expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
    expect(candidate.overlapBlockedBy ?? null).toBeNull();
  });

  it("holds the candidate when the barrel-shared scopes also share a real file (RUFU-226 guard)", async () => {
    // RUFU-832: WIP holder for the same reason as the paired case above - it is the lane that still claims.
    const holder = makeTask({ id: "FN-HOLDER", column: "in-progress", worktree: "/wt/fn-holder", autoMerge: false, createdAt: "2026-01-01T00:00:00.000Z" });
    const candidate = makeTask({ id: "FN-CANDIDATE", createdAt: "2026-01-02T00:00:00.000Z" });
    const store = createStore([holder, candidate], {
      [holder.id]: ["packages/core/src/index.ts", "packages/core/src/store.ts"],
      [candidate.id]: ["packages/core/src/index.ts", "packages/core/src/store.ts"],
    });

    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(true);
    expect(store.transitionQueuedEpisode).toHaveBeenCalledWith(candidate.id, expect.objectContaining({
      signature: `file-scope:${holder.id}`,
      overlapBlockedBy: holder.id,
    }));
  });

  it("leaves stale overlap bookkeeping for the scheduler when no live holder overlaps", async () => {
    const holder = makeTask({ id: "FN-HOLDER", column: "in-progress" });
    const candidate = makeTask({ overlapBlockedBy: "FN-STALE" });
    const store = createStore([holder, candidate], {
      [holder.id]: ["packages/engine/src/scheduler.ts"],
      [candidate.id]: ["packages/core/src/store.ts"],
    });

    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(false);
    expect(candidate.overlapBlockedBy).toBe("FN-STALE");
    expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
  });

  /*
  FNXC:OverlapScheduling 2026-09-09-01:55 (RUFU-200):
  The operator-visible effect of this gate is the queued announcement, keyed per episode by
  `file-scope:<blocker id>`. With the holder-side emptiness proof, three things must hold, verified
  against REAL git evidence (the proof runs real `git status --porcelain` + `rev-list` in an ephemeral
  repository — a mocked proof would test nothing about the fail-closed rule):
  1. a proven-empty phantom holder produces no queued notice at all;
  2. a genuinely-occupied re-block announces once across repeated dispatch passes (the gate asks every
     pass; the episode tuple keeps the announcement count at one);
  3. switching the blocking holder id changes the signature and announces again.
  */
  describe("one announcement per blocked episode (RUFU-200)", () => {
    const tmpPaths: string[] = [];

    afterEach(() => {
      resetCheckoutEmptinessProversForTesting();
      while (tmpPaths.length) {
        const path = tmpPaths.pop()!;
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup of the ephemeral fixture */
        }
      }
    });

    /** Ephemeral main repo plus one registered worktree on `fusion/fn-holder` at the base commit. */
    function createRepoWithHolderWorktree(): { rootDir: string; worktreePath: string } {
      const rootDir = mkdtempSync(join(tmpdir(), "rufu-200-gate-"));
      tmpPaths.push(rootDir);
      const run = (cmd: string, cwd = rootDir) => execSync(cmd, { cwd, stdio: "pipe" });
      run("git init -b main .");
      run('git config user.email "test@fusion.local"');
      run('git config user.name "Fusion Test"');
      writeFileSync(join(rootDir, "base.txt"), "base\n");
      run("git add -A && git commit -m init");
      const worktreePath = mkdtempSync(join(tmpdir(), "rufu-200-gate-wt-"));
      rmSync(worktreePath, { recursive: true, force: true }); // git requires an absent target dir
      tmpPaths.push(worktreePath);
      run(`git worktree add "${worktreePath}" -b fusion/fn-holder main`);
      return { rootDir, worktreePath };
    }

    function holderTasks(worktreePath: string) {
      const holder = makeTask({
        id: "FN-HOLDER",
        column: "todo",
        createdAt: "2026-01-01T00:00:00.000Z",
        worktree: worktreePath,
        branch: "fusion/fn-holder",
      });
      const candidate = makeTask({ id: "FN-CANDIDATE", column: "todo" });
      return { holder, candidate };
    }

    const sharedScope = (holderId: string, candidateId: string) => ({
      [holderId]: ["packages/core/src/store.ts"],
      [candidateId]: ["packages/core/src/store.ts"],
    });

    it("produces no queued notice at all for a proven-empty phantom holder", async () => {
      const { rootDir, worktreePath } = createRepoWithHolderWorktree();
      const { holder, candidate } = holderTasks(worktreePath);
      const store = createStore(
        [holder, candidate],
        sharedScope(holder.id, candidate.id),
        { integrationBranch: "main" },
        { rootDir },
      );

      await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(false);

      // The gate may still be asked again next pass, but the phantom never reaches the episode machine.
      expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
      expect((candidate.log ?? []).filter((entry) => String(entry.action).includes("file-scope lease"))).toHaveLength(0);
    });

    it("announces a genuinely-occupied hold exactly once across repeated dispatch passes", async () => {
      const { rootDir, worktreePath } = createRepoWithHolderWorktree();
      writeFileSync(join(worktreePath, "untracked-work.txt"), "uncommitted work\n"); // ⇒ occupied proof
      const { holder, candidate } = holderTasks(worktreePath);
      const store = createStore(
        [holder, candidate],
        sharedScope(holder.id, candidate.id),
        { integrationBranch: "main" },
        { rootDir },
      );

      for (let pass = 0; pass < 3; pass += 1) {
        await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(true);
      }

      // The gate reports the hold every pass; the episode tuple keeps the operator-visible announcement at one.
      expect(store.transitionQueuedEpisode).toHaveBeenCalledTimes(3);
      const queuedNotices = (candidate.log ?? []).filter((entry) => String(entry.action).includes("waiting for dormant file-scope lease FN-HOLDER"));
      expect(queuedNotices).toHaveLength(1);
      expect(candidate.overlapBlockedBy).toBe("FN-HOLDER");
      expect(candidate.queuedLogEpisodeSignature).toBe("file-scope:FN-HOLDER");
    });

    it("announces again when the blocking holder id switches", async () => {
      const { rootDir, worktreePath } = createRepoWithHolderWorktree();
      writeFileSync(join(worktreePath, "untracked-work.txt"), "uncommitted work\n"); // ⇒ occupied proof
      const { holder, candidate } = holderTasks(worktreePath);
      // A second occupied dormant holder, junior to FN-HOLDER but senior to the candidate.
      const alternate = makeTask({
        id: "FN-HOLDER-B",
        column: "todo",
        createdAt: "2026-01-01T12:00:00.000Z",
        worktree: worktreePath,
        branch: "fusion/fn-holder",
      });
      const tasks = [holder, alternate, candidate];
      const store = createStore(
        tasks,
        {
          [holder.id]: ["packages/core/src/store.ts"],
          [alternate.id]: ["packages/core/src/store.ts"],
          [candidate.id]: ["packages/core/src/store.ts"],
        },
        { integrationBranch: "main" },
        { rootDir },
      );

      await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(true);
      // Senior-first selection: the older holder owns the episode.
      expect(candidate.overlapBlockedBy).toBe("FN-HOLDER");

      // The episode's holder disappears (soft-delete is the production shape the sweep leaves behind).
      holder.deletedAt = new Date().toISOString();

      await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(true);

      expect(candidate.overlapBlockedBy).toBe("FN-HOLDER-B");
      const queuedNotices = (candidate.log ?? []).filter((entry) => String(entry.action).includes("waiting for dormant file-scope lease"));
      expect(queuedNotices).toHaveLength(2); // one per blocker id — the switch re-announces
      expect(String(queuedNotices[1].action)).toContain("FN-HOLDER-B");
    });
  });
});
