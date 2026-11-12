/*
FNXC:OverlapScheduling 2026-09-08-19:50 (RUFU-200):
A retained task checkout was treated as proof of unmerged work purely because the PATH existed
(`taskHoldsUnmergedCheckout`), so a task branch cut from the base that never committed anything kept a
`dormant` file-scope lease forever. RUFU-198 deadlocked its overlapping peer RUFU-199 exactly that way:
clean `git status --porcelain`, zero commits ahead of `main`, parked in a planning lane behind an
unmet dependency, therefore never dispatching and never reaching any dispatch-time metadata recovery
— while every heartbeat patrol re-created the checkout that kept the phantom alive.

This module computes the missing evidence: a checkout is `empty` only when its tree is clean AND it has
zero commits ahead of its resolved base ref, evaluated PER REPOSITORY so a workspace card cannot be
released on the strength of one clean sub-repository. Everything else is `occupied` (positive evidence
of work to preserve) or `unknown` (the proof could not be obtained). Downstream consumers may only
DOWNGRADE on `empty`; `unknown` must keep today's holder behavior, because the cost of guessing wrong
about `unknown` is destroying someone's uncommitted work while the cost of guessing wrong about
`occupied` is one more scheduling pass of waiting.

Design constraints that shaped this file:
- Async `exec` only. AGENTS.md allows synchronous shellout solely for short deterministic git plumbing
  inside a transaction; classification runs on a scheduling hot path, so it must not block the loop.
- Bounded per-pass cost: a short TTL cache, per-entry in-flight dedupe, and one bounded-concurrency
  fan-out per batch so a pass over N cards issues at most `concurrency` simultaneous git calls.
- No polling loop and no watcher: the proof is pull-based and computed on demand by whoever classifies.
*/
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { CheckoutEmptinessProofMap, CheckoutEmptinessVerdict } from "@fusion/core";
import { inspectLaneLegLocal, REFUSAL_BY_CLASSIFICATION, type LaneLegClassification, type LaneLegLocalState } from "./lane-legs.js";
import { recordLaneLegRefusal, type LaneLegRefusalNotice, type LaneLegRefusalStore } from "./lane-leg-refusal.js";
import { resolveIntegrationBranch, resolveIntegrationBranchFromSettings, type IntegrationBranchSettings } from "../merge/integration-branch.js";
/* RUFU-231: shared trusted-integration-identity chain (the same ordered identities the
   branch-conflict inspection and the sweep's foreign-tip rejection trust). */
import { resolveTrustedIntegrationRefs } from "../execution/branch-conflicts.js";

const execAsync = promisify(exec);

/**
 * FNXC:OverlapScheduling 2026-09-08-19:50: deliberately short. A checkout can gain an uncommitted edit
 * between two scheduling passes, and a `dormant → none` downgrade that outlives the moment it was true
 * is what would let a peer collide with real work. Ten seconds bounds the stale window without turning
 * every admission pass into a git storm.
 */
export const CHECKOUT_EMPTINESS_PROOF_TTL_MS = 10_000;

const GIT_COMMAND_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const DEFAULT_PROOF_CONCURRENCY = 4;
const DEFAULT_MAX_CACHED_PROOFS = 512;

/*
FNXC:LaneLegGate 2026-11-11-23:15 (RUFU-425, W4):
How often one refused leg may re-announce itself. The proof cache suppresses repeats inside its TTL,
but a scheduling pass every few seconds would otherwise write a History line per pass per lane — the
same shape that produced 16 536 audit rows for one card over two days (RUFU-393). The prover's refusal
is therefore announced at most once per window per path, while the `unknown` verdict it accompanies is
returned on EVERY pass: the announcement is bounded, the protection is not.
*/
const LANE_LEG_REFUSAL_NOTICE_FLOOR_MS = 15 * 60_000;

/*
FNXC:LaneLegGate 2026-11-11-23:50 (RUFU-425):
`LaneLegLocalState` is a subset of `LaneLegClassification` — the fork-free probe can name every
refusing class except `unborn-repository`, which needs a git read — so the shared
{@link REFUSAL_BY_CLASSIFICATION} table answers this file's lookup too. There is deliberately no
second mapping here: the code a refusal carries and the sentence the operator reads must not be able
to disagree about which class fired.
*/
const refusalCodeForLegState = (state: Exclude<LaneLegLocalState, "own-checkout">) => REFUSAL_BY_CLASSIFICATION[state];

/** Lookup key for a task's singular {@link Task.worktree} checkout. */
export const SINGULAR_CHECKOUT_KEY = "";

/** The subset of a task row the prover needs; keeps the prover usable with `slim: true` rows. */
export type CheckoutEmptinessTaskShape = {
  id?: string;
  worktree?: string | null;
  branch?: string | null;
  baseCommitSha?: string | null;
  workspaceWorktrees?: Record<string, {
    worktreePath?: string | null;
    branch?: string | null;
    baseBranch?: string | null;
    baseCommitSha?: string | null;
  } | undefined>;
};

export interface CheckoutEmptinessEntry {
  /** Key the verdict is published under: `""` for the singular checkout, else the workspace repo key. */
  key: string;
  path: string;
  /** Task-recorded base for THIS repository; resolved against the integration branch when absent. */
  baseRef: string | null;
  /** Branch ref, required to prove a dead/unregistered path in `ref-only` mode. */
  branchRef: string | null;
}

/**
 * Enumerate every retained checkout entry of a task, per repository (never all-or-nothing).
 *
 * `defaultBaseRef` is the pass-level fallback (normally the resolved integration branch) used only for
 * an entry with no task-recorded base. Callers that batch many tasks resolve it once and pass it in, so
 * a pass over N cards performs one integration-branch resolution rather than N.
 */
export function checkoutEmptinessEntries(
  task: CheckoutEmptinessTaskShape,
  defaultBaseRef?: string | null,
): CheckoutEmptinessEntry[] {
  const entries: CheckoutEmptinessEntry[] = [];
  const fallbackBaseRef = normalizeRef(defaultBaseRef);
  const singular = typeof task.worktree === "string" ? task.worktree.trim() : "";
  if (singular) {
    entries.push({
      key: SINGULAR_CHECKOUT_KEY,
      path: singular,
      baseRef: normalizeRef(task.baseCommitSha) ?? fallbackBaseRef,
      branchRef: normalizeRef(task.branch),
    });
  }
  for (const [repoKey, entry] of Object.entries(task.workspaceWorktrees ?? {})) {
    const path = typeof entry?.worktreePath === "string" ? entry.worktreePath.trim() : "";
    if (!path) continue;
    entries.push({
      key: repoKey,
      path,
      baseRef:
        normalizeRef(entry?.baseCommitSha)
        ?? normalizeRef(entry?.baseBranch)
        ?? normalizeRef(task.baseCommitSha)
        ?? fallbackBaseRef,
      branchRef: normalizeRef(entry?.branch) ?? normalizeRef(task.branch),
    });
  }
  return entries;
}

function normalizeRef(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

export interface CheckoutEmptinessExecOptions {
  cwd: string;
  timeout: number;
  maxBuffer: number;
}

export type CheckoutEmptinessExec = (
  command: string,
  options: CheckoutEmptinessExecOptions,
) => Promise<{ stdout: string }>;

/** Per-call options for one bounded proof fan-out. */
export interface CheckoutEmptinessProveOptions {
  /** Bypass the cached verdict for this batch (used after an observed lifecycle mutation). */
  force?: boolean;
  /**
   * Overrides the prover's default base ref for THIS batch only. A scheduler pass that already read
   * `settings.integrationBranch` passes it here, so a registry-shared prover never answers from a base
   * ref remembered under stale settings; the cache key includes the base ref, so both answers coexist.
   */
  integrationBranch?: string | null;
}

export interface CheckoutEmptinessProverOptions {
  /** Main checkout used for `ref-only` proof mode and the integration-branch fallback. */
  rootDir: string;
  /** Settings used only by the default integration-branch fallback resolver. */
  settings?: IntegrationBranchSettings;
  /** Caller-resolved integration branch; skips the built-in fallback resolution entirely. */
  integrationBranch?: string;
  ttlMs?: number;
  maxEntries?: number;
  /** Simultaneous git calls across one batch. */
  concurrency?: number;
  /** Injectable clock so TTL behavior is testable with fake timers. */
  now?: () => number;
  /** Injectable git runner for unit tests; real-git tests use the default. */
  execImpl?: CheckoutEmptinessExec;
  /**
   * Optional board handle used ONLY to record a lane-leg refusal (one History line plus one audit row).
   * Proving is never gated on it: a prover without a store still answers `unknown` for an
   * unmeasurable leg, which every consumer already treats as a holder.
   */
  store?: LaneLegRefusalStore;
}

interface CachedProof {
  verdict: CheckoutEmptinessVerdict;
  at: number;
}

/*
FNXC:OverlapScheduling 2026-09-08-19:50: git plumbing refs reach the shell, so every ref is
JSON-quoted (the same convention `self-healing.ts` uses for `git branch -D`). A task row's
`baseCommitSha`/`branch` values are not trusted to be ref-safe characters.
*/
function quoteRef(ref: string): string {
  return JSON.stringify(ref);
}

/** Cache keys are NUL-delimited so a ref or path containing the separator can never alias another entry. */
function proofCacheKey(path: string, baseRef: string, branchRef: string | null): string {
  return [path, baseRef, branchRef ?? ""].join("\u0000");
}

function parseCommitCount(stdout: string): number | null {
  const trimmed = stdout.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const count = Number(trimmed);
  return Number.isSafeInteger(count) ? count : null;
}

/**
 * Computes whether retained task checkouts still have anything to preserve.
 *
 * Every public method is fail-closed: a git failure, a timeout, unparseable output, an unresolvable
 * base ref, or a missing branch ref yields `unknown`, which every consumer treats as a holder.
 */
export class CheckoutEmptinessProver {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly execImpl: CheckoutEmptinessExec;
  private readonly rootDir: string;
  private readonly settings: IntegrationBranchSettings;
  private readonly pinnedIntegrationBranch: string | null;
  private readonly cache = new Map<string, CachedProof>();
  private readonly inFlight = new Map<string, Promise<CheckoutEmptinessVerdict>>();
  private integrationBranchPromise: Promise<string | null> | null = null;
  /** Optional board handle for lane-leg refusals; attaching is idempotent and never changes a verdict. */
  private legRefusalStore: LaneLegRefusalStore | undefined;
  /** Path -> when its refusal was last announced, so a polled lane cannot write History per pass. */
  private readonly legRefusalAnnouncedAt = new Map<string, number>();

  constructor(options: CheckoutEmptinessProverOptions) {
    this.rootDir = options.rootDir;
    this.settings = options.settings ?? {};
    this.pinnedIntegrationBranch = normalizeRef(options.integrationBranch);
    this.ttlMs = options.ttlMs ?? CHECKOUT_EMPTINESS_PROOF_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_CACHED_PROOFS;
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_PROOF_CONCURRENCY);
    this.now = options.now ?? Date.now;
    this.legRefusalStore = options.store;
    this.execImpl = options.execImpl ?? (async (command, execOptions) => {
      const result = await execAsync(command, execOptions);
      return { stdout: result.stdout };
    });
  }

  /*
  FNXC:LaneLegGate 2026-11-11-23:15 (RUFU-425):
  One prover is shared per project root, and the first caller to construct it does not necessarily
  own a store. Attaching late is therefore the difference between the refusal being recorded and the
  refusal existing nowhere, so an already-registered prover accepts a store the first time one is
  offered. It changes no verdict: proof behavior is identical with or without a recorder.
  */
  attachLegRefusalStore(store: LaneLegRefusalStore | undefined): void {
    if (!store) return;
    this.legRefusalStore ??= store;
  }

  /** Prove one task's retained entries. Returns an empty map for a checkout-free task. */
  async proveTask(
    task: CheckoutEmptinessTaskShape,
    options: CheckoutEmptinessProveOptions = {},
  ): Promise<CheckoutEmptinessProofMap> {
    const verdicts = await this.proveTasks([task], options);
    return verdicts.get(task.id ?? "") ?? new Map<string, CheckoutEmptinessVerdict>();
  }

  /**
   * One bounded fan-out for a whole scheduling pass. Results are keyed by task id; a task with no
   * retained entry gets an empty map, which classifies as "not a holder" without any git call.
   */
  async proveTasks(
    tasks: readonly CheckoutEmptinessTaskShape[],
    options: CheckoutEmptinessProveOptions = {},
  ): Promise<ReadonlyMap<string, CheckoutEmptinessProofMap>> {
    // The accumulator stays mutable; only the returned view is the read-only proof-map contract.
    const result = new Map<string, Map<string, CheckoutEmptinessVerdict>>();
    const passBaseRef = await this.baseRefForCall(options.integrationBranch);
    type Job = { taskId: string; key: string; entry: CheckoutEmptinessEntry };
    const jobs: Job[] = [];
    for (const task of tasks) {
      const taskId = task.id ?? "";
      const perTask = new Map<string, CheckoutEmptinessVerdict>();
      result.set(taskId, perTask);
      for (const entry of checkoutEmptinessEntries(task, passBaseRef)) {
        jobs.push({ taskId, key: entry.key, entry });
      }
    }
    if (jobs.length === 0) return result;

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        const verdict = await this.proveEntry(job.entry, options.force === true, job.taskId);
        result.get(job.taskId)?.set(job.key, verdict);
      }
    };
    const workers = Array.from({ length: Math.min(this.concurrency, jobs.length) }, () => worker());
    await Promise.all(workers);
    return result;
  }

  /** Drop one path's cached verdicts (e.g. after a reclaim released it). */
  invalidatePath(path: string): void {
    for (const cacheKey of [...this.cache.keys()]) {
      if (cacheKey.split("\u0000")[0] === path) this.cache.delete(cacheKey);
    }
  }

  /** Drop the whole cache; used by tests and by a caller that observed a lifecycle mutation. */
  invalidateAll(): void {
    this.cache.clear();
  }

  private async proveEntry(entry: CheckoutEmptinessEntry, force: boolean, taskId = ""): Promise<CheckoutEmptinessVerdict> {
    const baseRef = entry.baseRef ?? await this.defaultBaseRef();
    if (!baseRef) return "unknown";
    /*
    FNXC:BranchBaseIdentity 2026-09-13-00:40 (RUFU-231, defect 3):
    The zero-loss proof must trust the same ordered integration identities as the branch-conflict
    inspection and the sweep's foreign-tip rejection. Candidates: the entry's recorded base ref
    first (`baseCommitSha` — precise anchor), then the resolved integration branch and its
    remote-tracking counterparts (`<remote>/<integration>`). The chain anchors on the BRANCH NAME,
    not the recorded ref: after Step 2 acquisition a recorded `baseCommitSha` is a SHA, and
    `<remote>/<sha>` is never a valid identity — without the name anchor, a card rebased onto
    origin/main would prove occupied forever against its recorded SHA. A zero-own-commit branch
    rebased onto `<remote>/<integration>` is zero-ahead of the identity it actually landed on;
    proving only against a behind local identity read occupied forever (the unbounded loop's
    fourth voice). A failed identity resolution degrades to the recorded/branch ref: today's
    fail-closed behavior. The candidate set is part of the cache key so a verdict is never reused
    across a changed identity set.
    */
    const chainAnchor = (await this.defaultBaseRef()) ?? baseRef;
    /*
    FNXC:GitProofForkAccounting 2026-11-08-02:02 (RUFU-871):
    This line is the join between the two call sites a raw CDP profile named: `CheckoutEmptinessProver.execImpl`
    -> `runGit` -> `runProof` (3 813 / 3 811 inclusive samples on the `exec` / `execFile` paths) and
    `probeTrustedIntegrationRefs` -> `trustedRefsGit` -> `runGit` (2 380 / 2 378). The profile's ~28 %
    `onStreamRead` + `Readable.push` + `addChunk` and ~17 % `buffer.concat` shares were the stdout of these
    same subprocesses.

    It runs once per entry, and the entry cannot change its answer: the chain depends only on
    (rootDir, chainAnchor). `resolveTrustedIntegrationRefs` now shares one in-flight probe per key, so the
    `concurrency` workers of one pass fork the identity pair ONCE instead of once per worker — measured
    24 -> 18 git processes for a 4-card pass and for an 8-card pass, with every verdict unchanged.
    */
    const trusted = await resolveTrustedIntegrationRefs(this.rootDir, chainAnchor).catch((): string[] => []);
    const baseRefs = [...new Set([baseRef, chainAnchor, ...trusted])];
    const cacheKey = proofCacheKey(entry.path, baseRefs.join("\u0001"), entry.branchRef);

    if (!force) {
      const cached = this.cache.get(cacheKey);
      if (cached && this.now() - cached.at <= this.ttlMs) return cached.verdict;
      const pending = this.inFlight.get(cacheKey);
      if (pending) return pending;
    } else {
      this.cache.delete(cacheKey);
    }

    const pending = this.runProof(entry, baseRefs, taskId)
      .then((verdict) => {
        this.remember(cacheKey, verdict);
        return verdict;
      })
      .finally(() => {
        this.inFlight.delete(cacheKey);
      });
    this.inFlight.set(cacheKey, pending);
    return pending;
  }

  /*
  FNXC:LaneLegGate 2026-11-11-23:15 (RUFU-425):
  Announce a refused leg and never wait for the announcement. A proof that blocks on a board write is
  the anti-pattern FN-9175 exists to prevent, so the record is handed off and the verdict is returned
  on the same tick. The announcement floor bounds History per path; the `unknown` verdict that protects
  the lease is returned on every single pass regardless of the floor.
  */
  private recordLegRefusal(
    taskId: string,
    entry: CheckoutEmptinessEntry,
    state: Exclude<LaneLegLocalState, "own-checkout">,
  ): void {
    const store = this.legRefusalStore;
    if (!store || !taskId) return;
    const code = refusalCodeForLegState(state);
    if (!code) return;
    const now = this.now();
    const announcedAt = this.legRefusalAnnouncedAt.get(entry.path);
    if (announcedAt !== undefined && now - announcedAt < LANE_LEG_REFUSAL_NOTICE_FLOOR_MS) return;
    this.legRefusalAnnouncedAt.set(entry.path, now);
    const notice: LaneLegRefusalNotice = {
      code,
      repository: entry.key,
      path: entry.path,
      legs: [{
        repository: entry.key,
        classification: state as LaneLegClassification,
        entryCount: null,
        toplevel: null,
        head: null,
        lag: null,
      }],
    };
    void recordLaneLegRefusal(store, taskId, notice, "checkout-emptiness").catch(() => undefined);
  }

  private remember(cacheKey: string, verdict: CheckoutEmptinessVerdict): void {
    if (this.cache.size >= this.maxEntries) {
      // Map iteration order is insertion order, so the first key is the oldest remembered proof.
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(cacheKey, { verdict, at: this.now() });
  }

  /*
  FNXC:OverlapScheduling 2026-09-08-19:50 (RUFU-200):
  Two proof modes, tried in order. `live` mode proves both halves of the invariant against the real
  tree: an empty `git status --porcelain` (which counts untracked files, because an untracked file IS
  work that a forced worktree removal would destroy) AND `rev-list --count base..HEAD` == 0.

  When the live half cannot run — the recorded path is gone, or it was never a registered worktree —
  `ref-only` mode still proves the commits-ahead half against the branch ref in the main checkout. Tree
  cleanliness is VACUOUS there because there is no tree to be dirty, so zero commits ahead really does
  mean nothing to preserve. An unreadable ref yields `unknown`, never `empty`.
  */
  private async runProof(entry: CheckoutEmptinessEntry, baseRefs: readonly string[], taskId = ""): Promise<CheckoutEmptinessVerdict> {
    /*
    FNXC:LaneLegGate 2026-11-11-23:15 (RUFU-425, W4):
    A leg whose directory is empty, or is not its own repository, makes the live half of this proof
    read the ENCLOSING project: `git status --porcelain` at such a path answers for the folder that
    contains it, and a clean project around a leg that holds nothing produces a confident `empty`. That
    verdict is what releases a file-scope lease and authorises a worktree removal, so the prover was one
    of the two seams where a wrong-repository measurement could destroy live work.

    The check is the fork-free local probe, not `assessLaneLegs`: this prover's subprocess count is a
    measured ratchet (RUFU-871) and the pass covers dozens of checkouts. `.git` presence and an upward
    `stat` walk answer the same question without a spawn.

    A MISSING directory is deliberately NOT refused here. Proving a released worktree from its branch ref
    in the main checkout is the mode this function was designed around (RUFU-200), and it stays the
    answer; the missing-leg class is refused by the gates that have no refs-only mode.
    */
    const legState = await inspectLaneLegLocal(entry.path);
    if (legState !== "own-checkout" && legState !== "missing-directory") {
      // `unknown` is the verdict every consumer already treats as a holder. The refusal says why.
      this.recordLegRefusal(taskId, entry, legState);
      return "unknown";
    }

    const status = await this.runGit("git status --porcelain", entry.path);
    if (status.ok) {
      if (status.stdout.trim().length > 0) return "occupied";
      let anyReadOk = false;
      for (const baseRef of baseRefs) {
        const ahead = await this.runGit(`git rev-list --count ${quoteRef(baseRef)}..HEAD`, entry.path);
        if (!ahead.ok) continue;
        const count = parseCommitCount(ahead.stdout);
        if (count === null) continue;
        anyReadOk = true;
        if (count === 0) return "empty";
      }
      return anyReadOk ? "occupied" : "unknown";
    }

    if (!entry.branchRef) return "unknown";
    let anyReadOk = false;
    for (const baseRef of baseRefs) {
      const ahead = await this.runGit(
        `git rev-list --count ${quoteRef(baseRef)}..${quoteRef(entry.branchRef)}`,
        this.rootDir,
      );
      if (!ahead.ok) continue;
      const count = parseCommitCount(ahead.stdout);
      if (count === null) continue;
      anyReadOk = true;
      if (count === 0) return "empty";
    }
    return anyReadOk ? "occupied" : "unknown";
  }

  private async runGit(
    command: string,
    cwd: string,
  ): Promise<{ ok: true; stdout: string } | { ok: false }> {
    try {
      const result = await this.execImpl(command, {
        cwd,
        timeout: GIT_COMMAND_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
      });
      return { ok: true, stdout: typeof result.stdout === "string" ? result.stdout : "" };
    } catch {
      // A timeout, a non-zero exit, or a missing directory is the ABSENCE of proof, never proof of
      // emptiness: `unknown` keeps today's holder behavior (fail-closed).
      return { ok: false };
    }
  }

  private defaultBaseRef(): Promise<string | null> {
    if (this.pinnedIntegrationBranch) return Promise.resolve(this.pinnedIntegrationBranch);
    this.integrationBranchPromise ??= resolveIntegrationBranch(this.rootDir, this.settings)
      .then((branch) => normalizeRef(branch))
      .catch(() => null);
    return this.integrationBranchPromise;
  }

  /*
  FNXC:OverlapScheduling 2026-09-08-20:40 (RUFU-200):
  A caller that already resolved `integrationBranch` from live project settings passes it per call, so
  one registry-shared prover cannot answer with a base ref cached from stale settings. An empty
  override falls back to the constructor pin, then to origin/HEAD detection.
  */
  private async baseRefForCall(integrationBranch: string | null | undefined): Promise<string | null> {
    const override = normalizeRef(integrationBranch);
    if (override) return override;
    return await this.defaultBaseRef();
  }
}

/*
FNXC:OverlapScheduling 2026-09-08-19:50:
One prover per project root so the scheduler's admission pass, the worktree-capacity count, the outer
dispatch gate, and the self-healing reclaim all share ONE cache and one TTL window. Two provers would
mean two git fan-outs for the same state and, worse, a window where admission said `empty` while the
capacity count still said `occupied`.
*/
const proverByRootDir = new Map<string, CheckoutEmptinessProver>();

export function checkoutEmptinessProverFor(
  rootDir: string,
  options: Omit<CheckoutEmptinessProverOptions, "rootDir"> = {},
): CheckoutEmptinessProver {
  const existing = proverByRootDir.get(rootDir);
  if (existing) {
    // The first construction does not necessarily own a store, so a later caller may still attach one.
    existing.attachLegRefusalStore(options.store);
    return existing;
  }
  const created = new CheckoutEmptinessProver({ ...options, rootDir });
  proverByRootDir.set(rootDir, created);
  return created;
}

/*
FNXC:CheckoutEmptinessInvalidation 2026-10-02-05:47 (RUFU-487 step 1):
Until now `invalidatePath`/`invalidateAll` had NO production caller: the only freshness mechanism was
`CHECKOUT_EMPTINESS_PROOF_TTL_MS = 10_000`, so a card whose checkout had just been dirtied or released
kept answering from a verdict up to ten seconds stale, and any attempt to lengthen that TTL (the obvious
fix for the proof lane being the largest remaining git consumer — 1421 `spawn` samples, 6.1% of idle
dashboard CPU, measured 2026-10-02) would have widened that staleness instead of closing it.

This is the step that must come FIRST: attribute a lifecycle mutation to the checkouts it can dirty and
drop exactly those verdicts. Path selection reuses `checkoutEmptinessEntries`, the same enumeration the
prover itself proves, so a workspace card invalidates every member repository rather than only the
singular `worktree`. A mutation carrying no path at all invalidates everything: the safe direction for
an unattributable touch is a fresh proof, never a stale verdict — `checkoutEmptiness` is a downgrade-only
input, so a missing verdict keeps a blocker blocking while a wrong "empty" can release live work.
*/
export function invalidateEmptinessProofsForTask(
  rootDir: string,
  task: CheckoutEmptinessTaskShape,
): void {
  const prover = checkoutEmptinessProverFor(rootDir);
  const paths = new Set(
    checkoutEmptinessEntries(task)
      .map((entry) => entry.path)
      .filter((path) => path.length > 0),
  );
  if (paths.size === 0) {
    prover.invalidateAll();
    return;
  }
  for (const path of paths) prover.invalidatePath(path);
}

export function resetCheckoutEmptinessProversForTesting(): void {
  for (const prover of proverByRootDir.values()) prover.invalidateAll();
  proverByRootDir.clear();
  invalidateIntegrationBranchMemo();
}

/*
FNXC:OverlapScheduling 2026-09-08-20:40 (RUFU-200):
Every consumer that may downgrade a dormant lease must answer the emptiness question the SAME way, or
admission and the re-validating sweep disagree and the card oscillates between "blocked" and "free".
This helper is therefore the only sanctioned entry point: it resolves the integration branch once for
the pass (honouring `integrationBranch`, then `baseBranch`, then `origin/HEAD`), and issues ONE bounded
fan-out against the shared per-root prover.

Callers pass ONLY tasks that would otherwise classify `dormant`. A proven `empty` verdict is a
 downgrade: an empty result map, a missing entry, or an `unknown`/`occupied` verdict all keep the
dormant lease, so a prover failure cannot widen dispatch.
*/
/*
FNXC:GitProofForkAccounting 2026-11-08-03:49 (RUFU-871):
The Git fork the shared helper still paid once PER CALL.

`proveDormantCheckoutEmptiness` resolved the pass base ref itself, so the value reached the prover as the
per-call `integrationBranch` override and never passed through the prover's own memo. Seven production
call sites run it — `scheduler.ts:3313` (per admission pass), `executor/file-scope-lease-dispatch-gate.ts:156`
(per dispatch), `concurrency/concurrency.ts:770`, `healing/gridlock-detector.ts:205`, and
`self-healing.ts:549` / `:6116` (once per card) — and on the default deployment (`integrationBranch`
and `baseBranch` both unset) every one of them forked `git symbolic-ref --short refs/remotes/origin/HEAD`.
Measured before this change: `proveDormantCheckoutEmptiness, warm → 1` fork per call even when every
proof verdict was already cached, pinned by the then-current case in
`worktree/__tests__/git-proof-fork-count.test.ts`.

Why this is a repository-level fact and not a per-card one: `refs/remotes/origin/HEAD` is a symbolic ref
in the repository's own `.git`, written by `git remote set-head` / `git clone`. Nothing a card does to
its checkout moves it, so it is the same answer for every candidate in a pass — exactly the shape the
per-rootDir prover registry above already assumes.

Staleness accepted: `CHECKOUT_EMPTINESS_PROOF_TTL_MS` (10 s), the SAME window this file already
publishes and documents, not a new one. Two reasons that window is the honest bound rather than a
convenience:
- The value is already staler than that today. `CheckoutEmptinessProver.defaultBaseRef()` memoizes this
  same resolution in a promise that is never expired, so the prover's own base ref has an UNBOUNDED
  staleness window for the lifetime of the prover registry entry. A 10 s bound on the helper is a
  tightening, never a widening.
- The proof this feeds is downgrade-only and already tolerates a 10 s-old tree-cleanliness verdict, so a
  base-ref fact carried the same way cannot make the merge-safety proof more permissive than the window
  surrounding it already does. The proof cache key still includes the resolved base refs, so a re-pointed
  `origin/HEAD` yields a NEW proof key rather than reusing a verdict proven against the old one.
If an operator re-points `origin/HEAD` (`git remote set-head origin -a`), the accepted exposure is
therefore ≤ 10 s on this path, and a settings save is never exposed at all — see the settings rung below.

The settings rung is deliberately OUTSIDE the memo. `resolveIntegrationBranchFromSettings` answers from
`integrationBranch` / `baseBranch` alone and forks nothing, so consulting it per call keeps an operator's
explicit configuration live on every pass (the RUFU-200 requirement this helper was built to satisfy)
while only the git-derived half is remembered. Single-flight mirrors `resolveTrustedIntegrationRefs`: N
callers arriving before the first probe settles share one fork instead of N.
*/
interface IntegrationBranchMemoEntry {
  /** When the resolution started; bounds both the settled value and an unsettled flight. */
  at: number;
  promise: Promise<string | null>;
}

const integrationBranchMemoByRootDir = new Map<string, IntegrationBranchMemoEntry>();

/**
 * Drop the memoized git-derived integration branch for one repository, or for every repository.
 *
 * Deliberately has NO lifecycle caller, unlike `invalidateEmptinessProofsForTask`: moving
 * `refs/remotes/origin/HEAD` is `git remote set-head`, which Fusion never runs and observes no event
 * for, so there is no mutation to attribute the way a checkout dirtying is attributable. The 10 s TTL
 * above is what bounds an operator's re-point, and this seam exists for
 * `resetCheckoutEmptinessProversForTesting` and for a future operator-facing refresh, mirroring
 * `__resetTrustedIntegrationRefsForTests` — an exported test seam is not an unowned production hook.
 */
export function invalidateIntegrationBranchMemo(rootDir?: string): void {
  if (rootDir === undefined) {
    integrationBranchMemoByRootDir.clear();
    return;
  }
  integrationBranchMemoByRootDir.delete(rootDir);
}

/**
 * Resolve the base ref one proof pass should use: live settings first (free, never cached), then the
 * per-repository git-derived answer behind the file's existing 10 s proof TTL.
 */
async function resolvePassIntegrationBranch(
  rootDir: string,
  settings: IntegrationBranchSettings,
  now: () => number,
): Promise<string | null> {
  const fromSettings = normalizeRef(resolveIntegrationBranchFromSettings(settings));
  if (fromSettings) return fromSettings;

  const memo = integrationBranchMemoByRootDir.get(rootDir);
  if (memo && now() - memo.at < CHECKOUT_EMPTINESS_PROOF_TTL_MS) return await memo.promise;

  const entry: IntegrationBranchMemoEntry = { at: now(), promise: undefined as unknown as Promise<string | null> };
  // The settings rung already proved empty, so this call takes the git path; pass `settings` unchanged
  // rather than a stripped copy so the resolver's own ladder stays the single source of truth.
  entry.promise = resolveIntegrationBranch(rootDir, settings)
    .then((branch) => normalizeRef(branch))
    .catch(() => null);
  integrationBranchMemoByRootDir.set(rootDir, entry);
  return await entry.promise;
}

export async function proveDormantCheckoutEmptiness(input: {
  /**
   * Resolved lazily: a pass with no candidate never touches the store. Test fakes and narrower callers
   * therefore do not have to implement `getRootDir` for a classification that needs no git at all.
   */
  rootDir: string | (() => string);
  settings: IntegrationBranchSettings;
  candidates: readonly CheckoutEmptinessTaskShape[];
  prover?: CheckoutEmptinessProver;
  /**
   * Optional board handle forwarded to the shared prover so a refused lane leg is announced on the
   * card rather than only inside the engine log. Absent changes nothing about the verdicts.
   */
  store?: LaneLegRefusalStore;
  /**
   * Injectable clock for the per-repository base-ref memo, mirroring `CheckoutEmptinessProverOptions.now`,
   * so the TTL boundary is testable by advancing a counter instead of waiting out 10 s.
   */
  now?: () => number;
}): Promise<ReadonlyMap<string, CheckoutEmptinessProofMap>> {
  if (input.candidates.length === 0) return new Map<string, CheckoutEmptinessProofMap>();
  const rootDir = typeof input.rootDir === "function" ? input.rootDir() : input.rootDir;
  const prover = input.prover ?? checkoutEmptinessProverFor(rootDir, { store: input.store });
  const integrationBranch = await resolvePassIntegrationBranch(rootDir, input.settings, input.now ?? Date.now);
  return await prover.proveTasks(input.candidates, { integrationBranch });
}
