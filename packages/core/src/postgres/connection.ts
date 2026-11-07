/**
 * PostgreSQL connection management.
 *
 * FNXC:PostgresConnection 2026-06-24-01:55:
 * Manages the Drizzle connection pool backed by postgres.js, with the
 * DATABASE_MIGRATION_URL split for pooled runtime connections.
 *
 * Two connections may exist:
 *   1. Runtime pool — serves all normal queries. Uses DATABASE_URL (or the
 *      embedded lifecycle's resolved URL). May be a pooled/pooler connection.
 *   2. Migration connection — a direct (non-pooled) connection for schema work
 *      (DDL, migrations). Uses DATABASE_MIGRATION_URL when set, else the runtime
 *      URL. Always `prepare: false` so it works under transaction poolers.
 *
 * When the runtime URL is a transaction pooler and no migration URL is set,
 * runtime prepared statements are disabled automatically and a warning is
 * emitted (VAL-CONN-008). When a migration URL is set, runtime keeps prepared
 * statements enabled (the migration URL handles the DDL).
 *
 * The runtime pool disables prepared statements if the URL looks like a pooler,
 * because a pooler in transaction mode cannot safely cache prepared statements
 * across connections.
 */

import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createLogger } from "../process/logger.js";
import {
  resolveBackend,
  type ResolvedBackend,
  looksLikePoolerUrl,
  poolerWarning,
  describeBackendForLog,
} from "./backend-resolver.js";
import { redactCredentialsFromMessage, redactConnectionString } from "./credential-redact.js";
import { healthSessionStatementTimeoutMs } from "./health-probe-budget.js";

const log = createLogger("postgres-connection");

/**
 * FNXC:PostgresConnection 2026-06-24-01:55:
 * Connection pool sizing. Fusion's workload is primarily short transactional
 * queries, so one shared runtime pool serves every lane. It can be tuned via
 * `FUSION_PG_POOL_MAX`; the value below is the shipped default.
 */
/*
FNXC:PostgresPool 2026-11-06-21:23 (RUFU-483):
The shipped default used to be 3, which made the whole dashboard API queue behind the engine.
Measured on the production RunFusion dashboard (same build, same board, restart only adding
`FUSION_PG_POOL_MAX=20`): `GET /tasks/page?limit=100` went 10.8-17.1 s -> 3.3-3.9 s and
`GET /tasks/board-workflows` went 26-32 s -> 4.3-9.8 s. The wait was connection queueing, not query
cost: `limit=1` measured SLOWER than `limit=100` (13.1 s vs 10.8-17.1 s), the same page in `psql`
cost 0.110 s, `GET /settings/global` answered in 0.01 s while a slow page request was still running
(the event loop was not saturated), and PostgreSQL itself sat idle with 98 backends in `ClientRead`.

Sizing is the documented default engine-lane footprint on one runtime plus dashboard headroom:
`maxConcurrent` executors (default 2, `config/settings-schema.ts`) + the planning lane + the
plan-review lane + the code-review lane + the merge lane + scheduler/heartbeat housekeeping = 7
concurrent lane queries, and 10 leaves >= 3 slots for dashboard HTTP reads. 20 measured better on a
busy single-project server and stays documented opt-in guidance, but is not the default because of
the multiplication below: N project runtimes each own a pool of `poolMax + migration(1) + health(1)`
sessions, and 10 per store keeps a multi-project deployment viable against the win32 embedded default
cap of 150 (`DEFAULT_EMBEDDED_MAX_CONNECTIONS_WIN32`) and the [32, 2000] `embeddedPostgresMaxConnections`
clamp, where 20 per store makes even two stores uncomfortably tight at the minimum clamp.

FNXC:PostgresPool 2026-11-06-21:23 (RUFU-483) - the trade-off this retires:
The previous value was justified as "external databases frequently impose a low connection quota";
raising the default retires that protection and CHANGES THE FAILURE MODE on a server whose role or
database quota is smaller than `stores x (poolMax + 2)`. Such a deployment used to queue every query
slowly (slow dashboard, nothing refused); it can now be refused outright at connect time (`FATAL: sorry,
too many connections for connection pool`, a reserved-slot refusal, or a role-connection-limit refusal),
which surfaces as store-open / startup failure rather than latency. The remedy is one environment value:
set `FUSION_PG_POOL_MAX` lower until `stores x (poolMax + 2)` fits the quota (the existing 1..500 range
allows it), and read the resolved ceiling from the external-mode startup log line or from the
`fusion_postgres_pool_max` / `fusion_postgres_pool_backends` gauges on `/metrics`.
*/
export const DEFAULT_POOL_MAX = 10;
export const FUSION_PG_POOL_MAX_ENV = "FUSION_PG_POOL_MAX";
const MIN_POOL_MAX = 1;
const MAX_POOL_MAX = 500;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 20;

/** Schema type placeholder until the Drizzle schema (U3) is defined. */
type AnySchema = Record<string, never>;

/**
 * Options for creating the connection manager. Allows tests to override env
 * without mutating process.env.
 */
export interface CreateConnectionOptions {
  readonly backend?: ResolvedBackend;
  readonly poolMax?: number;
  /** Injected process environment for deterministic runtime-pool configuration. */
  readonly env?: NodeJS.ProcessEnv;
  readonly connectTimeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;
  readonly onWarning?: (message: string) => void;
  /** FNXC:ProjectDataIsolation 2026-07-14-14:25: Bind runtime queries to one project partition. */
  readonly projectId?: string;
  /** FNXC:ProjectDataIsolation 2026-07-14-14:25: Permit intentional schema/migration/cross-project administration. */
  readonly bypassProjectIsolation?: boolean;
  /** FNXC:ProjectDataIsolation 2026-07-14-14:25: Use the non-superuser role only after startup proves it exists and is grantable. */
  readonly useRuntimeRole?: boolean;
}

/** A live PostgreSQL connection set with runtime + migration Drizzle instances. */
export interface PostgresConnections {
  /** Drizzle instance for runtime queries (may use a pooled connection). */
  readonly runtime: PostgresJsDatabase<AnySchema>;
  /**
   * Drizzle instance for schema/migration work (direct connection, no pooler).
   * May be the same underlying connection as runtime when no migration URL split
   * is configured.
   */
  readonly migration: PostgresJsDatabase<AnySchema>;
  /** Dedicated max-one Drizzle instance for readiness and integrity reads. */
  readonly health: PostgresJsDatabase<AnySchema>;
  /** The resolved backend descriptor. */
  readonly backend: ResolvedBackend;
  /**
   * FNXC:PostgresPool 2026-11-06-21:23 (RUFU-483): The resolved runtime pool
   * ceiling actually applied to the runtime set. Exposed so an occupancy gauge
   * can state the denominator next to the observed backend count, and so a
   * connection-quota refusal is attributable to the number that caused it.
   * Dedicated health/migration sessions are `max: 1` and are NOT part of it.
   */
  readonly poolMax: number;
  /** Close all underlying connections. */
  close(): Promise<void>;
  /** Run a health-check query against the dedicated health connection. */
  ping(): Promise<void>;
}

/**
 * Error thrown when the database connection fails at startup.
 *
 * FNXC:PostgresConnection 2026-06-24-02:00:
 * Unreachable DATABASE_URL must produce a clear, actionable error and non-zero
 * exit (VAL-CONN-004). The error message redacts credentials so the password
 * is never exposed even in crash logs.
 */
export class DatabaseConnectionError extends Error {
  readonly cause: unknown;
  readonly safeUrl: string;

  constructor(url: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `Cannot connect to PostgreSQL at ${redactConnectionString(url)}: ` +
        `${redactCredentialsFromMessage(reason)}`,
    );
    this.name = "DatabaseConnectionError";
    this.cause = cause;
    this.safeUrl = redactConnectionString(url);
  }
}

/**
 * Create the PostgreSQL connection set from environment variables.
 *
 * Resolves the backend, creates the runtime and migration postgres.js
 * connections, wraps them in Drizzle, and verifies connectivity.
 *
 * Throws `DatabaseConnectionError` (with redacted credentials) if the initial
 * connection probe fails — the caller should exit non-zero.
 *
 * In embedded mode (DATABASE_URL unset), this throws because the connection
 * URL is not yet known — the embedded lifecycle feature must start Postgres
 * first and then call `createConnectionSetFromUrl` with the resolved URL.
 */
export async function createConnectionSet(
  env: NodeJS.ProcessEnv = process.env,
  options: CreateConnectionOptions = {},
): Promise<PostgresConnections> {
  const backend = options.backend ?? resolveBackend(env);

  if (backend.mode === "embedded") {
    // Embedded mode: the URL is provided by the embedded lifecycle (U2).
    // This connection layer does not start the embedded instance itself.
    throw new Error(
      "Cannot create a connection set in embedded mode without a resolved URL. " +
        "The embedded lifecycle (DATABASE_URL unset) must start Postgres first " +
        "and provide the connection URL via createConnectionSetFromUrl().",
    );
  }

  // External mode requires a runtime URL.
  if (!backend.runtimeUrl) {
    throw new Error(
      "External backend resolved but runtimeUrl is null. This is an internal error.",
    );
  }

  return createConnectionSetFromUrl(backend, { ...options, env });
}

/**
 * Create the connection set from an already-resolved backend (used by the
 * embedded lifecycle after it starts the bundled Postgres).
 */
export async function createConnectionSetFromUrl(
  backend: ResolvedBackend,
  options: CreateConnectionOptions = {},
): Promise<PostgresConnections> {
  const poolMax = resolvePoolMax(options);
  const connectTimeout = options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS;
  const idleTimeout = options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
  const onWarning = options.onWarning ?? ((msg: string) => log.warn(msg));

  // FNXC:PostgresTuiLogging 2026-07-15-14:52: Embedded PostgreSQL is the
  // default zero-config backend, so its already-resolved connection details
  // are routine startup noise in the TUI. Keep external target diagnostics.
  //
  // FNXC:PostgresPool 2026-11-06-21:23 (RUFU-483): the resolved runtime pool
  // ceiling rides on this line so a `too many connections` / reserved-slot /
  // role-limit refusal sitting next to it in the same startup output names the
  // number that caused it. Log text is deliberately not test-pinned; the tested
  // surface is the exposed `poolMax` on the connection set.
  if (backend.mode === "external") {
    log.log(`${describeBackendForLog(backend)} runtimePoolMax=${poolMax}`);
  }

  // Emit pooler warning if applicable (VAL-CONN-008).
  const warning = poolerWarning(backend);
  if (warning) {
    onWarning(warning);
  }

  // FNXC:ProjectDataIsolation 2026-07-14-12:10:
  // External and embedded databases may safely host multiple projects because
  // forced RLS partitions every project-owned table at the session boundary.

  const runtimeUrl = backend.runtimeUrl;
  if (!runtimeUrl) {
    throw new Error(
      "Cannot create connection set: backend.runtimeUrl is null. " +
        "Ensure the embedded lifecycle has provided a URL or DATABASE_URL is set.",
    );
  }

  // Determine whether to use prepared statements in the runtime pool.
  // Disable when the URL is a pooler and no migration URL split is configured.
  const runtimeIsPooler = looksLikePoolerUrl(runtimeUrl);
  const runtimePrepare = backend.migrationUrlOverridden ? true : !runtimeIsPooler;

  /*
  FNXC:ProjectDataIsolation 2026-07-14-12:10:
  PostgreSQL row-level security reads these startup parameters on every pooled session. Production project runtimes must provide projectId; unbound maintenance and existing test/admin callers default to the explicit bypass while the migration connection always bypasses isolation.
  */
  const runtimeConnectionParameters = options.projectId
    ? {
        ...(options.useRuntimeRole ? { role: "fusion_runtime" } : {}),
        "fusion.project_id": options.projectId,
      }
    : options.bypassProjectIsolation === false
      ? {}
      : { "fusion.project_bypass": "on" };

  /*
  FNXC:PostgresPool 2026-11-06-21:23 (RUFU-483):
  Every Fusion backend self-reports WHICH Fusion session class (and which project) opened it, so a
  `too many connections` refusal or an unexpected `pg_stat_activity` backlog names its owner instead of
  requiring a profiler, and so the `/metrics` occupancy gauges can be computed per store from
  `pg_stat_activity` without any per-project schema access. The values are deliberately prefixed
  `fusion-` so one `LIKE 'fusion-%'` predicate captures all Fusion traffic. Attribution rides NEXT TO the
  RLS parameters and changes none of them: `fusion.project_id` / `fusion.project_bypass` /
  `role: fusion_runtime` keep their exact per-session sets, and the health and migration sessions carry
  their OWN name (not the runtime one) because they are separate `max: 1` sessions, not pool members.
  */
  const projectSuffix = options.projectId ? `:${options.projectId}` : "";
  const runtimeApplicationName = `fusion-runtime${projectSuffix}`;
  const healthApplicationName = `fusion-health${projectSuffix}`;

  const runtimeSql = postgres(runtimeUrl, {
    max: poolMax,
    connect_timeout: connectTimeout,
    idle_timeout: idleTimeout,
    prepare: runtimePrepare,
    connection: { ...runtimeConnectionParameters, application_name: runtimeApplicationName },
    // Suppress the default onnotice (which logs to console.log) to avoid
    // leaking connection-parameter notices that might contain sensitive info.
    onnotice: () => {},
  });
  const runtimeDb = drizzle(runtimeSql);

  /*
  FNXC:PostgresHealthTransport 2026-09-23-02:09:
  Readiness and task-ID integrity must remain observable while scheduler work
  exhausts the runtime pool. This separately owned, max-one session retains
  the runtime target, pooler policy, and project/RLS binding without becoming
  a general query surface or a per-request connection.

  FNXC:PostgresHealthTransport 2026-09-26-00:45 (RUFU-301):
  Because the session is max-one, a probe the caller abandoned at its deadline
  used to stay active on it: pg_stat_activity showed `SELECT id FROM project.tasks`
  still running 5.0 s after the health call returned, and the next two polls then
  failed in the *earlier* connectivity stage because their `SELECT 1` queued behind
  that orphan. The session now carries a server-side `statement_timeout` below the
  probe budget, so PostgreSQL cancels the statement itself. Measured against an
  ACCESS EXCLUSIVE lock on project.tasks: cancelled at 1504 ms against a 1500 ms
  cap, 0 queries left on the session, next statement served in 1 ms, and a
  legitimate 20k-row read unaffected at 15 ms.
  */
  const healthSql = postgres(runtimeUrl, {
    max: 1,
    connect_timeout: connectTimeout,
    idle_timeout: idleTimeout,
    prepare: runtimePrepare,
    connection: {
      ...runtimeConnectionParameters,
      application_name: healthApplicationName,
      statement_timeout: healthSessionStatementTimeoutMs(),
    },
    onnotice: () => {},
  });
  const healthDb: PostgresJsDatabase<AnySchema> = drizzle(healthSql);

  // Migration connection: use DATABASE_MIGRATION_URL if set, else runtime URL.
  // Always prepare: false for migration work (DDL under a pooler must not use
  // prepared statements).
  const migrationUrl = backend.migrationUrl ?? runtimeUrl;
  /*
  FNXC:PostgresMigrationSession 2026-07-14-00:05:
  Migration work always owns a dedicated single-connection pool, even when runtime and migration URLs match. Session advisory locks and session_replication_role must cover the same backend session for the entire copy and must never leak trigger-disabled state into runtime traffic.
  */
  const migrationSql = postgres(migrationUrl, {
    max: 1,
    connect_timeout: connectTimeout,
    idle_timeout: idleTimeout,
    prepare: false,
    connection: { "fusion.project_bypass": "on", application_name: "fusion-migration" },
    onnotice: () => {},
  });
  const migrationDb: PostgresJsDatabase<AnySchema> = drizzle(migrationSql);

  let closePromise: Promise<void> | undefined;
  const connections: PostgresConnections = {
    runtime: runtimeDb,
    migration: migrationDb,
    health: healthDb,
    backend,
    poolMax,
    close() {
      closePromise ??= (async () => {
        await Promise.allSettled([
          migrationSql.end({ timeout: 5 }),
          healthSql.end({ timeout: 5 }),
          runtimeSql.end({ timeout: 5 }),
        ]);
      })();
      return closePromise;
    },
    async ping() {
      await healthSql`SELECT 1`;
    },
  };

  return connections;
}

/** Resolve the normal runtime capacity without coercing invalid operator input. */
export function resolvePoolMax(options: CreateConnectionOptions = {}): number {
  if (options.poolMax !== undefined) return options.poolMax;
  const raw = options.env?.[FUSION_PG_POOL_MAX_ENV] ?? process.env[FUSION_PG_POOL_MAX_ENV];
  if (raw === undefined) return DEFAULT_POOL_MAX;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (trimmed !== "" && Number.isInteger(value) && value >= MIN_POOL_MAX && value <= MAX_POOL_MAX) return value;
  (options.onWarning ?? ((msg: string) => log.warn(msg)))(
    `${FUSION_PG_POOL_MAX_ENV} must be an integer from ${MIN_POOL_MAX} through ${MAX_POOL_MAX}; using default ${DEFAULT_POOL_MAX}`,
  );
  return DEFAULT_POOL_MAX;
}

/**
 * Verify that a connection URL is reachable. Used as a startup precondition
 * (VAL-CONN-004: unreachable DATABASE_URL fails loudly).
 *
 * Throws `DatabaseConnectionError` with redacted credentials on failure.
 */
export async function verifyConnection(
  url: string,
  timeoutSeconds = DEFAULT_CONNECT_TIMEOUT_SECONDS,
): Promise<void> {
  const sql = postgres(url, {
    max: 1,
    connect_timeout: timeoutSeconds,
    idle_timeout: 1,
    prepare: false,
    onnotice: () => {},
  });
  try {
    await sql`SELECT 1`;
  } catch (error) {
    throw new DatabaseConnectionError(url, error);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export { redactConnectionString };
