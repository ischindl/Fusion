/*
FNXC:WorkspaceRootMember 2026-09-28-08:41 (RUFU-390):
A configured workspace member is joined onto the workspace root, and nothing verified that the
joined directory is a repository OF ITS OWN. A member directory that merely sits inside the root
repository makes `git rev-parse --show-toplevel` walk up and answer with the root, so the member
acquisition asks the root repository for a second worktree on the branch the task already occupies
— and git refuses. Real git is required here because the invariant under test is exactly that
walk-up: an in-memory git fake answers `--show-toplevel` however the test authors it, which is how
this class survived every existing suite. Everything not git-shaped stays a narrow seam (FN-5048).
*/
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { ActiveSessionRegistry } from "../agents/active-session-registry.js";
import { acquireWorkspaceRepoWorktree } from "../worktree/worktree-acquisition.js";
import { findWorktreeHoldingBranch, resolveWorkspaceRootMembership } from "../worktree/workspace-root-member.js";

function git(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

const hasGit = (() => {
  try {
    git(process.cwd(), "git --version");
    return true;
  } catch {
    return false;
  }
})();

const describeIfGit = hasGit ? describe : describe.skip;

/**
 * Minimal in-memory TaskStore covering exactly what the reuse path touches: the key-merging entry
 * write, `logEntry`, and the `getTask` re-read the caller performs after each repository.
 */
function makeFakeStore(initial: Task): { store: TaskStore; current: () => Task; logs: string[] } {
  let current = initial;
  const logs: string[] = [];
  const store = {
    async updateTask(_id: string, patch: Partial<Task>): Promise<void> {
      current = { ...current, ...patch };
    },
    async mergeWorkspaceWorktreeEntry(
      _id: string,
      repoRelPath: string,
      patch: Partial<NonNullable<Task["workspaceWorktrees"]>[string]>
        | ((freshTask: Task) => Promise<Partial<NonNullable<Task["workspaceWorktrees"]>[string]>>),
    ): Promise<Task> {
      const merged = typeof patch === "function" ? await patch(current) : patch;
      current = {
        ...current,
        workspaceWorktrees: {
          ...(current.workspaceWorktrees ?? {}),
          [repoRelPath]: { ...(current.workspaceWorktrees?.[repoRelPath] as object), ...merged } as NonNullable<Task["workspaceWorktrees"]>[string],
        },
      };
      return current;
    },
    async logEntry(_id: string, message: string): Promise<void> {
      logs.push(message);
    },
    async getTask(id: string): Promise<Task | null> {
      return id === current.id ? current : null;
    },
  } as unknown as TaskStore;
  return { store, current: () => current, logs };
}

const SETTINGS: Partial<Settings> = {
  commitMsgHookEnabled: false,
  taskPrefix: "FN",
  taskAttributionTrailerNames: ["Fusion-Task-Id"],
};

/**
 * A workspace root that is itself a git repository (the saneca shape) with one phantom member:
 * a plain directory inside the root repository, plus the task's real root-repository worktree
 * holding `fusion/<id>`.
 */
async function createRootRepoFixture(taskId: string, member: string) {
  const rootDir = await mkdtemp(join(tmpdir(), "fusion-root-member-"));
  git(rootDir, "git init -b main");
  git(rootDir, "git config user.email test@example.com");
  git(rootDir, "git config user.name Test");
  writeFileSync(join(rootDir, "AGENTS.MD"), "# root repository\n", "utf8");
  git(rootDir, "git add AGENTS.MD && git commit -m 'seed'");
  // The phantom member: a directory inside the root repository, not a repository of its own.
  mkdirSync(join(rootDir, member), { recursive: true });
  const taskDir = join(rootDir, ".fusion", "worktrees", taskId.toLowerCase());
  git(rootDir, `git worktree add -b ${JSON.stringify(`fusion/${taskId.toLowerCase()}`)} ${JSON.stringify(taskDir)} main`);
  const worktreeCount = (): number => git(rootDir, "git worktree list --porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length;
  return {
    rootDir: await realpath(rootDir),
    taskDir: await realpath(taskDir),
    worktreeCount,
    cleanup: () => { try { rmSync(rootDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best-effort temp cleanup */ } },
  };
}

describeIfGit("acquireWorkspaceRepoWorktree — a member that is the workspace root repository", { timeout: 60_000 }, () => {
  let fixture: Awaited<ReturnType<typeof createRootRepoFixture>> | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("classifies a plain directory inside the root repository as the root repository, and a real repository as its own", async () => {
    fixture = await createRootRepoFixture("FN-9100", "saneca");
    await expect(resolveWorkspaceRootMembership(join(fixture.rootDir, "saneca"), fixture.rootDir))
      .resolves.toMatchObject({ kind: "workspace-root-repository" });
    await expect(resolveWorkspaceRootMembership(fixture.rootDir, fixture.rootDir))
      .resolves.toMatchObject({ kind: "workspace-root-repository" });
    // An unreadable directory is `unknown`, never an authorization to rewrite anything.
    await expect(resolveWorkspaceRootMembership(join(fixture.rootDir, "does-not-exist"), fixture.rootDir))
      .resolves.toEqual({ kind: "unknown" });
    await expect(findWorktreeHoldingBranch(fixture.rootDir, "fusion/fn-9100")).resolves.toBe(fixture.taskDir);
    await expect(findWorktreeHoldingBranch(fixture.rootDir, "fusion/absent")).resolves.toBeUndefined();
    await expect(findWorktreeHoldingBranch(fixture.rootDir, "")).resolves.toBeUndefined();
  });

  it("reuses the registered worktree that holds the task branch instead of creating a second worktree of the same branch", async () => {
    fixture = await createRootRepoFixture("FN-9101", "saneca");
    const taskId = "FN-9101";
    const stalePath = join(fixture.taskDir, "saneca");
    expect(existsSync(stalePath)).toBe(false);
    const before = fixture.worktreeCount();

    const task = {
      id: taskId,
      title: "root-member task",
      description: "workspace task",
      status: "in-progress",
      branch: `fusion/${taskId.toLowerCase()}`,
      worktree: fixture.taskDir,
      workspaceWorktrees: {
        saneca: { worktreePath: stalePath, branch: `fusion/${taskId.toLowerCase()}`, baseBranch: "main" },
      },
    } as unknown as Task;
    const { store, current, logs } = makeFakeStore(task);

    const result = await acquireWorkspaceRepoWorktree({
      repoRelPath: "saneca",
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: SETTINGS,
      registry: new ActiveSessionRegistry(),
      worktreePath: stalePath,
    });

    // The member is served from the worktree that already holds the branch — the collision is gone.
    expect(result).toMatchObject({ worktreePath: fixture.taskDir, branch: `fusion/${taskId.toLowerCase()}`, alreadyAcquired: true });
    expect(current().workspaceWorktrees?.saneca?.worktreePath).toBe(fixture.taskDir);
    // And no second worktree of the root repository was created.
    expect(fixture.worktreeCount()).toBe(before);
    expect(logs.some((line) => line.includes("is the workspace root repository"))).toBe(true);
  });

  it("leaves a member that is its own repository on the ordinary creation path", async () => {
    fixture = await createRootRepoFixture("FN-9102", "saneca");
    const taskId = "FN-9102";
    // A genuine child repository: git resolves its toplevel to itself, not to the workspace root.
    const child = join(fixture.rootDir, "sub-repo");
    mkdirSync(child, { recursive: true });
    git(child, "git init -b main");
    git(child, "git config user.email test@example.com");
    git(child, "git config user.name Test");
    writeFileSync(join(child, "README.md"), "# sub\n", "utf8");
    git(child, "git add README.md && git commit -m 'seed sub'");
    expect(await resolveWorkspaceRootMembership(child, fixture.rootDir)).toEqual({ kind: "own-repository" });

    const task = {
      id: taskId,
      title: "own-repo member task",
      description: "workspace task",
      status: "in-progress",
      branch: `fusion/${taskId.toLowerCase()}`,
    } as unknown as Task;
    const { store, current, logs } = makeFakeStore(task);

    const result = await acquireWorkspaceRepoWorktree({
      repoRelPath: "sub-repo",
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: SETTINGS,
      registry: new ActiveSessionRegistry(),
      worktreePath: join(fixture.rootDir, ".fusion", "worktrees", taskId.toLowerCase(), "sub-repo"),
    });

    expect(result.worktreePath).toBe(join(fixture.rootDir, ".fusion", "worktrees", taskId.toLowerCase(), "sub-repo"));
    expect(existsSync(result.worktreePath)).toBe(true);
    expect(current().workspaceWorktrees?.["sub-repo"]?.worktreePath).toBe(result.worktreePath);
    // The root-member rewrite never fires for a healthy member.
    expect(logs.some((line) => line.includes("is the workspace root repository"))).toBe(false);
    expect(readFileSync(join(result.worktreePath, "README.md"), "utf8")).toContain("# sub");
  });
});
