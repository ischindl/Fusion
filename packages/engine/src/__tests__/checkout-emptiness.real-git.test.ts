/*
FNXC:OverlapScheduling 2026-09-08-19:50 (RUFU-200):
These tests are the only thing standing between this module and a silent data-loss bug. A `dormant →
none` downgrade releases a peer to write into a scope the holder may still be editing, so `empty` must
be producible ONLY by a clean tree plus zero commits ahead of base, and every degraded observation
(unclean, ahead, dead ref, timeout, unparseable output) must land on `occupied`/`unknown`.

The real-git describe is deliberately not mocked: mocking `git status` would let a broken argument
string pass every assertion while production reported `unknown` forever.
*/
// Real-git wallclock under parallel CI load; do not lower per-test timeouts without re-measuring.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exec, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import {
  CheckoutEmptinessProver,
  checkoutEmptinessEntries,
  resetCheckoutEmptinessProversForTesting,
  type CheckoutEmptinessExec,
  type CheckoutEmptinessProverOptions,
  type CheckoutEmptinessTaskShape,
} from "../worktree/checkout-emptiness.js";

const execAsync = promisify(exec);

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

async function run(command: string, cwd: string): Promise<string> {
  const { stdout } = await execAsync(command, { cwd, encoding: "utf-8" });
  return stdout.trim();
}

const tempDirs: string[] = [];

afterEach(async () => {
  resetCheckoutEmptinessProversForTesting();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setupRepo(): Promise<{ repoDir: string; baseSha: string }> {
  const repoDir = await mkdtemp(path.join(tmpdir(), "rufu-200-emptiness-"));
  tempDirs.push(repoDir);
  await run("git init -b main", repoDir);
  await run("git config user.email test@example.com", repoDir);
  await run("git config user.name 'Test User'", repoDir);
  await writeFile(path.join(repoDir, "note.txt"), "base\n", "utf-8");
  await run("git add note.txt && git commit -m 'chore: base'", repoDir);
  const baseSha = await run("git rev-parse HEAD", repoDir);
  return { repoDir, baseSha };
}

/** A prover pinned to `main` so no test depends on origin/HEAD detection. */
function proverFor(repoDir: string, overrides: Partial<CheckoutEmptinessProverOptions> = {}) {
  return new CheckoutEmptinessProver({ rootDir: repoDir, integrationBranch: "main", ...overrides });
}

function holder(taskId: string, worktree: string, baseCommitSha: string): CheckoutEmptinessTaskShape {
  return { id: taskId, worktree, branch: `fusion/${taskId.toLowerCase()}`, baseCommitSha };
}

describeIfGit("checkout-emptiness proof — real git", () => {
  it("proves a clean branch sitting at its base empty (the RUFU-198 shape)", async () => {
    const { repoDir, baseSha } = await setupRepo();
    const worktreePath = path.join(repoDir, "wt", "rufu-198");
    await run(`git checkout -b fusion/rufu-198 && git checkout main`, repoDir);
    await run(`git worktree add ${JSON.stringify(worktreePath)} fusion/rufu-198`, repoDir);

    const proof = await proverFor(repoDir).proveTask(holder("RUFU-198", worktreePath, baseSha));

    expect(proof.get("")).toBe("empty");
  }, 30_000);

  it("reports occupied for a single untracked file — untracked output IS work to preserve", async () => {
    const { repoDir, baseSha } = await setupRepo();
    const worktreePath = path.join(repoDir, "wt", "rufu-198");
    await run("git checkout -b fusion/rufu-198 && git checkout main", repoDir);
    await run(`git worktree add ${JSON.stringify(worktreePath)} fusion/rufu-198`, repoDir);
    await writeFile(path.join(worktreePath, "scratch.txt"), "half-written edit\n", "utf-8");

    const proof = await proverFor(repoDir).proveTask(holder("RUFU-198", worktreePath, baseSha));

    expect(proof.get("")).toBe("occupied");
  }, 30_000);

  it("reports occupied for a modified tracked file", async () => {
    const { repoDir, baseSha } = await setupRepo();
    const worktreePath = path.join(repoDir, "wt", "rufu-198");
    await run("git checkout -b fusion/rufu-198 && git checkout main", repoDir);
    await run(`git worktree add ${JSON.stringify(worktreePath)} fusion/rufu-198`, repoDir);
    await writeFile(path.join(worktreePath, "note.txt"), "base + local edit\n", "utf-8");

    const proof = await proverFor(repoDir).proveTask(holder("RUFU-198", worktreePath, baseSha));

    expect(proof.get("")).toBe("occupied");
  }, 30_000);

  it("reports occupied once the branch is one commit ahead of base", async () => {
    const { repoDir, baseSha } = await setupRepo();
    const worktreePath = path.join(repoDir, "wt", "rufu-198");
    await run("git checkout -b fusion/rufu-198 && git checkout main", repoDir);
    await run(`git worktree add ${JSON.stringify(worktreePath)} fusion/rufu-198`, repoDir);
    await writeFile(path.join(worktreePath, "work.txt"), "real work\n", "utf-8");
    await run("git add work.txt && git commit -m 'feat: real work'", worktreePath);

    const proof = await proverFor(repoDir).proveTask(holder("RUFU-198", worktreePath, baseSha));

    expect(proof.get("")).toBe("occupied");
  }, 30_000);

  it("proves a removed checkout empty in ref-only mode (cleanliness is vacuous, the ref is at base)", async () => {
    const { repoDir, baseSha } = await setupRepo();
    const worktreePath = path.join(repoDir, "wt", "gone");
    await run("git checkout -b fusion/rufu-201 && git checkout main", repoDir);
    await run(`git worktree add ${JSON.stringify(worktreePath)} fusion/rufu-201`, repoDir);
    await rm(worktreePath, { recursive: true, force: true });

    const proof = await proverFor(repoDir).proveTask(holder("RUFU-201", worktreePath, baseSha));

    expect(proof.get("")).toBe("empty");
  }, 30_000);

  it("reports occupied for a removed checkout whose branch still carries unmerged commits", async () => {
    const { repoDir, baseSha } = await setupRepo();
    const worktreePath = path.join(repoDir, "wt", "gone-ahead");
    await run("git checkout -b fusion/rufu-ahead && git checkout main", repoDir);
    await run(`git worktree add ${JSON.stringify(worktreePath)} fusion/rufu-ahead`, repoDir);
    await writeFile(path.join(worktreePath, "keepme.txt"), "unmerged\n", "utf-8");
    await run("git add keepme.txt && git commit -m 'feat: unmerged'", worktreePath);
    await rm(worktreePath, { recursive: true, force: true });

    const proof = await proverFor(repoDir).proveTask(holder("RUFU-AHEAD", worktreePath, baseSha));

    expect(proof.get("")).toBe("occupied");
  }, 30_000);

  /*
  FNXC:BranchBaseIdentity 2026-09-13-01:05 (RUFU-231, behavior-change ownership):
  This test previously asserted `unknown` whenever the RECORDED base ref was unresolvable.
  The trusted identity chain supersedes that: a dead `baseCommitSha` whose integration branch
  (and its remote-tracking counterparts) resolve is now genuinely PROVEN zero-ahead — the exact
  wedge shape RUFU-200's release must clear (a clean branch on the integration base owns
  nothing). Fail-closed keeps its real subject: the verdict is `unknown` only when NO trusted
  identity is readable at all — asserted below with both the recorded ref and the integration
  branch unresolvable.
  */
  it("proves a dead recorded base empty through the integration chain, and unknown only when no identity resolves", async () => {
    const { repoDir } = await setupRepo();
    const worktreePath = path.join(repoDir, "wt", "rufu-198");
    await run("git checkout -b fusion/rufu-198 && git checkout main", repoDir);
    await run(`git worktree add ${JSON.stringify(worktreePath)} fusion/rufu-198`, repoDir);

    const deadRecordedBase = await proverFor(repoDir).proveTask(holder("RUFU-198", worktreePath, "deadbeefdeadbeef"));
    expect(deadRecordedBase.get("")).toBe("empty");

    const unreadableEverything = await new CheckoutEmptinessProver({
      rootDir: repoDir,
      integrationBranch: "integration/does-not-exist",
    }).proveTask(holder("RUFU-198", worktreePath, "deadbeefdeadbeef"));
    expect(unreadableEverything.get("")).toBe("unknown");
  }, 30_000);

  it("resolves the base from the integration branch when the task records no baseCommitSha", async () => {
    const { repoDir } = await setupRepo();
    const worktreePath = path.join(repoDir, "wt", "rufu-198");
    await run("git checkout -b fusion/rufu-198 && git checkout main", repoDir);
    await run(`git worktree add ${JSON.stringify(worktreePath)} fusion/rufu-198`, repoDir);

    const task: CheckoutEmptinessTaskShape = { id: "RUFU-198", worktree: worktreePath, branch: "fusion/rufu-198" };
    const proof = await proverFor(repoDir).proveTask(task);

    expect(proof.get("")).toBe("empty");
  }, 30_000);

  it("proves workspace repositories independently so one dirty sub-repo keeps the whole lease", async () => {
    const { repoDir, baseSha } = await setupRepo();
    // Two repositories, two worktrees: what matters to the proof is that each entry is evaluated
    // against ITS OWN path, so a clean entry can never launder a dirty sibling.
    await run("git branch fusion/rufu-ws-a", repoDir);
    await run("git branch fusion/rufu-ws-b", repoDir);
    const cleanWt = path.join(repoDir, "wt", "ws", "a");
    const dirtyWt = path.join(repoDir, "wt", "ws", "b");
    await run(`git worktree add ${JSON.stringify(cleanWt)} fusion/rufu-ws-a`, repoDir);
    await run(`git worktree add ${JSON.stringify(dirtyWt)} fusion/rufu-ws-b`, repoDir);
    await writeFile(path.join(dirtyWt, "untracked.txt"), "scratch\n", "utf-8");

    const task: CheckoutEmptinessTaskShape = {
      id: "RUFU-WS",
      branch: "fusion/rufu-ws",
      baseCommitSha: baseSha,
      workspaceWorktrees: {
        "packages/a": { worktreePath: cleanWt, branch: "fusion/rufu-ws-a", baseCommitSha: baseSha },
        "packages/b": { worktreePath: dirtyWt, branch: "fusion/rufu-ws-b", baseCommitSha: baseSha },
      },
    };
    const proof = await proverFor(repoDir).proveTask(task);

    expect(proof.get("packages/a")).toBe("empty");
    expect(proof.get("packages/b")).toBe("occupied");
    expect(proof.get("packages/a")).not.toBe(proof.get("packages/b"));
  }, 40_000);

  it("returns an empty proof for a checkout-free task without touching git", async () => {
    const { repoDir } = await setupRepo();
    let calls = 0;
    const prover = proverFor(repoDir, {
      execImpl: async (command) => {
        calls += 1;
        return { stdout: command.includes("rev-list") ? "0\n" : "" };
      },
    });

    const proof = await prover.proveTask({ id: "RUFU-NONE" });

    expect([...proof.entries()]).toEqual([]);
    expect(calls).toBe(0);
  }, 20_000);
});

describe("checkout-emptiness proof — cache, dedupe, and bounded fan-out", () => {
  type ScriptedMode = "clean" | "dirty" | "ahead" | "fail" | "garbage";

  /** Scripted runner: clean tree, zero commits ahead, with call accounting and optional latency. */
  function scriptedExec(options: {
    verdicts?: Record<string, ScriptedMode>;
    latencyMs?: number;
  } = {}) {
    const state = { calls: 0, inFlight: 0, maxInFlight: 0, commands: [] as string[] };
    const execImpl: CheckoutEmptinessExec = async (command, execOptions) => {
      state.calls += 1;
      state.commands.push(`${command} @${execOptions.cwd}`);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        if (options.latencyMs) await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
        const mode = options.verdicts?.[execOptions.cwd] ?? options.verdicts?.["*"] ?? "clean";
        if (mode === "fail") throw new Error("git exited 128");
        if (command.startsWith("git status")) return { stdout: mode === "dirty" ? "?? scratch.txt\n" : "" };
        // Garbage is exercised on the commit-count parse only: a non-empty `git status --porcelain`
        // listing is indistinguishable from a dirty tree, and treating it as dirty is the safe read.
        if (mode === "garbage") return { stdout: "not-a-number\n" };
        return { stdout: mode === "ahead" ? "1\n" : "0\n" };
      } finally {
        state.inFlight -= 1;
      }
    };
    return { execImpl, state };
  }

  const task = (id: string, worktree: string): CheckoutEmptinessTaskShape => ({
    id,
    worktree,
    branch: `fusion/${id.toLowerCase()}`,
    baseCommitSha: "base-sha",
  });

  it("answers a repeat pass from cache without issuing git", async () => {
    const { execImpl, state } = scriptedExec();
    const prover = new CheckoutEmptinessProver({ rootDir: "/repo", integrationBranch: "main", execImpl });

    await prover.proveTask(task("RUFU-198", "/wt/a"));
    const callsAfterFirst = state.calls;
    const second = await prover.proveTask(task("RUFU-198", "/wt/a"));

    expect(callsAfterFirst).toBe(2);
    expect(state.calls).toBe(callsAfterFirst);
    expect(second.get("")).toBe("empty");
  });

  it("re-proves once the TTL window expires", async () => {
    const { execImpl, state } = scriptedExec();
    let clock = 1_000;
    const prover = new CheckoutEmptinessProver({
      rootDir: "/repo",
      integrationBranch: "main",
      execImpl,
      ttlMs: 10_000,
      now: () => clock,
    });

    await prover.proveTask(task("RUFU-198", "/wt/a"));
    clock += 9_000;
    await prover.proveTask(task("RUFU-198", "/wt/a"));
    expect(state.calls).toBe(2);

    clock += 2_000;
    await prover.proveTask(task("RUFU-198", "/wt/a"));
    expect(state.calls).toBe(4);
  });

  it("dedupes concurrent proofs of the same checkout into one git pair", async () => {
    const { execImpl, state } = scriptedExec({ latencyMs: 5 });
    const prover = new CheckoutEmptinessProver({ rootDir: "/repo", integrationBranch: "main", execImpl });

    const [first, second] = await Promise.all([
      prover.proveTask(task("RUFU-198", "/wt/a")),
      prover.proveTask(task("RUFU-198", "/wt/a")),
    ]);

    expect(state.calls).toBe(2);
    expect(first.get("")).toBe("empty");
    expect(second.get("")).toBe("empty");
  });

  it("evicts the oldest proof once the cache bound is reached", async () => {
    const { execImpl, state } = scriptedExec();
    const prover = new CheckoutEmptinessProver({
      rootDir: "/repo",
      integrationBranch: "main",
      execImpl,
      maxEntries: 1,
    });

    await prover.proveTask(task("RUFU-198", "/wt/a"));
    await prover.proveTask(task("RUFU-199", "/wt/b"));
    const callsAfterTwo = state.calls;
    // /wt/a was the oldest entry and is gone, so it must be re-proven rather than answered from cache.
    await prover.proveTask(task("RUFU-198", "/wt/a"));

    expect(callsAfterTwo).toBe(4);
    expect(state.calls).toBe(6);
  });

  it("bounds simultaneous git calls across one batch and fans out once per entry", async () => {
    const { execImpl, state } = scriptedExec({ latencyMs: 5 });
    const prover = new CheckoutEmptinessProver({
      rootDir: "/repo",
      integrationBranch: "main",
      execImpl,
      concurrency: 2,
    });
    const tasks = ["A", "B", "C", "D", "E"].map((id) => task(`RUFU-${id}`, `/wt/${id.toLowerCase()}`));

    const batch = await prover.proveTasks(tasks);

    expect(state.maxInFlight).toBeLessThanOrEqual(2);
    expect(state.calls).toBe(10);
    expect(batch.size).toBe(5);
    for (const id of ["RUFU-A", "RUFU-B", "RUFU-C", "RUFU-D", "RUFU-E"]) {
      expect(batch.get(id)?.get("")).toBe("empty");
    }
  });

  it("maps a dirty or ahead checkout to occupied and a failing or unparseable probe to unknown", async () => {
    const cases: Array<{ mode: ScriptedMode; expected: "occupied" | "unknown" }> = [
      { mode: "dirty", expected: "occupied" },
      { mode: "ahead", expected: "occupied" },
      { mode: "fail", expected: "unknown" },
      { mode: "garbage", expected: "unknown" },
    ];
    for (const { mode, expected } of cases) {
      resetCheckoutEmptinessProversForTesting();
      const { execImpl } = scriptedExec({ verdicts: { "*": mode } });
      const prover = new CheckoutEmptinessProver({ rootDir: "/repo", integrationBranch: "main", execImpl });
      const proof = await prover.proveTask(task("RUFU-X", "/wt/x"));
      expect(proof.get(""), mode).toBe(expected);
    }
  });

  it("refuses to invent a branch ref for ref-only mode and stays unknown", async () => {
    const { execImpl, state } = scriptedExec({ verdicts: { "*": "fail" } });
    const prover = new CheckoutEmptinessProver({ rootDir: "/repo", integrationBranch: "main", execImpl });

    const proof = await prover.proveTask({ id: "RUFU-NB", worktree: "/wt/gone", baseCommitSha: "base" });

    expect(proof.get("")).toBe("unknown");
    // No branch means the ref-only fallback cannot run: only the live status attempt is issued.
    expect(state.calls).toBe(1);
  });

  it("skips the cache read when the caller demands a fresh proof", async () => {
    const { execImpl, state } = scriptedExec();
    const prover = new CheckoutEmptinessProver({ rootDir: "/repo", integrationBranch: "main", execImpl });

    await prover.proveTask(task("RUFU-198", "/wt/a"));
    await prover.proveTasks([task("RUFU-198", "/wt/a")], { force: true });

    expect(state.calls).toBe(4);
  });

  it("invalidates only the released path's cached verdicts", async () => {
    const { execImpl, state } = scriptedExec();
    const prover = new CheckoutEmptinessProver({ rootDir: "/repo", integrationBranch: "main", execImpl });

    await prover.proveTasks([task("RUFU-198", "/wt/a"), task("RUFU-199", "/wt/b")]);
    const callsAfterBatch = state.calls;
    prover.invalidatePath("/wt/a");
    await prover.proveTasks([task("RUFU-198", "/wt/a"), task("RUFU-199", "/wt/b")]);

    expect(callsAfterBatch).toBe(4);
    expect(state.calls).toBe(6);
  });
});

describe("checkoutEmptinessEntries", () => {
  it("keys the singular checkout as an empty string and workspace entries by repository", () => {
    const entries = checkoutEmptinessEntries({
      id: "RUFU-WS",
      worktree: "/wt/singular",
      branch: "fusion/rufu-ws",
      baseCommitSha: "base",
      workspaceWorktrees: {
        "packages/core": { worktreePath: "/wt/core", branch: "fusion/rufu-ws", baseCommitSha: "core-base" },
        "packages/empty": { worktreePath: "   " },
      },
    });

    expect(entries).toEqual([
      { key: "", path: "/wt/singular", baseRef: "base", branchRef: "fusion/rufu-ws" },
      { key: "packages/core", path: "/wt/core", baseRef: "core-base", branchRef: "fusion/rufu-ws" },
    ]);
  });

  it("falls back to the per-repository baseBranch before the task-level base sha", () => {
    const [entry] = checkoutEmptinessEntries({
      worktree: undefined,
      baseCommitSha: "task-base",
      workspaceWorktrees: { "packages/engine": { worktreePath: "/wt/engine", baseBranch: "integration" } },
    });

    expect(entry?.baseRef).toBe("integration");
  });
});

/*
FNXC:BranchBaseIdentity 2026-09-13-00:45 (RUFU-231):
The trusted-identity chain on the lease surface. The wedge shape is a branch cut from a base
that local `main` never advanced to, then rebased onto the fetched `<remote>/main`: clean tree,
ZERO commits ahead of the identity it actually landed on, but non-zero ahead of the recorded
SHA base and the behind local branch. Proving only against the recorded/local identity read
`occupied` forever — the unbounded loop's fourth voice. Fail-closed still owns: a card's OWN
unique commit is ahead of every trusted identity and must stay `occupied`.
*/
async function setupDivergedOrigin(taskId: string, opts: { ownCommit?: boolean } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), `rufu-231-emptiness-${taskId.toLowerCase()}-`));
  tempDirs.push(base);
  const originDir = path.join(base, "origin.git");
  const seedDir = path.join(base, "seed");
  const repoDir = path.join(base, "repo");
  await run(`git init --bare -b main ${JSON.stringify(originDir)}`, base);
  await run(`git clone ${JSON.stringify(originDir)} ${JSON.stringify(seedDir)}`, base);
  await run("git config user.email seed@example.com && git config user.name 'Seed User'", seedDir);
  await writeFile(path.join(seedDir, "note.txt"), "base\n", "utf-8");
  await run("git add note.txt && git commit -m 'chore: base'", seedDir);
  await run("git push -u origin main", seedDir);
  const baseSha = await run("git rev-parse HEAD", seedDir);
  await run(`git clone ${JSON.stringify(originDir)} ${JSON.stringify(repoDir)}`, base);
  await run("git config user.email card@example.com && git config user.name 'Card User'", repoDir);
  // The foreign landing advances origin AFTER the card's clone fetched it.
  await writeFile(path.join(seedDir, "foreign.txt"), "landed elsewhere\n", "utf-8");
  await run("git add foreign.txt && git commit -m 'feat(FN-355): foreign landed work'", seedDir);
  await run("git push origin main", seedDir);
  await run("git fetch origin", repoDir);
  const worktreePath = path.join(repoDir, "wt", taskId.toLowerCase());
  await run(`git branch fusion/${taskId.toLowerCase()}`, repoDir);
  await run(`git worktree add ${JSON.stringify(worktreePath)} fusion/${taskId.toLowerCase()}`, repoDir);
  await run("git rebase origin/main", worktreePath);
  const originMain = await run("git rev-parse origin/main", repoDir);
  if (opts.ownCommit) {
    await writeFile(path.join(worktreePath, "own.txt"), "the card's own work\n", "utf-8");
    await run("git add own.txt && git commit -m 'feat(RUFU-231): own work'", worktreePath);
  }
  return { repoDir, baseSha, worktreePath, originMain };
}

describeIfGit("checkout-emptiness proof — RUFU-231 trusted identity chain", () => {
  it("proves a zero-own-commit branch rebased onto origin/main empty against a recorded SHA base", async () => {
    const { repoDir, baseSha, worktreePath } = await setupDivergedOrigin("RUFU-231A");
    // The wedge recorded no remote identity: the entry's only anchor is the recorded SHA,
    // which sits BEHIND origin/main. Only the name-anchored trusted chain clears it.
    const proof = await proverFor(repoDir).proveTask(holder("RUFU-231A", worktreePath, baseSha));
    expect(proof.get("")).toBe("empty");
  }, 30_000);

  it("keeps the card's own unique commit occupied even with the trusted chain (fail-closed)", async () => {
    const { repoDir, baseSha, worktreePath } = await setupDivergedOrigin("RUFU-231B", { ownCommit: true });
    const proof = await proverFor(repoDir).proveTask(holder("RUFU-231B", worktreePath, baseSha));
    expect(proof.get("")).toBe("occupied");
  }, 30_000);
});
