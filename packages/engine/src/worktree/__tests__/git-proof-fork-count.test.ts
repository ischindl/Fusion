/*
FNXC:GitProofForkAccounting 2026-11-08-02:20 (RUFU-871):
STEP 1 MEASUREMENT — how many `git` child processes the two profiled provers fork per unit of work.

A raw CDP CPU profile taken during a healthy (non-stalled) window while six board endpoints were in
flight attributed `child_process` fork time to exactly two product call sites:

  1. `CheckoutEmptinessProver.execImpl` -> `runGit` -> `runProof`
     (`packages/engine/src/worktree/checkout-emptiness.ts`) — 3 813 inclusive samples on the `exec`
     path, 3 811 on the `execFile` path.
  2. `probeTrustedIntegrationRefs` -> `trustedRefsGit` -> `runGit`
     (`packages/engine/src/execution/branch-conflicts.ts`) — 2 380 / 2 378 inclusive samples.
     Reached from `checkout-emptiness.ts:294` once PER PROVEN ENTRY, plus four other production sites.

Correlated shares the same profile put at ~28 % (`onStreamRead` + `Readable.push` + `addChunk`) and
~17 % (`buffer.concat`) are the reading and concatenation of those subprocesses' stdout, so the fork
COUNT and the stdout VOLUME are one cost seen twice.

Latency is not measurable here (this is the same event loop the UI shares, and a CI box is not the
operator's box), so this file measures the one thing that is: the number of subprocess spawns a given
trigger causes. The seam sits at `node:child_process` itself — every spawn the product performs
passes through this counter, including the ones behind a `promisify(exec)` captured at module load —
so no log parsing and no assumption about which helper forked is involved.

The expected numbers are the measured BEFORE counts. They are the ratchet: a change that reduces the
forks of a trigger must move the number DOWN, and one that raises a trigger must fail here.

MEASURED BEFORE -> AFTER (git forks per trigger): a 4-card pass 24 -> 18, an 8-card pass 24 -> 18, a
cold burst of 4 trusted-ref resolutions 8 -> 2. Single-card triggers stay at 4/6 and the warm repeat
pass stays at 0, because both were already at their floor — see the `2 -> 2` and `0 -> 0` cases below.
*/
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Counting seam over the real `node:child_process`. `vi.hoisted` because the mock factory runs during
 * the import phase — before this module's body — so the counter must exist before any product module
 * evaluates `promisify(exec)` against the mocked namespace.
 */
const seam = vi.hoisted(() => {
  type SpawnRecord = { fn: string; command: string; cwd: string };
  const records: SpawnRecord[] = [];
  const isGit = (command: string): boolean => command.trimStart().split(" ")[0] === "git";
  return {
    records,
    reset(): void {
      records.length = 0;
    },
    /** Only `git` spawns are the provers' cost; the fixture's own git calls are reset away. */
    gitCommands(): string[] {
      return records.filter((r) => isGit(r.command)).map((r) => r.command.replace(/\s+/g, " ").trim());
    },
    gitCount(): number {
      return this.gitCommands().length;
    },
    countMatching(prefixes: readonly string[]): number {
      return this.gitCommands().filter((command) => prefixes.some((prefix) => command.startsWith(prefix))).length;
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const cwdOf = (options: unknown): string => {
    if (!options || typeof options !== "object") return "";
    const cwd = (options as { cwd?: unknown }).cwd;
    return typeof cwd === "string" ? cwd : "";
  };
  /*
  The seam may only ADD a counter; it may not change what a call returns. Two traps, both of which
  silently produced a wrong measurement before they were closed:
  1. Every product call site is `promisify(exec)`. A bare wrapper resolves with the raw
     `[stdout, stderr]` tuple, so `result.stdout` becomes `undefined`, every verdict degrades to
     `unknown`, and the fork counts describe a program that does not exist.
  2. `node:child_process`'s `exec`/`execFile` carry their own `util.promisify.custom` implementation
     that closes over the REAL `exec`, so merely copying the symbol makes the promisified path bypass
     the counter entirely and the seam records nothing.
  The fix is to install a counting custom on the wrapper: the promisified call is counted once and
  still resolves through the genuine implementation.
  */
  const counting = <A extends unknown[], R>(
    fn: string,
    original: (...a: A) => R,
    commandOf: (args: A) => string,
    optionsAt: number,
  ): typeof original => {
    const record = (args: readonly unknown[]): void => {
      seam.records.push({ fn, command: commandOf(args as A), cwd: cwdOf(args[optionsAt]) });
    };
    const wrapper = (...args: A): R => {
      record(args);
      return Reflect.apply(original, actual, args);
    };
    for (const symbol of Object.getOwnPropertySymbols(original)) {
      (wrapper as unknown as Record<string, unknown>)[symbol as unknown as string] =
        (original as unknown as Record<string, unknown>)[symbol as unknown as string];
    }
    if (typeof (original as unknown as Record<string | symbol, unknown>)[promisify.custom] === "function") {
      const promisified = promisify(original);
      (wrapper as unknown as Record<string | symbol, unknown>)[promisify.custom] = (...args: unknown[]) => {
        record(args);
        return promisified(...args);
      };
    }
    return wrapper as typeof original;
  };
  const argv = (head: unknown, rest: unknown): string => [String(head), ...(Array.isArray(rest) ? rest : [])].join(" ");
  return {
    ...actual,
    exec: counting("exec", actual.exec, (args) => String(args[0]), 1),
    execFile: counting("execFile", actual.execFile, (args) => argv(args[0], args[1]), 2),
    execSync: counting("execSync", actual.execSync, (args) => String(args[0]), 1),
    spawn: counting("spawn", actual.spawn, (args) => argv(args[0], args[1]), 2),
  };
});

/** The fixture's own git plumbing must NOT be counted, so it runs against the un-mocked module. */
let realExec: ((command: string, cwd: string) => Promise<string>) | null = null;
async function run(command: string, cwd: string): Promise<string> {
  if (!realExec) {
    const cp = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const execAsync = promisify(cp.exec);
    realExec = async (cmd, dir) => (await execAsync(cmd, { cwd: dir, encoding: "utf-8" })).stdout.trim();
  }
  return await realExec(command, cwd);
}

type CheckoutTask = {
  id?: string;
  worktree?: string | null;
  branch?: string | null;
  baseCommitSha?: string | null;
};

/** The three populations a real board actually holds for retained checkouts. */
type CardShape = "at-base" | "rebased-onto-origin" | "ahead";

interface Fixture {
  rootDir: string;
  baseSha: string;
  makeCard(id: string, shape: CardShape): Promise<CheckoutTask>;
}

const tempDirs: string[] = [];

/*
Every fixture carries an `origin` remote and an `origin/HEAD`, because the trusted-identity chain —
the second profiled site — only forks when there ARE remote-tracking identities to discover. A
remote-less fixture measures zero for it and proves nothing. The upstream also advances after the
checkout clones, so local `main` sits BEHIND `origin/main`: the production shape RUFU-231 recorded,
and the one that makes the identity chain longer than one entry.
*/
async function setupFixture(tag: string): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), `rufu-871-forks-${tag}-`));
  tempDirs.push(base);
  const originDir = path.join(base, "origin.git");
  const seedDir = path.join(base, "seed");
  const rootDir = path.join(base, "repo");
  await run(`git init --bare -b main ${JSON.stringify(originDir)}`, base);
  await run(`git clone ${JSON.stringify(originDir)} ${JSON.stringify(seedDir)}`, base);
  await run("git config user.email seed@example.com && git config user.name 'Seed User'", seedDir);
  await writeFile(path.join(seedDir, "note.txt"), "base\n", "utf-8");
  await run("git add note.txt && git commit -m 'chore: base'", seedDir);
  await run("git push -u origin main", seedDir);
  const baseSha = await run("git rev-parse HEAD", seedDir);

  await run(`git clone ${JSON.stringify(originDir)} ${JSON.stringify(rootDir)}`, base);
  await run("git config user.email card@example.com && git config user.name 'Card User'", rootDir);
  await run("git remote set-head origin -a", rootDir);

  await writeFile(path.join(seedDir, "foreign.txt"), "landed elsewhere\n", "utf-8");
  await run("git add foreign.txt && git commit -m 'feat(FN-355): foreign landed work'", seedDir);
  await run("git push origin main", seedDir);
  await run("git fetch origin", rootDir);

  let counter = 0;
  return {
    rootDir,
    baseSha,
    async makeCard(id: string, shape: CardShape): Promise<CheckoutTask> {
      const slug = id.toLowerCase();
      const branch = `fusion/${slug}`;
      const worktree = path.join(rootDir, ".wt", `${slug}-${counter++}`);
      await run(`git checkout -B ${branch} ${baseSha}`, rootDir);
      if (shape === "rebased-onto-origin") await run("git rebase origin/main", rootDir);
      if (shape === "ahead") {
        await writeFile(path.join(rootDir, `${slug}-work.txt`), "unmerged\n", "utf-8");
        await run("git add -A && git commit -m 'feat: unmerged work'", rootDir);
      }
      await run("git checkout main", rootDir);
      await run(`git worktree add ${JSON.stringify(worktree)} ${branch}`, rootDir);
      seam.reset();
      return { id, worktree, branch, baseCommitSha: baseSha };
    },
  };
}

async function loadProduct() {
  const emptiness = await import("../checkout-emptiness.js");
  const conflicts = await import("../../execution/branch-conflicts.js");
  return { emptiness, conflicts };
}

beforeEach(async () => {
  seam.reset();
  const { conflicts } = await loadProduct();
  conflicts.__resetTrustedIntegrationRefsForTests();
});

afterEach(async () => {
  const { emptiness } = await loadProduct();
  emptiness.resetCheckoutEmptinessProversForTesting();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});


/*
FNXC:GitProofForkAccounting 2026-11-08-02:20 (RUFU-871):
Every expectation below is a subprocess COUNT, never a duration. `TRUSTED_REF_FORKS` is the count of
`git remote` + `git for-each-ref refs/remotes` a trigger spends discovering the trusted integration
identities, and `PROOF_FORKS` is what it spends on the proofs themselves (`git status` + the
`git rev-list --count <identity>..HEAD` loop). Splitting them is what makes the ratchet readable: the
proof work is irreducible per distinct checkout, the trusted-ref work is one per-repository fact.
*/
const TRUSTED_REF_PREFIXES = ["git remote", "git for-each-ref"] as const;
const PROOF_PREFIXES = ["git status", "git rev-list"] as const;

/*
Cards are built SEQUENTIALLY on purpose. `makeCard` moves the fixture checkout's own HEAD
(`git checkout -B <branch>` then `git checkout main`), so building cards concurrently races them
against each other and yields a fixture whose branch tips are not the shape being measured.
*/
async function cards(prefix: string, count: number, shape: CardShape, fx: Fixture): Promise<CheckoutTask[]> {
  const built: CheckoutTask[] = [];
  for (let index = 0; index < count; index += 1) {
    built.push(await fx.makeCard(`${prefix}${index + 1}`, shape));
  }
  return built;
}

describe("STEP 1 — measured git fork count per trigger", () => {
  it("one card whose branch is zero-ahead of its recorded base: 4 forks (2 identity + 2 proof)", async () => {
    const fx = await setupFixture("at-base");
    const { emptiness } = await loadProduct();
    const card = await fx.makeCard("RUFU-ATBASE", "at-base");

    const prover = new emptiness.CheckoutEmptinessProver({ rootDir: fx.rootDir, settings: { integrationBranch: "main" } });
    const proof = await prover.proveTask(card);

    expect(proof.get("")).toBe("empty");
    expect(seam.countMatching(TRUSTED_REF_PREFIXES)).toBe(2);
    expect(seam.countMatching(PROOF_PREFIXES)).toBe(2);
    expect(seam.gitCount()).toBe(4);
  }, 60_000);

  it("one card zero-ahead only of the LAST trusted identity: 6 forks — the loop costs every identity it misses", async () => {
    const fx = await setupFixture("rebased");
    const { emptiness } = await loadProduct();
    const card = await fx.makeCard("RUFU-REBASE", "rebased-onto-origin");

    const prover = new emptiness.CheckoutEmptinessProver({ rootDir: fx.rootDir, settings: { integrationBranch: "main" } });
    const proof = await prover.proveTask(card);

    // The RUFU-231 shape: ahead of the recorded SHA, ahead of a behind local `main`, zero-ahead of
    // `origin/main`. The loop short-circuits only on a ZERO, so a "yes" answer costs three rev-lists.
    expect(proof.get("")).toBe("empty");
    expect(seam.gitCommands()).toEqual([
      "git remote",
      "git for-each-ref --format='%(refname:strip=2)' refs/remotes",
      "git status --porcelain",
      `git rev-list --count ${JSON.stringify(fx.baseSha)}..HEAD`,
      "git rev-list --count \"main\"..HEAD",
      "git rev-list --count \"origin/main\"..HEAD",
    ]);
    expect(seam.gitCount()).toBe(6);
  }, 60_000);

  it("one occupied card: 6 forks, the same worst case, because it matches no identity", async () => {
    const fx = await setupFixture("ahead");
    const { emptiness } = await loadProduct();
    const card = await fx.makeCard("RUFU-AHEAD", "ahead");

    const prover = new emptiness.CheckoutEmptinessProver({ rootDir: fx.rootDir, settings: { integrationBranch: "main" } });
    const proof = await prover.proveTask(card);

    expect(proof.get("")).toBe("occupied");
    expect(seam.gitCount()).toBe(6);
  }, 60_000);

  it("a 4-card pass forks 18, down from the measured 24: the trusted-ref pair is forked once per pass", async () => {
    const fx = await setupFixture("batch4");
    const { emptiness } = await loadProduct();
    const batch = await cards("RUFU-B", 4, "rebased-onto-origin", fx);

    const prover = new emptiness.CheckoutEmptinessProver({ rootDir: fx.rootDir, settings: { integrationBranch: "main" }, concurrency: 4 });
    const proofs = await prover.proveTasks(batch);

    // Every key answers exactly what the un-shared run answered (the parity case below proves the
    // equality more broadly); the only thing that moved is the subprocess count.
    for (const task of batch) expect(proofs.get(task.id ?? "")?.get("")).toBe("empty");
    // BEFORE: 8 — the 4 workers all entered `proveEntry` before any identity probe landed, and the memo
    // fills only AFTER the probe settles, so each forked its own pair.
    // AFTER: 2 — one shared in-flight probe per (repoDir, integrationRef) key.
    expect(seam.countMatching(TRUSTED_REF_PREFIXES)).toBe(2);
    expect(seam.countMatching(PROOF_PREFIXES)).toBe(16);
    expect(seam.gitCount()).toBe(18);
  }, 60_000);

  it("an 8-card pass forks 18, down from the measured 24 — 2 trusted-ref + 2 irreducible proof forks per card", async () => {
    const fx = await setupFixture("batch8");
    const { emptiness } = await loadProduct();
    const batch = await cards("RUFU-C", 8, "at-base", fx);

    const prover = new emptiness.CheckoutEmptinessProver({ rootDir: fx.rootDir, settings: { integrationBranch: "main" }, concurrency: 4 });
    const proofs = await prover.proveTasks(batch);

    for (const task of batch) expect(proofs.get(task.id ?? "")?.get("")).toBe("empty");
    // Proof work is irreducible per distinct checkout: one `git status --porcelain` (the tree state is
    // the thing being proven, so no cache or batch can answer it) plus the first matching `rev-list`.
    expect(seam.countMatching(TRUSTED_REF_PREFIXES)).toBe(2);
    expect(seam.countMatching(PROOF_PREFIXES)).toBe(16);
    expect(seam.gitCount()).toBe(18);
  }, 60_000);

  it("a repeat pass inside the 10 s proof TTL already forks 0 — the emptiness cache is not the repetition", async () => {
    const fx = await setupFixture("warm");
    const { emptiness } = await loadProduct();
    const batch = await cards("RUFU-W", 2, "rebased-onto-origin", fx);
    const prover = new emptiness.CheckoutEmptinessProver({ rootDir: fx.rootDir, settings: { integrationBranch: "main" }, concurrency: 4 });
    await prover.proveTasks(batch);
    seam.reset();

    const second = await prover.proveTasks(batch);

    expect(seam.gitCount()).toBe(0);
    for (const task of batch) expect(second.get(task.id ?? "")?.get("")).toBe("empty");
  }, 60_000);

  it("the shared helper forks one integration-branch lookup PER CALL, uncached, even when every proof is cached", async () => {
    const fx = await setupFixture("helper");
    const { emptiness } = await loadProduct();
    const card = await fx.makeCard("RUFU-HELP", "at-base");
    // Unconfigured `integrationBranch` is the default deployment shape: the resolver must ask git.
    const prover = new emptiness.CheckoutEmptinessProver({ rootDir: fx.rootDir, settings: {} });

    await emptiness.proveDormantCheckoutEmptiness({ rootDir: fx.rootDir, settings: {} as never, candidates: [card], prover });
    const cold = seam.gitCommands();
    seam.reset();
    await emptiness.proveDormantCheckoutEmptiness({ rootDir: fx.rootDir, settings: {} as never, candidates: [card], prover });
    const warm = seam.gitCommands();
    seam.reset();
    await emptiness.proveDormantCheckoutEmptiness({ rootDir: fx.rootDir, settings: {} as never, candidates: [card], prover });

    expect(cold.filter((c) => c.startsWith("git symbolic-ref"))).toHaveLength(2);
    // Every subsequent call still forks one: the helper resolves the branch itself and the result is
    // remembered nowhere. `self-healing.ts:549` and `:6116` call this helper once PER CARD.
    expect(warm).toEqual(["git symbolic-ref --short refs/remotes/origin/HEAD"]);
  }, 60_000);

  it("trusted-ref resolution: 2 forks cold, 0 warm, and 2 for a cold burst of 4 (was 8)", async () => {
    const fx = await setupFixture("single-flight");
    const { conflicts } = await loadProduct();

    const cold = await conflicts.resolveTrustedIntegrationRefs(fx.rootDir, "main");
    expect(seam.gitCount()).toBe(2);

    seam.reset();
    const warmBurst = await Promise.all(Array.from({ length: 4 }, () => conflicts.resolveTrustedIntegrationRefs(fx.rootDir, "main")));
    expect(seam.gitCount()).toBe(0);

    conflicts.__resetTrustedIntegrationRefsForTests();
    seam.reset();
    const coldBurst = await Promise.all(Array.from({ length: 4 }, () => conflicts.resolveTrustedIntegrationRefs(fx.rootDir, "main")));

    expect(cold).toEqual(["main", "origin/main"]);
    // BEFORE: 4 callers, one answer, eight subprocesses (2 x K), and every burst member still resolved
    // the SAME set — seven of those forks bought nothing.
    // AFTER: one shared probe. The equality assertion is the half that matters: sharing the subprocess
    // may not share a DIFFERENT answer, so every joiner must still see the cold identity set.
    expect(seam.gitCount()).toBe(2);
    for (const refs of [...warmBurst, ...coldBurst]) expect(refs).toEqual(cold);
  }, 60_000);

  it("the measurement seam does not distort the proofs it counts (verdicts match a per-entry cold run)", async () => {
    const fx = await setupFixture("parity");
    const { emptiness } = await loadProduct();
    const batch = await cards("RUFU-P", 3, "rebased-onto-origin", fx);
    const options = { rootDir: fx.rootDir, settings: { integrationBranch: "main" } as const };

    // Baseline: one prover per card, so nothing is shared and every verdict is derived independently.
    const perCard = new Map<string, string | undefined>();
    for (const task of batch) {
      const solo = new emptiness.CheckoutEmptinessProver(options);
      perCard.set(task.id ?? "", (await solo.proveTask(task)).get(""));
      emptiness.resetCheckoutEmptinessProversForTesting();
      // The trusted-ref memo is module-global, so a solo prover must not inherit a warm identity set.
      const { conflicts } = await loadProduct();
      conflicts.__resetTrustedIntegrationRefsForTests();
    }
    seam.reset();

    const shared = new emptiness.CheckoutEmptinessProver({ ...options, concurrency: 4 });
    const proofs = await shared.proveTasks(batch);

    for (const task of batch) {
      expect(proofs.get(task.id ?? "")?.get(""), task.id).toBe(perCard.get(task.id ?? ""));
    }
  }, 60_000);
});

/*
FNXC:GitProofForkAccounting 2026-11-08-02:20 (RUFU-871):
The freshness contract this fork reduction deliberately did NOT touch, pinned so it cannot drift
silently while subprocess counts are being argued about.

The emptiness cache is keyed by (checkout path, trusted identity set, branch ref) with a 10 000 ms TTL,
and it holds no tip SHA and no tree fingerprint. Adding either is not free: the key is what a lookup is
computed FROM, so a tip-secure key needs a `git rev-parse` on every read — a fork on the path the whole
change exists to empty. What the design actually guarantees is narrower and must stay written down:
`empty` is downgrade-only, and `invalidateEmptinessProofsForTask` is the seam that attributes a lifecycle
mutation to the checkouts it can dirty and drops exactly those verdicts. Between a bare working-tree edit
and the next pass, the bound on staleness is the TTL — and when in doubt this lane re-proves rather than
serves, because a missing verdict keeps a blocker blocking while a wrong `empty` can release live work.
*/
describe("proof-cache freshness contract (unchanged by the fork reduction)", () => {
  it("a dirtied or advanced checkout is re-proved, never served the cached `empty` it had before", async () => {
    const fx = await setupFixture("freshness");
    const { emptiness } = await loadProduct();
    const card = await fx.makeCard("RUFU-FRESH", "at-base");
    const prover = emptiness.checkoutEmptinessProverFor(fx.rootDir, { settings: { integrationBranch: "main" } });

    expect((await prover.proveTask(card)).get("")).toBe("empty");

    // The branch moves ahead AND the tree gains an untracked file: both are work a `dormant -> none`
    // downgrade would have released.
    await run("echo work > work.txt && git add work.txt && git commit -q -m 'feat: new tip' && echo scratch > scratch.txt", card.worktree!);
    emptiness.invalidateEmptinessProofsForTask(fx.rootDir, card);
    seam.reset();

    const afterMutation = await prover.proveTask(card);

    expect(afterMutation.get("")).toBe("occupied");
    // The invalidation cost exactly ONE fork. A dirty tree is decided by `git status --porcelain` alone
    // — non-empty output returns `occupied` before the identity loop is ever entered — so the safe
    // direction is also the cheap one, and no cached verdict is consulted on the way there.
    expect(seam.countMatching(PROOF_PREFIXES)).toBe(1);
  }, 60_000);

  it("the reverse direction is re-proved too: an `occupied` verdict is never laundered into a cached `empty`", async () => {
    const fx = await setupFixture("direction");
    const { emptiness } = await loadProduct();
    const card = await fx.makeCard("RUFU-DIRTY", "ahead");
    const prover = emptiness.checkoutEmptinessProverFor(fx.rootDir, { settings: { integrationBranch: "main" } });

    expect((await prover.proveTask(card)).get("")).toBe("occupied");

    await run("git reset --hard main && git clean -fd", card.worktree!);
    prover.invalidatePath(card.worktree!);
    seam.reset();

    expect((await prover.proveTask(card)).get("")).toBe("empty");
    expect(seam.countMatching(PROOF_PREFIXES)).toBeGreaterThan(0);
  }, 60_000);
});
