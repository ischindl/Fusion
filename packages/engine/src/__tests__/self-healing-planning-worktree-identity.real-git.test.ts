/**
 * FNXC:PlanningLaneWorktreeIdentity 2026-11-18-19:35 (RUFU-893, Step 4):
 * THE THREE GIT READS AGAINST A REAL REPOSITORY. `worktree-metadata-planning-lane-identity.test.ts` states
 * each verdict through an injected seam, which proves the wiring and nothing about the commands; a parser
 * that mis-reads `rev-list` output would stay green there forever. This file therefore points the sweep's
 * `rootDir` at a real repository and lets the real probes answer, with the store faked so no PostgreSQL is
 * needed (the real-store half is `self-healing-planning-worktree-identity.pg.test.ts`).
 *
 * Four claims the injected-seam file structurally cannot make:
 * 1. `rev-list --count` answers 0 for a merged branch and N for a divergent one, so `contained` and
 *    `divergent` are separated by real ancestry rather than by a stub.
 * 2. Ref deletion is what makes a pointer a lie: the same card that had to be refused while its branch
 *    stood is cleared once the ref is gone, with the column untouched.
 * 3. Worktree-registration matching is EXACT. A registered worktree on `fusion/<id>-step-1` — the shape
 *    the foreach/step lanes really produce — must not be read as a live checkout of `fusion/<id>`, and the
 *    card must still be cleared.
 * 4. A root that is not a repository is a refusal, not an absence. Measured before the change, the
 *     unconditional clear happily nulled pointers at a non-repo `rootDir`; that is the pre-change behavior
 *     this case retires, and no mock can reproduce it because the failure being characterized IS the
 *     subprocess failing.
 */
import { execSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { withBranchWriteProvenance } from "./branch-write-provenance-store-stub.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

const openFixtures: Array<() => void> = [];

/** A real repository on `main` with one base commit, and a worktrees root the sweep can reason about. */
function createRepo(label: string): { rootDir: string; worktreesDir: string } {
  const base = mkdtempSync(join(tmpdir(), `rufu893-identity-${label}-`));
  const rootDir = join(base, "repo");
  mkdirSync(rootDir, { recursive: true });
  git(rootDir, "git init -b main");
  git(rootDir, 'git config user.email "card@example.com"');
  git(rootDir, 'git config user.name "Card User"');
  writeFileSync(join(rootDir, "tracked.txt"), "base\n", "utf8");
  git(rootDir, "git add tracked.txt");
  git(rootDir, "git commit -m 'chore: base'");
  openFixtures.push(() => rmSync(base, { recursive: true, force: true }));
  return { rootDir, worktreesDir: join(rootDir, ".fusion", "worktrees") };
}

function commitOnBranch(repo: string, branch: string, file: string): string {
  git(repo, `git checkout -b ${branch} main`);
  writeFileSync(join(repo, file), `${file}\n`, "utf8");
  git(repo, `git add ${file}`);
  git(repo, `git commit -m 'feat: ${file}'`);
  const sha = git(repo, "git rev-parse HEAD");
  git(repo, "git checkout main");
  return sha;
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function makeStore(tasks: Task[], worktreesDir: string) {
  const map = new Map(tasks.map((t) => [t.id, t]));
  const auditRows: Array<{ mutationType: string; metadata: Record<string, unknown> }> = [];
  const history: Array<{ taskId: string; message: string }> = [];
  const settings: Partial<Settings> = { globalPause: false, enginePaused: false, worktreesDir };
  const store = Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async () => [...map.values()]),
    updateTask: vi.fn(withBranchWriteProvenance(async (id: string, patch: Partial<Task>) => {
      const next = { ...(map.get(id) as Task), ...patch } as Task;
      map.set(id, next);
      return next;
    })),
    getTask: vi.fn(async (id: string) => map.get(id)),
    logEntry: vi.fn(async (id: string, message: string) => { history.push({ taskId: id, message }); }),
    recordRunAuditEvent: vi.fn(async (row: { mutationType: string; metadata: Record<string, unknown> }) => {
      auditRows.push({ mutationType: row.mutationType, metadata: row.metadata });
    }),
  }) as unknown as TaskStore & EventEmitter;
  return { store, auditRows, history };
}

const REFUSED = "task:reconcile-planning-lane-worktree-identity-no-action";
const CLEARED = "task:auto-recover-worktree-metadata-cleared";

describeIfGit("planning-lane worktree identity against real git (RUFU-893)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(() => {
    while (openFixtures.length > 0) openFixtures.pop()!();
  });

  it("clears a pointer whose ref is contained in main, proven by real ancestry", async () => {
    const { rootDir, worktreesDir } = createRepo("contained");
    const branch = "fusion/rufu893-c1";
    commitOnBranch(rootDir, branch, "landed.txt");
    git(rootDir, `git merge --no-ff ${branch} -m 'merge: landed'`);

    const { store, auditRows, history } = makeStore([task("RUFU893-C1", {
      worktree: join(worktreesDir, "rufu893-c1"),
      branch,
    })], worktreesDir);

    expect(await new SelfHealingManager(store, { rootDir }).reconcileTaskWorktreeMetadata()).toBe(1);
    expect(await store.getTask("RUFU893-C1")).toMatchObject({ column: "todo", branch: null, worktree: null });
    expect(auditRows.map((r) => r.mutationType)).toEqual([CLEARED]);
    expect(history[0]!.message).toContain("already contained in the integration branch");
  });

  it("refuses and keeps the pointers when the branch carries a commit main has never seen", async () => {
    const { rootDir, worktreesDir } = createRepo("divergent");
    const branch = "fusion/rufu893-d1";
    commitOnBranch(rootDir, branch, "undelivered.txt");

    const { store, auditRows, history } = makeStore([task("RUFU893-D1", {
      worktree: join(worktreesDir, "rufu893-d1"),
      branch,
    })], worktreesDir);

    expect(await new SelfHealingManager(store, { rootDir }).reconcileTaskWorktreeMetadata()).toBe(0);
    const kept = await store.getTask("RUFU893-D1");
    expect(kept).toMatchObject({ branch, worktree: join(worktreesDir, "rufu893-d1") });
    expect(auditRows.find((r) => r.mutationType === REFUSED)?.metadata).toMatchObject({ code: "ref-divergent" });
    expect(history[0]!.message).toContain("NOT contained");
    /* The count the operator acts on, measured by git rather than stated by a stub. */
    expect(git(rootDir, `git rev-list --count main..refs/heads/${branch}`)).toBe("1");
    expect(history[0]!.message).toContain("1 commit");
  });

  it("clears once the ref is gone, which is the proof that no commit was ever carried by the name", async () => {
    const { rootDir, worktreesDir } = createRepo("absent");
    const branch = "fusion/rufu893-a1";
    commitOnBranch(rootDir, branch, "abandoned.txt");
    git(rootDir, `git branch -D ${branch}`);

    const { store, auditRows } = makeStore([task("RUFU893-A1", {
      worktree: join(worktreesDir, "rufu893-a1"),
      branch,
    })], worktreesDir);

    expect(await new SelfHealingManager(store, { rootDir }).reconcileTaskWorktreeMetadata()).toBe(1);
    expect(await store.getTask("RUFU893-A1")).toMatchObject({ column: "todo", branch: null, worktree: null });
    expect(auditRows.map((r) => r.mutationType)).toEqual([CLEARED]);
  });

  it("does not read a registered `fusion/<id>-step-1` worktree as a live checkout of `fusion/<id>`", async () => {
    const { rootDir, worktreesDir } = createRepo("decoy");
    const branch = "fusion/rufu893-e1";
    /* A sibling step-lane worktree sharing this card's stem, registered and alive. */
    mkdirSync(join(worktreesDir, "rufu893-e1-step-1"), { recursive: true });
    git(rootDir, `git worktree add ${join(worktreesDir, "rufu893-e1-step-1")} -b ${branch}-step-1 main`);

    const { store, auditRows } = makeStore([task("RUFU893-E1", {
      worktree: join(worktreesDir, "rufu893-e1"),
      branch,
    })], worktreesDir);

    /*
    Exact matching means the decoy is neither absence proof nor a live premise: the ref for this card's own
    branch is gone, so the pointer is a lie and is cleared even though the inventory read is populated with a
    branch that shares its stem.
    */
    expect(git(rootDir, "git worktree list --porcelain")).toContain(`branch refs/heads/${branch}-step-1`);
    expect(await new SelfHealingManager(store, { rootDir }).reconcileTaskWorktreeMetadata()).toBe(1);
    expect(await store.getTask("RUFU893-E1")).toMatchObject({ branch: null, worktree: null });
    expect(auditRows.map((r) => r.mutationType)).toEqual([CLEARED]);
  });

  it("refuses at a root that is not a repository instead of reading silence as absence", async () => {
    /*
    THE PRE-CHANGE BEHAVIOR THIS RETIRES. Measured on the pre-change tree: a planning-lane card whose
    `worktree` pointed under a plain non-repository directory was cleared with no git question asked at all,
    and a workspace member-repository branch looks exactly like that at the entry's root. A directory that
    cannot answer `for-each-ref` is not evidence that a branch never existed.
    */
    const base = mkdtempSync(join(tmpdir(), "rufu893-notarepo-"));
    openFixtures.push(() => rmSync(base, { recursive: true, force: true }));
    const rootDir = join(base, "workspace-entry");
    mkdirSync(join(rootDir, "members", "engine"), { recursive: true });

    /* The card names a member worktree that is not on disk, so the git question is actually reached. */
    const { store, auditRows, history } = makeStore([task("RUFU893-NR", {
      worktree: join(rootDir, "members", "api"),
      branch: "fusion/rufu893-nr",
    })], join(rootDir, ".fusion", "worktrees"));

    expect(await new SelfHealingManager(store, { rootDir }).reconcileTaskWorktreeMetadata()).toBe(0);
    expect(await store.getTask("RUFU893-NR")).toMatchObject({
      branch: "fusion/rufu893-nr",
      worktree: join(rootDir, "members", "api"),
    });
    expect(auditRows.find((r) => r.mutationType === REFUSED)?.metadata).toMatchObject({ code: "probe-unknown" });
    expect(history).toHaveLength(1);
  });
});
