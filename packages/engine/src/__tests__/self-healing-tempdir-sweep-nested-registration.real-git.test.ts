/*
 * Surface enumeration: this covers the engine's out-of-process scratch reaper against real git
 * registrations. The sweep has no UI affordance, so its observable surfaces are
 * `git worktree list --porcelain`, the filesystem, and the `worktree:tempdir-sweep` audit rows —
 * all three are asserted here. No desktop/mobile surface applies.
 */

/*
FNXC:TempWorktreeSweep 2026-10-02-15:32:
RUFU-290: an agent shell whose cwd sits INSIDE a merge clean-room scratch tree and that runs
`git worktree add` with a RELATIVE path registers a worktree nested two levels under the scratch
entry (`<ai-merge>/fusion-ai-merge-<task>-<rand>/.fusion/worktrees/.ai-merge/probe-main`). The admin
record lives in the common dir, and the sweep discovered garbage by non-recursive `readdirSync` of
each scratch root plus a `fusion-ai-merge-` prefix filter, so a nested child is never enumerated: it
is never reaped while its parent lives (a merge in flight holds that parent for hours) and it survives
the parent's deletion as a phantom registration. These tests fabricate that exact shape with real git
and pin both halves of the contract — nested leftovers must disappear in one pass, and everything
outside authorized Fusion scratch containment must survive being *discovered*.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";

const describeIfGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0 ? describe : describe.skip;

const osState = vi.hoisted(() => ({ tempRoot: "" }));

/*
FNXC:TempWorktreeSweep 2026-10-02-15:32:
The sweep also scans `os.tmpdir()`. Left pointed at the real temp dir, a test run would reap other
concurrent tasks' `fusion-ai-merge-*` scratch trees on this host, so `tmpdir()` is redirected into
this file's own sandbox. Unlike the mocked sibling suite, nothing else is mocked: every assertion here
is only worth anything if real git performed the registrations.
 */
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, tmpdir: vi.fn(() => osState.tempRoot || actual.tmpdir()) };
});

const { activeSessionRegistry } = await import("../agents/active-session-registry.js");
const { SelfHealingManager } = await import("../self-healing.js");

const AI_MERGE_SEGMENTS = [".fusion", "worktrees", ".ai-merge"] as const;
const AI_MERGE_REL = AI_MERGE_SEGMENTS.join("/");
/** Past the 10-minute terminal-column grace and the reap floor, far below the 2-hour default window. */
const AGED_MS = 20 * 60 * 1000;
/** Past the 2-hour default window — what an entry with no extractable task id must clear. */
const VERY_AGED_MS = 3 * 60 * 60 * 1000;
/** Under the reap floor: nothing may reap this yet, at any gate. */
const FRESH_MS = 60 * 1000;
const RM = { recursive: true, force: true } as const;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function registeredWorktreePaths(repo: string): string[] {
  return git(repo, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
}

function aiMergeRootUnder(treeRoot: string): string {
  return join(treeRoot, ...AI_MERGE_SEGMENTS);
}

/**
 * Register a scratch worktree the way the leaking agent did: run from `host` (a scratch tree or the
 * repo), targeting a RELATIVE path under the host's own `.fusion/worktrees/.ai-merge/`.
 * Returns the absolute path git recorded.
 */
function addScratchWorktree(host: string, name: string): string {
  mkdirSync(aiMergeRootUnder(host), { recursive: true });
  git(host, ["worktree", "add", "--detach", `${AI_MERGE_REL}/${name}`, "HEAD"]);
  return join(aiMergeRootUnder(host), name);
}

function age(path: string, ageMs: number): void {
  const old = new Date(Date.now() - ageMs);
  utimesSync(path, old, old);
}

/**
 * Sweep entry point — private on purpose, and the sibling suite reaches it the same way.
 */
async function sweep(manager: SelfHealingManager): Promise<number> {
  return await (manager as unknown as { cleanupStaleTempMergeWorktrees(): Promise<number> })
    .cleanupStaleTempMergeWorktrees();
}

function sweepAudits(audits: Array<{ mutationType?: string }>) {
  return audits.filter((event) => event.mutationType === "worktree:tempdir-sweep");
}

function makeSweepStore(tasks: Task[]) {
  const audits: Array<Record<string, unknown>> = [];
  const settings = { globalPause: false, enginePaused: false, autoMerge: true } as Settings;
  const store = Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => settings),
    getTask: vi.fn(async (id: string) => {
      const task = tasks.find((candidate) => candidate.id === id);
      if (!task) throw new Error(`Task ${id} not found`);
      return task;
    }),
    listTasks: vi.fn(async () => []),
    updateTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async (event: Record<string, unknown>) => { audits.push(event); }),
  }) as unknown as TaskStore & EventEmitter;
  return { store, audits };
}

function makeTask(id: string, column: string): Task {
  return {
    id,
    title: id,
    description: id,
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Task;
}

describeIfGit("SelfHealingManager temp-merge sweep — nested registrations (real git)", () => {
  let sandbox = "";
  let repo = "";

  function initRepo(): string {
    const dir = realpathSync(mkdtempSync(join(osState.tempRoot, "repo-")));
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "Test"]);
    writeFileSync(join(dir, "file.txt"), "base\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "base"]);
    return dir;
  }

  beforeEach(() => {
    sandbox = realpathSync(mkdtempSync(join(os.tmpdir(), "rufu-290-sweep-")));
    // Point the sweep's tmpdir() root at the sandbox only AFTER the sandbox itself is created.
    osState.tempRoot = sandbox;
    repo = initRepo();
    activeSessionRegistry.clear();
  });

  afterEach(() => {
    activeSessionRegistry.clear();
    osState.tempRoot = "";
    try {
      rmSync(sandbox, RM);
    } catch {
      /* best effort */
    }
  });

  function managerFor(tasks: Task[]) {
    const { store, audits } = makeSweepStore(tasks);
    return { manager: new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set<string>() }), audits };
  }

  it("reaps a nested scratch registration together with its reapable parent", async () => {
    const parent = addScratchWorktree(repo, "fusion-ai-merge-FN-2510-abc123");
    const nested = addScratchWorktree(parent, "probe-main");
    age(parent, VERY_AGED_MS);
    age(nested, VERY_AGED_MS);
    const { manager } = managerFor([makeTask("FN-2510", "done")]);

    await sweep(manager);

    expect(existsSync(parent)).toBe(false);
    expect(existsSync(nested)).toBe(false);
    expect(registeredWorktreePaths(repo)).toEqual([repo]);
  });

  /*
  FNXC:TempWorktreeSweep 2026-10-02-15:32:
  This is the shape the operator actually measured: the RUFU-267 merge held its parent scratch open,
  so the parent stayed protected for a full day while its two nested probes aged. Directory-prefix
  discovery never listed the probes, and `git worktree prune` is a no-op while a registered path still
  exists, so nothing could take them. The nested child must therefore be reaped on its own merits —
  same task-id extraction, same age gate, same session veto — independently of whether the parent is
  reapable in this pass.
  */
  describe.each([
    { label: "a live session (merge in flight)", protect: (parent: string) => activeSessionRegistry.registerPath(parent, { taskId: "FN-2510", kind: "ai-merge", ownerKey: "FN-2510" }) },
    { label: "an age below the reap floor", protect: (parent: string) => age(parent, FRESH_MS) },
  ])("when the parent scratch is un-reapable by $label", ({ protect }) => {
    it("reaps the aged nested registration while leaving the parent untouched", async () => {
      const parent = addScratchWorktree(repo, "fusion-ai-merge-FN-2510-abc123");
      const nested = addScratchWorktree(parent, "probe-main");
      age(nested, VERY_AGED_MS);
      protect(parent);
      const { manager } = managerFor([makeTask("FN-2510", "done")]);

      await sweep(manager);

      expect(registeredWorktreePaths(repo)).not.toContain(nested);
      expect(existsSync(nested)).toBe(false);
      expect(existsSync(parent)).toBe(true);
      expect(registeredWorktreePaths(repo)).toContain(parent);
    });
  });

  it("applies the task-id age gate to nested entries, reaping the aged sibling in the same pass", async () => {
    const parent = addScratchWorktree(repo, "fusion-ai-merge-FN-2510-abc123");
    // Both children carry an extractable task id, so the terminal-column grace is the gate that
    // decides them. If discovery ignored that gate, the fresh sibling would disappear too; if
    // discovery never saw nested entries at all, the aged sibling would survive.
    const fresh = addScratchWorktree(parent, "fusion-ai-merge-FN-2510-probe1");
    const aged = addScratchWorktree(parent, "fusion-ai-merge-FN-2510-probe2");
    age(parent, FRESH_MS);
    age(fresh, FRESH_MS);
    age(aged, AGED_MS);
    const { manager } = managerFor([makeTask("FN-2510", "done")]);

    await sweep(manager);

    expect(existsSync(aged)).toBe(false);
    expect(registeredWorktreePaths(repo)).not.toContain(aged);
    expect(existsSync(fresh)).toBe(true);
    expect(registeredWorktreePaths(repo)).toContain(fresh);
  });

  it("defers and reports a nested registration an active session holds", async () => {
    const parent = addScratchWorktree(repo, "fusion-ai-merge-FN-2510-abc123");
    const held = addScratchWorktree(parent, "probe-integration");
    age(parent, FRESH_MS);
    age(held, VERY_AGED_MS);
    activeSessionRegistry.registerPath(held, { taskId: "FN-2510", kind: "workflow-step", ownerKey: "FN-2510#workflow-step" });
    const { manager, audits } = managerFor([makeTask("FN-2510", "done")]);

    await sweep(manager);

    expect(existsSync(held)).toBe(true);
    expect(registeredWorktreePaths(repo)).toContain(held);
    // "Left alone" is only diagnosable if the sweep says so: the deferral is reported, not silent.
    expect(sweepAudits(audits)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metadata: expect.objectContaining({ path: held, success: false, reason: "active-session" }),
      }),
    ]));
  });

  it("never deletes a registration outside authorized scratch containment, and reports it", async () => {
    // In-authority control: an aged parent directly under the clean-room root, with its own child.
    const scratch = addScratchWorktree(repo, "fusion-ai-merge-FN-2510-inroot");
    const scratchChild = addScratchWorktree(scratch, "probe-main");
    // Out-of-authority: a live pool worktree, and a scratch-shaped tree that is not under any
    // clean-room root. Both age out and both carry a terminal task id, so only containment stands
    // between them and the reaper once discovery becomes registration-driven.
    const poolWorktree = join(repo, ".fusion", "worktrees", "fusion-FN-777-pool");
    git(repo, ["worktree", "add", "--detach", poolWorktree, "HEAD"]);
    const outside = addScratchWorktree(join(repo, "outside-scratch"), "fusion-ai-merge-FN-777-out");
    const outsideChild = addScratchWorktree(outside, "probe-main");
    for (const path of [scratch, scratchChild, poolWorktree, outside, outsideChild]) age(path, VERY_AGED_MS);
    const { manager, audits } = managerFor([makeTask("FN-2510", "done"), makeTask("FN-777", "done")]);

    await sweep(manager);

    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(scratchChild)).toBe(false);
    expect(existsSync(poolWorktree)).toBe(true);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(outsideChild)).toBe(true);
    // The repo's own main checkout is a registration too, and it must survive.
    expect(registeredWorktreePaths(repo)).toEqual(
      expect.arrayContaining([repo, poolWorktree, outside, outsideChild]),
    );
    expect(registeredWorktreePaths(repo)).not.toContain(scratch);
    expect(registeredWorktreePaths(repo)).not.toContain(scratchChild);
    // Out-of-containment scratch-shaped trees are reported rather than quietly ignored.
    const reported = sweepAudits(audits)
      .map((event) => (event.metadata as { path?: string })?.path)
      .filter((path): path is string => typeof path === "string");
    expect(reported).toEqual(expect.arrayContaining([outside, outsideChild]));
  });

  /*
  FNXC:TempWorktreeSweep 2026-10-02-15:32:
  The other half of the operator's symptom: `git worktree remove` on a parent deletes the whole tree
  recursively, so the nested child's DIRECTORY goes away while its registration is left behind, and
  an out-of-band deletion of both directories leaves two phantom registrations and no entries for
  `readdirSync` to find at all. `git worktree prune` clears exactly this residue — but the old sweep
  only reached prune from inside the per-entry cleanup block, so with nothing enumerated it never ran.
  A pass must therefore prune when the registration list still names a path under authorized scratch
  whose directory is gone.
  */
  it("clears registrations whose directories were already deleted out-of-band", async () => {
    const parent = addScratchWorktree(repo, "fusion-ai-merge-FN-2510-abc123");
    const nested = addScratchWorktree(parent, "probe-main");
    rmSync(parent, RM);
    expect(existsSync(parent)).toBe(false);
    expect(registeredWorktreePaths(repo)).toEqual(expect.arrayContaining([parent, nested]));
    const { manager, audits } = managerFor([makeTask("FN-2510", "done")]);

    await sweep(manager);

    expect(registeredWorktreePaths(repo)).toEqual([repo]);
    expect(sweepAudits(audits)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: "registration-residue-pruned", success: true }),
      }),
    ]));
  });
});
