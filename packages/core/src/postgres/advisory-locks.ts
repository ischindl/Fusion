import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

type AdvisoryLockTransaction = Pick<PostgresJsDatabase<Record<string, never>>, "execute">;

/*
FNXC:SchemaLockDeadline 2026-09-23-06:40:
STAS-251. Both boot locks are cluster-wide and PostgreSQL waits for them forever by
default, so one session that dies holding either one parks every later boot in a queue that
reports nothing: the caller-facing boot ceiling expired first and never said which phase or
lock cost the time. The wait is now bounded and its failure names the lock, so a stalled
holder is an actionable error instead of an indefinitely repeated stall.
*/

/** Upper bound on waiting for a boot-critical advisory lock before failing loudly. */
export const SCHEMA_MUTATION_LOCK_TIMEOUT_MS = 20_000;

const SQLITE_MIGRATION_STATE_LOCK_KEY = "fusion:sqlite-migration-state";
const SCHEMA_APPLIER_LOCK_KEY = "fusion:schema-applier";

/**
 * PostgreSQL `lock_not_available` — raised when `lock_timeout` cancels the wait. Drizzle wraps
 * the driver error, so the code has to be read from the chain, not just the outer error.
 */
function isLockTimeoutError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && typeof current === "object" && current !== null; depth += 1) {
    if ((current as { code?: string }).code === "55P03") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export class SchemaMutationLockTimeoutError extends Error {
  readonly lockKey: string;

  constructor(lockKey: string, timeoutMs: number, cause: unknown) {
    super(
      `Timed out after ${timeoutMs}ms waiting for the ${lockKey} advisory lock — another session is holding it`,
      { cause },
    );
    this.name = "SchemaMutationLockTimeoutError";
    this.lockKey = lockKey;
  }
}

async function acquireBoundedAdvisoryXactLock(
  tx: AdvisoryLockTransaction,
  lockKey: typeof SQLITE_MIGRATION_STATE_LOCK_KEY | typeof SCHEMA_APPLIER_LOCK_KEY,
  timeoutMs: number,
): Promise<void> {
  /* The bound is transaction-local so a pooled connection never carries it afterwards. */
  await tx.execute(sql`SELECT set_config('lock_timeout', ${`${timeoutMs}ms`}, true)`);
  try {
    /*
    The key is inlined rather than bound as a parameter: both values are module constants, and
    keeping the name in the statement text is what lets lock-order tests and `pg_stat_activity`
    readers see which lock a waiting session is queueing for.
    */
    await tx.execute(sql.raw(`SELECT pg_advisory_xact_lock(hashtext('${lockKey}'))`));
  } catch (error) {
    if (isLockTimeoutError(error)) {
      throw new SchemaMutationLockTimeoutError(lockKey, timeoutMs, error);
    }
    throw error;
  }
}

/**
 * Serialize schema DDL behind any active SQLite cutover transaction.
 *
 * SQLite migration takes `fusion:sqlite-migration-state` before it reads the
 * target schema. Schema application and runtime plugin DDL must take the same
 * lock first, then their narrower schema lock, so PostgreSQL never sees the
 * inverse DDL/read lock order that can deadlock concurrent project startup.
 */
export async function acquireSqliteMigrationStateLock(
  tx: AdvisoryLockTransaction,
  timeoutMs: number = SCHEMA_MUTATION_LOCK_TIMEOUT_MS,
): Promise<void> {
  await acquireBoundedAdvisoryXactLock(tx, SQLITE_MIGRATION_STATE_LOCK_KEY, timeoutMs);
}

export async function acquireSchemaMutationLocks(
  tx: AdvisoryLockTransaction,
  timeoutMs: number = SCHEMA_MUTATION_LOCK_TIMEOUT_MS,
): Promise<void> {
  await acquireSqliteMigrationStateLock(tx, timeoutMs);
  await acquireBoundedAdvisoryXactLock(tx, SCHEMA_APPLIER_LOCK_KEY, timeoutMs);
}

import postgres from "postgres";
import { looksLikePoolerUrl } from "./backend-resolver.js";

export class PlanningLifecycleLockTransportError extends Error {
  /*
  FNXC:PlanningLifecycleLockIdentity 2026-11-11-16:12 (RUFU-600 Steps 1-2):
  The canonical lock messages are a classifier contract (`planning-handoff-recovery.ts` anchors them
  with `$`), so every measurement this task needs to report — who holds the key, how long the caller
  waited, how long a holder ran past its bound, whether teardown was proven — rides these STRUCTURED
  FIELDS instead of being appended to the message text. Appending holder detail to the message would
  silently un-classify every executor retry that hits it.
  */
  readonly reason?: PlanningLifecycleLockFailureReason;
  /** Which phase refused: `acquisition` is the only phase that means contention. */
  readonly phase?: string;
  readonly budgetMs?: number;
  readonly waitedMs?: number;
  readonly heldMs?: number;
  readonly maxHoldMs?: number;
  readonly holder?: PlanningLifecycleHolder;
  /** A pid this process could not prove dead; releasing it is the reclaim pass's, never a guess. */
  readonly unresolvedPid?: number;
  /** True only when the key was VERIFIED free afterwards — never inferred from having asked. */
  readonly keyFreedProven?: boolean;

  constructor(message: string, detail: PlanningLifecycleLockFailureDetail = {}) {
    super(message);
    this.name = "PlanningLifecycleLockTransportError";
    this.reason = detail.reason;
    this.phase = detail.phase;
    this.budgetMs = detail.budgetMs;
    this.waitedMs = detail.waitedMs;
    this.heldMs = detail.heldMs;
    this.maxHoldMs = detail.maxHoldMs;
    this.holder = detail.holder;
    this.unresolvedPid = detail.unresolvedPid;
    this.keyFreedProven = detail.keyFreedProven;
  }
}

/** Why an acquisition refused. Fixed enum: contention and transport need opposite remedies. */
/** What a reclaim sweep may conclude about one server session it did not open. */
export type PlanningLifecycleTerminateOutcome = "terminated" | "refused" | "failed";

/** One abandoned acquisition whose teardown could not be proven, kept in a bounded in-process ledger. */
export type PlanningLifecycleUnprovenTeardown = { key: string; pid: number | null; at: number };

export type PlanningLifecycleLockFailureReason =
  | "contention"
  | "transport-unavailable"
  | "teardown-unproven"
  | "hold-exceeded";

/** Whether a direct (non-pooled) session endpoint is usable for advisory-key work at all. */
export type PlanningLifecycleTransportAvailability =
  | { available: true }
  | { available: false; reason: string };

export type PlanningLifecycleLockFailureDetail = {
  reason?: PlanningLifecycleLockFailureReason;
  phase?: string;
  budgetMs?: number;
  waitedMs?: number;
  heldMs?: number;
  maxHoldMs?: number;
  holder?: PlanningLifecycleHolder;
  unresolvedPid?: number;
  keyFreedProven?: boolean;
};

export const DEFAULT_PLANNING_LIFECYCLE_LOCK_TIMEOUT_MS = 5_000;

/*
FNXC:PlanningLifecycleLockOperatorLane 2026-11-11-17:35 (RUFU-600 Step 4):
An operator who presses Retry is waiting for an answer they can act on, and the automated lane's five
seconds is not enough to reach one when the transport is slow: the measured refusals that surfaced as
HTTP 500 spent the whole budget without ever getting far enough to name a holder. One named constant
governs the operator's own lane and it is deliberately wider; every automated lane (planning, dependency
release, merge queue, triage, self-healing) keeps DEFAULT_PLANNING_LIFECYCLE_LOCK_TIMEOUT_MS, so this
widens no automated behaviour. It is exported because the restart route answers a second question with
the same number — "was this a transport that could not be reached, or a key someone is holding?" — and
two budgets for one interaction drift.
*/
export const OPERATOR_PLANNING_LIFECYCLE_LOCK_TIMEOUT_MS = 20_000;

/*
FNXC:PlanningLifecycleLockDeadline 2026-11-11-16:12 (RUFU-600 Step 2):
One budget governs the WHOLE acquisition now, not each phase separately. The per-phase budgets were the
compositing bug: session setup, the backend-identity read, PostgreSQL's own `lock_timeout` and cleanup
each got their own copy of the number, so a message could read `timed out after 5000ms` while the request
had already consumed several times that. Every phase now receives the REMAINING budget, so the wall clock
cannot exceed the stated deadline by more than the bounded teardown. Refusals still quote the total the
caller stated, because the canonical message shape is a classifier contract.
 */
export class AcquisitionBudget {
  readonly startedAt = Date.now();

  constructor(readonly totalMs: number) {}

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Milliseconds left for the next phase; 0 once the one deadline is spent. */
  remainingMs(): number {
    return Math.max(0, this.totalMs - this.elapsedMs);
  }

  expired(): boolean {
    return this.remainingMs() === 0;
  }
}

type DedicatedPostgresClient = ReturnType<typeof postgres>;
export type PlanningLifecycleLockInput = {
  projectId: string;
  taskId: string;
  directSessionUrl: string | null;
  provenance: "embedded-lifecycle" | "migration-override" | "runtime-direct" | null;
  runtimeUrl?: string | null;
  migrationUrl?: string | null;
  timeoutMs?: number;
  onLockAcquisitionAttempt?: () => void;
};

/** Side-effect-free structural check shared by the lineage degrade path and lock acquisition. */
export function planningLifecycleLockTransportAvailability(input: Pick<PlanningLifecycleLockInput, "directSessionUrl" | "provenance" | "runtimeUrl" | "migrationUrl">): PlanningLifecycleTransportAvailability {
  const directUrl = input.directSessionUrl;
  if (!directUrl || !input.provenance || looksLikePoolerUrl(directUrl)) return { available: false, reason: "direct-session-unavailable" };
  let directDatabase: string;
  try { directDatabase = decodeURIComponent(new URL(directUrl).pathname.replace(/^\//, "")); } catch { return { available: false, reason: "direct-session-invalid" }; }
  if (!directDatabase) return { available: false, reason: "direct-session-database-missing" };
  const descriptorEndpoint = input.provenance === "embedded-lifecycle" || input.provenance === "runtime-direct" ? input.runtimeUrl : input.migrationUrl;
  if (!descriptorEndpoint || descriptorEndpoint !== directUrl) return { available: false, reason: "backend-descriptor-mismatch" };
  const operationalUrl = input.runtimeUrl ?? input.migrationUrl;
  if (operationalUrl) {
    try {
      const operationalDatabase = decodeURIComponent(new URL(operationalUrl).pathname.replace(/^\//, ""));
      if (!operationalDatabase || operationalDatabase !== directDatabase) return { available: false, reason: "backend-database-mismatch" };
    } catch { return { available: false, reason: "backend-endpoint-invalid" }; }
  }
  return { available: true };
}

/*
FNXC:PlanningLifecycleLockIdentity 2026-11-11-16:12 (RUFU-600 Step 1):
This is the ONLY place the planning-lifecycle advisory key is composed. Diagnosis, release, the
reclaim sweep and the acquisition path all call it, because two derivations of the same key drift
and a drifting diagnosis reports "no holder" for a key that is locked — the exact operational lie
this task removes.
*/
export const planningLifecycleLockKey = (projectId: string, taskId: string): string => `fusion:planning-lifecycle:${projectId}:${taskId}`;
export type PostgresBackendIdentity = {
  database: string;
  host: string | null;
  port: number | null;
  cluster: string | null;
  /*
  FNXC:PlanningLifecycleLockIdentity 2026-11-11-16:12 (RUFU-600 Step 1):
  The session's own pid is read with the rest of its identity because it is the only handle that can
  later answer "did MY session survive being abandoned?" — for a teardown proof and, if it did not, for
  a targeted terminate. It is never compared between endpoints.
  */
  pid: number | null;
};

async function readPostgresBackendIdentity(client: DedicatedPostgresClient): Promise<PostgresBackendIdentity[]> {
  return await client<PostgresBackendIdentity[]>`
    SELECT current_database() AS database,
           inet_server_addr()::text AS host,
           inet_server_port() AS port,
           current_setting('cluster_name', true) AS cluster,
           pg_backend_pid() AS pid
  `;
}

async function runBoundedTransportPhase<T>(
  client: DedicatedPostgresClient,
  budget: AcquisitionBudget,
  phase: string,
  timeoutMessage: string,
  failureMessage: string,
  operation: () => Promise<T>,
): Promise<T> {
  /*
  FNXC:PlanningLifecycleLockDeadline 2026-11-11-16:12 (RUFU-600 Step 2):
  The bound is the REMAINING budget, not a fresh copy of the total, and the refusal names the phase that
  hit it. `acquisition` is the only phase that means contention; every other phase is transport, and
  before the phase rode on the error the two were indistinguishable to the caller that had to choose
  between a 409 an operator can act on and a 500 they cannot.
   */
  const remainingMs = budget.remainingMs();
  if (remainingMs === 0) {
    throw new PlanningLifecycleLockTransportError(timeoutMessage, { phase, reason: phase === "acquisition" ? "contention" : "transport-unavailable", budgetMs: budget.totalMs, waitedMs: budget.elapsedMs });
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          void client.end({ timeout: 0 }).catch(() => undefined);
          reject(new PlanningLifecycleLockTransportError(timeoutMessage, { phase, reason: phase === "acquisition" ? "contention" : "transport-unavailable", budgetMs: budget.totalMs, waitedMs: budget.elapsedMs }));
        }, remainingMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof PlanningLifecycleLockTransportError) throw error;
    // Do not retain the driver error as `cause`: connection failures can carry
    // endpoint credentials, while this error is operator-visible.
    throw new PlanningLifecycleLockTransportError(failureMessage, { phase, reason: phase === "acquisition" ? "contention" : "transport-unavailable", budgetMs: budget.totalMs, waitedMs: budget.elapsedMs });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * FNXC:PlanningLifecycleLockTeardown 2026-11-11-16:12 (RUFU-600 Step 2):
 * An abandoned session whose teardown could not be PROVEN is recorded here — in memory, ids only —
 * because `@fusion/core`'s PostgreSQL layer deliberately writes no log lines, and the next owner of
 * that pid is the reclaim sweep, not a console line an operator has to already be watching. The ledger
 * is bounded and FIFO: the newest unproven teardowns are the ones a sweep can still act on.
 */
const UNPROVEN_TEARDOWN_LEDGER_CAP = 64;
const unprovenTeardownLedger: Array<{ key: string; pid: number | null; at: number }> = [];

function debugPlanningLifecycle(_detail: string, pid: number | undefined, key: string): void {
  if (!key) return;
  unprovenTeardownLedger.push({ key, pid: pid ?? null, at: Date.now() });
  if (unprovenTeardownLedger.length > UNPROVEN_TEARDOWN_LEDGER_CAP) unprovenTeardownLedger.shift();
}

/** Pids the process abandoned without proving they died — reclaim candidates, never a terminate licence. */
export function getPlanningLifecycleUnprovenTeardowns(): ReadonlyArray<PlanningLifecycleUnprovenTeardown> {
  return [...unprovenTeardownLedger];
}

export function clearPlanningLifecycleUnprovenTeardown(key: string): void {
  const index = unprovenTeardownLedger.findIndex((entry) => entry.key === key);
  if (index >= 0) unprovenTeardownLedger.splice(index, 1);
}

/** What a caller may ask of the planning-lifecycle lock beyond naming the task. */
export type PlanningLifecycleLockOptions = PlanningLifecycleLockAcquireOptions & { timeoutMs?: number };

/** Options both planning-lifecycle acquisition surfaces accept beyond the transport input. */
export type PlanningLifecycleLockAcquireOptions = {
  /** Closed-vocabulary purpose stamped onto the session; defaults to `unknown`. */
  holderLabel?: PlanningLifecycleHolderLabel;
  /**
   * Upper bound on the granted HOLD itself, not on the wait. Absent keeps today's unbounded hold, so no
   * existing lane changes behaviour; the operator Retry lane sets it so a longer budget can never become
   * an unbounded hold.
   */
  maxHoldMs?: number;
};

/*
FNXC:PlanningLifecycleLockDeadline 2026-11-11-16:12 (RUFU-600 Step 2):
Teardown gets its OWN bounded budget after the acquisition deadline. That is not a second budget smuggled
in next to the one the spec forbids: the deadline bounds how long a caller may WAIT, this bounds how long
a LEAK may survive. The old code waited for neither — it asked for teardown, never looked, and moved on,
which is what let an abandoned hold sit idle on the key for hours.
 */
export const PLANNING_LIFECYCLE_TEARDOWN_BUDGET_MS = 2_000;

/**
 * Stamp the session's purpose BEFORE the blocking wait. A session parked in `pg_advisory_lock` is the
 * holder-to-be, and an operator diagnosing a live wait has to see which lane is parked there rather than
 * an empty `application_name`. Best-effort: a role that cannot set it still gets its lock.
 */
async function stampPlanningLifecycleHolderLabel(
  client: DedicatedPostgresClient,
  budget: AcquisitionBudget,
  label: PlanningLifecycleHolderLabel,
  taskId?: string | null,
): Promise<void> {
  await runBoundedTransportPhase(
    client,
    budget,
    "holder identity",
    `Planning lifecycle lock holder identity timed out after ${budget.totalMs}ms`,
    "Planning lifecycle lock could not stamp its holder identity",
    async () => {
      await client`SELECT set_config('application_name', ${planningLifecycleApplicationName(label, taskId)}, false)`;
    },
  ).catch(() => undefined);
}

/**
 * Bound the HOLD. A granted lock whose callback outlives `maxHoldMs` ends by terminating its own session
 * — the only mechanism that releases a session-scoped advisory lock whose JS side has stopped caring
 * about it. The throw only surfaces the typed condition; the teardown in the caller's `finally` performs
 * the terminate and the proof.
 */
async function runBoundedPlanningLifecycleHold<T>(callback: () => Promise<T>, maxHoldMs: number | undefined, startedAt: number): Promise<T> {
  if (!maxHoldMs || maxHoldMs <= 0) return await callback();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      callback(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const heldMs = Math.max(1, Date.now() - startedAt);
          reject(new PlanningLifecycleLockTransportError(`Planning lifecycle lock hold exceeded after ${heldMs}ms`, {
            phase: "hold",
            reason: "hold-exceeded",
            heldMs,
            maxHoldMs,
          }));
        }, maxHoldMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/*
FNXC:PlanningLifecycleLockTeardown 2026-11-11-16:12 (RUFU-600 Step 2):
The proof asks the only two questions a refusal has to be honest about: is the key still held, and is the
session that may hold it still there. The pid is the one this session learned about itself through
`pg_backend_pid()`; a NULL pid means no server session identity was ever established, so only the key half
is answerable. Written as a tagged template so the key and pid are bound parameters, never interpolated.
The `pg_database` subselect rather than `current_database()::oid` is the measured cast rule documented on
`queryPlanningLifecycleHoldersByKey`.
 */
export type PlanningLifecycleTeardownProof = { keyStillHeld: boolean; pidPresent: boolean };

async function provePlanningLifecycleTeardown(
  transport: Omit<PlanningLifecycleLockInput, "taskId">,
  key: string,
  pid: number | null,
  budgetMs: number,
): Promise<PlanningLifecycleTeardownProof | null> {
  const availability = planningLifecycleLockTransportAvailability(transport);
  if (!availability.available) return null;
  const client = openReadOnlyPlanningSession(transport.directSessionUrl as string, budgetMs);
  try {
    const rows = await withQueryBudget(
      client<Array<{ key_still_held: unknown; pid_present: unknown }>>`
        SELECT
          EXISTS (
            SELECT 1 FROM pg_locks l
             WHERE l.locktype = 'advisory'
               AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
               AND l.granted
               AND l.classid::oid::bigint = ((hashtext(${key})::bigint >> 32) & 4294967295)
               AND l.objid::oid::bigint   =  (hashtext(${key})::bigint & 4294967295)
          ) AS key_still_held,
          EXISTS (
            SELECT 1 FROM pg_stat_activity a WHERE a.pid = ${pid}::int
          ) AS pid_present`,
      budgetMs,
    );
    const row = rows?.[0];
    if (!row) return null;
    return { keyStillHeld: row.key_still_held === true, pidPresent: row.pid_present === true };
  } catch {
    return null;
  } finally {
    await client.end({ timeout: 1 }).catch(() => undefined);
  }
}

/**
 * End the dedicated session and PROVE what it left behind.
 *
 * Order matters. Unregister first: this session is ours and is being destroyed, so the reclaim veto must
 * not block terminating it. Then unlock every key a grant was ever DISPATCHED for — the old `acquired`
 * guard skipped exactly the grant that lands while the caller is already abandoning, which is how a key
 * stays locked with nobody having observed the grant. Then await the close, then verify from a separate
 * session and terminate our own pid if it is somehow still standing.
 */
async function teardownPlanningLifecycleSession(args: {
  transport: Omit<PlanningLifecycleLockInput, "taskId">;
  client: DedicatedPostgresClient;
  dispatchedKeys: string[];
  pid: number | null;
}): Promise<PlanningLifecycleTeardownProof & { unresolvedPid?: number }> {
  const { transport, client, dispatchedKeys, pid } = args;
  unregisterPlanningLifecycleSession(pid);
  for (const unlockKey of [...dispatchedKeys].reverse()) {
    await Promise.race([
      client`SELECT pg_advisory_unlock(hashtext(${unlockKey}))`.then(() => undefined).catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, PLANNING_LIFECYCLE_TEARDOWN_BUDGET_MS / 4))),
    ]);
  }
  await Promise.race([
    client.end({ timeout: 1 }).then(() => undefined).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, PLANNING_LIFECYCLE_TEARDOWN_BUDGET_MS / 2))),
  ]);
  const key = dispatchedKeys[0];
  if (!key) return { keyStillHeld: false, pidPresent: false };
  let proof = await provePlanningLifecycleTeardown(transport, key, pid, PLANNING_LIFECYCLE_TEARDOWN_BUDGET_MS);
  if (proof?.keyStillHeld && pid !== null && proof.pidPresent) {
    await terminatePlanningLifecycleSession(transport, pid);
    proof = await provePlanningLifecycleTeardown(transport, key, pid, PLANNING_LIFECYCLE_TEARDOWN_BUDGET_MS);
  }
  if (!proof) {
    /* Unverifiable is reported, never guessed at: an unprovable pid is the reclaim pass's input. */
    return { keyStillHeld: true, pidPresent: pid !== null, ...(pid !== null ? { unresolvedPid: pid } : {}) };
  }
  return { ...proof, ...(proof.pidPresent && pid !== null ? { unresolvedPid: pid } : {}) };
}

/**
 * Attach holder and wait measurement to a refusal without moving its message. Contention is the only
 * refusal an operator can act on by waiting, so it is the only one that gets a name.
 */
/**
 * Attach holder and wait measurement to a refusal without moving its message.
 *
 * FNXC:PlanningLifecycleLockIdentity 2026-11-11-16:12 (RUFU-600 Step 1): ONLY a lock refusal is touched.
 * Whatever the locked callback throws propagates untouched — the existing contract that
 * `planning-lifecycle-advisory-lock.pg.test.ts` pins (`callback failed` must survive a grant), and a
 * nested planning-lock call inside a callback must not be re-labelled by its outer holder. Contention is
 * the only refusal an operator can act on by waiting, so it is the only one that gets a name.
 */
async function withPlanningLifecycleHolderDetail(
  error: unknown,
  ctx: { transport: Omit<PlanningLifecycleLockInput, "taskId">; projectId: string; taskId: string; budget: AcquisitionBudget },
): Promise<unknown> {
  if (!(error instanceof PlanningLifecycleLockTransportError)) return error;
  if (error.reason !== "contention" || error.holder) return error;
  const diagnosis = await diagnosePlanningLifecycleAdvisoryKey({
    ...ctx.transport,
    taskId: ctx.taskId,
    timeoutMs: PLANNING_LIFECYCLE_TEARDOWN_BUDGET_MS,
  });
  const enriched = new PlanningLifecycleLockTransportError(error.message, {
    reason: error.reason,
    phase: error.phase,
    budgetMs: error.budgetMs ?? ctx.budget.totalMs,
    waitedMs: error.waitedMs ?? ctx.budget.elapsedMs,
    holder: diagnosis.reason === "held" ? diagnosis.holder ?? undefined : undefined,
  });
  return enriched;
}

/**
 * FNXC:PlanningDependencyReseed 2026-08-04-00:43:
 * Planning handoff and dependency re-seed cross processes, so their outer lock
 * is a dedicated PostgreSQL session rather than the TaskStore's local mutex.
 * Never use the runtime pool: a transaction pooler can change sessions between
 * lock and unlock and silently defeat session advisory locking.
 *
 * FNXC:PlanningLifecycleLockDeadline 2026-11-11-16:12 (RUFU-600 Steps 1-2):
 * The surface gained `holderLabel` and `maxHoldMs`. Callers that pass a bare transport input still
 * typecheck — both additions are optional — but the lanes that matter now name themselves, and every
 * phase draws from ONE deadline instead of each getting a fresh copy of it.
 */
export async function withPlanningLifecycleAdvisoryLock<T>(
  input: PlanningLifecycleLockInput & PlanningLifecycleLockAcquireOptions,
  callback: () => Promise<T>,
): Promise<T> {
  const availability = planningLifecycleLockTransportAvailability(input);
  if (!availability.available) {
    throw new PlanningLifecycleLockTransportError(`Planning lifecycle lock transport unavailable: ${availability.reason}`, {
      phase: "transport",
      reason: "transport-unavailable",
    });
  }
  const directUrl = input.directSessionUrl!;
  const directDatabase = decodeURIComponent(new URL(directUrl).pathname.replace(/^\//, ""));
  const operationalUrl = input.runtimeUrl ?? input.migrationUrl;
  const budget = new AcquisitionBudget(Math.max(1, input.timeoutMs ?? DEFAULT_PLANNING_LIFECYCLE_LOCK_TIMEOUT_MS));

  const client = postgres(directUrl, {
    max: 1,
    connect_timeout: Math.max(1, Math.ceil(budget.remainingMs() / 1_000)),
    prepare: false,
    onnotice: () => {},
    debug: input.onLockAcquisitionAttempt
      ? (_connection, query) => {
          if (query.includes("pg_advisory_lock(")) input.onLockAcquisitionAttempt?.();
        }
      : undefined,
  });
  const key = planningLifecycleLockKey(input.projectId, input.taskId);
  /*
  FNXC:PlanningLifecycleLockTeardown 2026-11-11-16:12 (RUFU-600 Step 2):
  `dispatched` records a grant that was SENT, not one that was observed. Teardown unlocks everything
  dispatched, because a grant whose reply was never read is precisely the case the old `acquired` flag
  left locked forever.
   */
  const dispatched: string[] = [];
  let selfPid: number | null = null;
  try {
    /*
    FNXC:PlanningDependencyReseed 2026-08-04-00:54:
    URL shape is not proof of the connected target. Verify the session-selected
    database before locking so an accidental migration endpoint cannot serialize
    one database while task writes target another.
    */
    const identity = await runBoundedTransportPhase(
      client,
      budget,
      "session setup",
      `Planning lifecycle lock session setup timed out after ${budget.totalMs}ms`,
      "Planning lifecycle lock could not establish its dedicated session",
      async () => {
        const rows = await readPostgresBackendIdentity(client);
        await client`SELECT set_config('lock_timeout', ${`${Math.max(1, budget.remainingMs())}ms`}, false)`;
        return rows;
      },
    );
    if (identity[0]?.database !== directDatabase) {
      throw new PlanningLifecycleLockTransportError("Planning lifecycle lock session selected an unexpected database", {
        phase: "session setup",
        reason: "transport-unavailable",
        budgetMs: budget.totalMs,
        waitedMs: budget.elapsedMs,
      });
    }
    const identityPid = identity[0]?.pid;
    selfPid = typeof identityPid === "number" && Number.isFinite(identityPid) && identityPid > 0 ? identityPid : null;

    /*
    FNXC:PlanningDependencyReseed 2026-08-04-01:04:
    A database name identifies neither a PostgreSQL server nor an advisory-lock
    namespace. Compare the resolved operational connection's server identity
    with the dedicated direct session so a migration URL aimed at another
    cluster with the same database cannot serialize the wrong task lifecycle.
    */
    if (operationalUrl && operationalUrl !== directUrl) {
      const operationalClient = postgres(operationalUrl, {
        max: 1,
        connect_timeout: Math.max(1, Math.ceil(budget.remainingMs() / 1_000)),
        prepare: false,
        onnotice: () => {},
      });
      try {
        const operationalIdentity = await runBoundedTransportPhase(
          operationalClient,
          budget,
          "backend identity",
          `Planning lifecycle lock backend identity check timed out after ${budget.totalMs}ms`,
          "Planning lifecycle lock could not verify the resolved backend server identity",
          () => readPostgresBackendIdentity(operationalClient),
        );
        const expected = operationalIdentity[0];
        const actual = identity[0];
        if (!expected || !actual
          || expected.database !== actual.database
          || expected.host !== actual.host
          || expected.port !== actual.port
          || (expected.cluster && actual.cluster && expected.cluster !== actual.cluster)) {
          throw new PlanningLifecycleLockTransportError("Planning lifecycle lock endpoint targets a different PostgreSQL server than the resolved backend", {
            phase: "backend identity",
            reason: "transport-unavailable",
            budgetMs: budget.totalMs,
            waitedMs: budget.elapsedMs,
          });
        }
      } catch (error) {
        if (error instanceof PlanningLifecycleLockTransportError) throw error;
        throw new PlanningLifecycleLockTransportError("Planning lifecycle lock could not verify the resolved backend server identity", {
          phase: "backend identity",
          reason: "transport-unavailable",
          budgetMs: budget.totalMs,
          waitedMs: budget.elapsedMs,
        });
      } finally {
        await operationalClient.end({ timeout: 5 }).catch(() => undefined);
      }
    }

    await stampPlanningLifecycleHolderLabel(client, budget, input.holderLabel ?? "unknown", input.taskId);

    /*
    FNXC:PlanningLifecycleLockDeadline 2026-11-11-16:12 (RUFU-600 Step 2):
    PostgreSQL's own wait bound is re-stamped from the SAME remaining budget the JS race uses, so the
    server can never wait longer than the caller was promised. HEAD set it once at session setup with the
    full budget, which let the identity reads spend time the grant wait then spent again.
     */
    dispatched.push(key);
    await runBoundedTransportPhase(
      client,
      budget,
      "acquisition",
      `Planning lifecycle lock acquisition timed out after ${budget.totalMs}ms`,
      "Planning lifecycle lock acquisition failed",
      async () => {
        await client`SELECT set_config('lock_timeout', ${`${Math.max(1, budget.remainingMs())}ms`}, false)`;
        await client`SELECT pg_advisory_lock(hashtext(${key}))`;
      },
    );
    if (selfPid !== null) registerPlanningLifecycleSession(selfPid, key, input.holderLabel ?? "unknown");
    return await runBoundedPlanningLifecycleHold(callback, input.maxHoldMs, budget.startedAt);
  } catch (error) {
    throw await withPlanningLifecycleHolderDetail(error, { transport: input, projectId: input.projectId, taskId: input.taskId, budget });
  } finally {
    const proof = await teardownPlanningLifecycleSession({ transport: input, client, dispatchedKeys: dispatched, pid: selfPid });
    if (proof.unresolvedPid !== undefined) {
      /* Reported for the reclaim pass, never acted on from here: an unprovable pid is not a licence to
         terminate whatever looks stale from the board. */
      debugPlanningLifecycle(`planning lifecycle lock teardown unproven: pid=${proof.unresolvedPid} key=${dispatched[0] ?? "none"}`, proof.unresolvedPid, dispatched[0] ?? "");
    }
  }
}

/**
 * FNXC:SpecLockLineageInvalidation 2026-08-10-14:33:
 * Parent removal can affect many children, but no child may be cleared outside its planning lock.
 * Advisory locks are session-scoped, so this acquires every sorted task key on one dedicated session
 * instead of trading correctness for a fan-out cap or opening one connection per child.
 *
 * FNXC:PlanningLifecycleLockDeadline 2026-11-11-16:12 (RUFU-600 Step 2):
 * Every key now draws from the SAME end-to-end deadline, the session carries the SAME single holder
 * label, and teardown proves and unlocks every dispatched grant exactly as the single-key surface does.
 * The two surfaces share the phase helper, the stamp, the hold bound, and the teardown proof so the
 * dependency/lineage/merge-queue lanes cannot drift away from the operator Retry lane that got fixed.
 */
export async function withPlanningLifecycleAdvisoryLocks<T>(
  input: Omit<PlanningLifecycleLockInput, "taskId"> & { taskIds: readonly string[] } & PlanningLifecycleLockAcquireOptions,
  callback: () => Promise<T>,
): Promise<T> {
  const taskIds = [...new Set(input.taskIds)].sort();
  if (taskIds.length === 0) return callback();
  const availability = planningLifecycleLockTransportAvailability(input);
  if (!availability.available) {
    throw new PlanningLifecycleLockTransportError(`Planning lifecycle lock transport unavailable: ${availability.reason}`, {
      phase: "transport",
      reason: "transport-unavailable",
    });
  }
  const directUrl = input.directSessionUrl!;
  const budget = new AcquisitionBudget(Math.max(1, input.timeoutMs ?? DEFAULT_PLANNING_LIFECYCLE_LOCK_TIMEOUT_MS));
  const directDatabase = decodeURIComponent(new URL(directUrl).pathname.replace(/^\//, ""));
  const operationalUrl = input.runtimeUrl ?? input.migrationUrl;
  const client = postgres(directUrl, {
    max: 1, connect_timeout: Math.max(1, Math.ceil(budget.remainingMs() / 1_000)), prepare: false, onnotice: () => {},
    debug: input.onLockAcquisitionAttempt ? (_connection, query) => { if (query.includes("pg_advisory_lock(")) input.onLockAcquisitionAttempt?.(); } : undefined,
  });
  const keys = taskIds.map((taskId) => planningLifecycleLockKey(input.projectId, taskId));
  const dispatched: string[] = [];
  let selfPid: number | null = null;
  try {
    const identity = await runBoundedTransportPhase(client, budget, "session setup", `Planning lifecycle lock session setup timed out after ${budget.totalMs}ms`, "Planning lifecycle lock could not establish its dedicated session", async () => {
      const rows = await readPostgresBackendIdentity(client);
      await client`SELECT set_config('lock_timeout', ${`${Math.max(1, budget.remainingMs())}ms`}, false)`;
      return rows;
    });
    if (identity[0]?.database !== directDatabase) {
      throw new PlanningLifecycleLockTransportError("Planning lifecycle lock session selected an unexpected database", {
        phase: "session setup",
        reason: "transport-unavailable",
        budgetMs: budget.totalMs,
        waitedMs: budget.elapsedMs,
      });
    }
    const identityPid = identity[0]?.pid;
    selfPid = typeof identityPid === "number" && Number.isFinite(identityPid) && identityPid > 0 ? identityPid : null;

    /*
    FNXC:SpecLockLineageInvalidation 2026-08-10-14:47:
    The multi-key session must prove the same resolved backend identity as the single-key lock.
    Matching advisory key strings on a different PostgreSQL server would serialize nothing.
    */
    if (operationalUrl && operationalUrl !== directUrl) {
      const operationalClient = postgres(operationalUrl, {
        max: 1,
        connect_timeout: Math.max(1, Math.ceil(budget.remainingMs() / 1_000)),
        prepare: false,
        onnotice: () => {},
      });
      try {
        const operationalIdentity = await runBoundedTransportPhase(
          operationalClient,
          budget,
          "backend identity",
          `Planning lifecycle lock backend identity check timed out after ${budget.totalMs}ms`,
          "Planning lifecycle lock could not verify the resolved backend server identity",
          () => readPostgresBackendIdentity(operationalClient),
        );
        const expected = operationalIdentity[0];
        const actual = identity[0];
        if (!expected || !actual
          || expected.database !== actual.database
          || expected.host !== actual.host
          || expected.port !== actual.port
          || (expected.cluster && actual.cluster && expected.cluster !== actual.cluster)) {
          throw new PlanningLifecycleLockTransportError("Planning lifecycle lock endpoint targets a different PostgreSQL server than the resolved backend", {
            phase: "backend identity",
            reason: "transport-unavailable",
            budgetMs: budget.totalMs,
            waitedMs: budget.elapsedMs,
          });
        }
      } catch (error) {
        if (error instanceof PlanningLifecycleLockTransportError) throw error;
        throw new PlanningLifecycleLockTransportError("Planning lifecycle lock could not verify the resolved backend server identity", {
          phase: "backend identity",
          reason: "transport-unavailable",
          budgetMs: budget.totalMs,
          waitedMs: budget.elapsedMs,
        });
      } finally {
        await operationalClient.end({ timeout: 5 }).catch(() => undefined);
      }
    }
    await stampPlanningLifecycleHolderLabel(client, budget, input.holderLabel ?? "unknown", input.taskIds[0] ?? null);
    for (const key of keys) {
      dispatched.push(key);
      await runBoundedTransportPhase(client, budget, "acquisition", `Planning lifecycle lock acquisition timed out after ${budget.totalMs}ms`, "Planning lifecycle lock acquisition failed", async () => {
        await client`SELECT set_config('lock_timeout', ${`${Math.max(1, budget.remainingMs())}ms`}, false)`;
        await client`SELECT pg_advisory_lock(hashtext(${key}))`;
      });
    }
    if (selfPid !== null) registerPlanningLifecycleSession(selfPid, keys[0], input.holderLabel ?? "unknown");
    return await runBoundedPlanningLifecycleHold(callback, input.maxHoldMs, budget.startedAt);
  } catch (error) {
    throw await withPlanningLifecycleHolderDetail(error, { transport: input, projectId: input.projectId, taskId: taskIds[0], budget });
  } finally {
    const proof = await teardownPlanningLifecycleSession({ transport: input, client, dispatchedKeys: dispatched, pid: selfPid });
    if (proof.unresolvedPid !== undefined) debugPlanningLifecycle(`planning lifecycle lock teardown unproven: pid=${proof.unresolvedPid} key=${dispatched[0] ?? "none"}`, proof.unresolvedPid, dispatched[0] ?? "");
  }
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * FNXC:PlanningLifecycleLockIdentity 2026-11-11-16:12 (RUFU-600 Step 1):
 * A refused Retry used to be an HTTP 500 wearing a generic sentence because nothing in the dedicated
 * session ever declared who it was. The session now stamps a bounded, secret-free `application_name`
 * drawn from a CLOSED vocabulary, so a holder read out of `pg_stat_activity` is attributable to a
 * lane instead of to "something". The label travels as structured fields on the error and the
 * diagnosis, never inside the five canonical lock messages: the classifier in
 * `packages/engine/src/planning-handoff-recovery.ts` anchors those messages with `$`, so appended
 * detail would silently un-classify every executor retry — a message the classifier anchors is a
 * contract, not a string.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Closed vocabulary of planning-lifecycle holder purposes. Add a member only together with a caller. */
export const PLANNING_LIFECYCLE_HOLDER_LABELS = [
  "retry",
  "planning",
  "dependency",
  "merge-queue",
  "lineage",
  "repo-scope",
  "pr-closeout",
  "sweep",
  "unknown",
] as const;

export type PlanningLifecycleHolderLabel = (typeof PLANNING_LIFECYCLE_HOLDER_LABELS)[number];

/** Marks a PostgreSQL session as one of ours. Kept short — `application_name` is a bounded field. */
export const PLANNING_LIFECYCLE_APPLICATION_NAME_PREFIX = "fusion-planning:";

/** Cap on the stamped session name: it is a diagnostic, and a diagnostic must not grow without bound. */
const PLANNING_LIFECYCLE_APPLICATION_NAME_MAX = 64;

const HOLDER_LABEL_SET: ReadonlySet<string> = new Set<string>(PLANNING_LIFECYCLE_HOLDER_LABELS);

/** Session identity stamped into `application_name`. */
export function planningLifecycleApplicationName(
  label: PlanningLifecycleHolderLabel,
  taskId?: string | null,
): string {
  const labelled = `${PLANNING_LIFECYCLE_APPLICATION_NAME_PREFIX}${label}`;
  if (!taskId) return labelled;
  /*
  FNXC:PlanningLifecycleLockIdentity 2026-11-11-17:35 (RUFU-600 Step 3):
  The task id rides in the same GUC because `pg_locks` cannot give it back: the advisory key is
  `hashtext("fusion:planning-lifecycle:<project>:<task>")`, so a holder row reveals a pid and an age but
  never the card whose key it holds — and a reclaim pass that cannot name the card cannot check whether
  that card is executing before it ends a session. Anything outside a conservative id alphabet is replaced
  and the whole name is capped, because the stamp is a diagnostic string that must never grow unbounded.
   */
  const budget = PLANNING_LIFECYCLE_APPLICATION_NAME_MAX - labelled.length - 1;
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, Math.max(0, budget));
  return safe.length > 0 ? `${labelled}:${safe}` : labelled;
}

/**
 * The inverse of `planningLifecycleApplicationName`. An unknown label or an absent task segment is
 * reported as such rather than guessed: a reclaim pass that invents a card would act on the wrong one.
 */
export function parsePlanningLifecycleApplicationName(raw: string | null | undefined): {
  label: PlanningLifecycleHolderLabel;
  taskId: string | null;
} {
  if (typeof raw !== "string" || raw.length === 0) return { label: "unknown", taskId: null };
  const body = raw.startsWith(PLANNING_LIFECYCLE_APPLICATION_NAME_PREFIX)
    ? raw.slice(PLANNING_LIFECYCLE_APPLICATION_NAME_PREFIX.length)
    : raw;
  const separator = body.indexOf(":");
  const labelPart = separator === -1 ? body : body.slice(0, separator);
  const taskPart = separator === -1 ? "" : body.slice(separator + 1);
  return {
    label: HOLDER_LABEL_SET.has(labelPart) ? (labelPart as PlanningLifecycleHolderLabel) : "unknown",
    taskId: /^[A-Za-z0-9._-]+$/.test(taskPart) ? taskPart : null,
  };
}

/**
 * Pure label derivation from whatever `pg_stat_activity.application_name` carries. Anything outside
 * the closed vocabulary — including a foreign session holding a colliding advisory key — reads as
 * `unknown`, because naming a lane this product cannot prove would send the operator to a lane that
 * never touched the card.
 */
export function resolvePlanningLifecycleHolderLabel(raw: string | null | undefined): PlanningLifecycleHolderLabel {
  if (typeof raw !== "string" || raw.length === 0) return "unknown";
  const candidate = raw.startsWith(PLANNING_LIFECYCLE_APPLICATION_NAME_PREFIX)
    ? raw.slice(PLANNING_LIFECYCLE_APPLICATION_NAME_PREFIX.length)
    : raw;
  return HOLDER_LABEL_SET.has(candidate) ? (candidate as PlanningLifecycleHolderLabel) : "unknown";
}

/** `pg_stat_activity.state` narrowed to what an operator can act on; anything else is `unknown`. */
export type PlanningLifecycleHolderState = "idle" | "active" | "idle-in-transaction" | "unknown";

export type PlanningLifecycleHolder = {
  label: PlanningLifecycleHolderLabel;
  pid: number;
  state: PlanningLifecycleHolderState;
  /** Milliseconds the holder session has sat in its current state, measured by PostgreSQL. */
  ageMs: number;
  /**
   * The card the holder named for itself at stamp time, or NULL for a session that stamped only a label —
   * which includes every session opened before RUFU-600 shipped. NULL is never guessed at.
   */
  taskId: string | null;
  /**
   * True only when the session's own `application_name` carries `PLANNING_LIFECYCLE_APPLICATION_NAME_PREFIX`,
   * i.e. this product opened it. A row on a colliding advisory key written by any other client — `psql`, a
   * migration script, another service — is `false`, and ending a session this product did not create is not
   * this product's call to make, whatever the operator confirms.
   */
  ours: boolean;
};

/** Why a diagnosis answers the way it does. Fixed enum: each value is a distinct operator answer. */
export type PlanningLifecycleDiagnosisReason =
  | "held"
  | "not-held"
  /** A holder exists but its identity could not be read (e.g. statistics permission denied). */
  | "identity-not-derivable"
  /** No advisory domain exists to inspect (backend OFF / in-process fallback). */
  | "transport-unavailable"
  /** The holder query itself failed; the key state is unknown, which is NOT the same as free. */
  | "holder-query-failed";

export type PlanningLifecycleKeyDiagnosis = {
  key: string;
  heldByThisProcess: boolean;
  holder: PlanningLifecycleHolder | null;
  reason: PlanningLifecycleDiagnosisReason;
};

/**
 * FNXC:PlanningLifecycleLockIdentity 2026-11-11-16:12 (RUFU-600 Step 1):
 * The advisory-key match predicate, proven against a lock the holder itself took (RUFU-600 Step 0
 * measurement): PostgreSQL splits the int8 `hashtext(key)` into `objid` = the low 32 bits and `classid`
 * = the high 32 bits, both stored UNSIGNED. `classid`/`objid` are `regclass`, so both sides widen
 * through `oid` to bigint — comparing them as regclass would try to resolve 4294967295 as a class name.
 * Written as tagged templates so the key is always a bound parameter, never interpolated SQL. Pinned
 * behaviourally by `planning-lifecycle-lock-leak.pg.test.ts`; do not "simplify" the cast chain.
 *
 * Two casts here are measured fixes, not style (both failed loudly against a real server):
 *   - `l.classid`/`l.objid` are `regclass`, so each side widens through `oid` to `bigint`. Compared as
 *     regclass, PostgreSQL tries to resolve 4294967295 as a class name instead.
 *   - `l.database` may NOT be compared with `current_database()::oid`: PostgreSQL refuses the text→oid
 *     cast (`invalid input syntax for type oid: "postgres"`), so the database oid comes from the
 *     `pg_database` catalog row instead.
 */
function queryPlanningLifecycleHoldersByKey(client: DedicatedPostgresClient, key: string) {
  return client<HolderRow[]>`
    SELECT l.pid AS pid,
           a.application_name AS application_name,
           a.state AS state,
           (extract(epoch from (now() - a.state_change)) * 1000)::float8 AS age_ms
      FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory'
       AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND l.granted
       AND l.classid::oid::bigint = ((hashtext(${key})::bigint >> 32) & 4294967295)
       AND l.objid::oid::bigint   =  (hashtext(${key})::bigint & 4294967295)`;
}

/** The same projection for every planning-lifecycle holder in this database, whatever its key. */
function queryPlanningLifecycleAllHolders(client: DedicatedPostgresClient, applicationNamePrefix: string) {
  return client<HolderRow[]>`
    SELECT l.pid AS pid,
           a.application_name AS application_name,
           a.state AS state,
           (extract(epoch from (now() - a.state_change)) * 1000)::float8 AS age_ms
      FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory'
       AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND l.granted
       AND a.application_name LIKE ${`${applicationNamePrefix}%`}`;
}

type HolderRow = { pid: unknown; application_name: unknown; state: unknown; age_ms: unknown };

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapHolderState(raw: unknown): PlanningLifecycleHolderState {
  if (raw === "idle") return "idle";
  if (raw === "active") return "active";
  if (raw === "idle in transaction") return "idle-in-transaction";
  return "unknown";
}

function mapHolderRow(row: HolderRow): PlanningLifecycleHolder | null {
  const pid = toFiniteNumber(row.pid);
  if (pid === null || pid <= 0) return null;
  const ageMs = toFiniteNumber(row.age_ms);
  const rawApplicationName = typeof row.application_name === "string" ? row.application_name : null;
  const identity = parsePlanningLifecycleApplicationName(rawApplicationName);
  return {
    label: identity.label,
    pid,
    state: mapHolderState(row.state),
    ageMs: ageMs === null || ageMs < 0 ? 0 : Math.round(ageMs),
    taskId: identity.taskId,
    ours: rawApplicationName !== null && rawApplicationName.startsWith(PLANNING_LIFECYCLE_APPLICATION_NAME_PREFIX),
  };
}

/*
 * FNXC:PlanningLifecycleLockIdentity 2026-11-11-16:12 (RUFU-600 Step 1):
 * This registry is what makes "prove death, never elapse time" answerable at all: a session this
 * process is actively holding is live by construction no matter how long its `state_change` stamp
 * has aged, because a planning callback doing slow work leaves its session idle while the JS side
 * runs. A pid absent from the registry is the only shape a reclaim may ever consider.
 */
const livePlanningLifecycleSessions = new Map<number, { key: string; label: PlanningLifecycleHolderLabel; startedAt: number }>();

/** Called by the acquisition path once the session's own pid and its grant are both known. */
export function registerPlanningLifecycleSession(pid: number, key: string, label: PlanningLifecycleHolderLabel): void {
  if (!Number.isFinite(pid) || pid <= 0) return;
  livePlanningLifecycleSessions.set(pid, { key, label, startedAt: Date.now() });
}

export function unregisterPlanningLifecycleSession(pid: number | null | undefined): void {
  if (pid === null || pid === undefined || !Number.isFinite(pid)) return;
  livePlanningLifecycleSessions.delete(pid);
}

/** True while this process holds the session — a reclaim candidate must never be live here. */
export function isPlanningLifecycleSessionLive(pid: number | null | undefined): boolean {
  return pid !== null && pid !== undefined && livePlanningLifecycleSessions.has(pid);
}

/** Pids this process currently holds planning-lifecycle sessions for (diagnostics, reclaim veto). */
export function getPlanningLifecycleLiveSessionPids(): number[] {
  return [...livePlanningLifecycleSessions.keys()];
}

/** Read-only inspection input; the same provenance rules the acquisition enforces. */
export type PlanningLifecycleSessionInput = Omit<PlanningLifecycleLockInput, "taskId"> & { timeoutMs?: number };

function openReadOnlyPlanningSession(url: string, budgetMs: number): DedicatedPostgresClient {
  return postgres(url, {
    max: 1,
    connect_timeout: Math.max(1, Math.ceil(budgetMs / 1_000)),
    prepare: false,
    onnotice: () => {},
  });
}

function withQueryBudget<T>(query: Promise<T>, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("planning lifecycle holder query budget expired")), budgetMs);
  });
  return Promise.race([query, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Read-only: who holds this task's planning-lifecycle key right now.
 *
 * It answers `holder-query-failed` rather than `not-held` when it cannot see, because "I could not
 * find a holder" and "no holder exists" are different operator answers, and collapsing them is how a
 * locked key gets reported as free.
 */
export async function diagnosePlanningLifecycleAdvisoryKey(
  input: PlanningLifecycleSessionInput & { taskId: string },
): Promise<PlanningLifecycleKeyDiagnosis> {
  const key = planningLifecycleLockKey(input.projectId, input.taskId);
  const availability = planningLifecycleLockTransportAvailability(input);
  if (!availability.available) return { key, heldByThisProcess: false, holder: null, reason: "transport-unavailable" };
  const budgetMs = Math.max(1, input.timeoutMs ?? DEFAULT_PLANNING_LIFECYCLE_LOCK_TIMEOUT_MS);
  const client = openReadOnlyPlanningSession(input.directSessionUrl as string, budgetMs);
  try {
    const rows = await withQueryBudget(queryPlanningLifecycleHoldersByKey(client, key), budgetMs);
    return summarizeHolderRows(key, rows ?? []);
  } catch {
    return { key, heldByThisProcess: false, holder: null, reason: "holder-query-failed" };
  } finally {
    await client.end({ timeout: 1 }).catch(() => undefined);
  }
}

/** Shared shaping so diagnosis and reclaim can never disagree about what a row means. */
export function summarizeHolderRows(key: string, rows: readonly HolderRow[]): PlanningLifecycleKeyDiagnosis {
  const mapped = rows.map(mapHolderRow).filter((h): h is PlanningLifecycleHolder => h !== null);
  if (mapped.length === 0) {
    /* Rows that carry no usable pid are holders this product cannot name; say so instead of "free". */
    return { key, heldByThisProcess: false, holder: null, reason: rows.length > 0 ? "identity-not-derivable" : "not-held" };
  }
  const oldest = mapped.reduce((a, b) => (b.ageMs > a.ageMs ? b : a));
  return { key, heldByThisProcess: mapped.some((h) => isPlanningLifecycleSessionLive(h.pid)), holder: oldest, reason: "held" };
}

/** Every planning-lifecycle holder session in this database, for the bounded reclaim sweep. */
/** A holder population read, with the read's own health: an unreadable catalog is never an empty one. */
export type PlanningLifecycleHolderPopulation = {
  sessions: PlanningLifecycleHolder[];
  reason: "ok" | PlanningLifecycleDiagnosisReason;
};

export async function listPlanningLifecycleHolderSessions(
  input: PlanningLifecycleSessionInput,
): Promise<PlanningLifecycleHolderPopulation> {
  const availability = planningLifecycleLockTransportAvailability(input);
  if (!availability.available) return { sessions: [], reason: "transport-unavailable" };
  const budgetMs = Math.max(1, input.timeoutMs ?? DEFAULT_PLANNING_LIFECYCLE_LOCK_TIMEOUT_MS);
  const client = openReadOnlyPlanningSession(input.directSessionUrl as string, budgetMs);
  try {
    const rows = await withQueryBudget(queryPlanningLifecycleAllHolders(client, PLANNING_LIFECYCLE_APPLICATION_NAME_PREFIX), budgetMs);
    return { sessions: (rows ?? []).map(mapHolderRow).filter((h): h is PlanningLifecycleHolder => h !== null), reason: "ok" };
  } catch {
    return { sessions: [], reason: "holder-query-failed" };
  } finally {
    await client.end({ timeout: 1 }).catch(() => undefined);
  }
}

/** Ask PostgreSQL to end a provably-orphaned session. A session this process holds is always refused. */
/*
FNXC:PlanningLifecycleLockRelease 2026-11-11-17:35 (RUFU-600 Steps 3-4):
The release an operator reaches for when a card is stuck behind a key nobody can see. It is honest about
what PostgreSQL actually permits, because the intuitive version of this surface is impossible:
  - `pg_advisory_unlock` / `pg_advisory_unlock_all` release keys the CALLING SESSION holds. A key held by
    another session cannot be unchecked from here, whatever the caller confirms, so this surface never
    pretends to try;
  - `pg_cancel_backend` stops a query, and an abandoned acquisition holds its key while its session sits
    idle — cancel has nothing to cancel and the key stays held;
  - `pg_terminate_backend` is therefore the ONLY lever over a foreign holder, and it is destructive: it
    ends a session that might be doing real work. So the veto list is checked first and any single one of
    them refuses — the session is one this process registered as live, its `pg_stat_activity` state is
    `active` (a statement is running in it), it is not a session this product opened, it is younger than
    the code-owned age floor, the card behind the key is live, or the diagnosis could not identify it at
    all. The full conjunction and why each leg is necessary is the P0 note below.
The answer is re-derived from the database afterwards: `released: true` means the key is measured free,
never that a terminate call was issued. An unverified release is the same lie this task removed from the
acquisition path.
*/
/** Everything an operator surface needs to answer "is this task's planning key held, and by whom". */
export type PlanningLifecycleLockDiagnosis = PlanningLifecycleKeyDiagnosis & {
  transport: PlanningLifecycleTransportAvailability;
  /** The budget the diagnosis itself was given, so a caller can tell a slow answer from a verdict. */
  budgetMs: number;
  /** Every labelled planning-lifecycle session, not only this key's holder. */
  holders: PlanningLifecycleHolder[];
  holdersReason: "ok" | PlanningLifecycleDiagnosisReason;
};

/**
 * The youngest holder this product is willing to call dead, measured by PostgreSQL from the holder's own
 * `state_change`. One declaration on purpose: the operator release route and the periodic reclaim sweep
 * both consult THIS number, because two floors that can drift is how one lane starts killing what the
 * other lane still believes is working.
 *
 * FNXC:PlanningLifecycleLockRelease 2026-11-11-19:14 (RUFU-600 code-review P0):
 * The floor is not a courtesy — it is half of the proof that a holder is dead. A planning callback does its
 * work through the runtime pool and leaves its dedicated lock session idle for nearly the whole hold, so
 * `state` says nothing about whether the lane is mid-work: an honest holder is reported `idle` in almost
 * every sample. Without a floor, an operator who clicks Release one second after the engine entered a plan
 * publication ends the session while that lane's durable writes are still landing, the key frees, and a
 * second acquirer enters the critical section beside the first — mutual exclusion lost with no error on
 * either side, which is the RUFU-287 plan-corruption race. A quarter of an hour of a session sitting in one
 * state is a holder that is not mid-work; a session that just did something has a young `state_change`.
 */
export const PLANNING_LIFECYCLE_RELEASE_AGE_FLOOR_MS = 15 * 60_000;

/**
 * What the caller can prove about the card behind the key. Every field is a veto the release surface
 * consumes for itself, so no caller has to remember to pre-check it — see the P0 note on
 * {@link PLANNING_LIFECYCLE_RELEASE_AGE_FLOOR_MS} for why the veto may not live in the caller's filter.
 */
export type PlanningLifecycleReleaseGuards = {
  /**
   * Veto when the card itself is live (a planning or execution session owns it). Absent, throwing, or true
   * all refuse: a caller that cannot answer "is this card busy?" cannot prove it safe to end a session.
   */
  isCardLive?: (taskId: string) => boolean | Promise<boolean>;
  /**
   * Override the code-owned age floor. Production lanes never pass it; the PostgreSQL harness does, because
   * `state_change` is the server's clock and cannot be rewound, and a test that waited 15 real minutes for
   * the floor would be the slow-test anti-pattern AGENTS.md refuses.
   */
  ageFloorMs?: number;
};

export type PlanningLifecycleReleaseReport = {
  key: string;
  /** True only when the key was held and is now measured free. */
  released: boolean;
  reason:
    | "confirmation-required"
    | "transport-unavailable"
    | "identity-not-derivable"
    | "holder-query-failed"
    | "not-held"
    | "holder-active"
    | "live-session"
    /** The holder is not a session this product opened, so it is not this product to end. */
    | "foreign-holder"
    /** The holder is younger than {@link PLANNING_LIFECYCLE_RELEASE_AGE_FLOOR_MS}: not provably dead. */
    | "below-age-floor"
    /** The card behind the key has live planning/execution ownership of its own sessions. */
    | "card-live"
    /** No liveness probe was supplied, so the card's idleness cannot be proven — refuse, do not guess. */
    | "liveness-unproven"
    | "terminate-failed"
    | "released"
    | "release-unproven";
  holder: PlanningLifecycleHolder | null;
  terminated: boolean;
};

/*
FNXC:PlanningLifecycleLockRelease 2026-11-11-19:14 (RUFU-600 code-review P0):
The old release vetoes were "not in THIS process's registry" plus "not mid-statement". Neither one is a
proof of death for a cross-process holder: the registry only knows sessions this daemon opened, and
`state === "active"` is true only in the milliseconds a statement is executing, while a planning callback
holds its session idle for nearly the whole hold. `withPlanningLifecycleAdvisoryLock` exists precisely
because planning handoff and dependency re-seed cross processes, so the operator's Release button reached
`pg_terminate_backend` over a lane that was legitimately working — at ageMs≈1s if the operator clicked
that fast. The safety rule from Step 3 ("release must prove death, not merely elapse time") therefore
lives HERE, in the shared surface both the operator route and the reclaim sweep call, and not only in the
sweep's candidate filter: a conjunction enforced by the caller is not a contract, it is one caller's habit.
The vetoes below are the conjunction, cheapest and most certain first, and every one of them refuses
rather than proceeding on a partial answer:
  - the session must be one this product opened (its own `application_name` says so), so a foreign client
    sitting on a colliding advisory key is never a terminate candidate;
  - it must sit past the code-owned age floor, which is the only evidence available for a holder in
    another process;
  - the card behind the key must be proven idle by a probe the caller injects — absent or throwing counts
    as live.
*/
export async function releasePlanningLifecycleAdvisoryKey(
  input: PlanningLifecycleSessionInput & { taskId: string },
  confirm: boolean,
  guards: PlanningLifecycleReleaseGuards = {},
): Promise<PlanningLifecycleReleaseReport> {
  const key = planningLifecycleLockKey(input.projectId, input.taskId);
  const refused = (
    reason: PlanningLifecycleReleaseReport["reason"],
    holder: PlanningLifecycleHolder | null,
    terminated = false,
  ): PlanningLifecycleReleaseReport => ({ key, released: false, reason, holder, terminated });

  // Nothing in this call is reversible, so an absent confirmation performs no database call at all.
  if (confirm !== true) return refused("confirmation-required", null);

  const availability = planningLifecycleLockTransportAvailability(input);
  if (!availability.available) return refused("transport-unavailable", null);

  const before = await diagnosePlanningLifecycleAdvisoryKey(input);
  // A key that is already free answers `not-held` before any veto: a repeated or concurrent Release click
  // must stay idempotent, and refusing it would tell the operator to act again on nothing.
  if (before.reason !== "held") return refused(before.reason, before.holder);

  const holder = before.holder as PlanningLifecycleHolder;
  if (isPlanningLifecycleSessionLive(holder.pid)) return refused("live-session", holder);
  if (holder.state === "active") return refused("holder-active", holder);
  if (!holder.ours) return refused("foreign-holder", holder);

  const ageFloorMs = guards.ageFloorMs ?? PLANNING_LIFECYCLE_RELEASE_AGE_FLOOR_MS;
  if (holder.ageMs < ageFloorMs) return refused("below-age-floor", holder);

  if (typeof guards.isCardLive !== "function") return refused("liveness-unproven", holder);
  let cardLive = true;
  try {
    cardLive = await guards.isCardLive(input.taskId);
  } catch {
    // A probe that cannot answer is a probe that says "busy": fail-closed over an irreversible act.
    cardLive = true;
  }
  if (cardLive) return refused("card-live", holder);

  const terminated = await terminatePlanningLifecycleSession(input, holder.pid);
  if (terminated.outcome !== "terminated") return refused("terminate-failed", holder);

  const after = await diagnosePlanningLifecycleAdvisoryKey(input);
  if (after.reason === "not-held") {
    return { key, released: true, reason: "released", holder, terminated: true };
  }
  return refused("release-unproven", holder, true);
}

export async function terminatePlanningLifecycleSession(
  input: PlanningLifecycleSessionInput,
  pid: number,
): Promise<{ outcome: PlanningLifecycleTerminateOutcome }> {
  if (!Number.isFinite(pid) || pid <= 0 || isPlanningLifecycleSessionLive(pid)) return { outcome: "refused" };
  const availability = planningLifecycleLockTransportAvailability(input);
  if (!availability.available) return { outcome: "refused" };
  const budgetMs = Math.max(1, input.timeoutMs ?? DEFAULT_PLANNING_LIFECYCLE_LOCK_TIMEOUT_MS);
  const client = openReadOnlyPlanningSession(input.directSessionUrl as string, budgetMs);
  try {
    const rows = await withQueryBudget(client<Array<{ terminated: unknown }>>`SELECT pg_terminate_backend(${pid}::int) AS terminated`, budgetMs);
    return rows?.[0]?.terminated === true ? { outcome: "terminated" } : { outcome: "failed" };
  } catch {
    return { outcome: "failed" };
  } finally {
    await client.end({ timeout: 1 }).catch(() => undefined);
  }
}
