/*
 * Surface enumeration: engine recovery lane only — this is a git + store seam, so no dashboard surface,
 * no desktop or mobile breakpoint, and no CLI surface applies (the operator surfaces are covered in
 * `bin-task-reconcile.test.ts` and `landed-truth-census.real-git.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, LANDING_PROOF_UNPROVEN_ERROR_PREFIX, type Task, type TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

/*
Self-healing's shared complete-lane mover is a landing authority (RUFU-702, code-review P2).

`moveToCompleteLaneAfterLandedCleanup` carries `mergeDetails` and performs the terminal `moveTask`, and seven
recovery arms finalize through it. It used to move first and never asked, so every one of those arms could
reach `done` on a commit the default branch does not hold — including the two whose `baseBranch` falls back
to `task.baseBranch || task.executionStartBranch || projectDefaultBranch`, a ref that can itself name a
Fusion task branch. Their premise re-verifies OWNERSHIP, which proves an owned commit exists on THAT ref and
says nothing about `main`; that is RUFU-294's shape arriving through a door this card had not closed.

The assertions are deliberately at the CALLER level, because the reviewer's requirement is prevention, not
detection: the census can only find such a card after the false `done`. What is asserted is the observable
lane state (`moveTask` never ran, the card is not in the terminal lane), the durable hold the door owes, and
the refusal row — never log prose.

Git is real and the store is faked. A fake shell cannot discharge a claim about what the default branch
contains; a fake store is what makes "was the card moved?" directly observable.
*/

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  const full = command.startsWith("git ") ? command : `git ${command}`;
  return execSync(full, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-702-MOVER",
    title: "Off-main delivery claim",
    description: "recovery arm finalizes a commit that is not on main",
    column: "in-review",
    branch: "fusion/rufu-702-mover",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

interface MoverStore extends TaskStore {
  row: Task;
  moveTask: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
  updateTaskAtomic: ReturnType<typeof vi.fn>;
  logEntry: ReturnType<typeof vi.fn>;
  history: string[];
  auditRows: Array<{ mutationType: string; metadata: Record<string, unknown> }>;
}

function moverStore(initial: Task): MoverStore {
  const history: string[] = [];
  const auditRows: MoverStore["auditRows"] = [];
  const store = {
    row: initial,
    getTask: vi.fn(async () => store.row),
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
    listTasks: vi.fn(async () => [store.row]),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      store.row = { ...store.row, ...patch } as Task;
      if (patch.error === null) delete (store.row as { error?: string | null }).error;
      return store.row;
    }),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: Task) => Partial<Task> | null) => {
      const patch = updater(store.row);
      if (!patch) return null;
      store.row = { ...store.row, ...patch } as Task;
      if (patch.error === null) delete (store.row as { error?: string | null }).error;
      return store.row;
    }),
    // The mover must refuse BEFORE this runs, so its call count is the whole prevention assertion.
    moveTask: vi.fn(async (_id: string, column: string) => {
      store.row = { ...store.row, column } as Task;
      return store.row;
    }),
    logEntry: vi.fn(async (_id: string, message: string) => { history.push(message); }),
    recordRunAuditEvent: vi.fn(async (entry: { mutationType: string; metadata: Record<string, unknown> }) => {
      auditRows.push(entry);
    }),
    emit: vi.fn(),
    on: vi.fn(),
  } as unknown as MoverStore;
  store.history = history;
  store.auditRows = auditRows;
  return store;
}

describeIfGit("self-healing complete-lane mover — landing proof is required before the move (RUFU-702)", () => {
  let repo: string;
  let offMainSha: string;
  let onMainSha: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "rufu-702-mover-"));
    git(repo, "init -b main");
    git(repo, "config user.email mover@test.local");
    git(repo, "config user.name Mover Test");
    git(repo, "config commit.gpgsign false");
    writeFileSync(join(repo, "README.md"), "seed\n");
    git(repo, "add README.md");
    git(repo, "commit -m seed");

    // The RUFU-702 shape: a commit owned by this card, living only on a task branch, never on main.
    git(repo, "checkout -b fusion/rufu-702-mover");
    mkdirSync(join(repo, "packages"), { recursive: true });
    writeFileSync(join(repo, "packages", "deliverable.ts"), "export const delivered = true;\n");
    git(repo, "add -A");
    git(repo, "commit -m 'feat(RUFU-702-MOVER): deliverable that never reaches main'");
    offMainSha = git(repo, "rev-parse HEAD");

    // main moves on independently, so ancestry cannot accidentally succeed through a fast-forward.
    git(repo, "checkout main");
    writeFileSync(join(repo, "NEWS.md"), "unrelated main work\n");
    git(repo, "add NEWS.md");
    git(repo, "commit -m 'main work while the card sat in review'");
    onMainSha = git(repo, "rev-parse HEAD");

    // Sanity: the fixture really is the false-landing shape, not a test artifact.
    const isAncestor = spawnSync("git", ["merge-base", "--is-ancestor", offMainSha, "main"], { cwd: repo }).status === 0;
    expect(isAncestor).toBe(false);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function moverFor(row: Task) {
    const store = moverStore(row);
    const manager = new SelfHealingManager(store, { rootDir: repo });
    return { store, manager };
  }

  it("refuses the move, leaves the card in review, and records the hold + refusal row", async () => {
    const row = taskFixture({
      mergeDetails: {
        commitSha: offMainSha,
        merged: true,
        mergedAt: new Date().toISOString(),
        // The lie RUFU-294's row told: a landing target naming its own sibling task branch.
        mergeTargetBranch: "fusion/rufu-702-mover",
        mergeTargetSource: "task-branch-context",
      } as Task["mergeDetails"],
    });
    const { store, manager } = moverFor(row);

    const result = await (manager as unknown as {
      moveToCompleteLaneAfterLandedCleanup: (t: Task, lane: string, source: string, md?: Task["mergeDetails"]) => Promise<Task | null>;
    }).moveToCompleteLaneAfterLandedCleanup(row, "done", "recover-already-merged-review", row.mergeDetails);

    // (a) the mover reports it did not move, and the terminal move never happened
    expect(result).toBeNull();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.row.column).toBe("in-review");

    // (b) the named refusal is durable on the row, with the shared machine-matchable prefix
    expect(typeof store.row.error).toBe("string");
    expect(store.row.error!.startsWith(LANDING_PROOF_UNPROVEN_ERROR_PREFIX)).toBe(true);

    // (c) one bounded audit row for this door, and a History line, without a status write
    const refusalRows = store.auditRows.filter((r) => r.mutationType === "task:finalization-landing-proof-refused");
    expect(refusalRows).toHaveLength(1);
    expect(refusalRows[0]!.metadata.source).toBe("self-healing-complete-lane-move");
    expect(refusalRows[0]!.metadata.recordedSha).toBe(offMainSha);
    expect(store.row.status ?? null).toBeNull();
    expect(store.history.some((line) => line.includes("REFUSED"))).toBe(true);
  });

  it("moves a card whose recorded commit IS on the integration branch and clears its stale hold", async () => {
    const row = taskFixture({
      column: "in-review",
      error: `${LANDING_PROOF_UNPROVEN_ERROR_PREFIX} stale hold from an earlier pass`,
      mergeDetails: {
        commitSha: onMainSha,
        merged: true,
        mergedAt: new Date().toISOString(),
      } as Task["mergeDetails"],
    });
    const { store, manager } = moverFor(row);

    const result = await (manager as unknown as {
      moveToCompleteLaneAfterLandedCleanup: (t: Task, lane: string, source: string, md?: Task["mergeDetails"]) => Promise<Task | null>;
    }).moveToCompleteLaneAfterLandedCleanup(row, "done", "reconcile-absent-branch", row.mergeDetails);

    // Positive control: the door is not a blanket refusal — real delivery still finalizes.
    expect(result).not.toBeNull();
    expect(store.moveTask).toHaveBeenCalledTimes(1);
    expect(store.row.column).toBe("done");
    // ...and the hold this door wrote on an earlier pass is discharged once the repository agrees.
    expect(store.row.error ?? null).toBeNull();
  });

  it("treats a store whose moveTask resolves undefined as a SUCCESS, not a refusal", async () => {
    // The token contract: `null` is the only refusal this function authors. Lightweight in-memory recovery
    // stores resolve `moveTask` to undefined, and a falsy `!movedTask` check at a call site silently read
    // that as a refusal — the card moved, but the arm skipped its own audit row and recovery counter.
    const row = taskFixture({
      mergeDetails: {
        commitSha: onMainSha,
        merged: true,
        mergedAt: new Date().toISOString(),
      } as Task["mergeDetails"],
    });
    const store = moverStore(row);
    store.moveTask = vi.fn(async () => undefined) as unknown as typeof store.moveTask;
    const manager = new SelfHealingManager(store, { rootDir: repo });

    const result = await (manager as unknown as {
      moveToCompleteLaneAfterLandedCleanup: (t: Task, lane: string, source: string, md?: Task["mergeDetails"]) => Promise<Task | null>;
    }).moveToCompleteLaneAfterLandedCleanup(row, "done", "recover-already-merged-review", row.mergeDetails);

    expect(result).not.toBeNull();
    expect(store.moveTask).toHaveBeenCalledTimes(1);
  });

  it("defers rather than refuses when the repository cannot be read", async () => {
    const row = taskFixture({
      mergeDetails: {
        commitSha: "0".repeat(40),
        merged: true,
        mergedAt: new Date().toISOString(),
      } as Task["mergeDetails"],
    });
    const store = moverStore(row);
    // A rootDir that is not a repository at all: the yardstick is unreadable, which is silence, not guilt.
    const manager = new SelfHealingManager(store, { rootDir: mkdtempSync(join(tmpdir(), "rufu-702-not-a-repo-")) });

    const result = await (manager as unknown as {
      moveToCompleteLaneAfterLandedCleanup: (t: Task, lane: string, source: string, md?: Task["mergeDetails"]) => Promise<Task | null>;
    }).moveToCompleteLaneAfterLandedCleanup(row, "done", "recover-interrupted-merging", row.mergeDetails);

    expect(result).not.toBeNull();
    expect(store.moveTask).toHaveBeenCalledTimes(1);
    expect(store.row.error ?? null).toBeNull();
  });
});
