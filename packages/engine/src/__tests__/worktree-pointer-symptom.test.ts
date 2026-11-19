/**
 * RUFU-1054 symptom and ownership coverage for the pointer sweep.
 *
 * FNXC:WorktreePointerState 2026-11-18-03:38 (RUFU-1054):
 * The reported failure is RUFU-243: a card whose recorded working directory had been deleted, sitting in a
 * lane where `reconcileTaskWorktreeMetadata` deliberately refuses to touch worktree metadata (FN-5256's
 * guard, earned when a live card's pointer was cleared out from under a running shell). The refusal is
 * correct, and nothing else owned the class, so the card kept pointing at a directory that did not exist
 * and every claim built on that field — "hasWorktree", the stale-worktree re-derivation, the cleanup
 * ledger — described a path rather than a checkout. The operator's fix was a hand-run
 * `UPDATE project.tasks SET worktree = NULL`.
 *
 * The fixture is a REAL repository with REAL `git worktree` operations and no mocked git helper, because
 * every wrong verdict this card is about came from a read that described some other repository. The
 * deletion is a real `rm -rf` that leaves git's administrative entry standing — the shape the card names
 * as the reproduction — and measured against it, `git worktree list --porcelain` still PRINTS the deleted
 * path with a `prunable` line. That is why the old reader's "registered" answer and this classifier's
 * "live checkout" answer are different questions.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { acquireTaskWorktree } from "../worktree/worktree-acquisition.js";

// ── real git fixture ─────────────────────────────────────────────────────────

interface Fixture {
  root: string;
  cleanup: () => void;
  addWorktree: (branch: string, path: string) => void;
  commitIn: (path: string, file: string) => void;
  /**
   * A commit carrying the task-attribution trailer — the shape a real task branch's commits have. The
   * bare-branch collision inspector classifies a stranded branch as reclaimable ONLY when its unique
   * commits are exclusively attributed to that task id, so an acquisition case that must END with a fresh
   * checkout needs commits the collision ladder is allowed to recognise as the card's own.
   */
  commitAsTask: (path: string, file: string, taskId: string) => void;
  commitCount: (branch: string) => number;
  /** git's own administrative entry for a worktree name (`.git/worktrees/<name>`). */
  adminEntryExists: (name: string) => boolean;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createFixture(): Fixture {
  // realpath first: macOS hands out /var -> /private/var, and a pointer compared against git's
  // canonicalised output must be canonical for the same reason production code canonicalises.
  const root = mkdtempSync(join(realpathSync(tmpdir()), "rufu-1054-repo-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "Fixture"]);
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git(root, ["add", "seed.txt"]);
  git(root, ["commit", "-m", "seed"]);
  return {
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* best-effort temp cleanup */
      }
    },
    addWorktree: (branch, path) => {
      git(root, ["worktree", "add", "-b", branch, path, "HEAD"]);
    },
    commitIn: (path, file) => {
      writeFileSync(join(path, file), `${file} content\n`);
      git(path, ["add", file]);
      git(path, ["commit", "-m", file]);
    },
    commitAsTask: (path, file, taskId) => {
      writeFileSync(join(path, file), `${file} content\n`);
      git(path, ["add", file]);
      git(path, ["commit", "-m", file, "-m", `Fusion-Task-Id: ${taskId}`]);
    },
    commitCount: (branch) => Number(git(root, ["rev-list", "--count", branch]) || "0"),
    adminEntryExists: (name) => existsSync(join(root, ".git", "worktrees", name)),
  };
}

// ── store harness ────────────────────────────────────────────────────────────

interface Harness {
  store: TaskStore & EventEmitter;
  tasks: Map<string, Task>;
  patches: Array<{ id: string; patch: Record<string, unknown> }>;
  auditRows: Array<{ mutationType: string; metadata: Record<string, unknown> }>;
  history: string[];
  setExecuting: (ids: Set<string>) => void;
  manager: SelfHealingManager;
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "in-progress",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function makeHarness(rows: Task[], rootDir: string): Harness {
  const map = new Map(rows.map((row) => [row.id, row]));
  const patches: Harness["patches"] = [];
  const auditRows: Harness["auditRows"] = [];
  const history: string[] = [];
  let executing = new Set<string>();

  const applyPatch = async (id: string, patch: Record<string, unknown>) => {
    patches.push({ id, patch });
    const current = map.get(id);
    if (current) map.set(id, { ...current, ...patch } as Task);
    return map.get(id) ?? null;
  };

  const store = {
    getSettings: async () => ({ globalPause: false, enginePaused: false }),
    listTasks: async () => [...map.values()],
    getTask: async (id: string) => map.get(id) ?? null,
    updateTask: async (id: string, patch: Record<string, unknown>) => applyPatch(id, patch),
    updateTaskAtomic: async (
      id: string,
      update: (live: Task) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>,
    ) => {
      const current = map.get(id);
      if (!current) return null;
      const patch = await update(current);
      if (!patch) return null;
      return applyPatch(id, patch);
    },
    recordRunAuditEvent: async (input: { mutationType: string; metadata?: Record<string, unknown> }) => {
      auditRows.push({ mutationType: input.mutationType, metadata: input.metadata ?? {} });
    },
    logEntry: async (_id: string, action: string) => {
      history.push(action);
    },
    logEntryOnce: async (_id: string, opts: { action?: string }) => {
      history.push(opts?.action ?? "");
      return true;
    },
    moveTask: async () => undefined,
  };

  const typedStore = store as unknown as TaskStore & EventEmitter;
  return {
    store: typedStore,
    tasks: map,
    patches,
    auditRows,
    history,
    setExecuting: (ids) => {
      executing = ids;
    },
    manager: new SelfHealingManager(typedStore, {
      rootDir,
      getExecutingTaskIds: () => executing,
    }),
  };
}

/**
 * A pointer git registers nowhere, built the way the field actually goes stale: a real checkout on a real
 * branch with real commits, then a real deletion that leaves git's administrative entry behind.
 */
function makeStateBPointer(fixture: Fixture, branch: string, dirName: string, attributedTo?: string): string {
  const deadPath = join(fixture.root, ".fusion", "worktrees", dirName);
  fixture.addWorktree(branch, deadPath);
  if (attributedTo) fixture.commitAsTask(deadPath, "work.txt", attributedTo);
  else fixture.commitIn(deadPath, "work.txt");
  rmSync(deadPath, { recursive: true, force: true });
  return deadPath;
}

function rowsOfType(harness: Harness, mutationType: string) {
  return harness.auditRows.filter((row) => row.mutationType === mutationType);
}

describe("RUFU-1054 worktree pointer symptom", () => {
  let fixture: Fixture | null = null;

  afterEach(() => {
    fixture?.cleanup();
    fixture = null;
  });

  describe("the reported residual: the metadata reconcile does not repair this class", () => {
    /*
    FNXC:WorktreePointerState 2026-11-18-03:55 (RUFU-1054): pin 1, red then green.
    RED against pre-fix code (transcript in the task log): this fixture returned 1, wrote the SAME deleted
    path back, and emitted `task:auto-recover-worktree-metadata-rebound` with previous == new, because
    `getRegisteredWorktreeBranchMap` still maps the branch to the deleted path — the pool's reader does not
    drop git's `prunable` entries. The card's premise expected the FN-5256 refusal; it never fired, so the
    defect was recorded as a success and the class stayed invisible.
    GREEN after Step 3: the registry answer now excludes an entry git itself marks unbacked, so the rebind
    arm has no target, the branch survives as a `prunableBranches` witness, and the row is refused through
    the refusal event the FN-5256 guard already uses — zero writes, and `reconcileWorktreePointers` owns the
    repair of clearing the pointer alone.
    */
    it("refuses a WIP-lane stale pointer instead of rebounding it to the deleted path", async () => {
      fixture = createFixture();
      const branch = "fusion/rufu-243";
      const deadPath = makeStateBPointer(fixture, branch, "rufu-243");
      const harness = makeHarness(
        [task("RUFU-243", { column: "in-progress", worktree: deadPath, branch })],
        fixture.root,
      );

      const repaired = await harness.manager.reconcileTaskWorktreeMetadata();

      expect(repaired).toBe(0);
      expect(harness.patches).toEqual([]);
      expect(harness.tasks.get("RUFU-243")?.worktree).toBe(deadPath);
      expect(rowsOfType(harness, "task:auto-recover-worktree-metadata-rebound")).toHaveLength(0);
      expect(rowsOfType(harness, "task:auto-recover-worktree-metadata-cleared")).toHaveLength(0);
      expect(rowsOfType(harness, "task:auto-recover-worktree-metadata-skipped-active")).toHaveLength(1);
      // And the pointer sweep that does own this class repairs it without touching the branch.
      expect(await harness.manager.reconcileWorktreePointers()).toBe(1);
      expect(harness.patches).toEqual([{ id: "RUFU-243", patch: { worktree: null } }]);
      expect(harness.tasks.get("RUFU-243")?.branch).toBe(branch);
    });
  });

  describe("reconcileWorktreePointers: the state it repairs", () => {
    it("clears a WIP-lane pointer that git registers nowhere, keeping the branch and the lineage", async () => {
      fixture = createFixture();
      const branch = "fusion/rufu-243";
      const deadPath = makeStateBPointer(fixture, branch, "rufu-243");
      const commitsBefore = fixture.commitCount(branch);
      const harness = makeHarness(
        [task("RUFU-243", { column: "in-progress", worktree: deadPath, branch, sessionFile: "/tmp/session.jsonl" })],
        fixture.root,
      );

      const repaired = await harness.manager.reconcileWorktreePointers();

      expect(repaired).toBe(1);
      // Exactly one field: the pointer. Branch, lane, status, and unrelated metadata all stand.
      expect(harness.patches).toEqual([{ id: "RUFU-243", patch: { worktree: null } }]);
      const live = harness.tasks.get("RUFU-243")!;
      expect(live.worktree).toBeNull();
      expect(live.branch).toBe(branch);
      expect(live.column).toBe("in-progress");
      expect(live.status).toBeNull();
      expect(live.sessionFile).toBe("/tmp/session.jsonl");
      // No mutating worktree command ran: the branch ref and git's own administrative entry both stand.
      expect(fixture.commitCount(branch)).toBe(commitsBefore);
      expect(fixture.adminEntryExists("rufu-243")).toBe(true);
    });

    it("emits one repair row with the closed five-key metadata and one operator History line", async () => {
      fixture = createFixture();
      const branch = "fusion/rufu-243";
      const deadPath = makeStateBPointer(fixture, branch, "rufu-243");
      const harness = makeHarness(
        [task("RUFU-243", { column: "in-progress", worktree: deadPath, branch })],
        fixture.root,
      );

      await harness.manager.reconcileWorktreePointers();

      const rows = rowsOfType(harness, "task:reconcile-worktree-pointer");
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]!.metadata).sort()).toEqual(["column", "outcome", "passCount", "state", "taskId"]);
      expect(rows[0]!.metadata).toMatchObject({
        taskId: "RUFU-243",
        column: "in-progress",
        state: "stale-pointer",
        outcome: "repaired",
      });
      // The row carries no path, no branch name, and no sha, whatever the fixture's paths look like.
      const serialized = JSON.stringify(rows[0]!.metadata);
      expect(serialized).not.toContain(fixture.root);
      expect(serialized).not.toContain(branch);

      expect(harness.history).toHaveLength(1);
      expect(harness.history[0]).toContain("[worktree-pointer]");
      expect(harness.history[0]).not.toContain(fixture.root);
      expect(harness.history[0]).not.toContain(branch);
    });

    it("treats a review-lane card as its own candidate too", async () => {
      fixture = createFixture();
      const branch = "fusion/rufu-243";
      const deadPath = makeStateBPointer(fixture, branch, "rufu-243");
      const harness = makeHarness(
        [task("RUFU-243", { column: "in-review", worktree: deadPath, branch })],
        fixture.root,
      );

      expect(await harness.manager.reconcileWorktreePointers()).toBe(1);
    });

    it("leaves a `todo`-lane state-B row to the metadata reconcile, whose lane sets are disjoint", async () => {
      fixture = createFixture();
      const branch = "fusion/rufu-243";
      const deadPath = makeStateBPointer(fixture, branch, "rufu-243");
      const harness = makeHarness(
        [task("RUFU-243", { column: "todo", worktree: deadPath, branch })],
        fixture.root,
      );

      expect(await harness.manager.reconcileWorktreePointers()).toBe(0);
      expect(harness.patches).toHaveLength(0);
      expect(harness.auditRows).toHaveLength(0);
      // The row is left exactly as found. Its owning lane is the metadata reconcile's, whose lane sets are
      // disjoint from these; Step 3's hardening covers what that lane does with it.
      expect(harness.tasks.get("RUFU-243")?.worktree).toBe(deadPath);
    });
  });

  describe("reconcileWorktreePointers: what it must not touch", () => {
    it("costs a live registered checkout zero writes and zero rows", async () => {
      fixture = createFixture();
      const branch = "fusion/rufu-consistent";
      const livePath = join(fixture.root, ".fusion", "worktrees", "rufu-consistent");
      fixture.addWorktree(branch, livePath);
      fixture.commitIn(livePath, "work.txt");
      const commitsBefore = fixture.commitCount(branch);
      const harness = makeHarness(
        [task("RUFU-CONSISTENT", { column: "in-progress", worktree: livePath, branch })],
        fixture.root,
      );

      expect(await harness.manager.reconcileWorktreePointers()).toBe(0);
      expect(harness.patches).toHaveLength(0);
      expect(harness.auditRows).toHaveLength(0);
      expect(harness.tasks.get("RUFU-CONSISTENT")?.worktree).toBe(livePath);
      expect(fixture.commitCount(branch)).toBe(commitsBefore);
    });

    it("reports an unclaimed live tree as owned-elsewhere and writes nothing", async () => {
      fixture = createFixture();
      const branch = "fusion/rufu-unclaimed";
      const livePath = join(fixture.root, ".fusion", "worktrees", "rufu-unclaimed");
      fixture.addWorktree(branch, livePath);
      const unreachable = join(fixture.root, "never-existed");
      const harness = makeHarness(
        [task("RUFU-UNCLAIMED", { column: "in-progress", worktree: unreachable, branch })],
        fixture.root,
      );

      expect(await harness.manager.reconcileWorktreePointers()).toBe(0);
      expect(harness.patches).toHaveLength(0);
      const rows = rowsOfType(harness, "task:reconcile-worktree-pointer-no-action");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.metadata).toMatchObject({ state: "unclaimed-live-tree", outcome: "owned-elsewhere" });
      // The path stays unclaimed here: `reconcileTaskWorktreeMetadata`'s rebind arm is that field's writer.
      expect(harness.tasks.get("RUFU-UNCLAIMED")?.worktree).toBe(unreachable);
    });

    it("refuses a pointer that names a live directory git registers nowhere", async () => {
      fixture = createFixture();
      const branch = "fusion/rufu-unregistered";
      // A real directory with real content that git has never heard of: not a checkout, and clearing the
      // pointer on it would drop the only reference to a tree someone may still be holding.
      const strayPath = join(fixture.root, ".fusion", "worktrees", "stray");
      mkdirSync(strayPath, { recursive: true });
      writeFileSync(join(strayPath, "notes.txt"), "not a checkout\n");
      const harness = makeHarness(
        [task("RUFU-UNREGISTERED", { column: "in-progress", worktree: strayPath, branch })],
        fixture.root,
      );

      expect(await harness.manager.reconcileWorktreePointers()).toBe(0);
      expect(harness.patches).toHaveLength(0);
      const rows = rowsOfType(harness, "task:reconcile-worktree-pointer-no-action");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.metadata.state).toBe("outside-work-tree");
    });

    it("writes nothing for a workspace card, a paused card, an executing card, or a merge-active card", async () => {
      fixture = createFixture();
      const rows = [
        task("RUFU-WS", {
          column: "in-progress",
          worktree: join(fixture.root, "gone-a"),
          branch: "fusion/rufu-ws",
          workspaceWorktrees: [{ repoPath: "repo-a", worktreePath: join(fixture.root, "gone-a") }] as never,
        }),
        task("RUFU-PAUSED", {
          column: "in-progress",
          worktree: join(fixture.root, "gone-b"),
          branch: "fusion/rufu-paused",
          paused: true,
        }),
        task("RUFU-EXEC", { column: "in-progress", worktree: join(fixture.root, "gone-c"), branch: "fusion/rufu-exec" }),
        task("RUFU-MERGE", {
          column: "in-review",
          worktree: join(fixture.root, "gone-d"),
          branch: "fusion/rufu-merge",
          status: "merging",
        }),
        task("RUFU-BLOCKED", {
          column: "in-progress",
          worktree: join(fixture.root, "gone-e"),
          branch: "fusion/rufu-blocked",
          status: "blocked",
          externalBlock: {
            origin: "outside-worktree",
            code: "credential",
            message: "Credential host refused the request",
            source: "agent-declaration",
            blockedAt: new Date().toISOString(),
            resume: { column: "in-progress", currentStep: 0 },
          } as never,
        }),
      ];
      const harness = makeHarness(rows, fixture.root);
      harness.setExecuting(new Set(["RUFU-EXEC"]));

      expect(await harness.manager.reconcileWorktreePointers()).toBe(0);
      expect(harness.patches).toHaveLength(0);
      const states = new Map(
        rowsOfType(harness, "task:reconcile-worktree-pointer-no-action").map((row) => [
          row.metadata.taskId,
          row.metadata.state,
        ]),
      );
      expect(states.get("RUFU-WS")).toBe("gate-workspace-task");
      expect(states.get("RUFU-PAUSED")).toBe("gate-paused");
      expect(states.get("RUFU-EXEC")).toBe("gate-executing");
      expect(states.get("RUFU-MERGE")).toBe("gate-merge-active");
      expect(states.get("RUFU-BLOCKED")).toBe("gate-externally-blocked");
    });

    it("does not reach through an operator park or a soft-deleted row", async () => {
      fixture = createFixture();
      const harness = makeHarness(
        [
          task("RUFU-USERPAUSED", {
            column: "in-progress",
            worktree: join(fixture.root, "gone"),
            branch: "fusion/rufu-userpaused",
            userPaused: true,
          }),
          task("RUFU-DELETED", {
            column: "in-progress",
            worktree: join(fixture.root, "gone-2"),
            branch: "fusion/rufu-deleted",
            deletedAt: new Date().toISOString(),
          }),
        ],
        fixture.root,
      );

      expect(await harness.manager.reconcileWorktreePointers()).toBe(0);
      expect(harness.patches).toHaveLength(0);
    });

    it("performs no repair at all when the registry cannot be read, rather than reading absence", async () => {
      fixture = createFixture();
      const harness = makeHarness(
        [task("RUFU-243", { column: "in-progress", worktree: join(fixture.root, "gone"), branch: "fusion/rufu-243" })],
        // Not a repository: `git worktree list` fails here. A pass that read that as "nothing is registered
        // anywhere" would call every pointer on the board stale.
        join(fixture.root, "not-a-repo"),
      );

      expect(await harness.manager.reconcileWorktreePointers()).toBe(0);
      expect(harness.patches).toHaveLength(0);
      expect(harness.auditRows).toHaveLength(0);
    });

    it("refuses a card whose own error sentence is an acquisition conflict, leaving the repair to RUFU-356", async () => {
      fixture = createFixture();
      const branch = "fusion/rufu-conflict";
      const deadPath = makeStateBPointer(fixture, branch, "rufu-conflict");
      const harness = makeHarness(
        [
          task("RUFU-CONFLICT", {
            column: "in-progress",
            worktree: deadPath,
            branch,
            status: "failed",
            error: `Worktree acquisition failed after 3 heartbeat attempts for branch "${branch}": fatal: '${branch}' is already checked out at '/somewhere/else'`,
          }),
        ],
        fixture.root,
      );

      expect(await harness.manager.reconcileWorktreePointers()).toBe(0);
      expect(harness.patches).toHaveLength(0);
      expect(rowsOfType(harness, "task:reconcile-worktree-pointer-no-action")[0]?.metadata.state).toBe(
        "gate-acquisition-conflict",
      );
    });

    it("refuses a card whose worktree vanished mid-merge, leaving it to FN-7802", async () => {
      fixture = createFixture();
      const branch = "fusion/rufu-fn7802";
      const deadPath = makeStateBPointer(fixture, branch, "rufu-fn7802");
      const harness = makeHarness(
        [
          task("RUFU-FN7802", {
            column: "in-review",
            worktree: deadPath,
            branch,
            status: "failed",
            error: `Refusing to start coding agent in missing worktree: ${deadPath}`,
          }),
        ],
        fixture.root,
      );

      expect(await harness.manager.reconcileWorktreePointers()).toBe(0);
      expect(harness.patches).toHaveLength(0);
      expect(rowsOfType(harness, "task:reconcile-worktree-pointer-no-action")[0]?.metadata.state).toBe(
        "gate-missing-worktree-session-start",
      );
    });

    it("keeps a terminal-lane card out of the pass", async () => {
      fixture = createFixture();
      const harness = makeHarness(
        [task("RUFU-DONE", { column: "done", worktree: join(fixture.root, "gone"), branch: "fusion/rufu-done" })],
        fixture.root,
      );

      expect(await harness.manager.reconcileWorktreePointers()).toBe(0);
      expect(harness.patches).toHaveLength(0);
      expect(harness.auditRows).toHaveLength(0);
    });

    it("abstains entirely while the engine is paused", async () => {
      fixture = createFixture();
      const harness = makeHarness(
        [task("RUFU-243", { column: "in-progress", worktree: join(fixture.root, "gone"), branch: "fusion/rufu-243" })],
        fixture.root,
      );
      (harness.store as unknown as { getSettings: () => Promise<unknown> }).getSettings = async () => ({
        globalPause: true,
        enginePaused: false,
      });

      expect(await harness.manager.reconcileWorktreePointers()).toBe(0);
      expect(harness.patches).toHaveLength(0);
    });
  });

  describe("reconcileWorktreePointers: write discipline", () => {
    it("writes nothing when the live row drifted under the fenced re-read", async () => {
      fixture = createFixture();
      const branch = "fusion/rufu-drift";
      const deadPath = makeStateBPointer(fixture, branch, "rufu-drift");
      const repoRoot = fixture.root;
      const harness = makeHarness(
        [task("RUFU-DRIFT", { column: "in-progress", worktree: deadPath, branch })],
        fixture.root,
      );
      // Acquisition re-derived the pointer between the page read and the write.
      (harness.store as unknown as {
        updateTaskAtomic: (id: string, update: (live: Task) => unknown) => Promise<unknown>;
      }).updateTaskAtomic = async (id, update) => {
        const live = { ...(harness.tasks.get(id) as Task), worktree: join(repoRoot, "re-acquired") };
        return update(live as Task);
      };

      expect(await harness.manager.reconcileWorktreePointers()).toBe(0);
      expect(harness.patches).toHaveLength(0);
      expect(rowsOfType(harness, "task:reconcile-worktree-pointer-no-action")[0]?.metadata).toMatchObject({
        state: "stale-pointer",
        outcome: "write-refused",
      });
    });

    it("still lands the repair when the audit sink never settles", async () => {
      fixture = createFixture();
      const branch = "fusion/rufu-sink";
      const deadPath = makeStateBPointer(fixture, branch, "rufu-sink");
      const harness = makeHarness(
        [task("RUFU-SINK", { column: "in-progress", worktree: deadPath, branch })],
        fixture.root,
      );
      (harness.store as unknown as { recordRunAuditEvent: () => Promise<never> }).recordRunAuditEvent =
        () => new Promise<never>(() => {});

      expect(await harness.manager.reconcileWorktreePointers()).toBe(1);
      expect(harness.patches).toEqual([{ id: "RUFU-SINK", patch: { worktree: null } }]);
    });

    it("emits one no-action row per (card, verdict) and still repairs when the verdict changes", async () => {
      fixture = createFixture();
      const branch = "fusion/rufu-dedupe";
      const livePath = join(fixture.root, ".fusion", "worktrees", "rufu-dedupe");
      fixture.addWorktree(branch, livePath);
      const harness = makeHarness(
        [task("RUFU-DEDUPE", { column: "in-progress", worktree: join(fixture.root, "never-existed"), branch })],
        fixture.root,
      );

      // Passes one and two: the same owned-elsewhere verdict, reported once.
      await harness.manager.reconcileWorktreePointers();
      await harness.manager.reconcileWorktreePointers();
      const noAction = rowsOfType(harness, "task:reconcile-worktree-pointer-no-action");
      expect(noAction).toHaveLength(1);
      expect(noAction[0]!.metadata).toMatchObject({ state: "unclaimed-live-tree", outcome: "owned-elsewhere" });
      expect(harness.patches).toHaveLength(0);

      // The last checkout then disappears too, so the verdict becomes `stale-pointer`. Repairs are never
      // memoed, so a card that becomes repairable is repaired in the pass that proves it.
      rmSync(livePath, { recursive: true, force: true });
      expect(await harness.manager.reconcileWorktreePointers()).toBe(1);
      expect(harness.patches).toEqual([{ id: "RUFU-DEDUPE", patch: { worktree: null } }]);
      expect(rowsOfType(harness, "task:reconcile-worktree-pointer")).toHaveLength(1);
    });
  });
});

/*
FNXC:WorktreePointerState 2026-11-18-03:56 (RUFU-1054): pin 3, red then green.
RED against pre-fix code (transcript in the task log): the card's sixth premise says
`getRegisteredWorktreeBranchMap` "returns an empty map on a git failure", so a failed read and a repository
with no worktrees are one answer. Measured with the registry pointed at a directory that is not a
repository, a card whose checkout EXISTS and IS registered for its own branch — the healthiest row the
taxonomy has — was called stale, and because it sits in a lane FN-5256 does not protect the fall-through arm
cleared `worktree` AND `branch` AND `sessionFile` and reported a recovery.
GREEN after Step 3: an unreadable listing ends the pass before any card is examined. The pre-fix run also
showed that `task:auto-recover-worktree-metadata-cleared` already carries absolute paths and branch names in
its metadata; this card keeps those three events byte-identical by instruction, so the never-recorded rule
is asserted on this card's own two events, not on the inherited ones.
*/
describe("RUFU-1054 pin 3: an unreadable registry repairs nothing", () => {
  it("writes nothing at all when the registered-worktree listing cannot be read", async () => {
    const fixture = createFixture();
    const livePath = join(fixture.root, ".worktrees", "fn-pb3");
    fixture.addWorktree("fusion/fn-pb3", livePath);
    // A real directory that is not a repository: every git command in it fails, which is the whole point.
    const unreadableRoot = mkdtempSync(join(realpathSync(tmpdir()), "rufu-1054-not-a-repo-"));
    try {
      const harness = makeHarness(
        [task("RUFU-PB3", { column: "todo", worktree: livePath, branch: "fusion/fn-pb3", sessionFile: "/tmp/rufu-pb3.json" })],
        unreadableRoot,
      );

      const repaired = await harness.manager.reconcileTaskWorktreeMetadata();

      expect(repaired).toBe(0);
      expect(harness.patches).toEqual([]);
      expect(harness.auditRows).toEqual([]);
      expect(harness.history).toEqual([]);
      const live = harness.tasks.get("RUFU-PB3")!;
      expect(live.worktree).toBe(livePath);
      expect(live.branch).toBe("fusion/fn-pb3");
      expect(live.sessionFile).toBe("/tmp/rufu-pb3.json");
      expect(existsSync(livePath)).toBe(true);

      // The pointer sweep shares the rule: the same unreadable root refuses it too.
      expect(await harness.manager.reconcileWorktreePointers()).toBe(0);
      expect(harness.patches).toEqual([]);
      expect(harness.auditRows).toEqual([]);
    } finally {
      rmSync(unreadableRoot, { recursive: true, force: true });
      fixture.cleanup();
    }
  });
});

/*
FNXC:WorktreePointerState 2026-11-19-08:30 (RUFU-1054): pin 4.
The two executor seams (`prepare-graph-node-execution.ts`, `run-graph-custom-node.ts`) notice a gone pointer
and rebuild their dispatch task with `worktree: undefined`, appending a History line each time. Neither ever
writes the row, so the column stayed wrong for the whole life of the card while the operator kept reading the
same missing directory on the card face. Acquisition is the lane that holds the pointer AND can ask git, so
that is where the clear becomes DURABLE. These four cases run against a real repository with real
`git worktree` operations; the registry read is injected only where the case is about git refusing to answer
or about proving that no read happened.
*/
describe("RUFU-1054 pin 4: acquisition persists the repair instead of re-deriving it", () => {
  let fixture: Fixture | null = null;

  afterEach(() => {
    fixture?.cleanup();
    fixture = null;
  });

  /** The row as a non-stripping lane hands it to acquisition: the pointer still names the dead path. */
  function rowWithPointer(id: string, pointer: string, branch: string): Task {
    return task(id, { column: "in-progress", worktree: pointer, branch });
  }

  it("clears the gone pointer on the ROW, not only in memory, and ends the call matching reality", async () => {
    fixture = createFixture();
    const branch = "fusion/rufu-900";
    const deadPath = makeStateBPointer(fixture, branch, "rufu-900", "RUFU-900");
    const commitsBefore = fixture.commitCount(branch);
    const harness = makeHarness([rowWithPointer("RUFU-900", deadPath, branch)], fixture.root);

    const result = await acquireTaskWorktree({
      rootDir: fixture.root,
      task: harness.tasks.get("RUFU-900")!,
      store: harness.store,
      settings: {},
      runInitCommand: false,
    });

    // The durable clear: one patch naming exactly the pointer column, written during this same call.
    expect(harness.patches).toEqual(expect.arrayContaining([{ id: "RUFU-900", patch: { worktree: null } }]));
    // `branch` survives: the pointer says where a checkout is, the branch says where the work is.
    const live = harness.tasks.get("RUFU-900")!;
    expect(live.branch).toBe(branch);
    expect(fixture.commitCount(branch)).toBe(commitsBefore);
    // And by the end of the same call the persisted column names a checkout git really registers.
    expect(existsSync(live.worktree!)).toBe(true);
    expect(result.worktreePath).toBe(live.worktree);
    expect(git(fixture.root, ["worktree", "list", "--porcelain"])).toContain(live.worktree!);
    // The operator reads the card, not the audit store.
    expect(harness.history.some((line) => line.includes("[worktree-pointer]"))).toBe(true);
  });

  it("adds no second write for an unclaimed live tree, whose adoption belongs to the metadata rebind", async () => {
    fixture = createFixture();
    const branch = "fusion/rufu-901";
    // One live tree for the branch at a path the row does not name; the named path never existed.
    const livePath = join(fixture.root, ".fusion", "worktrees", "rufu-901-elsewhere");
    fixture.addWorktree(branch, livePath);
    const deadPath = join(fixture.root, ".fusion", "worktrees", "rufu-901");
    const harness = makeHarness([rowWithPointer("RUFU-901", deadPath, branch)], fixture.root);

    await acquireTaskWorktree({
      rootDir: fixture.root,
      task: harness.tasks.get("RUFU-901")!,
      store: harness.store,
      settings: {},
      runInitCommand: false,
      createWorktree: async (createBranch: string, path: string) => ({ path, branch: createBranch }),
    }).catch(() => undefined);

    // Two writers of one column is how a repair becomes a race: this lane never clears a pointer whose
    // branch has a live tree elsewhere, whatever the rest of acquisition then decides to do.
    expect(harness.patches).not.toEqual(expect.arrayContaining([{ id: "RUFU-901", patch: { worktree: null } }]));
    expect(existsSync(livePath)).toBe(true);
    expect(git(fixture.root, ["worktree", "list", "--porcelain"])).toContain(livePath);
  });

  it("repairs nothing when git cannot answer, and asks it exactly once", async () => {
    fixture = createFixture();
    const branch = "fusion/rufu-902";
    const deadPath = makeStateBPointer(fixture, branch, "rufu-902");
    const harness = makeHarness([rowWithPointer("RUFU-902", deadPath, branch)], fixture.root);
    let reads = 0;

    await acquireTaskWorktree({
      rootDir: fixture.root,
      task: harness.tasks.get("RUFU-902")!,
      store: harness.store,
      settings: {},
      runInitCommand: false,
      createWorktree: async (createBranch: string, path: string) => ({ path, branch: createBranch }),
      readWorktreeRegistry: async () => {
        reads += 1;
        return { status: "unreadable" };
      },
    }).catch(() => undefined);

    expect(reads).toBe(1);
    expect(harness.patches).not.toEqual(expect.arrayContaining([{ id: "RUFU-902", patch: { worktree: null } }]));
    expect(harness.tasks.get("RUFU-902")?.worktree).toBe(deadPath);
    expect(harness.tasks.get("RUFU-902")?.branch).toBe(branch);
    // The live-claim control: a refusal to read is not absence, so the card keeps the pointer its
    // reservation timeout will name again — the symptom stays visible instead of being laundered away.
    expect(existsSync(deadPath)).toBe(false);
  });

  it("costs a live, registered pointer no registry read and no write at all", async () => {
    fixture = createFixture();
    const branch = "fusion/rufu-903";
    const livePath = join(fixture.root, ".fusion", "worktrees", "rufu-903");
    fixture.addWorktree(branch, livePath);
    const harness = makeHarness([rowWithPointer("RUFU-903", livePath, branch)], fixture.root);
    let reads = 0;

    const result = await acquireTaskWorktree({
      rootDir: fixture.root,
      task: harness.tasks.get("RUFU-903")!,
      store: harness.store,
      settings: {},
      runInitCommand: false,
      readWorktreeRegistry: async () => {
        reads += 1;
        return { status: "ok", entries: [] };
      },
    });

    // The warm state-A dispatch of a healthy card is the most common call in the system; it pays nothing
    // for this repair, which is the read budget the card was filed with.
    expect(reads).toBe(0);
    expect(harness.patches).toEqual([]);
    expect(result.source).toBe("existing");
    expect(result.worktreePath).toBe(livePath);
  });
});
