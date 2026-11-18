/**
 * FNXC:PlanningLaneWorktreeIdentity 2026-11-18-19:45 (RUFU-893, Step 4):
 * PG + REAL GIT regression for the planning-lane half of the worktree/branch identity lane — the store
 * semantics that an in-memory fake cannot vouch for: the branch-provenance write guard, the persisted row
 * after a clear, a real `run_audit_events` row read back over SQL, and a real History row.
 *
 * The invariant this file holds, rather than the five reported cards:
 * 1. A planning-lane pointer whose ref git does not know is cleared IN PLACE. `column` and `status` are
 *    asserted unchanged, because this sweep's deliverable is metadata hygiene and never a lifecycle move —
 *    the same containment rule RUFU-439 pins for the terminal lane, applied to the lane that has no other
 *    owner (`reconcile-missing-worktree-merge-active` is in-review only, `reconcile-stale-acquisition-conflict`
 *    needs a heartbeat park, `reconcileTerminalBranchConflictParks` reads complete-role lanes alone).
 * 2. A branch that still carries a commit the integration branch lacks is NEVER cleared, and its commits
 *    remain reachable from the ref afterwards — the salvage the retained pointer exists to carry.
 * 3. Worktree-registration matching is EXACT: a live worktree on `fusion/<id>-step-1` is neither absence
 *    proof nor a live premise for `fusion/<id>`.
 * 4. A member-repository branch measured at a non-git root HOLDS. `absent` at that path is an absence of
 *    looking, so an unreadable probe refuses rather than clearing — the direction that keeps RUFU-390's
 *    root-as-member shape alive.
 * 5. The refusal row is the closed four-key ids/enums set, and no value carries the branch name or a path.
 *
 * The locally-runnable half of the git claims is `self-healing-planning-worktree-identity.real-git.test.ts`;
 * this file adds the persisted-row and audit-row halves.
 */
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { SelfHealingManager } from "../self-healing.js";

const pgTest = pgDescribe;

const CLEARED_EVENT = "task:auto-recover-worktree-metadata-cleared";
const REFUSED_EVENT = "task:reconcile-planning-lane-worktree-identity-no-action";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

const openFixtures: Array<() => void> = [];

/** A real repository on `main`; fixtures are real because the whole contract is a git verdict. */
function createRepoFixture(label: string): { rootDir: string; worktreesDir: string } {
  if (!hasGit) throw new Error("git is required for this fixture");
  const base = mkdtempSync(join(tmpdir(), `rufu893-pg-${label}-`));
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

function commitOnBranch(repo: string, branch: string, file: string): void {
  git(repo, `git checkout -b ${branch} main`);
  writeFileSync(join(repo, file), `${file}\n`, "utf8");
  git(repo, `git add ${file}`);
  git(repo, `git commit -m 'feat: ${file}'`);
  git(repo, "git checkout main");
}

pgTest("self-healing reconcileTaskWorktreeMetadata planning-lane identity (PostgreSQL + real git, RUFU-893)", () => {
  const h: SharedPgTaskStoreTestHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_rufu893_identity",
    projectId: "rufu893-identity",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);
  afterEach(() => {
    while (openFixtures.length > 0) openFixtures.pop()!();
  });

  /**
   * Seed a planning-lane card wearing the pointer pair. The provenance field rides with the branch because
   * core requires it on any branch write — the same guard the clear has to satisfy in the other direction.
   */
  async function seedPointerCard(
    id: string,
    shape: { column?: string; branch?: string | null; worktree?: string | null },
  ): Promise<string> {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: id, column: shape.column ?? "todo" },
      { taskId: id, applyDefaultWorkflowSteps: false },
    );
    await store.updateTask(id, {
      branch: shape.branch === null ? null : (shape.branch ?? `fusion/${id.toLowerCase()}`),
      branchWriteOrigin: "engine",
      worktree: shape.worktree === null ? null : (shape.worktree ?? `.fusion/worktrees/${id.toLowerCase()}`),
      status: null,
    } as never);
    store.taskCache.delete(id);
    return id;
  }

  /** Rows are read back over SQL after a sink drain, because an accepted emit is not yet a durable row. */
  async function auditRows(taskId: string, mutationType: string): Promise<Array<Record<string, unknown>>> {
    await h.store().flushRunAuditSink();
    const rows = await h.adminSql()`SELECT metadata FROM project.run_audit_events WHERE task_id = ${taskId} AND mutation_type = ${mutationType}`;
    return rows.map((row: { metadata: unknown }) =>
      (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata) as Record<string, unknown>);
  }

  it("clears a ref-less pointer IN PLACE, with the persisted row, History and audit all agreeing", async () => {
    const store = h.store();
    const { rootDir, worktreesDir } = createRepoFixture("absent");
    const branch = "fusion/rufu893pg-a1";
    commitOnBranch(rootDir, branch, "abandoned.txt");
    git(rootDir, `git branch -D ${branch}`);
    const id = await seedPointerCard("rufu893pg-a1", {
      branch,
      worktree: join(worktreesDir, "rufu893pg-a1"),
    });

    expect(await new SelfHealingManager(store, { rootDir }).reconcileTaskWorktreeMetadata()).toBe(1);

    const cleared = await store.getTask(id);
    expect(cleared?.worktree ?? undefined).toBeUndefined();
    expect(cleared?.branch ?? undefined).toBeUndefined();
    /* LIFECYCLE CONTAINMENT: the fix is a metadata repair, never a relocation or a status write. */
    expect(cleared?.column).toBe("todo");
    expect(cleared?.status ?? undefined).toBeUndefined();
    /* The provenance the clear is required to state, read back from the persisted row. */
    expect(cleared?.branchWriteOrigin).toBe("engine");
    expect((cleared?.log ?? []).some((entry) => /worktree-identity/i.test(entry.action))).toBe(true);
    expect((await auditRows(id, CLEARED_EVENT)).length).toBeGreaterThan(0);
    expect(await auditRows(id, REFUSED_EVENT)).toEqual([]);
  });

  it("withholds the clear while the branch carries a commit main has never seen, and the commits survive", async () => {
    const store = h.store();
    const { rootDir, worktreesDir } = createRepoFixture("divergent");
    const branch = "fusion/rufu893pg-b1";
    commitOnBranch(rootDir, branch, "undelivered.txt");
    const id = await seedPointerCard("rufu893pg-b1", {
      branch,
      worktree: join(worktreesDir, "rufu893pg-b1"),
    });

    expect(await new SelfHealingManager(store, { rootDir }).reconcileTaskWorktreeMetadata()).toBe(0);

    const kept = await store.getTask(id);
    expect(kept?.branch).toBe(branch);
    expect(kept?.worktree).toBe(join(worktreesDir, "rufu893pg-b1"));
    expect(kept?.column).toBe("todo");
    /* The work is still reachable by the name the retained pointer names. */
    expect(git(rootDir, `git rev-list --count main..refs/heads/${branch}`)).toBe("1");

    const refusals = await auditRows(id, REFUSED_EVENT);
    expect(refusals).toHaveLength(1);
    expect(Object.keys(refusals[0]!).sort()).toEqual(["code", "column", "outcome", "taskId"]);
    expect(refusals[0]).toEqual({ taskId: id, column: "todo", code: "ref-divergent", outcome: "withheld" });
    for (const value of Object.values(refusals[0]!)) {
      expect(String(value)).not.toContain("fusion/");
      expect(String(value)).not.toContain(worktreesDir);
    }
    expect((await store.getTask(id))?.log.some((entry) => /NOT contained/.test(entry.action))).toBe(true);
  });

  it("does not read a live `fusion/<id>-step-1` worktree as this card's checkout", async () => {
    const store = h.store();
    const { rootDir, worktreesDir } = createRepoFixture("decoy");
    const branch = "fusion/rufu893pg-c1";
    mkdirSync(join(worktreesDir, "rufu893pg-c1-step-1"), { recursive: true });
    git(rootDir, `git worktree add ${join(worktreesDir, "rufu893pg-c1-step-1")} -b ${branch}-step-1 main`);
    const id = await seedPointerCard("rufu893pg-c1", {
      branch,
      worktree: join(worktreesDir, "rufu893pg-c1"),
    });

    expect(git(rootDir, "git worktree list --porcelain")).toContain(`branch refs/heads/${branch}-step-1`);
    expect(await new SelfHealingManager(store, { rootDir }).reconcileTaskWorktreeMetadata()).toBe(1);
    const cleared = await store.getTask(id);
    expect(cleared?.branch ?? undefined).toBeUndefined();
    expect(cleared?.column).toBe("todo");
    /* The decoy's own checkout is untouched — this sweep removes no worktree and no ref. */
    expect(git(rootDir, "git worktree list --porcelain")).toContain(`branch refs/heads/${branch}-step-1`);
  });

  it("holds a member-repository pointer at a root that is not a repository", async () => {
    /*
    RUFU-390's shape, on the side of the decision that withholds. The workspace entry directory is not a git
    repository, so every probe there answers `unknown` for a member branch; reading that as `absent` is how
    a pointer pair naming live member work gets nulled, and a `null` branch at an entry whose member repos
    are real is a pointer acquisition can never rebuild.
    */
    const store = h.store();
    const base = mkdtempSync(join(tmpdir(), "rufu893-pg-notarepo-"));
    openFixtures.push(() => rmSync(base, { recursive: true, force: true }));
    const rootDir = join(base, "workspace-entry");
    mkdirSync(join(rootDir, "members", "engine"), { recursive: true });
    const id = await seedPointerCard("rufu893pg-d1", {
      branch: "fusion/rufu893pg-d1",
      worktree: join(rootDir, "members", "api"),
    });

    expect(await new SelfHealingManager(store, { rootDir }).reconcileTaskWorktreeMetadata()).toBe(0);
    const kept = await store.getTask(id);
    expect(kept?.branch).toBe("fusion/rufu893pg-d1");
    expect(kept?.column).toBe("todo");
    const refusals = await auditRows(id, REFUSED_EVENT);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ code: "probe-unknown", outcome: "withheld" });
  });
});
