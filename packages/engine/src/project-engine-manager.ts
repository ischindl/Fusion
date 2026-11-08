/**
 * ProjectEngineManager — uniform lifecycle management for all project engines.
 *
 * Every registered project gets an identical ProjectEngine. There is no
 * "primary" or "default" engine — each is created from CentralCore metadata
 * and started through the same code path.
 *
 * The manager is the single owner of all engines. It handles:
 *   - Eager startup of all registered projects via `startAll()`
 *   - Background reconciliation of newly registered projects via `startReconciliation()`
 *   - Lazy startup of newly-accessed projects via `ensureEngine()` and `onProjectAccessed()`
 *   - Deduplication of concurrent start requests for the same project
 *   - Graceful shutdown of all engines via `stopAll()`
 */

import { existsSync, realpathSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { createTaskStoreForBackend, resolveEffectiveConcurrency, type CentralCore, type TaskStore, type RegisteredProject, type MigrationProgressEvent } from "@fusion/core";
import { ProjectEngine } from "./project-engine.js";
import type { ProjectEngineOptions } from "./project-engine.js";
import type { ProjectRuntimeConfig } from "./project/project-runtime.js";
import {
  acquireEngineSingleton,
  EngineAlreadyRunningError,
  type EngineSingletonLock,
} from "./project/engine-singleton-lock.js";
import { runtimeLog } from "./logger.js";
import {
  preserveAllRemoteTunnelsForSupervisedRestart,
  shutdownAllRemoteTunnels,
} from "./remote-access/remote-tunnel-service.js";

/**
 * Options shared across all engines created by the manager.
 * These are injected by the CLI layer (dashboard.ts / serve.ts).
 */
export interface EngineManagerOptions {
  /**
   * FNXC:StorageMigrationNotice 2026-07-12-00:00:
   * The manager carries the resolved CLI package version to each per-project engine so the one-time Postgres-migration inbox message is evaluated per project while remaining gated to the same released runtime version.
   */
  cliPackageVersion?: ProjectEngineOptions["cliPackageVersion"];
  getMergeStrategy?: ProjectEngineOptions["getMergeStrategy"];
  processPullRequestMerge?: ProjectEngineOptions["processPullRequestMerge"];
  createGroupPr?: ProjectEngineOptions["createGroupPr"];
  syncGroupPr?: ProjectEngineOptions["syncGroupPr"];
  prNodeGithubOps?: ProjectEngineOptions["prNodeGithubOps"];
  createPrNodeGithubOps?: ProjectEngineOptions["createPrNodeGithubOps"];
  prReconcileGithubOps?: ProjectEngineOptions["prReconcileGithubOps"];
  getTaskMergeBlocker?: ProjectEngineOptions["getTaskMergeBlocker"];
  onInsightRunProcessed?: ProjectEngineOptions["onInsightRunProcessed"];
  createMissionValidationEvidenceProvider?: ProjectEngineOptions["createMissionValidationEvidenceProvider"];
  /**
   * FNXC:SqliteFinalRemoval 2026-06-26-11:20: shared TaskStore from the central
   * backend boot so engines reuse one connection pool (no second embedded PG).
   *
   * FNXC:FasterStartup 2026-07-14-23:55:
   * Inject only for the project whose resolved working directory matches this
   * store's rootDir. Multi-project engines must factory-boot (or receive) their
   * own bound store — a cwd-partitioned TaskStore must never back a different
   * project root. Callers may still pass per-call overrides via ensureEngine.
   */
  externalTaskStore?: ProjectEngineOptions["externalTaskStore"];
  /** Forward first-boot SQLite migration progress to a fixed-port holding server. */
  onMigrationProgress?: (event: MigrationProgressEvent) => void;
}

/** Default interval for background reconciliation (30 seconds). */
export const DEFAULT_RECONCILIATION_INTERVAL_MS = 30_000;

/*
FNXC:EngineStartAttemptTruth 2026-11-07-13:20 (RUFU-496):
An engine start used to be tracked as a bare `Promise<ProjectEngine>` in `this.starting`, with no
owner, no age, and no stage. Two consequences made the dashboard lie:
1. A start that never SETTLES cleared nothing (the map is deleted only in `ensureEngine`'s catch and
   after a successful start), so `starting` stayed true forever with no error recorded anywhere.
2. `has()` answers true for a pending entry, and `reconcile()` builds its retry set with
   `activeProjects.filter((p) => !this.has(p.id))`, so that same stuck entry removed the project from
   reconciliation forever. The missing handle was therefore never repaired while agents kept running.

The attempt record below is what makes a stuck start nameable from outside: it carries the wall-clock
it began, the awaited boundary it is currently sitting at, the promise, and a token so a late settle
cannot clear or republish a successor attempt. `FUSION_ENGINE_START_TIMEOUT_MS` bounds the wait and
turns it into a terminal named failure.
*/

/** A named awaited boundary inside `createAndStart`, so a stuck start is describable from outside. */
export type EngineStartStage =
  | "registry-read"
  | "working-directory"
  | "startup-concurrency"
  | "singleton-acquire"
  | "runtime-start"
  | "started-hook"
  | "complete";

/** Synchronous view of an in-flight start attempt (no promise, safe to serialize). */
export interface EngineStartAttemptInfo {
  /** Wall-clock milliseconds since epoch when the attempt began. */
  startedAt: number;
  /** The awaited boundary the attempt is currently blocked on. */
  stage: EngineStartStage;
  /** Distinguishes this attempt from a later attempt for the same project. */
  token: number;
}

/** A recorded, operator-readable engine-start failure. */
export interface EngineStartFailureRecord {
  /** Wall-clock milliseconds since epoch when the failure was recorded. */
  at: number;
  /** The stage the attempt was blocked on when it failed. */
  stage: EngineStartStage;
  /** Error message (already stringified). */
  message: string;
  /** True when the failure was this manager's own bounded-wait deadline, not a rejection. */
  timedOut: boolean;
}

/** Rejection raised when a start attempt exceeds {@link resolveEngineStartTimeoutMs}. */
export class EngineStartTimeoutError extends Error {
  constructor(projectId: string, stage: EngineStartStage, timeoutMs: number) {
    super(
      `Engine start for project ${projectId} did not settle within ${timeoutMs}ms (stuck at stage: ${stage})`,
    );
    this.name = "EngineStartTimeoutError";
  }
}

/** Environment override key for the engine-start deadline. */
export const ENGINE_START_TIMEOUT_ENV = "FUSION_ENGINE_START_TIMEOUT_MS";
/** Default ceiling on a single engine-start attempt (10 minutes). */
export const DEFAULT_ENGINE_START_TIMEOUT_MS = 600_000;
/** Floor for the override, so a mistyped value cannot hot-restart engines forever. */
export const MIN_ENGINE_START_TIMEOUT_MS = 10_000;
/** Warn once at this much in-flight startup time, always before the ceiling. */
export const ENGINE_START_STALL_WARN_MS = 90_000;

/**
 * Resolve the engine-start deadline from the environment, floored at
 * {@link MIN_ENGINE_START_TIMEOUT_MS}. An unset or unparsable value keeps the default.
 */
export function resolveEngineStartTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[ENGINE_START_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_ENGINE_START_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ENGINE_START_TIMEOUT_MS;
  return Math.max(MIN_ENGINE_START_TIMEOUT_MS, Math.floor(parsed));
}

/** Internal bookkeeping for one in-flight start attempt. */
interface StartAttemptRecord {
  projectId: string;
  startedAt: number;
  stage: EngineStartStage;
  token: number;
  /** The bounded promise every caller (including dedup hits) awaits. */
  promise: Promise<ProjectEngine>;
  /** Set when the deadline fired: the underlying start must unwind instead of publishing. */
  abandoned: boolean;
  /** Timer handles, cleared on settle so a resolved start leaves nothing pending. */
  stallTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * FNXC:RemoteAccess 2026-09-01-02:54:
 * Shutdown intent, threaded from the only place that knows it: the dashboard sets its exit code to
 * FUSION_RESTART_EXIT_CODE when a restart was REQUESTED. It is passed as an argument rather than read
 * from the environment on purpose — FUSION_RESTART_SUPERVISED is inherited by every child process, and
 * trusting it once already produced the "restart does nothing" bug (see hasLiveSupervisingParent).
 */
export interface StopAllOptions {
  /** True when this process is exiting for a supervisor that will relaunch it immediately. */
  supervisedRestart?: boolean;
}

/**
 * Warm one project's engine up on behalf of a host that merely HOSTS the manager.
 *
 * FNXC:EngineStatusTruth 2026-11-07-14:20 (RUFU-496):
 * The desktop and CLI hosts start engines so a freshly opened dashboard can execute tasks, but they are
 * not the process whose whole purpose is that engine. Two of them awaited `ensureEngine` inside the
 * blocking server-construction path, so a cold-start that threw killed server creation before
 * `listen()` - the dashboard never came up, and because the rejection also wiped the attempt tracking,
 * the card had no way to say why it was dead. That is the opposite failure of the lie this task fixes:
 * a truthfully-false `connected` is fine, but only if the reason is nameable.
 *
 * The contract this helper encodes for those hosts:
 * (a) the rejection reason lands on the manager's own failure record (via `ensureEngine`) AND on the
 *     host's log channel, so both the payload and the host's trace can name it;
 * (b) the attempt state is already terminal by the time this resolves (`starting:false`, reason
 *     `start-failed`), so no later status read can report "starting" forever;
 * (c) the warm-up re-arms itself by RETURNING undefined rather than throwing: the host still calls
 *     `listen()`, and {@link ProjectEngineManager.reconcile} re-admits the project under its capped
 *     backoff. A host that owns the engine (`fn serve`, `fn daemon`) deliberately does NOT use this -
 *     there a failed start is fatal by design.
 *
 * `ensureEngine` is called with exactly one argument; the call shape is a tested contract.
 */
export async function warmUpProjectEngine(
  manager: Pick<ProjectEngineManager, "ensureEngine">,
  projectId: string,
  options: { host: string; onWarning?: (message: string) => void },
): Promise<ProjectEngine | undefined> {
  try {
    return await manager.ensureEngine(projectId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onWarning?.(`[${options.host}] Failed to warm project engine: ${message}`);
    return undefined;
  }
}

export class ProjectEngineManager {
  private engines = new Map<string, ProjectEngine>();
  /**
   * FNXC:EngineStartAttemptTruth 2026-11-07-13:20 (RUFU-496):
   * Was `Map<string, Promise<ProjectEngine>>`. The value is now a full attempt record so an
   * in-flight start can answer "how long, and blocked on which stage". `has()`, `beginDrain()` and
   * the live-engine semantics are unchanged: a pending entry is still "the manager has an entry for
   * this project", which is precisely why the reconciliation predicate had to move off `has()`.
   */
  private starting = new Map<string, StartAttemptRecord>();
  private singletonLocks = new Map<string, EngineSingletonLock>();
  /**
   * FNXC:DashboardHealth 2026-06-21-03:30:
   * Engine availability must reflect machine-level truth, not only engines this
   * process owns. Projects whose engine is owned by ANOTHER fusion process on
   * this machine are tracked here, populated when `acquireEngineSingleton`
   * rejects with {@link EngineAlreadyRunningError} — that error is positive
   * proof an engine is live for the project, just not owned by us. We keep
   * retrying to start (so we take over if the other process dies), but the
   * dashboard must report the engine as available rather than showing a false
   * "engine not running" banner.
   */
  private externalEngines = new Set<string>();
  private stopped = false;

  /*
  FNXC:EngineStartAttemptTruth 2026-11-07-13:20 (RUFU-496):
  `lastStartFailures` and `startBackoff` are the two halves that stop a permanently blocked project
  from hiding. Without a recorded failure, an aged-out attempt left no trace an operator or the
  dashboard could read; without a backoff, re-admitting the project every 30-second reconciliation
  tick would hot-loop the very startup that is wedged. A successful start clears both.
  */
  private lastStartFailures = new Map<string, EngineStartFailureRecord>();
  private startBackoff = new Map<string, { failures: number; nextEligibleAt: number }>();
  private attemptToken = 0;
  private engineStartTimeoutMs = resolveEngineStartTimeoutMs();

  /*
  FNXC:CapacityModel 2026-07-28-20:10 (drop the cross-project cap):
  The shared cross-project semaphore, its mutable limit and the
  `concurrency:changed` subscription are DELETED. Capacity is two numbers per
  project; a machine-wide cap was a third limiter with its own separate authority
  (a central-DB singleton row), and reconciling it against the per-project gates is
  exactly the multi-limiter arbitration this simplification removes.
  */

  /** Reconciliation state for background project startup. */
  private reconciliationInterval: ReturnType<typeof setInterval> | null = null;
  private reconciliationStopped = false;

  constructor(
    private centralCore: CentralCore,
    private options: EngineManagerOptions = {},
  ) {
  }

  // ── Public accessors ──

  /** Get a running engine by projectId. Returns undefined if not started. */
  getEngine(projectId: string): ProjectEngine | undefined {
    return this.engines.get(projectId);
  }

  /* FNXC:ChatRestartAutoContinue 2026-09-17-21:05: dashboard-side late wiring for engines started after server boot; call `getAllEngines()` once to cover existing ones. */
  private engineStartedHook?: (engine: ProjectEngine) => void | Promise<void>;

  setEngineStartedHook(hook?: (engine: ProjectEngine) => void | Promise<void>): void {
    this.engineStartedHook = hook;
  }


  /** Get all running engines. */
  getAllEngines(): ReadonlyMap<string, ProjectEngine> {
    return this.engines;
  }

  /**
   * Whether an engine is running for any project on this machine — including
   * engines owned by another fusion process (detected via the singleton lock).
   * Drives the dashboard's "engine available" health so a UI-only launch
   * alongside an already-running engine does not show a false banner.
   */
  hasRunningEngine(): boolean {
    return this.engines.size > 0 || this.externalEngines.size > 0;
  }

  /** Project ids whose engine is owned by another fusion process on this machine. */
  getExternalEngineIds(): ReadonlySet<string> {
    return this.externalEngines;
  }

  /** Get the TaskStore for a project from its engine. */
  getStore(projectId: string): TaskStore | undefined {
    return this.engines.get(projectId)?.getTaskStore();
  }

  /** Check if an engine is running or starting for this project. */
  has(projectId: string): boolean {
    return this.engines.has(projectId) || this.starting.has(projectId);
  }

  /*
  FNXC:EngineStartAttemptTruth 2026-11-07-13:20 (RUFU-496):
  `packages/dashboard/src/routes/context.ts` documents that "ProjectEngineManager exposes no
  synchronous engine-liveness/paused introspection", which is why /api/engine/status could only guess
  from `has() && !getEngine()`. These two accessors close that gap: they answer, without awaiting
  anything, "is a start in flight and how far did it get" and "what was the last recorded failure".
  They are deliberately synchronous and allocation-light because the dashboard polls this on a
  10-second timer.
  */

  /**
   * Synchronous view of an in-flight engine start, or `undefined` when no attempt is pending.
   * The returned object is a copy, so a caller cannot mutate the manager's bookkeeping.
   */
  getStartAttempt(projectId: string): EngineStartAttemptInfo | undefined {
    const record = this.starting.get(projectId);
    if (!record) return undefined;
    return { startedAt: record.startedAt, stage: record.stage, token: record.token };
  }

  /** The last recorded engine-start failure for a project, or `undefined` if none was recorded. */
  getLastStartFailure(projectId: string): EngineStartFailureRecord | undefined {
    return this.lastStartFailures.get(projectId);
  }

  /**
   * Whether reconciliation may attempt another start for a project that has failed before.
   * A project with no failure history is always eligible.
   */
  isStartEligibleAfterBackoff(projectId: string, now: number = Date.now()): boolean {
    const backoff = this.startBackoff.get(projectId);
    if (!backoff) return true;
    return now >= backoff.nextEligibleAt;
  }

  // ── Pause / Resume ────────────────────────────────────────────────────

  /**
   * Pause a project: update its status in CentralCore and stop its engine.
   * This prevents the reconciliation loop from restarting the engine.
   */
  async pauseProject(projectId: string): Promise<void> {
    if (this.stopped) throw new Error("ProjectEngineManager is stopped");

    runtimeLog.log(`Pausing project ${projectId}`);

    // Update CentralCore status
    await this.centralCore.updateProject(projectId, { status: "paused" });
    await this.centralCore.updateProjectHealth(projectId, { status: "paused" });

    // Stop the engine if running
    const engine = this.engines.get(projectId);
    if (engine) {
      await engine.stop();
      this.engines.delete(projectId);
      runtimeLog.log(`Stopped engine for paused project ${projectId}`);
    }

    // Remove from starting set to prevent a stalled start from completing
    this.abandonAttempt(projectId);

    await this.releaseSingleton(projectId);
  }

  /**
   * Resume a paused project: update its status in CentralCore and start its engine.
   */
  async resumeProject(projectId: string): Promise<void> {
    if (this.stopped) throw new Error("ProjectEngineManager is stopped");

    runtimeLog.log(`Resuming project ${projectId}`);

    // Update CentralCore status
    await this.centralCore.updateProject(projectId, { status: "active" });
    await this.centralCore.updateProjectHealth(projectId, { status: "active" });

    // Start the engine
    await this.ensureEngine(projectId);
  }

  // ── Lifecycle ──

  /**
   * Ensure an engine is running for the given project.
   * If already started, returns immediately. If starting, deduplicates.
   * If not started, creates and starts a new engine from CentralCore metadata.
   */
  async ensureEngine(
    projectId: string,
    overrides?: Partial<ProjectEngineOptions>,
  ): Promise<ProjectEngine> {
    if (this.stopped) throw new Error("ProjectEngineManager is stopped");

    // Check if the project is paused before starting
    const project = await this.centralCore.getProject(projectId);
    if (project && (project.status as string) === "paused") {
      throw new Error(`Project ${projectId} is paused`);
    }

    const existing = this.engines.get(projectId);
    if (existing) return existing;

    // Deduplicate concurrent start requests
    const pending = this.starting.get(projectId);
    if (pending) return pending.promise;

    /*
    FNXC:EngineStartAttemptTruth 2026-11-07-13:20 (RUFU-496):
    The attempt record is created BEFORE `createAndStart` is invoked so the very first await is
    already attributable. `record.promise` is the BOUNDED promise: every caller, including a dedup
    hit that arrives later, awaits the same deadline-bounded promise rather than the raw startup.
    Handing dedup callers the raw promise is what made a wedged start able to hang N callers forever.
    */
    const record: StartAttemptRecord = {
      projectId,
      startedAt: Date.now(),
      stage: "registry-read",
      token: ++this.attemptToken,
      promise: Promise.resolve(undefined as unknown as ProjectEngine),
      abandoned: false,
      stallTimer: null,
      deadlineTimer: null,
    };
    const created = this.createAndStart(projectId, record, overrides);
    record.promise = this.boundToDeadline(projectId, record, created);
    this.starting.set(projectId, record);
    return record.promise;
  }

  /**
   * Race a start attempt against the configured deadline and arm the mid-flight stall warning.
   *
   * FNXC:EngineStartAttemptTruth 2026-11-07-13:20 (RUFU-496):
   * The deadline does more than abandon the wait. It marks the attempt `abandoned`, which is the
   * signal `createAndStart` checks at every later boundary so a late success unwinds (stopping any
   * engine it built and releasing the singleton) instead of publishing an engine nobody is waiting
   * for. Clearing the pending entry here is what returns the project to reconciliation eligibility;
   * a plain `Promise.race` would have left the entry in place and kept the starvation intact.
   */
  private boundToDeadline(
    projectId: string,
    record: StartAttemptRecord,
    created: Promise<ProjectEngine>,
  ): Promise<ProjectEngine> {
    const timeoutMs = this.engineStartTimeoutMs;
    const stallWarnMs = Math.min(ENGINE_START_STALL_WARN_MS, Math.max(1, timeoutMs - 1));

    return new Promise<ProjectEngine>((resolve, reject) => {
      let settled = false;

      record.stallTimer = setTimeout(() => {
        record.stallTimer = null;
        if (settled) return;
        runtimeLog.warn(
          `Engine start for project ${projectId} is still in flight after ${Date.now() - record.startedAt}ms (stage: ${record.stage})`,
        );
      }, stallWarnMs);
      record.stallTimer.unref?.();

      record.deadlineTimer = setTimeout(() => {
        record.deadlineTimer = null;
        if (settled) return;
        settled = true;
        record.abandoned = true;
        // Only clear if the entry is still OURS - a successor may already own the slot.
        if (this.starting.get(projectId)?.token === record.token) {
          this.starting.delete(projectId);
        }
        this.recordStartFailure(projectId, record, new EngineStartTimeoutError(projectId, record.stage, timeoutMs), true);
        runtimeLog.warn(
          `Engine start for project ${projectId} timed out after ${timeoutMs}ms at stage ${record.stage}`,
        );
        reject(new EngineStartTimeoutError(projectId, record.stage, timeoutMs));
      }, timeoutMs);
      record.deadlineTimer.unref?.();

      created.then(
        (engine) => {
          if (settled) return;
          settled = true;
          this.clearAttemptTimers(record);
          if (this.starting.get(projectId)?.token === record.token) {
            this.starting.delete(projectId);
          }
          // A start that got there on its own proves the project is healthy again.
          this.startBackoff.delete(projectId);
          this.lastStartFailures.delete(projectId);
          resolve(engine);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          this.clearAttemptTimers(record);
          if (this.starting.get(projectId)?.token === record.token) {
            this.starting.delete(projectId);
          }
          // An engine owned by another process is positive proof of liveness, not a failure:
          // recording it would let the payload report a real outage reason for a working project.
          if (!(err instanceof EngineAlreadyRunningError)) {
            this.recordStartFailure(projectId, record, err, false);
          }
          reject(err);
        },
      );
    });
  }

  private clearAttemptTimers(record: StartAttemptRecord): void {
    if (record.stallTimer !== null) {
      clearTimeout(record.stallTimer);
      record.stallTimer = null;
    }
    if (record.deadlineTimer !== null) {
      clearTimeout(record.deadlineTimer);
      record.deadlineTimer = null;
    }
  }

  /**
   * Record why the last start did not succeed, and arm the reconciliation backoff.
   * `EngineAlreadyRunningError` never reaches here - see {@link boundToDeadline}.
   */
  private recordStartFailure(
    projectId: string,
    record: StartAttemptRecord,
    error: unknown,
    timedOut: boolean,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastStartFailures.set(projectId, {
      at: Date.now(),
      stage: record.stage,
      message,
      timedOut,
    });
    const prior = this.startBackoff.get(projectId);
    const failures = (prior?.failures ?? 0) + 1;
    this.startBackoff.set(projectId, {
      failures,
      nextEligibleAt: Date.now() + this.startBackoffDelayMs(failures),
    });
  }

  /** Capped exponential backoff: one reconciliation interval, doubling, capped at 15 minutes. */
  private startBackoffDelayMs(failures: number): number {
    const base = DEFAULT_RECONCILIATION_INTERVAL_MS;
    const capped = Math.min(15 * 60_000, base * 2 ** Math.min(failures - 1, 20));
    return capped;
  }

  /**
   * Stop tracking an in-flight attempt without publishing its result (used by pause).
   * Token-guarded so a pause racing a successor attempt cannot clear the successor.
   */
  private abandonAttempt(projectId: string): void {
    const record = this.starting.get(projectId);
    if (!record) return;
    record.abandoned = true;
    this.clearAttemptTimers(record);
    this.starting.delete(projectId);
  }

  /**
   * Start engines for all registered projects.
   * Failures for individual projects are logged but don't stop others.
   */
  async startAll(): Promise<void> {
    const projects = await this.centralCore.listProjects();
    if (projects.length === 0) return;

    runtimeLog.log(`Starting engines for ${projects.length} registered project(s)`);

    const results = await Promise.allSettled(
      projects.map((p) => this.ensureEngine(p.id)),
    );

    let started = 0;
    let failed = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        started++;
      } else if (result.reason instanceof EngineAlreadyRunningError) {
        // Engine owned by another process — expected, already logged once.
        continue;
      } else {
        failed++;
        runtimeLog.warn(`Engine start failed: ${result.reason}`);
      }
    }

    runtimeLog.log(`Engine startup complete: ${started} started, ${failed} failed`);
  }

  /** Close admission on every engine and stop reconciliation without tearing engines down. */
  beginDrain(): void {
    this.stopped = true;
    this.reconciliationStopped = true;

    // Stop reconciliation interval
    if (this.reconciliationInterval !== null) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = null;
    }

    for (const engine of this.engines.values()) {
      try {
        engine.beginDrain?.();
      } catch (error) {
        runtimeLog.warn(
          `Engine drain error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    for (const attempt of this.starting.values()) {
      void attempt.promise.then((engine) => engine.beginDrain?.()).catch(() => undefined);
    }
  }

  /** Gracefully stop all engines and reconciliation. */
  async stopAll(options: StopAllOptions = {}): Promise<void> {
    this.beginDrain();

    /*
    FNXC:PostgresResourceLifecycle 2026-07-14-18:42:
    Project runtimes own the PostgreSQL pools CentralCore may have adopted. Persist mesh-offline state before stopping any engine so runtime backend shutdown cannot race the final central write against a closed pool.
    */
    try {
      this.centralCore.stopDiscovery();
      await this.centralCore.markLocalNodeOffline();
    } catch (error) {
      runtimeLog.warn(`Failed to persist local node offline before engine shutdown: ${error instanceof Error ? error.message : String(error)}`);
    }

    /*
    FNXC:RemoteAccess 2026-08-31-07:08:
    Remote tunnels are process-lifetime, not engine-lifetime (see remote-tunnel-service.ts), so THIS
    is the only path that stops them — `engine.stop()` no longer does, which is what lets "Stop
    engine"/"Restart engine" leave the operator's public URL alive. Run it before engine.stop() while
    each TaskStore is still open, so the "was running on shutdown" marker persists and restore-on-start
    can bring the tunnel back.
    */
    /*
    FNXC:RemoteAccess 2026-09-01-02:54:
    A SUPERVISED RESTART IS NOT A SHUTDOWN. `supervisedRestart` is set when the dashboard is exiting with
    FUSION_RESTART_EXIT_CODE for a supervisor that will relaunch it seconds later (Command Center
    "Restart", and "Update from source", which ends in the same exit). Killing the tunnel there took the
    operator's public URL down on every routine restart — observed twice, container healthy, URL dead.
    Only a genuine process/container exit stops it.
    */
    const supervisedRestart = options.supervisedRestart === true;
    const tunnelShutdowns = Array.from(this.engines.entries()).map(
      async ([id, engine]) => {
        try {
          await engine.shutdownRemoteTunnelForProcessExit({ supervisedRestart });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          runtimeLog.warn(`Engine ${id} remote tunnel ${supervisedRestart ? "handover" : "shutdown"} error: ${message}`);
        }
      },
    );
    await Promise.all(tunnelShutdowns);
    // Sweep any tunnel whose engine is already gone (e.g. a paused project) so no child process
    // outlives this one publishing a port nothing serves — or, across a supervised restart, so it is
    // released rather than killed.
    const sweep = supervisedRestart
      ? preserveAllRemoteTunnelsForSupervisedRestart()
      : shutdownAllRemoteTunnels();
    await sweep.catch((err) => {
      runtimeLog.warn(`Remote tunnel sweep error: ${err instanceof Error ? err.message : String(err)}`);
    });

    const stops = Array.from(this.engines.entries()).map(
      async ([id, engine]) => {
        try {
          await engine.stop();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          runtimeLog.warn(`Engine ${id} stop error: ${message}`);
        }
      },
    );
    await Promise.all(stops);
    this.engines.clear();
    for (const attempt of this.starting.values()) {
      this.clearAttemptTimers(attempt);
    }
    this.starting.clear();
    this.externalEngines.clear();
    this.startBackoff.clear();

    // Release all singleton locks so another fusion process can take over.
    const releases = Array.from(this.singletonLocks.values()).map((lock) =>
      lock.release().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        runtimeLog.warn(`Singleton lock release error: ${message}`);
      }),
    );
    await Promise.all(releases);
    this.singletonLocks.clear();
  }

  private async releaseSingleton(projectId: string): Promise<void> {
    const lock = this.singletonLocks.get(projectId);
    if (!lock) return;
    this.singletonLocks.delete(projectId);
    try {
      await lock.release();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtimeLog.warn(
        `Singleton lock release error for ${projectId}: ${message}`,
      );
    }
  }

  /**
   * Fire-and-forget engine start — suitable as a callback for
   * onProjectFirstAccessed in the server layer.
   */
  onProjectAccessed(projectId: string): void {
    if (this.has(projectId)) return;
    this.ensureEngine(projectId).catch((err) => {
      // Expected when another process owns the engine — already logged once.
      if (err instanceof EngineAlreadyRunningError) return;
      const message = err instanceof Error ? err.message : String(err);
      runtimeLog.warn(
        `Failed to start engine for project ${projectId}: ${message}`,
      );
    });
  }

  // ── Background Reconciliation ────────────────────────────────────────

  /**
   * Start background reconciliation to detect and start engines for
   * newly registered projects without requiring UI access.
   *
   * This runs on an interval, checking for projects that have been
   * registered but don't have running engines yet.
   *
   * Idempotent — safe to call multiple times. Reconciliation stops
   * when `stopReconciliation()` or `stopAll()` is called.
   *
   * @param intervalMs How often to check for new projects (default: 30 seconds)
   */
  startReconciliation(intervalMs: number = DEFAULT_RECONCILIATION_INTERVAL_MS): void {
    if (this.stopped || this.reconciliationStopped) return;
    if (this.reconciliationInterval !== null) return; // Already running

    runtimeLog.log(`Starting project engine reconciliation (interval: ${intervalMs}ms)`);

    // Run an immediate reconciliation tick, then schedule periodic checks
    this.reconcile().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      runtimeLog.warn(`Reconciliation tick failed: ${message}`);
    });

    this.reconciliationInterval = setInterval(() => {
      if (this.reconciliationStopped) {
        this.stopReconciliation();
        return;
      }
      this.reconcile().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        runtimeLog.warn(`Reconciliation tick failed: ${message}`);
      });
    }, intervalMs);

    // Prevent the interval from keeping the process alive
    this.reconciliationInterval.unref?.();
  }

  /**
   * Stop background reconciliation.
   * Idempotent — safe to call even if reconciliation is not running.
   */
  stopReconciliation(): void {
    this.reconciliationStopped = true;
    if (this.reconciliationInterval !== null) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = null;
      runtimeLog.log("Stopped project engine reconciliation");
    }
  }

  /**
   * Check for registered projects that don't have engines and start them.
   * This is the core reconciliation logic used by both `startReconciliation`
   * and `startAll()`.
   */
  private async reconcile(): Promise<void> {
    if (this.stopped || this.reconciliationStopped) return;

    try {
      const projects = await this.centralCore.listProjects();
      if (projects.length === 0) return;

      // Filter out paused projects — they should not have engines started
      const activeProjects = projects.filter((p) => (p.status as string) !== "paused");

      // Find projects that have neither a live engine nor an attempt still in flight.
      /*
      FNXC:EngineStartAttemptTruth 2026-11-07-13:20 (RUFU-496):
      This predicate used to be `!this.has(p.id)`, and `has()` is true for a PENDING attempt. That
      made "a start was once attempted" equivalent to "an engine is running": a project whose first
      attempt never settled was filtered out of reconciliation forever and its missing handle was
      never repaired. The retry set is now keyed on the two facts that actually matter - no live
      handle and no attempt in flight - plus a capped backoff so a permanently blocked project cannot
      hot-loop the 30-second tick. An aged-out or failed attempt therefore makes the project eligible
      again, which is what closes the starvation rather than just relabelling it.
      */
      const now = Date.now();
      const missing = activeProjects.filter(
        (p) => !this.engines.has(p.id) && !this.starting.has(p.id) && this.isStartEligibleAfterBackoff(p.id, now),
      );
      if (missing.length === 0) return;

      runtimeLog.log(
        `Reconciliation: found ${missing.length} project(s) without engines`,
      );

      // Start engines for missing projects (fire-and-forget)
      for (const project of missing) {
        if (this.stopped || this.reconciliationStopped) break;
        this.ensureEngine(project.id).catch((err) => {
          // An engine owned by another process is expected, not a failure —
          // createAndStart already logged it once and recorded it in
          // externalEngines. Swallow it here so reconciliation doesn't warn
          // every interval for the same externally-owned engine.
          if (err instanceof EngineAlreadyRunningError) return;
          const message = err instanceof Error ? err.message : String(err);
          runtimeLog.warn(
            `Failed to start engine for project ${project.id}: ${message}`,
          );
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtimeLog.warn(`Reconciliation failed: ${message}`);
    }
  }

  // ── Internal ──

  private async createAndStart(
    projectId: string,
    attempt: StartAttemptRecord,
    overrides?: Partial<ProjectEngineOptions>,
  ): Promise<ProjectEngine> {
    const project = await this.centralCore.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found in CentralCore`);
    }

    // Prevent starting engines for paused projects
    if ((project.status as string) === "paused") {
      throw new Error(`Project ${projectId} is paused`);
    }

    const runtimeConfig = await this.buildRuntimeConfig(project, attempt);
    const engineOptions = this.buildEngineOptions(project, runtimeConfig.workingDirectory, overrides);

    /*
    FNXC:EngineStartAttemptTruth 2026-11-07-13:20 (RUFU-496):
    The deadline may have fired while we were still opening the project's TaskStore. Stopping here
    keeps an abandoned attempt from acquiring the singleton and then publishing an engine nobody is
    waiting for, which would strand the lock against a successor attempt.
    */
    if (attempt.abandoned) {
      throw new EngineStartTimeoutError(projectId, attempt.stage, this.engineStartTimeoutMs);
    }

    // Acquire the per-machine singleton guard before spinning up any engine
    // subsystems. This prevents two fusion processes from running engines for
    // the same project on one machine.
    attempt.stage = "singleton-acquire";
    const singleton = await acquireEngineSingleton(
      projectId,
      runtimeConfig.workingDirectory,
      (err) => {
        runtimeLog.warn(
          `Engine singleton lock for ${projectId} was compromised: ${err.message}`,
        );
      },
    ).catch((err) => {
      if (err instanceof EngineAlreadyRunningError) {
        // An engine IS running for this project — another fusion process owns
        // it. Record it so the dashboard reports the engine as available, and
        // log only on the first detection to avoid spamming every 30s
        // reconciliation tick while the other process stays alive.
        if (!this.externalEngines.has(projectId)) {
          runtimeLog.warn(
            `Refusing to start engine for ${projectId}: ${err.message}`,
          );
        }
        this.externalEngines.add(projectId);
      }
      throw err;
    });
    this.singletonLocks.set(projectId, singleton);
    // Acquiring the singleton proves no other process owns the engine, so clear
    // any prior "owned by another process" marker now — before engine.start().
    // If start fails below we release the lock and a later tick retries; leaving
    // the marker set here would make hasRunningEngine() report a phantom engine.
    this.externalEngines.delete(projectId);

    const engine = new ProjectEngine(
      runtimeConfig,
      this.centralCore,
      engineOptions,
    );

    attempt.stage = "runtime-start";
    try {
      await engine.start();
    } catch (err) {
      // If engine start fails we must release the singleton so a retry can
      // re-acquire it.
      await this.releaseSingleton(projectId);
      throw err;
    }

    /*
    FNXC:EngineStartAttemptTruth 2026-11-07-13:20 (RUFU-496):
    A start that finished AFTER its own deadline must not publish. The dashboard already told the
    operator the start failed and reconciliation may have launched a successor, so publishing here
    would either double-start the project's lanes or hand back an engine no lifecycle owner holds.
    Tearing down (stop + release the singleton) is the only disposition that leaves the manager
    consistent for the next attempt.
    */
    if (attempt.abandoned) {
      await engine.stop().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        runtimeLog.warn(`Discarded engine stop error for ${projectId}: ${message}`);
      });
      await this.releaseSingleton(projectId);
      throw new EngineStartTimeoutError(projectId, attempt.stage, this.engineStartTimeoutMs);
    }

    this.engines.set(projectId, engine);
    /*
    FNXC:EngineStartAttemptTruth 2026-11-07-13:20 (RUFU-496):
    The pending-entry clear moved to `boundToDeadline`, which is token-guarded and also clears the
    stall/deadline timers. `attempt.stage = "started-hook"` records the last boundary that can still
    fail before the engine is considered up.
    */
    attempt.stage = "started-hook";
    /*
    FNXC:ChatRestartAutoContinue 2026-09-17-21:05:
    Engines start lazily, after the dashboard has installed its engine-started hook; the hook is
    where the dashboard attaches per-engine services (chat restart-continuation) that the engine
    must not construct itself. A throwing hook may never fail engine start.
    */
    try {
      await this.engineStartedHook?.(engine);
    } catch (hookErr: unknown) {
      runtimeLog.warn(`engine-started hook failed for ${projectId}: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`);
    }
    runtimeLog.log(
      `Started engine for ${project.name ?? projectId} (${projectId})`,
    );
    attempt.stage = "complete";

    return engine;
  }

  private async buildRuntimeConfig(
    project: RegisteredProject,
    attempt: StartAttemptRecord,
  ): Promise<ProjectRuntimeConfig> {
    attempt.stage = "working-directory";
    const workingDirectory = await this.centralCore.resolveLocalProjectWorkingDirectory(project.id);
    // `resolveStartupConcurrency` may open the project's TaskStore to read live settings. That is the
    // boundary a second-process project wedges at when its store cannot be opened, and it sits
    // BEFORE the singleton guard, which is why external ownership was never recorded for it.
    attempt.stage = "startup-concurrency";
    const capacity = await this.resolveStartupConcurrency(project, workingDirectory);

    return {
      projectId: project.id,
      workingDirectory,
      isolationMode:
        (project.isolationMode as "in-process" | "child-process") ??
        "in-process",
      maxConcurrent: capacity.maxConcurrent,
      maxWorktrees: capacity.worktreeLimit ?? capacity.maxConcurrent,
      onMigrationProgress: this.options.onMigrationProgress,
    };
  }

  /*
  FNXC:CapacityModel 2026-08-21-15:45:
  FN-9185 makes live project settings authoritative even while a runtime is starting.
  The registry snapshot is used only when a project-scoped TaskStore cannot be opened; this avoids
  constructing a startup capacity from a stale central record that omits a persisted project override.
  */
  private async resolveStartupConcurrency(project: RegisteredProject, workingDirectory: string) {
    const externalStore = this.options.externalTaskStore;
    const getExternalSettingsFast = externalStore?.getSettingsFast;
    if (externalStore && typeof getExternalSettingsFast === "function" && sameProjectRoot(externalStore.getRootDir(), workingDirectory)) {
      return resolveEffectiveConcurrency(await getExternalSettingsFast.call(externalStore));
    }

    // A missing root cannot host a project-scoped store (notably a stale registry row).
    if (!existsSync(workingDirectory)) {
      return resolveEffectiveConcurrency(project.settings as Record<string, unknown> | undefined);
    }

    try {
      const boot = await createTaskStoreForBackend({ rootDir: workingDirectory, projectId: project.id });
      try {
        return resolveEffectiveConcurrency(await boot.taskStore.getSettingsFast());
      } finally {
        await boot.shutdown();
      }
    } catch {
      return resolveEffectiveConcurrency(project.settings as Record<string, unknown> | undefined);
    }
  }

  private buildEngineOptions(
    project: RegisteredProject,
    workingDirectory: string,
    overrides?: Partial<ProjectEngineOptions>,
  ): ProjectEngineOptions {
    /*
    FNXC:FasterStartup 2026-07-14-23:55 / 2026-07-15-00:40:
    Share the CLI-booted TaskStore only when the engine's working directory is
    the same project root as the store. Compare realpath when available so a
    symlinked CLI cwd and a registry-canonical path still share one pool
    (Greptile: path.resolve alone double-boots symlink aliases).
    */
    const sharedStore = this.options.externalTaskStore;
    const shareForThisProject = Boolean(
      sharedStore
      && sameProjectRoot(sharedStore.getRootDir(), workingDirectory),
    );
    return {
      projectId: project.id,
      cliPackageVersion: this.options.cliPackageVersion,
      getMergeStrategy: this.options.getMergeStrategy,
      processPullRequestMerge: this.options.processPullRequestMerge,
      createGroupPr: this.options.createGroupPr,
      syncGroupPr: this.options.syncGroupPr,
      prNodeGithubOps: this.options.prNodeGithubOps,
      createPrNodeGithubOps: this.options.createPrNodeGithubOps,
      createMissionValidationEvidenceProvider: this.options.createMissionValidationEvidenceProvider,
      prReconcileGithubOps: this.options.prReconcileGithubOps,
      getTaskMergeBlocker: this.options.getTaskMergeBlocker,
      onInsightRunProcessed: this.options.onInsightRunProcessed,
      ...(shareForThisProject && sharedStore ? { externalTaskStore: sharedStore } : {}),
      ...overrides,
    };
  }
}

/**
 * FNXC:FasterStartup 2026-07-15-00:40:
 * Path identity for externalTaskStore matching: resolve then realpath so
 * symlinked project roots compare equal to their canonical registry path.
 */
function sameProjectRoot(a: string, b: string): boolean {
  const normalize = (p: string): string => {
    const resolved = pathResolve(p);
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  };
  return normalize(a) === normalize(b);
}
