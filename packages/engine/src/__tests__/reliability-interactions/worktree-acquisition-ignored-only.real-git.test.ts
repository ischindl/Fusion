/*
FNXC:WorktreeCleanup 2026-09-26-01:29 (RUFU-298 — an ignored-only pinned checkout must never terminalize a card):

Reported symptom: card RUFU-260 died permanently with "Worktree acquisition failed after 3 heartbeat attempts"
(2026-09-24 20:03:00Z, `executor-retry-exhausted` terminalization). Its pinned worktree held only git-ignored
build output (`!! node_modules/`-style entries — zero deliverable bytes, yet zero proof-of-absence), and the
acquisition reclaim refused to remove it, so the same throw recurred every heartbeat.

Invariant under test (end-to-end through `acquireTaskWorktree` with real git, not a mocked remove):
acquisition decides from the FN-9233 content classification. `clean`/`regenerable-ignored` keep the audited
PoolPrune removal path; `ignored-only` (this file) and `deliverable` preserve the checkout aside under
`.fusion/recovery/worktrees/` and continue; the pinned path's stale admin registration is pruned so the
fresh `git worktree add` at the same path can succeed; only an unverifiable probe fails closed. Mock-level
decision-table coverage lives in `worktree-acquisition-ignored-only-decision.test.ts`; the mock seam alone
could not see the registration wedge (RUFU-278's motivating test mocked the removal), so this file drives
the whole funnel over a real repository.
*/
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireTaskWorktree } from "../../worktree/worktree-acquisition.js";
import { git, hasGit, reliabilityTestTempParent } from "./_helpers.js";

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function makeRepo(): string {
  const root = mkdtempSync(join(reliabilityTestTempParent(), "rufu-298-acq-"));
  cleanup.push(root);
  git(root, "git init -b main");
  git(root, "git config user.email test@example.com");
  git(root, "git config user.name Test");
  writeFileSync(join(root, ".gitignore"), "*.cache\n");
  writeFileSync(join(root, "README.md"), "# fixture\n");
  git(root, "git add .gitignore README.md");
  git(root, "git commit -m \"C0\"");
  return root;
}

/**
 * RUFU-260's exact shape: the task's registered pinned checkout has been left detached at its own
 * branch tip (crash recovery / archive-restore shape) and carries only git-ignored content.
 */
function ignoredOnlyPinnedCheckout(taskId: string) {
  const root = makeRepo();
  const branch = `fusion/${taskId.toLowerCase()}`;
  const pinned = join(root, ".fusion", "worktrees", taskId.toLowerCase());
  git(root, `git worktree add ${JSON.stringify(pinned)} -b ${JSON.stringify(branch)}`);
  writeFileSync(join(pinned, "feature.ts"), "export const work = 1;\n");
  git(pinned, "git add feature.ts");
  // Executor task-worktree convention: a real footer trailer, not a subject-embedded mention.
  git(pinned, `git commit -m "feat: deliverable" -m "Fusion-Task-Id: ${taskId}"`);
  const deliverableSha = git(pinned, "git rev-parse HEAD");
  git(pinned, "git checkout --detach HEAD");
  writeFileSync(join(pinned, "build.cache"), "regenerable-looking build junk\n");
  return { root, branch, pinned, deliverableSha };
}

function makeAuditor() {
  const events: any[] = [];
  const audit = {
    git: vi.fn(async (event: any) => { events.push(event); }),
    filesystem: vi.fn(async (event: any) => { events.push(event); }),
  };
  return { events, audit: audit as any };
}

function makeRun() {
  const store = {
    updateTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
  } as any;
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { store, logger };
}

function worktreeRegistrations(root: string): string[] {
  return git(root, "git worktree list --porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
}

describe("RUFU-298 acquisition of an ignored-only pinned checkout (real git)", () => {
  it.skipIf(!hasGit)("resolves: preserves the ignored-only checkout aside and recreates at the pinned path", async () => {
    const { root, branch, pinned, deliverableSha } = ignoredOnlyPinnedCheckout("FN-2981");
    const { store, logger } = makeRun();
    const { audit } = makeAuditor();

    const result = await acquireTaskWorktree({
      task: { id: "FN-2981", title: "ignored-only reclaim", description: "", branch, worktree: pinned } as any,
      rootDir: root,
      store,
      settings: {} as any,
      audit,
      logger,
    });

    // The original symptom: acquisition failed permanently. It must instead complete.
    expect(result.worktreePath).toBe(pinned);
    expect(result.source).toBe("fresh");

    // The recreation carries the branch's committed deliverables.
    expect(git(pinned, "git rev-parse --abbrev-ref HEAD")).toBe(branch);
    expect(() => git(pinned, `git merge-base --is-ancestor ${deliverableSha} HEAD`)).not.toThrow();

    // The preserved checkout survives verbatim under the recovery directory — content is never deleted.
    const recoveryDir = join(root, ".fusion", "recovery", "worktrees");
    const preserved = readdirSync(recoveryDir).filter((name) => name.startsWith("fn-2981-"));
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(recoveryDir, preserved[0], "build.cache"), "utf8")).toBe("regenerable-looking build junk\n");

    // The fresh recreation does not inherit the ignored junk.
    expect(existsSync(join(pinned, "build.cache"))).toBe(false);

    // The stale admin registration no longer wedges `git worktree add`: exactly one registration per path.
    const registrations = worktreeRegistrations(root);
    expect(registrations.filter((path) => path === pinned)).toHaveLength(1);
  });

  it.skipIf(!hasGit)("audits the decision: classification-driven preservation plus an explicit admin-entry prune", async () => {
    const { root, branch, pinned } = ignoredOnlyPinnedCheckout("FN-2982");
    const { store, logger } = makeRun();
    const { events, audit } = makeAuditor();

    await acquireTaskWorktree({
      task: { id: "FN-2982", title: "ignored-only reclaim", description: "", branch, worktree: pinned } as any,
      rootDir: root,
      store,
      settings: {} as any,
      audit,
      logger,
    });

    // The preservation record carries the probed content class (FN-9233 semantics), not an opaque label.
    expect(events).toContainEqual(expect.objectContaining({
      type: "file:write",
      target: expect.stringContaining("recovery"),
      metadata: expect.objectContaining({ taskId: "FN-2982", classification: "ignored-only", reason: "task-pinned-content-preserved" }),
    }));

    // RUFU-298: the acquisition explicitly prunes the stale registration it just orphaned, instead of
    // relying on the branch-collision ladder's incidental prune for recreation to succeed.
    expect(events).toContainEqual(expect.objectContaining({
      type: "worktree:admin-entry-pruned",
      metadata: expect.objectContaining({ reason: "task-pinned-preserving-reclaim", success: true }),
    }));
  });

  it.skipIf(!hasGit)("preserves deliverable-class scratch aside and still recreates (RUFU-278 non-terminal invariant)", async () => {
    const root = makeRepo();
    const branch = "fusion/fn-2983";
    const pinned = join(root, ".fusion", "worktrees", "fn-2983");
    git(root, `git worktree add ${JSON.stringify(pinned)} -b ${JSON.stringify(branch)}`);
    writeFileSync(join(pinned, "feature.ts"), "export const work = 1;\n");
    git(pinned, "git add feature.ts");
    git(pinned, `git commit -m "feat: deliverable" -m "Fusion-Task-Id: FN-2983"`);
    git(pinned, "git checkout --detach HEAD");
    // Untracked, NOT ignored → deliverable class (RUFU-278's motivating `.gate-out.txt` shape).
    writeFileSync(join(pinned, ".gate-out.txt"), "review evidence\n");

    const { store, logger } = makeRun();
    const { audit } = makeAuditor();

    const result = await acquireTaskWorktree({
      task: { id: "FN-2983", title: "deliverable reclaim", description: "", branch, worktree: pinned } as any,
      rootDir: root,
      store,
      settings: {} as any,
      audit,
      logger,
    });

    expect(result.worktreePath).toBe(pinned);
    const recoveryDir = join(root, ".fusion", "recovery", "worktrees");
    const preserved = readdirSync(recoveryDir).filter((name) => name.startsWith("fn-2983-"));
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(recoveryDir, preserved[0], ".gate-out.txt"), "utf8")).toBe("review evidence\n");
  });
});
