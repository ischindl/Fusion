/*
FNXC:BranchBaseIdentity 2026-09-13-03:40:
RUFU-231 defect regression on real git (the RUFU-217 wedge reproduced): a card cut from local
main, rebased onto origin/main at acquire time, and left with ZERO own commits — its branch tip
is a foreign landed commit that local main never received. Before the trusted-identity chain,
every proof measured against the mis-trusted local identity: the landed tip proved
`live-foreign` forever (pause/retry loop, lease never released).

Post-fix contract pinned here:
1. `inspectBranchConflict` proves the tip landed against the remote-tracking identity
   (`tip-already-merged`, `landedVia: "remote-tracking"`) — the wedge is no longer a conflict.
2. `classifyForeignOnlyContamination` calls the foreign commit `alreadyUpstream` (its patch is
   on origin/main), not `unique`.
3. The reclaim sweep releases the wedge checkout (branch + worktree cleared, metadata cleared)
   when the checkout is provably clean, preserving uncommitted work as a recovery patch when it
   is dirty.
4. When even the capture fails, the sweep HOLDS: zero git mutation, checkout intact.
*/
import { execSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { classifyForeignOnlyContamination, inspectBareBranchCollision, inspectBranchConflict, resolveTrustedIntegrationRefs } from "../execution/branch-conflicts.js";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { taskHoldsUnmergedCheckout } from "@fusion/core";
import { CheckoutEmptinessProver } from "../worktree/checkout-emptiness.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

interface WedgeFixture {
  rootDir: string;
  originDir: string;
  wtPath: string;
  foreignSha: string;
  cleanup: () => void;
}

/*
Rebuild the wedge shape step by step:
origin(main=A) -> clone(main=A) -> origin advances to F (foreign, task-attributed) ->
clone fetches -> worktree branch cut from local main and rebased onto origin/main.
*/
function createWedgeFixture(taskId: string): WedgeFixture {
  const base = mkdtempSync(path.join(os.tmpdir(), "rufu231-wedge-"));
  const rootDir = path.join(base, "repo");
  const originDir = path.join(base, "origin.git");
  const seedDir = path.join(base, "seed");
  const wtPath = path.join(rootDir, ".worktrees", `fusion-${taskId.toLowerCase()}`);

  execSync(`git init --bare -b main ${JSON.stringify(originDir)}`, { stdio: "pipe" });
  git(base, `git clone ${JSON.stringify(originDir)} ${JSON.stringify(seedDir)}`);
  git(seedDir, 'git config user.email "seed@example.com"');
  git(seedDir, 'git config user.name "Seed User"');
  writeFileSync(path.join(seedDir, "tracked.txt"), "init\n", "utf8");
  git(seedDir, "git add tracked.txt");
  git(seedDir, "git commit -m 'init'");
  git(seedDir, "git push -u origin main");

  git(base, `git clone ${JSON.stringify(originDir)} ${JSON.stringify(rootDir)}`);

  // The foreign landing advances origin AFTER this card cloned it. Real content (not
  // --allow-empty): a landed patch must be patch-id-provable, as any real foreign commit is.
  writeFileSync(path.join(seedDir, "foreign.txt"), "landed by FN-355\n", "utf8");
  git(seedDir, "git add foreign.txt");
  git(seedDir, "git commit -m 'feat(FN-355): foreign landed work' -m 'Fusion-Task-Id: FN-355'");
  git(seedDir, "git push origin main");
  const foreignSha = git(seedDir, "git rev-parse HEAD");

  git(rootDir, "git fetch origin");
  expect(git(rootDir, "git rev-parse main")).not.toBe(git(rootDir, "git rev-parse origin/main"));

  // rebaseNewWorktreeOntoRemote faithfully reproduced: cut from local main, rebased onto origin/main.
  mkdirSync(path.join(rootDir, ".worktrees"), { recursive: true });
  git(rootDir, `git worktree add ${JSON.stringify(wtPath)} -b fusion/${taskId.toLowerCase()} main`);
  git(wtPath, "git rebase origin/main");
  expect(git(rootDir, `git rev-parse fusion/${taskId.toLowerCase()}`)).toBe(foreignSha);

  return {
    rootDir,
    originDir,
    wtPath,
    foreignSha,
    cleanup: () => {
      try {
        chmodSync(path.join(rootDir, ".fusion", "recovery"), 0o755);
      } catch {
        // best-effort
      }
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function makeTask(taskId: string, overrides: Partial<Task> = {}): Task {
  return {
    id: taskId,
    title: taskId,
    description: "zero-own-commit wedge",
    status: "failed",
    column: "in-review",
    paused: true,
    pausedReason: "branch-conflict-unrecoverable",
    checkedOutBy: null,
    branch: `fusion/${taskId.toLowerCase()}`,
    worktree: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function createStore(task: Task, settings: Partial<Settings> = {}): TaskStore & EventEmitter {
  const tasks = new Map<string, Task>([[task.id, task]]);
  const mergedSettings = {
    globalPause: false,
    enginePaused: false,
    maintenanceIntervalMs: 0,
    taskStuckTimeoutMs: 60_000,
    autoMerge: true,
    ...settings,
  } as Settings;
  const emitter = Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => mergedSettings),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) =>
      [...tasks.values()].filter((t) => (column ? t.column === column : true))),
    getTask: vi.fn(async (id: string) => tasks.get(id) ?? null),
    updateTask: vi.fn(async (id: string, updates: Partial<Task>) => {
      const current = tasks.get(id)!;
      tasks.set(id, { ...current, ...updates } as Task);
      return tasks.get(id);
    }),
    moveTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    clearStaleExecutionStartBranchReferences: vi.fn(async () => []),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
  }) as unknown as TaskStore & EventEmitter;
  (emitter as any).__tasks = tasks;
  return emitter;
}

describeIfGit("RUFU-231 zero-own-commit foreign-base wedge recovery (real git)", { timeout: 60_000 }, () => {
  const fixtures: Array<WedgeFixture["cleanup"]> = [];
  afterEach(() => {
    for (const cleanup of fixtures.splice(0)) cleanup();
  });

  it("proves the wedge tip landed against the remote-tracking identity (no longer a conflict)", async () => {
    const fx = createWedgeFixture("FN-9100");
    fixtures.push(fx.cleanup);

    const inspection = await inspectBranchConflict({
      repoDir: fx.rootDir,
      branchName: "fusion/fn-9100",
      conflictingWorktreePath: fx.wtPath,
      requestingTaskId: "FN-9100",
      ownerTaskId: "FN-9100",
      startPoint: "main",
      integrationRef: "main",
    });

    expect(inspection.kind).toBe("tip-already-merged");
    if (inspection.kind === "tip-already-merged") {
      expect(inspection.landedVia).toBe("remote-tracking");
      expect(inspection.integrationRef).toBe("origin/main");
      expect(inspection.tipSha).toBe(fx.foreignSha);
    }
  });

  it("classifies the remote-landed foreign commit as alreadyUpstream, not unique", async () => {
    const fx = createWedgeFixture("FN-9101");
    fixtures.push(fx.cleanup);

    // The wedge row had NO base identity, so recovery falls back to the integration name.
    const classification = await classifyForeignOnlyContamination({
      repoDir: fx.rootDir,
      branchName: "fusion/fn-9101",
      baseSha: "main",
      taskId: "FN-9101",
    });

    expect(classification.foreignCommitCount).toBe(1);
    expect(classification.ownCommitCount).toBe(0);
    expect(classification.alreadyUpstreamShas).toEqual([fx.foreignSha]);
    expect(classification.uniqueShas).toEqual([]);
    expect(classification.kind).toBe("foreign-only-already-upstream");
  });

  it("releases the clean wedge checkout via the reclaim sweep: branch+worktree cleared, lease gone", async () => {
    const fx = createWedgeFixture("FN-9102");
    fixtures.push(fx.cleanup);
    const task = makeTask("FN-9102", { worktree: fx.wtPath });
    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: fx.rootDir, getExecutingTaskIds: () => new Set<string>() });

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(1);
    const final = (store as any).__tasks.get("FN-9102");
    expect(final.worktree).toBeNull();
    expect(final.branch).toBeNull();
    expect(final.paused).toBe(false);
    expect(final.error).toBeNull();
    // Git mutations are exactly the legal zero-loss ones: branch ref and worktree registration gone.
    expect(() => git(fx.rootDir, "git rev-parse --verify refs/heads/fusion/fn-9102")).toThrow();
    expect(existsSync(fx.wtPath)).toBe(false);
    expect(store.logEntry).toHaveBeenCalledWith("FN-9102", expect.stringContaining("tip-already-merged FN-9102"));
  });

  it("preserves dirty uncommitted work (tracked AND untracked) before releasing the wedge checkout", async () => {
    const fx = createWedgeFixture("FN-9103");
    fixtures.push(fx.cleanup);
    // Zero own commits preserved: dirty via a tracked modification + an untracked file only.
    writeFileSync(path.join(fx.wtPath, "scratch.txt"), "untracked work in progress\n", "utf8");
    writeFileSync(path.join(fx.wtPath, "tracked.txt"), "local uncommitted edit\n", "utf8");

    const task = makeTask("FN-9103", { worktree: fx.wtPath });
    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: fx.rootDir, getExecutingTaskIds: () => new Set<string>() });

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(1);
    const recoveryDir = path.join(fx.rootDir, ".fusion", "recovery");
    const patches = readdirSync(recoveryDir).filter((entry) => entry.endsWith(".patch"));
    expect(patches.length).toBe(1);
    const patch = readFileSync(path.join(recoveryDir, patches[0]!), "utf8");
    expect(patch).toContain("local uncommitted edit");
    expect(patch).toContain("untracked work in progress");
    // The release happened only after capture; the patch is the durable copy of the checkout.
    expect(existsSync(fx.wtPath)).toBe(false);
    expect(store.logEntry).toHaveBeenCalledWith("FN-9103", expect.stringContaining("preserved to"));
  });

  it("holds the checkout when capture fails: zero git mutation, branch and worktree intact", async () => {
    const fx = createWedgeFixture("FN-9104");
    fixtures.push(fx.cleanup);
    writeFileSync(path.join(fx.wtPath, "scratch.txt"), "cannot be captured\n", "utf8");
    // Make the patch write path unwritable so the proof-of-preservation genuinely fails.
    mkdirSync(path.join(fx.rootDir, ".fusion", "recovery"), { recursive: true });
    chmodSync(path.join(fx.rootDir, ".fusion", "recovery"), 0o000);

    const task = makeTask("FN-9104", { worktree: fx.wtPath });
    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: fx.rootDir, getExecutingTaskIds: () => new Set<string>() });

    let recovered = 0;
    try {
      recovered = await manager.reclaimSelfOwnedBranchConflicts();
    } finally {
      chmodSync(path.join(fx.rootDir, ".fusion", "recovery"), 0o755);
    }

    expect(recovered).toBe(0);
    // Never release an unproven checkout: everything git-side is untouched, including the
    // held worktree's own status view (the failed capture must not leave an altered index).
    expect(git(fx.rootDir, "git rev-parse fusion/fn-9104")).toBe(fx.foreignSha);
    expect(existsSync(fx.wtPath)).toBe(true);
    expect(git(fx.wtPath, "git status --porcelain")).toBe("?? scratch.txt");
    const final = (store as any).__tasks.get("FN-9104");
    expect(final.worktree).toBe(fx.wtPath);
    expect(final.branch).toBe("fusion/fn-9104");
    expect(store.logEntry).toHaveBeenCalledWith("FN-9104", expect.stringContaining("held: checkout dirty and unproven"));
  });

  /*
  FNXC:BranchBaseIdentity 2026-09-13-00:50 (RUFU-231 Step 5, "same identity on the sibling base-chain
  readers — one shared-helper test, not three copies"):
  The singular executor chain (`handleBranchConflict` → `inspectBranchConflict`), the bare-collision
  arm (`worktree-backend` → `inspectBareBranchCollision`), the sweep's foreign-tip rejection, and the
  checkout-emptiness prover all ask "does this branch own anything?" about the SAME diverged state.
  One answer, shared: they resolve landedness against the ordered trusted identities
  (`resolveTrustedIntegrationRefs`: local integration branch, then its remote-tracking counterparts),
  so a shape cleared on one surface cannot stay refused on another.
  */
  it("all base-chain readers reach the same zero-loss decision for one diverged state", async () => {
    const fx = createWedgeFixture("FN-9105");
    fixtures.push(fx.cleanup);

    // One shared identity chain, ordered local-first.
    expect(await resolveTrustedIntegrationRefs(fx.rootDir, "main")).toEqual(["main", "origin/main"]);

    const singular = await inspectBranchConflict({
      repoDir: fx.rootDir,
      branchName: "fusion/fn-9105",
      conflictingWorktreePath: fx.wtPath,
      requestingTaskId: "FN-9105",
      ownerTaskId: "FN-9105",
      startPoint: "main",
      integrationRef: "main",
    });
    expect(singular.kind).toBe("tip-already-merged");
    const singularTip = singular.kind === "tip-already-merged" ? singular.tipSha : null;

    // The bare-collision arm sees the branch WITHOUT a live checkout (the acquisition-time shape).
    git(fx.rootDir, `git worktree remove --force ${JSON.stringify(fx.wtPath)}`);
    const bare = await inspectBareBranchCollision({
      repoDir: fx.rootDir,
      branchName: "fusion/fn-9105",
      conflictingWorktreePath: fx.wtPath,
      requestingTaskId: "FN-9105",
      ownerTaskId: "FN-9105",
      startPoint: "main",
      integrationRef: "main",
    });
    expect(bare.kind).toBe("tip-already-merged");
    if (singular.kind === "tip-already-merged" && bare.kind === "tip-already-merged") {
      expect(bare.landedVia).toBe(singular.landedVia);
      expect(bare.landedVia).toBe("remote-tracking");
      expect(bare.integrationRef).toBe(singular.integrationRef);
      expect(bare.tipSha).toBe(singularTip);
    }

    /*
    Lease-consumer parity (the documented oscillation hazard): scheduler admission, the dispatch
    gate, the gridlock detector and the re-validating sweep each run their own prover against the
    same tree. Two independent prover instances must yield the same verdict — otherwise a card
    alternates between holder and released between lanes. `taskHoldsUnmergedCheckout` is the single
    predicate all four consume; the same-verdict proof below is asserted through it.
    */
    const taskShape = { id: "FN-9105", worktree: fx.wtPath, branch: "fusion/fn-9105", baseCommitSha: "main" };
    const proverA = new CheckoutEmptinessProver({ rootDir: fx.rootDir, integrationBranch: "main" });
    const proverB = new CheckoutEmptinessProver({ rootDir: fx.rootDir, integrationBranch: "main" });
    const proofA = await proverA.proveTask(taskShape);
    const proofB = await proverB.proveTask(taskShape);
    expect(proofA.get("")).toBe("empty");
    expect(proofB.get("")).toBe(proofA.get(""));
    const holder = { worktree: fx.wtPath } as Task;
    expect(taskHoldsUnmergedCheckout(holder, proofA)).toBe(taskHoldsUnmergedCheckout(holder, proofB));
    expect(taskHoldsUnmergedCheckout(holder, proofA)).toBe(false);
  });

  /*
  FNXC:LifecycleContainment 2026-09-13-00:50 (RUFU-231 Step 5, `autoMerge: false` /
  `userPaused` / `globalPause` live-session cards stay byte-identical):
  The bounded park must not become a side door that mutates cards the operator is holding. Every
  suppression below is asserted as ZERO store writes — the row the operator paused is untouched.
  */
  function pausedShapeFixtures() {
    const fx = createWedgeFixture("FN-9106");
    fixtures.push(fx.cleanup);
    return fx;
  }

  it("leaves autoMerge:false, userPaused, globalPause, and live-session cards byte-identical", async () => {
    const fx = pausedShapeFixtures();
    const variants: Array<{ name: string; settings: Partial<Settings>; overrides: Partial<Task>; liveSession?: boolean }> = [
      { name: "autoMerge-off", settings: { autoMerge: false }, overrides: {} },
      { name: "userPaused", settings: {}, overrides: { userPaused: true } },
      { name: "globalPause", settings: { globalPause: true }, overrides: {} },
      { name: "live-session", settings: {}, overrides: {}, liveSession: true },
    ];

    for (const variant of variants) {
      const task = makeTask("FN-9106", { ...variant.overrides, worktree: fx.wtPath });
      const store = createStore(task, variant.settings);
      const manager = new SelfHealingManager(store, {
        rootDir: fx.rootDir,
        getExecutingTaskIds: () => new Set<string>(),
      });
      if (variant.liveSession) activeSessionRegistry.registerPath(fx.wtPath, { taskId: task.id, kind: "executor", ownerKey: task.id });
      let recovered = 0;
      try {
        recovered = await manager.reclaimSelfOwnedBranchConflicts();
      } finally {
        if (variant.liveSession) activeSessionRegistry.unregisterPath(fx.wtPath);
      }

      expect(recovered, variant.name).toBe(0);
      expect(store.updateTask, variant.name).not.toHaveBeenCalled();
      expect(store.moveTask, variant.name).not.toHaveBeenCalled();
      const final = (store as any).__tasks.get(task.id);
      expect(final.branch, variant.name).toBe("fusion/fn-9106");
      expect(final.worktree, variant.name).toBe(fx.wtPath);
      expect(final.pausedReason, variant.name).toBe("branch-conflict-unrecoverable");
      // The checkout itself is untouched too: the branch ref and worktree registration survive.
      expect(git(fx.rootDir, `git rev-parse ${final.branch}`), variant.name).toBe(fx.foreignSha);
      expect(existsSync(fx.wtPath), variant.name).toBe(true);
    }
  });
});
