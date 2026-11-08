import { access, constants as fsConstants, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunAuditor } from "../../util/run-audit.js";
import {
  RemovalReason,
  removeWorktree,
} from "../../worktree/worktree-backend.js";
import { reapOrphanWorktrees } from "../../worktree/worktree-pool.js";
import { git, hasGit } from "./_helpers.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/*
STAS-397: a release that discards ignored content must say what it threw away, so the tests that used
to assert a refusal now assert the record instead. A hand-rolled collector, not a mock: this suite's
rule is that the git calls are real, and the auditor is the thing under observation, not a stand-in
for it.
*/
function collectAuditEvents(): { events: Array<{ type: string; metadata?: Record<string, unknown> }>; auditor: RunAuditor } {
  const events: Array<{ type: string; metadata?: Record<string, unknown> }> = [];
  return {
    events,
    auditor: { git: async (event: { type: string; metadata?: Record<string, unknown> }) => { events.push(event); } } as unknown as RunAuditor,
  };
}

describe.skipIf(!hasGit)("reliability interactions: defensive removal preserves unverifiable content", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  async function setupRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "fusion-defensive-remove-"));
    roots.push(root);
    git(root, "git init -b main");
    git(root, 'git config user.email "test@example.com"');
    git(root, 'git config user.name "Test User"');
    await writeFile(join(root, "README.md"), "# repo\n", "utf-8");
    await writeFile(join(root, ".gitignore"), ".fusion/\ndist/\nnode_modules/\n.env\n", "utf-8");
    git(root, "git add README.md .gitignore");
    git(root, 'git commit -m "init"');
    await mkdir(join(root, ".worktrees"), { recursive: true });
    return root;
  }

  async function createWorktree(root: string, name: string): Promise<string> {
    const worktreePath = join(root, ".worktrees", name);
    git(root, `git worktree add -b ${JSON.stringify(`fusion/${name}`)} ${JSON.stringify(worktreePath)}`);
    return worktreePath;
  }

  it("pool-prune refuses and preserves a dirty registered worktree", async () => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, "dirty-prune");
    await writeFile(join(worktreePath, "wip.txt"), "uncommitted\n", "utf-8");

    await expect(
      removeWorktree({ rootDir: root, worktreePath, settings: {}, reason: RemovalReason.PoolPrune }),
    ).rejects.toThrow(/preserving/);

    expect(await readFile(join(worktreePath, "wip.txt"), "utf-8")).toBe("uncommitted\n");
  });

  it("idle-sweep refuses and preserves a dirty registered worktree", async () => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, "dirty-idle");
    await writeFile(join(worktreePath, "wip.txt"), "uncommitted\n", "utf-8");

    await expect(
      removeWorktree({ rootDir: root, worktreePath, settings: {}, reason: RemovalReason.SelfHealingIdleSweep }),
    ).rejects.toThrow(/preserving/);

    expect(await pathExists(worktreePath)).toBe(true);
  });

  it("pool-prune removes ignored content under a build directory", async () => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, "ignored-prune");
    await mkdir(join(worktreePath, "dist"), { recursive: true });
    await writeFile(join(worktreePath, "dist", "manual.txt"), "regenerable\n", "utf-8");

    /*
    FNXC:WorktreeCleanup 2026-09-01-06:09:
    FN-9233 deliberately removed the prior preservation contract for files beneath build directories.
    STAS-397 generalised it: no ignored path is occupancy, so the name of the directory is not a question
    a release asks.
    */
    await expect(
      removeWorktree({ rootDir: root, worktreePath, settings: {}, reason: RemovalReason.PoolPrune }),
    ).resolves.toMatchObject({ removed: true });

    expect(await pathExists(worktreePath)).toBe(false);
  });

  it.each([
    RemovalReason.MergerCleanup,
    RemovalReason.MergerPostMerge,
    RemovalReason.PoolPrune,
    RemovalReason.SelfHealingBranchConflict,
    RemovalReason.SelfHealingIdleSweep,
    RemovalReason.SelfHealingReclaim,
    RemovalReason.SelfHealingStaleActiveBranch,
    RemovalReason.StepSessionCleanup,
  ])("%s preserves a dirty automatically managed worktree", async (reason) => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, reason);
    await writeFile(join(worktreePath, "wip.txt"), "uncommitted\n", "utf-8");

    await expect(removeWorktree({ rootDir: root, worktreePath, settings: {}, reason })).rejects.toThrow(/preserving/);

    expect(await readFile(join(worktreePath, "wip.txt"), "utf-8")).toBe("uncommitted\n");
  });

  it.each([
    RemovalReason.MergerCleanup,
    RemovalReason.MergerPostMerge,
    RemovalReason.PoolPrune,
    RemovalReason.SelfHealingBranchConflict,
    RemovalReason.SelfHealingIdleSweep,
    RemovalReason.SelfHealingReclaim,
    RemovalReason.SelfHealingStaleActiveBranch,
    RemovalReason.StepSessionCleanup,
  ])("%s removes a built checkout whose only content is ignored output", async (reason) => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, `regenerable-${reason}`);
    await mkdir(join(worktreePath, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(worktreePath, "dist"), { recursive: true });
    await writeFile(join(worktreePath, "node_modules", "pkg", "index.js"), "generated\n", "utf-8");
    await writeFile(join(worktreePath, "dist", "bundle.js"), "generated\n", "utf-8");

    await expect(removeWorktree({ rootDir: root, worktreePath, settings: {}, reason })).resolves.toMatchObject({ removed: true });

    expect(await pathExists(worktreePath)).toBe(false);
  });

  it.each([
    RemovalReason.MergerCleanup,
    RemovalReason.MergerPostMerge,
    RemovalReason.PoolPrune,
    RemovalReason.SelfHealingBranchConflict,
    RemovalReason.SelfHealingIdleSweep,
    RemovalReason.SelfHealingReclaim,
    RemovalReason.SelfHealingStaleActiveBranch,
    RemovalReason.StepSessionCleanup,
    RemovalReason.CompletionLandedCleanup,
  ])("%s removes a built checkout holding Fusion scratch and other ignored output", async (reason) => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, `fusion-scratch-${reason}`);
    await mkdir(join(worktreePath, ".fusion", "cache"), { recursive: true });
    await mkdir(join(worktreePath, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(worktreePath, "dist"), { recursive: true });
    await writeFile(join(worktreePath, ".fusion", "cache", "plugin-build-cache.json"), "{}\n", "utf-8");
    await writeFile(join(worktreePath, "node_modules", "pkg", "index.js"), "generated\n", "utf-8");
    await writeFile(join(worktreePath, "dist", "bundle.js"), "generated\n", "utf-8");

    await expect(removeWorktree({ rootDir: root, worktreePath, settings: {}, reason })).resolves.toMatchObject({ removed: true });
    expect(await pathExists(worktreePath)).toBe(false);
  });

  /*
  STAS-397 replaced three name-based policies with one question. These three tests are where that
  replacement is most visible, so they state the new rule from the angle that used to be refused.

  The concern FN-9276 recorded here was real: a top-level `.fusion` can hold board state. What protects
  that state is not the child probe — it is `assertCleanForDefensiveRemoval` refusing the project root
  checkout by identity, which stays in place and is asserted below. A worktree-local `.fusion` is tool
  output written into the copy, and the row naming it is what makes discarding it reviewable.
  */
  it("releases an ignored Fusion scratch directory whatever it holds, naming it in the discard record", async () => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, "fusion-scratch-unexpected");
    await mkdir(join(worktreePath, ".fusion", "tasks", "FN-1"), { recursive: true });
    await writeFile(join(worktreePath, ".fusion", "tasks", "FN-1", "notes.md"), "keep\n", "utf-8");
    const { events, auditor } = collectAuditEvents();

    await expect(removeWorktree({ rootDir: root, worktreePath, settings: {}, reason: RemovalReason.PoolPrune, audit: auditor })).resolves.toMatchObject({ removed: true });

    expect(await pathExists(worktreePath)).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "worktree:removal-discarded-ignored-content",
      metadata: expect.objectContaining({ discardedIgnoredPaths: [".fusion/"] }),
    }));
  });

  it("releases Fusion scratch alongside an ignored env file and names both in the discard record", async () => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, "fusion-scratch-env");
    await mkdir(join(worktreePath, ".fusion", "cache"), { recursive: true });
    await writeFile(join(worktreePath, ".fusion", "cache", "plugin-build-cache.json"), "{}\n", "utf-8");
    await writeFile(join(worktreePath, ".env"), "TOKEN=ignored\n", "utf-8");
    const { events, auditor } = collectAuditEvents();

    await expect(removeWorktree({ rootDir: root, worktreePath, settings: {}, reason: RemovalReason.PoolPrune, audit: auditor })).resolves.toMatchObject({ removed: true });

    expect(await pathExists(worktreePath)).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "worktree:removal-discarded-ignored-content",
      metadata: expect.objectContaining({
        discardedIgnoredPaths: expect.arrayContaining([".fusion/", ".env"]),
      }),
    }));
  });

  it("refuses defensive removal of the project root", async () => {
    const root = await setupRepo();
    await mkdir(join(root, ".fusion", "cache"), { recursive: true });
    await writeFile(join(root, ".fusion", "cache", "plugin-build-cache.json"), "{}\n", "utf-8");

    await expect(removeWorktree({ rootDir: root, worktreePath: root, settings: {}, reason: RemovalReason.PoolPrune })).rejects.toThrow(/preserving/);
    expect(await pathExists(root)).toBe(true);
  });

  /*
  STAS-397: this table used to run the eight defensive reasons against an unallowlisted `.env` to prove
  each one PRESERVED the checkout. That is the policy that wedged every checkout created by this
  repository's documented dependency install, so the table now proves the opposite half of the same
  contract: none of the eight refuses, and none of them forces.
  */
  it.each([
    RemovalReason.MergerCleanup,
    RemovalReason.MergerPostMerge,
    RemovalReason.PoolPrune,
    RemovalReason.SelfHealingBranchConflict,
    RemovalReason.SelfHealingIdleSweep,
    RemovalReason.SelfHealingReclaim,
    RemovalReason.SelfHealingStaleActiveBranch,
    RemovalReason.StepSessionCleanup,
  ])("%s releases a checkout whose ignored content includes an unlisted .env file", async (reason) => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, `ignored-${reason}`);
    await mkdir(join(worktreePath, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(worktreePath, "node_modules", "pkg", "index.js"), "generated\n", "utf-8");
    await writeFile(join(worktreePath, ".env"), "TOKEN=ignored\n", "utf-8");

    await expect(removeWorktree({ rootDir: root, worktreePath, settings: {}, reason })).resolves.toMatchObject({ removed: true });

    expect(await pathExists(worktreePath)).toBe(false);
  });

  it("removes ignored content that a durable landing proof accompanies, recording the proof", async () => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, "post-landing-ignored");
    await mkdir(join(worktreePath, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(worktreePath, "dist"), { recursive: true });
    await writeFile(join(worktreePath, "node_modules", "pkg", "index.js"), "generated\n", "utf-8");
    await writeFile(join(worktreePath, "dist", "bundle.js"), "generated\n", "utf-8");
    await writeFile(join(worktreePath, ".env"), "TOKEN=ignored\n", "utf-8");

    await expect(removeWorktree({
      rootDir: root,
      worktreePath,
      settings: {},
      reason: RemovalReason.CompletionLandedCleanup,
      postLandingProof: { landedSha: "abc123", source: "real-git-test" },
    })).resolves.toMatchObject({ removed: true });

    expect(await pathExists(worktreePath)).toBe(false);
  });

  it("removes a nested monorepo build directory reported by ignored matching", async () => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, "nested-ignored");
    await mkdir(join(worktreePath, "packages", "core", "dist"), { recursive: true });
    await writeFile(join(worktreePath, "packages", "core", "dist", "x.js"), "generated\n", "utf-8");

    await expect(removeWorktree({
      rootDir: root,
      worktreePath,
      settings: {},
      reason: RemovalReason.PoolPrune,
    })).resolves.toMatchObject({ removed: true });

    expect(await pathExists(worktreePath)).toBe(false);
  });

  it.each([
    ["untracked deliverable", async (worktreePath: string) => writeFile(join(worktreePath, "wip.txt"), "keep\n", "utf-8")],
    ["modified tracked deliverable", async (worktreePath: string) => writeFile(join(worktreePath, "README.md"), "changed\n", "utf-8")],
  ])("preserves %s even after a durable landing proof", async (_label, addDeliverable) => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, "post-landing-deliverable");
    await addDeliverable(worktreePath);

    await expect(removeWorktree({
      rootDir: root,
      worktreePath,
      settings: {},
      reason: RemovalReason.CompletionLandedCleanup,
      postLandingProof: { source: "real-git-test" },
    })).rejects.toThrow(/preserving/);

    expect(await pathExists(worktreePath)).toBe(true);
  });

  it("preserves an unverifiable checkout even after a durable landing proof", async () => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, "post-landing-corrupt");
    await rm(join(root, ".git", "worktrees", "post-landing-corrupt"), { recursive: true, force: true });

    await expect(removeWorktree({
      rootDir: root,
      worktreePath,
      settings: {},
      reason: RemovalReason.CompletionLandedCleanup,
      postLandingProof: { source: "real-git-test" },
    })).rejects.toThrow(/status probe failed/);

    expect(await pathExists(join(worktreePath, "README.md"))).toBe(true);
  });

  it("a failing status probe preserves the checkout instead of enabling deletion", async () => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, "corrupt-probe");
    // Corrupt the registration so the cleanliness probe cannot run at all.
    await rm(join(root, ".git", "worktrees", "corrupt-probe"), { recursive: true, force: true });

    await expect(
      removeWorktree({ rootDir: root, worktreePath, settings: {}, reason: RemovalReason.PoolPrune }),
    ).rejects.toThrow(/preserving/);

    expect(await pathExists(join(worktreePath, "README.md"))).toBe(true);
  });

  it("clean registered worktrees are still removed by pool-prune", async () => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, "clean-prune");

    await removeWorktree({ rootDir: root, worktreePath, settings: {}, reason: RemovalReason.PoolPrune });

    expect(await pathExists(worktreePath)).toBe(false);
  });

  it("addressed teardown reasons keep their legacy forced semantics on dirty worktrees", async () => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, "task-reset-dirty");
    await writeFile(join(worktreePath, "wip.txt"), "uncommitted\n", "utf-8");

    await removeWorktree({ rootDir: root, worktreePath, settings: {}, reason: RemovalReason.TaskReset });

    expect(await pathExists(worktreePath)).toBe(false);
  });

  it("startup reaper preserves dangling or content orphans", async () => {
    const root = await setupRepo();

    const danglingOrphan = join(root, ".worktrees", "dangling-orphan");
    await mkdir(danglingOrphan, { recursive: true });
    await writeFile(join(danglingOrphan, ".git"), "gitdir: /nonexistent/admin\n", "utf-8");

    const contentOrphan = join(root, ".worktrees", "content-orphan");
    await mkdir(contentOrphan, { recursive: true });
    await writeFile(join(contentOrphan, ".git"), "gitdir: /nonexistent/admin\n", "utf-8");
    await writeFile(join(contentOrphan, "wip.txt"), "precious\n", "utf-8");

    await reapOrphanWorktrees(root);

    expect(await pathExists(join(danglingOrphan, ".git"))).toBe(true);
    expect(await readFile(join(contentOrphan, "wip.txt"), "utf-8")).toBe("precious\n");
    expect(dirname(contentOrphan)).toBe(join(root, ".worktrees"));
  });
});
