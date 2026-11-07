/**
 * RUFU-081 domain sampler: PostgreSQL query-rate gauge + Fusion-domain gauges
 * (project / running-agent / board-column counts) for the dashboard `/metrics`
 * endpoint.
 *
 * The PG rate closes the "poll-storm" diagnosis gap: `pg_stat_database`
 * xact_commit/xact_rollback delta, normalized to a per-second rate on the
 * tick. The baseline tracks counters PER DATABASE so a stats reset in one
 * database is detected even when the cross-database sum stays positive,
 * and a failed-probe gap invalidates the baseline so a reset that lands
 * inside the gap can never produce a cross-epoch (fabricated) rate. The Fusion-domain gauges answer the "how busy is the board" questions
 * (active/paused project split, running agents, tasks per column) from stores
 * the dashboard has ALREADY opened — never by opening a store, starting an
 * engine, or starting a watcher just to answer a scrape.
 *
 * Pool occupancy (RUFU-483) answers the sibling question "is the board slow because it cannot get a
 * database connection?". `fusion_postgres_pool_backends{project,role,state}` counts the Fusion-named
 * backends visible in `pg_stat_activity` and `fusion_postgres_pool_max{project,role}` states the
 * configured runtime ceiling, so saturation reads as `backends == max` beside elevated request latency
 * — no profiler. The probe runs on each store's dedicated `max: 1` health session, never on the runtime
 * pool it measures, and renders from pre-read state like every other family here.
 *
 * Non-blocking by design, matching `runtime-sampler.ts`:
 *   - every read happens on a pre-read tick; `buildSnapshot` performs zero
 *     awaited I/O and only renders pre-read numeric state;
 *   - the PG read is best-effort and degrades (keeps the last-known rate, or
 *     `0` on the first invalid sample) when the layer is absent, the DB is
 *     privilege-fenced (embedded PG from agent sessions), or a pool error
 *     occurs — it never throws and never hammers the DB;
 *   - duplicate/undefined project ids are deduped so they never produce
 *     duplicate or malformed metric lines.
 *
 * All seams are injectable so tests exercise the sampler without booting
 * stores or a database (mirroring `createRuntimeSampler(init)`).
 */

import { drizzleSql } from "@fusion/core";
import type { TaskListReadField } from "@fusion/core";
import type { MetricFamily, MetricSample } from "./prometheus-text.js";

const sql = drizzleSql;
import { listRegisteredProjectStores, countRunningAgentsInStore } from "../project-store-resolver.js";

/** Per-database cumulative counters for one `pg_stat_database` probe row. */
export interface PgDbStats {
  /** `pg_stat_database.datname` — per-DB identity for baseline tracking. */
  datname: string;
  /** Cumulative transactions committed since the last stats reset (this database). */
  xactCommit: number;
  /** Cumulative transactions rolled back since the last stats reset (this database). */
  xactRollback: number;
}

/** One probe sample: the per-database cumulative counters (one entry per `pg_stat_database` row). */
export type PgStats = PgDbStats[];

/** Reads the per-database cumulative PG counters, or resolves `null` when no layer exists. */
export type PgStatsReader = () => Promise<PgStats | null>;

/*
 * FNXC:PostgresPool 2026-11-06-21:23 (RUFU-483):
 * Pool OCCUPANCY is the measurement that turns "the board takes 10-30 s to paint" into a number. The
 * runtime pool ceiling was 3 until RUFU-483, so every dashboard HTTP read queued behind the engine's
 * own lane queries; the ceiling alone was never visible on any board surface, and no client-side
 * long-task profile showed it. These gauges make the constraint directly readable:
 * saturation is `fusion_postgres_pool_backends == fusion_postgres_pool_max` beside elevated request
 * latency, without a profiler.
 *
 * The read travels `pg_stat_activity` on each store's DEDICATED `max: 1` health session, never the
 * runtime pool: a probe that queued behind the pool it is measuring would be blind exactly when it
 * mattered (the same reasoning RUFU-301 put on the health transport). Only the three session classes
 * Fusion itself names are rendered, so an arbitrary `application_name` from another client of a shared
 * database can never inflate metric cardinality.
 */
/** One `pg_stat_activity` aggregate row: backends carrying one `application_name` in one state. */
export interface PoolBackendRow {
  /** Raw `pg_stat_activity.application_name` (e.g. `fusion-runtime:proj_a`). */
  applicationName: string;
  /** Raw `pg_stat_activity.state`; `null` for background workers, bucketed as `other`. */
  state: string | null;
  /** Backend count for that (application_name, state) pair. */
  count: number;
}

/** One store's pool-occupancy read: the activity rows plus that store's configured runtime ceiling. */
export interface PoolOccupancySample {
  rows: PoolBackendRow[];
  /** Resolved runtime pool ceiling from the store's async layer, when it exposes one. */
  poolMax?: number;
}

/**
 * Reads one registered store's pool occupancy. Resolves `null` when the store exposes no live async
 * layer or the read failed (privilege-fenced role, pool error) so the sampler keeps the last-known
 * values instead of throwing.
 */
export type PoolStatsReader = (store: unknown) => Promise<PoolOccupancySample | null>;

/** The Fusion-owned session classes an `application_name` may carry; anything else is not rendered. */
const POOL_SESSION_ROLES: readonly string[] = ["runtime", "health", "migration"];

/** Label value for a Fusion session that carries no project partition (admin/test/unbound pools). */
const UNBOUND_POOL_LABEL = "unbound";

/**
 * Parse a Fusion session `application_name` into its (role, project) label pair.
 *
 * Returns `null` for anything Fusion did not name: the role is a CLOSED set, because `application_name`
 * is attacker-choosable by any client of a shared PostgreSQL database and an open-set label on the
 * unauthenticated `/metrics` surface would be a cardinality and disclosure vector.
 */
export function parsePoolApplicationName(name: unknown): { role: string; project: string } | null {
  if (typeof name !== "string" || !name.startsWith("fusion-")) return null;
  const rest = name.slice("fusion-".length);
  const colon = rest.indexOf(":");
  const role = colon === -1 ? rest : rest.slice(0, colon);
  if (!POOL_SESSION_ROLES.includes(role)) return null;
  const project = colon === -1 ? "" : rest.slice(colon + 1);
  return { role, project: project.length === 0 ? UNBOUND_POOL_LABEL : project };
}

/** Bucket a raw `pg_stat_activity.state` into the rendered state labels (closed set of three). */
export function poolStateBucket(state: string | null | undefined): "active" | "idle" | "other" {
  const normalized = typeof state === "string" ? state.trim().toLowerCase() : "";
  if (normalized === "active") return "active";
  if (normalized === "idle") return "idle";
  // `idle in transaction`, `fast path function`, `disabled`, NULL (background workers).
  return "other";
}

/**
 * A slim task view: only the column is needed to count cards per column.
 * Kept narrow so tests can hand over `{ column }` objects without a real store.
 */
export interface SlimTaskLike {
  column: string;
}

/** Registry that yields the already-open project stores (injectable). */
export type RegisteredStoreRegistry = () => Array<{ projectId: string; store: unknown }>;

/** The pre-read domain snapshot a `/metrics` render reflects. */
export interface DomainSamplerState {
  /** Per-second transaction delta, or 0/last-known when unavailable. */
  pgQueriesPerSecond: number;
  /** Registered-project split by running-agent activity. */
  projectCounts: { total: number; active: number; idle: number };
  /** projectId -> number of running agents in that project's open store. */
  runningAgentsByProject: Record<string, number>;
  /** columnId -> number of tasks in that column across all registered projects. */
  columnCounts: Record<string, number>;
  /**
   * projectId -> last SUCCESSFUL pool-occupancy rows for that store. A failed read keeps the previous
   * rows (same degradation contract as the PG-rate baseline), and a store that has never been read
   * simply contributes no rows rather than a zero that would claim an observed empty pool.
   */
  poolBackendsByProject: Record<string, PoolBackendRow[]>;
  /** projectId -> that store's configured runtime pool ceiling (absent when the layer exposes none). */
  poolMaxByProject: Record<string, number>;
}

/** Constructor options (all injectable). */
export interface DomainSamplerInit {
  /** Source of already-open project stores (defaults to `listRegisteredProjectStores`). */
  registeredStores?: RegisteredStoreRegistry;
  /** Per-store running-agent counter (defaults to `countRunningAgentsInStore`). */
  countAgentsInStore?: (store: unknown) => Promise<number>;
  /**
   * Per-store slim task listing. Defaults to `defaultListTasks` above, which asks the store for
   * `listTasks({ slim: true, fields: [] })` — the empty declared field set is what keeps comment
   * text out of this 5 s read (RUFU-883).
   */
  listTasksInStore?: (store: unknown) => Promise<SlimTaskLike[]>;
  /** PG cumulative-counter reader (defaults to the store-layer `pg_stat_database` probe). */
  pgStatsReader?: PgStatsReader;
  /**
   * Per-store pool-occupancy reader (defaults to the `pg_stat_activity` probe on the store's dedicated
   * health session). RUFU-483.
   */
  poolStatsReader?: PoolStatsReader;
  /** Tick cadences in ms (defaults: PG 5s / domain 5s). */
  tick?: { pgMs?: number; domainMs?: number };
  /** A fake-timer-friendly `setInterval`/`clearInterval` surface. */
  timers?: {
    setInterval: (fn: () => void, ms: number) => { unref?: () => void };
    clearInterval: (t: { unref?: () => void }) => void;
  };
}

/** The domain sampler's public handle. */
export interface DomainSampler {
  readonly state: DomainSamplerState;
  readonly started: boolean;
  /** Read the PG rate + domain gauges into the pre-read snapshot now. */
  samplePgRate(): Promise<void>;
  /** Read the domain gauges into the pre-read snapshot now. */
  sampleDomain(): Promise<void>;
  /** Start interval timers (unref'd so they never keep the process alive). */
  start(): void;
  /** Clear interval timers and fence out any in-flight sample. */
  stopTimers(): void;
  /** Assemble the domain metric families for a scrape (synchronous, O(metric count)). */
  buildSnapshot(nowMs?: number): MetricFamily[];
}

/** Per-database cumulative counter baseline values (one entry per `pg_stat_database.datname`). */
type PgBaseline = Map<string, { xactCommit: number; xactRollback: number }>;

/**
 * Fold the per-store occupancy reads into rendered samples.
 *
 * FNXC:PostgresPool 2026-11-06-21:23 (RUFU-483):
 * N project stores sharing one PostgreSQL database each read the SAME cluster-wide `pg_stat_activity`
 * rows, so a row is claimed by the first (application name, state bucket) that reports it and every
 * sibling store's identical copy is dropped — otherwise a two-store deployment would double-count
 * every backend. Unparseable names (any client Fusion does not own) contribute nothing.
 */
function collectPoolBackendSamples(
  backendsByProject: Record<string, PoolBackendRow[]>,
): MetricSample[] {
  const claimed = new Set<string>();
  const totals = new Map<string, { project: string; role: string; state: string; count: number }>();
  for (const rows of Object.values(backendsByProject)) {
    for (const row of rows ?? []) {
      const parsed = parsePoolApplicationName(row?.applicationName);
      if (!parsed) continue;
      const bucket = poolStateBucket(row.state);
      const claimKey = `${row.applicationName}\u0000${bucket}`;
      if (claimed.has(claimKey)) continue;
      claimed.add(claimKey);
      const key = `${parsed.project}\u0000${parsed.role}\u0000${bucket}`;
      const count = Number.isFinite(row.count) && row.count >= 0 ? row.count : 0;
      const existing = totals.get(key);
      if (existing) existing.count += count;
      else totals.set(key, { project: parsed.project, role: parsed.role, state: bucket, count });
    }
  }
  return [...totals.values()].map((entry) => ({
    labelValues: [entry.project, entry.role, entry.state],
    value: entry.count,
  }));
}

/** Default timers from the global scope (fake-timer injectable). */
function defaultTimers(): DomainSamplerInit["timers"] {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms) as unknown as { unref?: () => void },
    clearInterval: (t) => clearInterval(t as unknown as ReturnType<typeof setInterval>),
  };
}

/** Default registry: the dashboard's already-open project-store cache. */
function defaultRegistry(): RegisteredStoreRegistry {
  return () => listRegisteredProjectStores() as Array<{ projectId: string; store: unknown }>;
}

/** Default per-store running-agent counter. */
async function defaultCountAgents(store: unknown): Promise<number> {
  return countRunningAgentsInStore(store as Parameters<typeof countRunningAgentsInStore>[0]);
}

/**
 * Default slim task listing through the store's public `listTasks`.
 *
 * FNXC:MetricsBoardReadPayload 2026-11-04-19:43 (RUFU-883):
 * `fields: []` is the whole point of this function. The sampler's declared need is
 * `SlimTaskLike { column: string }` — it tallies cards per column and reads nothing else — so it
 * declares that it reads NONE of the wide fields, and the SELECT stops carrying them. Before this
 * the read shipped every card's `comments` and `steeringComments` here every 5 s, for every
 * registered project, and they were discarded after `task.column` was read. Measured offline from a
 * 10.35 GiB production heap snapshot: 394 503 live copies of one steering sentence held as `text` on
 * comment records inside 37 616 arrays, hanging off 18 801 `comments` + 18 751 `steeringComments`
 * properties of hydrated rows, against a board of 2 766 live cards of which only 836 carry any
 * comment — ~22 living hydrations of every commented card. That is why the writer bound in RUFU-640
 * (2026-10-11) stopped the growth of the DATA and not the growth of the HEAP.
 *
 * `slim: true` is kept, not replaced: it is what excludes `log`, and `fields` cannot buy that column
 * back. The declared set is part of the read-shape key (RUFU-627), so this read can never be served
 * a wide row by memo or in-flight coalescing.
 */
async function defaultListTasks(store: unknown): Promise<SlimTaskLike[]> {
  const anyStore = store as {
    listTasks?: (opts: { slim: true; fields?: readonly TaskListReadField[] }) => Promise<SlimTaskLike[]>;
  };
  if (typeof anyStore.listTasks !== "function") return [];
  return anyStore.listTasks({ slim: true, fields: [] });
}

/** Default PG cumulative-counter reader. Reads `pg_stat_database` (one row per database) on the
 * first registered store that exposes a live async layer. Best-effort: a missing layer,
 * privilege-fenced PG, or pool error resolves `null` so the sampler keeps the last-known rate
 * instead of throwing.
 */
export function defaultPgStatsReader(): PgStatsReader {
  return async (): Promise<PgStats | null> => {
    const stores = listRegisteredProjectStores();
    for (const { store } of stores) {
      const layer = (store as { getAsyncLayer?: () => { db: { execute: (q: unknown) => Promise<unknown[]> } } | null }).getAsyncLayer?.();
      if (!layer) continue;
      try {
        const rows = (await layer.db.execute(
          sql.raw(`
            SELECT datname, xact_commit, xact_rollback FROM pg_stat_database
          `),
        )) as Array<{ datname: string; xact_commit: number; xact_rollback: number }>;
        if (!rows || rows.length === 0) return null;
        return rows.map((row) => ({
          datname: String(row.datname ?? ""),
          xactCommit: Number(row.xact_commit) || 0,
          xactRollback: Number(row.xact_rollback) || 0,
        }));
      } catch {
        // Privilege-fenced / transient — degrade to null, never throw.
        return null;
      }
    }
    return null;
  };
}

/**
 * Default per-store pool-occupancy reader.
 *
 * FNXC:PostgresPool 2026-11-06-21:23 (RUFU-483):
 * The probe runs on the store's **dedicated `max: 1` health session** (`layer.healthDb`), never on
 * `layer.db`: the runtime pool is exactly the resource being measured, so measuring it from inside
 * means the probe queues behind the saturation it exists to report. Best-effort like the pg-rate
 * reader: a store with no live async layer, a privilege-fenced role (embedded PG from agent sessions),
 * or a pool error resolves `null` so the sampler keeps last-known values and never throws.
 */
export function defaultPoolStatsReader(): PoolStatsReader {
  return async (store): Promise<PoolOccupancySample | null> => {
    const layer = (
      store as {
        getAsyncLayer?: () => {
          healthDb?: { execute: (q: unknown) => Promise<unknown[]> };
          poolMax?: number;
        } | null;
      }
    ).getAsyncLayer?.();
    if (!layer?.healthDb) return null;
    try {
      const rows = (await layer.healthDb.execute(
        sql.raw(`
          SELECT application_name, state, count(*)::int AS backend_count
          FROM pg_stat_activity
          WHERE application_name LIKE 'fusion-%'
          GROUP BY 1, 2
        `),
      )) as Array<{ application_name?: string; state?: string | null; backend_count?: number | string }>;
      return {
        rows: (rows ?? []).map((row) => ({
          applicationName: String(row?.application_name ?? ""),
          state: row?.state == null ? null : String(row.state),
          count: Number(row?.backend_count) || 0,
        })),
        poolMax: typeof layer.poolMax === "number" && Number.isFinite(layer.poolMax) ? layer.poolMax : undefined,
      };
    } catch {
      // Privilege-fenced / transient — degrade to null (last-known retained), never throw.
      return null;
    }
  };
}

/** Create a domain sampler. Timers are NOT started until {@link DomainSampler.start}. */
export function createDomainSampler(init: DomainSamplerInit = {}): DomainSampler {
  const registry = init.registeredStores ?? defaultRegistry();
  const countAgents = init.countAgentsInStore ?? defaultCountAgents;
  const listTasks = init.listTasksInStore ?? defaultListTasks;
  const pgReader = init.pgStatsReader ?? defaultPgStatsReader();
  const poolReader = init.poolStatsReader ?? defaultPoolStatsReader();
  const tick = { pgMs: init.tick?.pgMs ?? 5000, domainMs: init.tick?.domainMs ?? 5000 };
  const timers = init.timers ?? defaultTimers();

  const state: DomainSamplerState = {
    pgQueriesPerSecond: 0,
    projectCounts: { total: 0, active: 0, idle: 0 },
    runningAgentsByProject: {},
    columnCounts: {},
    poolBackendsByProject: {},
    poolMaxByProject: {},
  };
  let previousPg: PgBaseline | undefined;
  let previousPgAtMs: number | null = null;
  /*
   * FNXC:MetricsSampler 2026-08-18-04:20 (RUFU-081 Greptile P1, RUFU-106 review fix):
   * A failed probe marks the retained baseline STALE: a stats reset landing inside the failed
   * gap is invisible to the next successful probe (the counter may already have grown past the
   * retained total, so the cross-epoch delta would read positive), so the first success after a
   * failed gap re-baselines and keeps the last-known rate instead of emitting a fabricated rate.
   */
  let pgBaselineStale = false;
  let pgEverBaselined = false;
  /*
   * FNXC:MetricsSampler 2026-08-18-04:20 (RUFU-081 Greptile P1, RUFU-106 review fix):
   * Restart fencing: stopTimers() bumps the generation, and a sample that started before the
   * stop (its pre-close read still awaiting) must not write its stale result after the sampler
   * restarts. The in-flight guard below is factory-scoped so it SURVIVES restarts — a pre-close
   * sample still running at restart keeps blocking new ticks until it resolves (and is then
   * fenced out of the write).
   */
  let sampleGeneration = 0;
  const inFlight = new Set<string>();
  let started = false;

  const timersMap = new Map<string, { unref?: () => void }>();

  async function samplePgRate(): Promise<void> {
    const gen = sampleGeneration;
    let stats: PgStats | null = null;
    try {
      stats = await pgReader();
    } catch {
      stats = null;
    }
    // Restarted mid-sample: discard this read — its write would be stale (Greptile P1 review fix).
    if (gen !== sampleGeneration) return;
    const now = Date.now();
    if (!stats || stats.length === 0) {
      /*
       * FNXC:MetricsSampler 2026-08-16-23:35 (RUFU-081 Greptile P1 #1, RUFU-106):
       * A transient reader failure (null or thrown) must NOT reset the PG baseline. Resetting
       * `previousPg = undefined` here made the next good sample look like a FIRST sample and
       * report rate 0, even though real queries kept flowing. On failure we keep the last-known
       * `previousPg` and `state.pgQueriesPerSecond`; only a successful counter read
       * establishes/advances the baseline (a first-ever failure still leaves the rate at 0).
       */
      pgBaselineStale = true;
      return;
    }
    const current: PgBaseline = new Map();
    for (const row of stats) {
      if (typeof row?.datname !== "string" || row.datname.length === 0) continue;
      current.set(row.datname, {
        xactCommit: Number(row.xactCommit) || 0,
        xactRollback: Number(row.xactRollback) || 0,
      });
    }
    if (current.size === 0) {
      pgBaselineStale = true;
      return;
    }
    if (!previousPg || !previousPgAtMs || pgBaselineStale) {
      previousPg = current;
      previousPgAtMs = now;
      pgBaselineStale = false;
      if (!pgEverBaselined) {
        state.pgQueriesPerSecond = 0;
        pgEverBaselined = true;
      }
      // A re-baseline after a stale gap keeps the last-known rate (see pgBaselineStale comment).
      return;
    }
    const elapsedMs = now - previousPgAtMs;
    let delta = 0;
    let reset = false;
    for (const [datname, cur] of current) {
      const prev = previousPg.get(datname);
      if (!prev) continue; // database appeared mid-window: join the baseline, no delta yet
      const d = cur.xactCommit + cur.xactRollback - (prev.xactCommit + prev.xactRollback);
      if (d < 0) {
        /*
         * FNXC:MetricsSampler 2026-08-18-04:20 (RUFU-081 Greptile P1, RUFU-106 review fix):
         * A PER-DB counter went backward: a stats reset in this database. The cross-database sum
         * can stay positive when other databases grew in the same window, so an aggregate-only
         * reset check would accept the cross-epoch delta — the per-DB check is the only detector.
         */
        reset = true;
        break;
      }
      delta += d;
    }
    previousPg = current;
    previousPgAtMs = now;
    pgBaselineStale = false;
    if (reset || elapsedMs <= 0) {
      // Clock skew or a stats reset (pg_stat_reset) — keep the last-known rate.
      return;
    }
    state.pgQueriesPerSecond = (delta / elapsedMs) * 1000;
  }

  async function sampleDomain(): Promise<void> {
    const gen = sampleGeneration;
    // Registry entries are keyed by projectId; dedupe so a duplicate/undefined
    // project id can never produce duplicate or malformed metric lines.
    const entries = new Map<string, { store: unknown }>();
    for (const entry of registry()) {
      const projectId = entry?.projectId;
      if (typeof projectId !== "string" || projectId.length === 0) continue;
      // First registration of a project id is canonical; later duplicates are
      // dropped so a duplicate id can never double-count a column or an agent.
      if (!entries.has(projectId)) entries.set(projectId, { store: entry.store });
    }
    // Use the deduped keys so both per-project and aggregate counts agree.
    const projectIds = [...entries.keys()];
    const runningByProject: Record<string, number> = {};
    const columnCounts: Record<string, number> = {};
    /*
     * RUFU-483 pool occupancy, keyed per project so a failed read keeps THAT store's last-known rows
     * and a store that left the registry contributes nothing (a closed store must never leave ghost
     * backends behind).
     */
    const poolSamples = new Map<string, PoolOccupancySample | null>();

    await Promise.all(
      projectIds.map(async (projectId) => {
        const { store } = entries.get(projectId)!;
        let running = 0;
        try {
          running = await countAgents(store);
        } catch {
          running = 0;
        }
        runningByProject[projectId] = running;

        let poolSample: PoolOccupancySample | null = null;
        try {
          poolSample = await poolReader(store);
        } catch {
          poolSample = null;
        }
        poolSamples.set(projectId, poolSample);

        let tasks: SlimTaskLike[] = [];
        try {
          tasks = await listTasks(store);
        } catch {
          tasks = [];
        }
        for (const task of tasks) {
          // Each slim task row contributes one card to its column. Column ids
          // are strings; guard against undefined/malformed rows.
          const column = task?.column;
          if (typeof column !== "string" || column.length === 0) continue;
          columnCounts[column] = (columnCounts[column] ?? 0) + 1;
        }
      }),
    );

    // Restarted mid-sample: discard this read — its write would be stale (Greptile P1 review fix).
    if (gen !== sampleGeneration) return;

    /*
     * FNXC:PostgresPool 2026-11-06-21:23 (RUFU-483): the mirror of the pg-rate degradation contract —
     * a failed occupancy read keeps the last-known rows for THAT store rather than zeroing them, so a
     * transient privilege fence or pool error never renders "the pool emptied". A first-ever failure
     * has nothing to retain, and that store simply renders no backend rows (never a malformed line).
     */
    const nextBackends: Record<string, PoolBackendRow[]> = {};
    const nextMaxima: Record<string, number> = {};
    for (const projectId of projectIds) {
      const observed = poolSamples.get(projectId);
      if (observed) {
        nextBackends[projectId] = observed.rows;
        if (typeof observed.poolMax === "number" && Number.isFinite(observed.poolMax)) {
          nextMaxima[projectId] = observed.poolMax;
        } else if (typeof state.poolMaxByProject[projectId] === "number") {
          nextMaxima[projectId] = state.poolMaxByProject[projectId];
        }
        continue;
      }
      if (state.poolBackendsByProject[projectId]) {
        nextBackends[projectId] = state.poolBackendsByProject[projectId];
      }
      if (typeof state.poolMaxByProject[projectId] === "number") {
        nextMaxima[projectId] = state.poolMaxByProject[projectId];
      }
    }
    state.poolBackendsByProject = nextBackends;
    state.poolMaxByProject = nextMaxima;

    const total = projectIds.length;
    const active = projectIds.filter((id) => (runningByProject[id] ?? 0) > 0).length;
    state.runningAgentsByProject = runningByProject;
    state.columnCounts = columnCounts;
    state.projectCounts = { total, active, idle: total - active };
  }

  function start(): void {
    if (started) return;
    started = true;
    /*
     * FNXC:MetricsSampler 2026-08-17-01:01 (RUFU-081 Greptile P1 #2, RUFU-106):
     * In-flight flags are FACTORY-SCOPED (not created here) so the guard survives a
     * stopTimers()+start() restart: a sample still running from before the restart keeps
     * blocking ticks of the same arm until it resolves, where it is fenced out of its write
     * by the generation check (Greptile P1 review fix 2026-08-18).
     */
    const arm = (key: string, intervalMs: number, run: () => Promise<void>): void => {
      const timer = timers!.setInterval(() => {
        /*
         * FNXC:MetricsSampler 2026-08-17-01:01 (RUFU-081 Greptile P1 #2, RUFU-106):
         * An async sample that outlasts its interval must never overlap the next tick. If this
         * sampler's previous run is still awaiting, skip the tick entirely; otherwise set the flag,
         * run the sample, and clear it in `finally` so the next interval arm is armed again.
         */
        if (inFlight.has(key)) return;
        inFlight.add(key);
        void run()
          .catch(() => undefined)
          .finally(() => inFlight.delete(key));
      }, intervalMs);
      timer.unref?.();
      timersMap.set(key, timer);
    };
    arm("pg", tick.pgMs, samplePgRate);
    arm("domain", tick.domainMs, sampleDomain);
  }

  function stopTimers(): void {
    started = false;
    // Fence out any in-flight sample: it started before this stop, so its write (if it
    // resolves after a restart) must be discarded (Greptile P1 review fix 2026-08-18).
    sampleGeneration += 1;
    /*
     * FNXC:MetricsSampler 2026-08-18-11:53 (RUFU-081 Greptile P1, RUFU-106 review fix):
     * The retained PG baseline is STALE on stop too: if PostgreSQL statistics reset during
     * the stop gap, counters regrow past the retained totals and the first post-restart
     * success would emit a cross-epoch delta as a positive rate. Marking the baseline stale
     * makes the first post-restart success re-baseline and keep the last-known rate.
     */
    pgBaselineStale = true;
    for (const key of [...timersMap.keys()]) {
      const timer = timersMap.get(key);
      if (timer) {
        try {
          timers!.clearInterval(timer);
        } catch {
          /* ignore */
        }
        timersMap.delete(key);
      }
    }
  }

  function buildSnapshot(_nowMs?: number): MetricFamily[] {
    const families: MetricFamily[] = [];

    // ── PostgreSQL query rate ──────────────────────────────────────────────
    families.push({
      name: "fusion_domain_postgres_queries_per_second",
      help: "PostgreSQL transaction rate (xact_commit + xact_rollback delta per second); degrades to last-known when unreadable",
      type: "gauge",
      samples: [{ value: state.pgQueriesPerSecond }],
    });

    // ── Project + running-agent counts ─────────────────────────────────────
    families.push({
      name: "fusion_domain_projects_total",
      help: "Registered open projects (already-open stores only)",
      type: "gauge",
      samples: [{ value: state.projectCounts.total }],
    });
    families.push({
      name: "fusion_domain_projects_active",
      help: "Registered projects currently running at least one agent",
      type: "gauge",
      samples: [{ value: state.projectCounts.active }],
    });
    families.push({
      name: "fusion_domain_projects_idle",
      help: "Registered projects running zero agents (idle/unpaused park)",
      type: "gauge",
      samples: [{ value: state.projectCounts.idle }],
    });
    const agentProjectSamples = Object.entries(state.runningAgentsByProject).map(([projectId, count]) => ({
      labelValues: [projectId],
      value: count,
    }));
    families.push({
      name: "fusion_domain_project_running_agents",
      help: "Running agents per registered project",
      type: "gauge",
      labels: ["project"],
      samples: agentProjectSamples,
    });

    // ── Board task counts per column ───────────────────────────────────────
    const columnSamples = Object.entries(state.columnCounts).map(([column, count]) => ({
      labelValues: [column],
      value: count,
    }));
    families.push({
      name: "fusion_domain_board_tasks",
      help: "Tasks per board column across all registered projects",
      type: "gauge",
      labels: ["column"],
      samples: columnSamples,
    });

    /*
     * ── PostgreSQL pool occupancy (RUFU-483) ──────────────────────────────
     * The measurement that answers "why is the board slow?" without a profiler: a runtime pool whose
     * every slot is busy IS the reason a one-row dashboard read can be slower than a hundred-row one.
     * Read = the observed backend buckets equal the configured ceiling, next to elevated request
     * latency. Absence of a row is NOT headroom — see docs/diagnostics.md.
     */
    families.push({
      name: "fusion_postgres_pool_backends",
      help: "Fusion PostgreSQL backends in pg_stat_activity per session class and state (read on the dedicated health session; a read failure keeps the last-known values)",
      type: "gauge",
      labels: ["project", "role", "state"],
      samples: collectPoolBackendSamples(state.poolBackendsByProject),
    });
    const poolMaxSamples = Object.entries(state.poolMaxByProject).map(([projectId, max]) => ({
      labelValues: [projectId, "runtime"],
      value: max,
    }));
    families.push({
      name: "fusion_postgres_pool_max",
      help: "Configured runtime pool ceiling per registered store (excludes the dedicated max-one health/migration sessions); a store refused at startup by a connection quota contributes no row",
      type: "gauge",
      labels: ["project", "role"],
      samples: poolMaxSamples,
    });

    return families;
  }

  return {
    state,
    get started() {
      return started;
    },
    samplePgRate,
    sampleDomain,
    start,
    stopTimers,
    buildSnapshot,
  };
}