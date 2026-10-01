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
import { resolveIntegrationBranch, type IntegrationBranchSettings } from "../merge/integration-branch.js";
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

  constructor(options: CheckoutEmptinessProverOptions) {
    this.rootDir = options.rootDir;
    this.settings = options.settings ?? {};
    this.pinnedIntegrationBranch = normalizeRef(options.integrationBranch);
    this.ttlMs = options.ttlMs ?? CHECKOUT_EMPTINESS_PROOF_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_CACHED_PROOFS;
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_PROOF_CONCURRENCY);
    this.now = options.now ?? Date.now;
    this.execImpl = options.execImpl ?? (async (command, execOptions) => {
      const result = await execAsync(command, execOptions);
      return { stdout: result.stdout };
    });
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
        const verdict = await this.proveEntry(job.entry, options.force === true);
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

  private async proveEntry(entry: CheckoutEmptinessEntry, force: boolean): Promise<CheckoutEmptinessVerdict> {
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

    const pending = this.runProof(entry, baseRefs)
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
  private async runProof(entry: CheckoutEmptinessEntry, baseRefs: readonly string[]): Promise<CheckoutEmptinessVerdict> {
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
  if (existing) return existing;
  const created = new CheckoutEmptinessProver({ ...options, rootDir });
  proverByRootDir.set(rootDir, created);
  return created;
}

export function resetCheckoutEmptinessProversForTesting(): void {
  for (const prover of proverByRootDir.values()) prover.invalidateAll();
  proverByRootDir.clear();
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
export async function proveDormantCheckoutEmptiness(input: {
  /**
   * Resolved lazily: a pass with no candidate never touches the store. Test fakes and narrower callers
   * therefore do not have to implement `getRootDir` for a classification that needs no git at all.
   */
  rootDir: string | (() => string);
  settings: IntegrationBranchSettings;
  candidates: readonly CheckoutEmptinessTaskShape[];
  prover?: CheckoutEmptinessProver;
}): Promise<ReadonlyMap<string, CheckoutEmptinessProofMap>> {
  if (input.candidates.length === 0) return new Map<string, CheckoutEmptinessProofMap>();
  const rootDir = typeof input.rootDir === "function" ? input.rootDir() : input.rootDir;
  const prover = input.prover ?? checkoutEmptinessProverFor(rootDir);
  const integrationBranch = await resolveIntegrationBranch(rootDir, input.settings).catch(() => null);
  return await prover.proveTasks(input.candidates, { integrationBranch });
}
