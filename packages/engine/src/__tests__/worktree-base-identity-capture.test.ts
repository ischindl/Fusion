/*
FNXC:BranchBaseIdentity 2026-09-13-00:40:
RUFU-231 (Mission defect 1 / Deliverable 2): acquire must record the base identity it
actually cut/rebased onto so a future wedge is diagnosable from the task row alone.

The RUFU-217 wedge carried NO baseBranch / executionStartBranch / baseCommitSha: the
default-base singular acquisition persisted none of them, and the post-create rebase onto
`<remote>/<integrationBranch>` (worktreeRebaseBeforeMerge, on by default) left the branch
tip on the remote-tracking identity while any later capture measured only against local
main. Every zero-loss proof then saw inherited landed work as unique foreign content.

These tests pin the post-fix contract on real git: the recorded identity names the commit
the branch actually sits on (remote-tracking truth after a rebase; local truth when local
is ahead — the FN-5937 inflation guard), a vanished requested base is never resurrected
(FN-2165), and workspace per-repo entries record their resolved base even when none was
explicitly requested.
*/
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { acquireTaskWorktree, acquireWorkspaceRepoWorktree } from "../worktree/worktree-acquisition.js";
import { ActiveSessionRegistry } from "../agents/active-session-registry.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

vi.mock("../worktree/worktree-db-hydrate.js", () => ({
  hydrateWorktreeDb: vi.fn().mockResolvedValue({ degraded: false, tasksCopied: 1, documentsCopied: 1, artifactsCopied: 0 }),
}));

vi.mock("../worktree/worktree-desktop-artifacts.js", () => ({
  removeDesktopBuildArtifacts: vi.fn().mockResolvedValue({ removed: [], skipped: [], failures: [] }),
}));

vi.mock("../worktree/worktree-hooks.js", async () => {
  const actual = await vi.importActual<typeof import("../worktree/worktree-hooks.js")>("../worktree/worktree-hooks.js");
  return {
    ...actual,
    installTaskWorktreeIdentityGuard: vi.fn().mockResolvedValue(undefined),
  };
});

const describeIfGit = hasGit ? describe : describe.skip;

function git(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: "base identity capture",
    status: "in-progress",
    worktree: null,
    branch: null,
    ...overrides,
  } as Task;
}

function makeStore(task: Task) {
  let current = task;
  const patches: Array<Partial<Task>> = [];
  const store = {
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      if (id !== current.id) throw new Error(`Task ${id} not found`);
      patches.push(patch);
      current = { ...current, ...patch };
      return current;
    }),
    logEntry: vi.fn(async () => undefined),
    getTask: vi.fn(async (id: string) => (id === current.id ? current : null)),
    async mergeWorkspaceWorktreeEntry(
      id: string,
      repoRelPath: string,
      patch: Partial<NonNullable<Task["workspaceWorktrees"]>[string]> | ((fresh: Task) => Promise<Partial<NonNullable<Task["workspaceWorktrees"]>[string]>>),
      mergeOptions?: { clearSingularWorktree?: boolean },
    ): Promise<Task> {
      if (id !== current.id) throw new Error(`Task ${id} not found`);
      const resolved = typeof patch === "function" ? await patch(current) : patch;
      current = {
        ...current,
        workspaceWorktrees: {
          ...(current.workspaceWorktrees ?? {}),
          [repoRelPath]: { ...(current.workspaceWorktrees?.[repoRelPath] ?? {}), ...resolved },
        },
        ...(mergeOptions?.clearSingularWorktree ? { worktree: undefined, branch: undefined } : {}),
      };
      return current;
    },
  } as unknown as TaskStore;
  return { current: () => current, patches, store };
}

describeIfGit("RUFU-231 worktree base identity capture (real git)", { timeout: 60_000 }, () => {
  const trash: string[] = [];
  function track<T extends string>(path: T): T {
    trash.push(path);
    return path;
  }

  afterEach(() => {
    for (const path of trash.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  function initRepo(): string {
    const repo = track(mkdtempSync(join(tmpdir(), "rufu231-base-")));
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    git(repo, "git commit --allow-empty -m 'init'");
    return repo;
  }

  it("records baseBranch / executionStartBranch / baseCommitSha for a default-base singular card", async () => {
    const rootDir = initRepo();
    const mainTip = git(rootDir, "git rev-parse main");
    const { current, patches, store } = makeStore(makeTask("FN-9001"));

    const result = await acquireTaskWorktree({
      task: makeTask("FN-9001"),
      rootDir,
      store,
      settings: {} as Partial<Settings>,
    });

    expect(result.source).toBe("fresh");
    const identityPatch = patches.find((patch) => patch.baseCommitSha !== undefined);
    expect(identityPatch).toBeDefined();
    expect(identityPatch?.baseCommitSha).toBe(mainTip);
    expect(identityPatch?.baseBranch).toBe("main");
    expect(identityPatch?.executionStartBranch).toBe("main");
    expect(current().baseCommitSha).toBe(mainTip);
    expect(current().baseBranch).toBe("main");
    expect(current().executionStartBranch).toBe("main");
  });

  it("records the remote-tracking identity the branch actually sits on after the create-time rebase (RUFU-217 shape)", async () => {
    // origin holds the foreign landed commit; local main is behind it.
    const origin = track(mkdtempSync(join(tmpdir(), "rufu231-origin-")));
    git(origin, "git init --bare -b main");
    const seeder = track(mkdtempSync(join(tmpdir(), "rufu231-seed-")));
    git(seeder, `git clone ${JSON.stringify(origin)} .`);
    git(seeder, 'git config user.email "test@example.com"');
    git(seeder, 'git config user.name "Test User"');
    git(seeder, "git commit --allow-empty -m 'init'");
    git(seeder, "git push -u origin main");

    const rootDir = track(mkdtempSync(join(tmpdir(), "rufu231-diverged-")));
    git(rootDir, `git clone ${JSON.stringify(origin)} .`);
    git(rootDir, 'git config user.email "test@example.com"');
    git(rootDir, 'git config user.name "Test User"');

    // The foreign landing happens AFTER this card's clone: origin moves ahead of local.
    git(seeder, "git commit --allow-empty -m 'feat(FN-355): foreign landed work' -m 'Fusion-Task-Id: FN-355'");
    git(seeder, "git push origin main");
    const foreignTip = git(seeder, "git rev-parse HEAD");

    git(rootDir, "git fetch origin");
    const localMain = git(rootDir, "git rev-parse main");
    expect(foreignTip).not.toBe(localMain);

    // The production create path rebases the fresh branch onto origin/main
    // (rebaseNewWorktreeOntoRemote). Reproduce that mutation faithfully.
    const createWorktree = vi.fn(async (branch: string, path: string, _taskId: string, startPoint?: string) => {
      git(rootDir, `git worktree add ${JSON.stringify(path)} -b ${JSON.stringify(branch)} ${JSON.stringify(startPoint ?? "main")}`);
      git(path, "git rebase origin/main");
      return { path, branch };
    });
    const { current, patches, store } = makeStore(makeTask("FN-9002"));

    await acquireTaskWorktree({
      task: makeTask("FN-9002"),
      rootDir,
      store,
      settings: {} as Partial<Settings>,
      createWorktree,
    });

    const identityPatch = patches.find((patch) => patch.baseCommitSha !== undefined);
    // NOT the stale local identity — the recorded SHA names the identity the branch
    // actually sits on (the remote-tracking tip the rebase moved it onto).
    expect(identityPatch?.baseCommitSha).toBe(foreignTip);
    expect(current().baseCommitSha).toBe(foreignTip);
    expect(current().executionStartBranch).toBe("main");
  });

  it("never resurrects an executionStartBranch that createWorktree cleared as unresolvable (FN-2165)", async () => {
    const rootDir = initRepo();
    const createWorktree = vi.fn(async (branch: string, path: string, taskId: string) => {
      // FN-2165: the recorded start point vanished (dep branch merged+deleted);
      // createWorktree clears it and proceeds from the default base.
      await store.updateTask(taskId, { executionStartBranch: null });
      git(rootDir, `git worktree add ${JSON.stringify(path)} -b ${JSON.stringify(branch)} main`);
      return { path, branch };
    });
    const { current, patches, store } = makeStore(makeTask("FN-9003", { executionStartBranch: "release/gone-dep-branch" }));

    await acquireTaskWorktree({
      task: makeTask("FN-9003", { executionStartBranch: "release/gone-dep-branch" }),
      rootDir,
      store,
      settings: {} as Partial<Settings>,
      createWorktree,
    });

    for (const patch of patches) {
      expect(patch.executionStartBranch).not.toBe("release/gone-dep-branch");
      expect(patch.baseBranch).not.toBe("release/gone-dep-branch");
    }
    const identityPatch = patches.find((patch) => patch.baseCommitSha !== undefined);
    expect(identityPatch?.executionStartBranch).toBe("main");
    expect(identityPatch?.baseBranch).toBe("main");
    expect(current().executionStartBranch).toBe("main");
  });

  it("workspace per-repo entries record the resolved base ref even when none was requested", async () => {
    const fixture: WorkspaceFixture = await createWorkspaceFixture(["repo-a"]);
    trash.push(fixture.rootDir);
    const repoA = fixture.repoPath("repo-a");
    const origin = `${repoA}-origin`;
    git(repoA, `git init --bare ${JSON.stringify(origin)}`);
    git(repoA, `git remote add origin ${JSON.stringify(origin)}`);
    git(repoA, "git push -u origin main");
    const repoATip = git(repoA, "git rev-parse main");

    const { current, store } = makeStore(makeTask("FN-9004"));
    const result = await acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a",
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: {} as Partial<Settings>,
      registry: new ActiveSessionRegistry(),
    });

    const entry = current().workspaceWorktrees?.["repo-a"];
    expect(entry?.worktreePath).toBe(result.worktreePath);
    // Default-based per-repo card: the resolved base ref is recorded, not left blank.
    expect(entry?.baseBranch).toBeTruthy();
    expect(git(repoA, `git rev-parse ${JSON.stringify(`${entry?.baseBranch}^{commit}`)}`)).toBe(repoATip);
    expect(entry?.baseCommitSha).toBeTruthy();
  });

  it("preserves the FN-5937 inflation guard: local-ahead capture keeps the local tip", async () => {
    // base-commit-capture sibling invariant re-asserted through the acquire seam:
    // when local main is ahead of origin, the recorded base must be the LOCAL tip.
    const rootDir = initRepo();
    const origin = track(mkdtempSync(join(tmpdir(), "rufu231-origin-behind-")));
    git(origin, "git init --bare -b main");
    git(rootDir, `git remote add origin ${JSON.stringify(origin)}`);
    git(rootDir, "git push -u origin main");
    git(rootDir, "git commit --allow-empty -m 'FN-9000: unpushed predecessor'");
    const localTip = git(rootDir, "git rev-parse HEAD");

    const { current, patches, store } = makeStore(makeTask("FN-9005"));
    await acquireTaskWorktree({
      task: makeTask("FN-9005"),
      rootDir,
      store,
      settings: {} as Partial<Settings>,
    });

    const identityPatch = patches.find((patch) => patch.baseCommitSha !== undefined);
    expect(identityPatch?.baseCommitSha).toBe(localTip);
    expect(current().baseCommitSha).toBe(localTip);
  });
});
