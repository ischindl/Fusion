import { describe, it, expect, afterEach, afterAll } from "vitest";
import {
  createConnectionSet,
  createConnectionSetFromUrl,
  verifyConnection,
  DatabaseConnectionError,
  resolvePoolMax,
  DEFAULT_POOL_MAX,
  type ResolvedBackend,
} from "../../postgres/connection.js";
import { resolveBackendWithOptions } from "../../postgres/backend-resolver.js";
import { redactConnectionString } from "../../postgres/credential-redact.js";
import { DEFAULT_PROJECT_SETTINGS } from "../../config/settings-schema.js";

// FNXC:PgTestAuthFix 2026-07-14-07:35:
// Use FUSION_PG_TEST_URL_BASE (which includes credentials on CI) instead of the
// bare FUSION_PG_TEST_URL default that omits user/password, causing postgres.js
// to fall back to the OS user ('runner' on GitHub Actions) and fail auth.
const PG_TEST_URL =
  process.env.FUSION_PG_TEST_URL ??
  `${process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432"}/postgres`;

const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL);

/*
FNXC:PostgresPool 2026-11-06-21:23 (RUFU-483):
`resolvePoolMax` deliberately falls through to `process.env` when `options.env` does not carry the key
(`options.env?.[KEY] ?? process.env[KEY]`), so every assertion in this file about the SHIPPED default is
only meaningful with an ambient value out of the way. A deployment that already exports
`FUSION_PG_POOL_MAX` — the production RunFusion host does, at 8 — would otherwise turn "no override
resolves to the default" into "no override resolves to whatever this operator happened to set", which is
exactly the vacuous-guard shape RUFU-483's regression must not inherit. Snapshot, clear for this file,
restore in `afterAll` so no sibling file inherits the mutation.
*/
const AMBIENT_POOL_MAX = process.env.FUSION_PG_POOL_MAX;
delete process.env.FUSION_PG_POOL_MAX;
afterAll(() => {
  if (AMBIENT_POOL_MAX !== undefined) process.env.FUSION_PG_POOL_MAX = AMBIENT_POOL_MAX;
});

/**
 * Helper: skip tests when no PostgreSQL is reachable. The existing Homebrew
 * instance on localhost:5432 is the default; set FUSION_PG_TEST_URL to point
 * elsewhere, or FUSION_PG_TEST_SKIP=1 to skip integration tests.
 */
const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

describe("connection: runtime pool configuration", () => {
  /*
   * FNXC:PostgresPool 2026-11-06-21:23 (RUFU-483): the shipped default used to be 3, which put every
   * dashboard HTTP read in the same three-connection queue the engine lanes occupy. The production
   * measurement is in `connection.ts`; this is the part of it that must NEVER depend on PostgreSQL,
   * because a pg-only guard is skipped into vacuity wherever the pg suite is skipped. The headroom
   * bound is derived from the settings-schema executor default plus the four documented extra lane
   * families, so raising `maxConcurrent` widens the requirement instead of silently invalidating it.
   */
  it("ships a default above the legacy 3 and above the documented engine-lane footprint", () => {
    /** The value that caused the 10.8-17.1 s / 26-32 s board paints reported in RUFU-483. */
    const LEGACY_DEFAULT_POOL_MAX = 3;
    // (a) the constant really moved off the buggy value.
    expect(DEFAULT_POOL_MAX).toBeGreaterThan(LEGACY_DEFAULT_POOL_MAX);
    // (b) at least 3 slots of dashboard-read headroom over the legacy ceiling — the margin the
    // measured relief (limit=1 13.1 s -> 0.5-3.0 s) is attributable to.
    expect(DEFAULT_POOL_MAX).toBeGreaterThanOrEqual(LEGACY_DEFAULT_POOL_MAX + 3);
    // (c) the default covers the documented lane footprint it was sized against:
    //   - `maxConcurrent` executor lanes (settings-schema default 2),
    //   - the planning lane,
    //   - the plan-review lane,
    //   - the code-review lane,
    //   - the merge lane,
    //   - scheduler + heartbeat housekeeping queries.
    const documentedLaneFootprint =
      DEFAULT_PROJECT_SETTINGS.maxConcurrent /* executor lanes */ +
      1 /* planning */ +
      1 /* plan-review */ +
      1 /* code-review */ +
      1 /* merge */ +
      1 /* scheduler/heartbeat housekeeping */;
    expect(DEFAULT_POOL_MAX).toBeGreaterThanOrEqual(documentedLaneFootprint + 3);
    // The headroom is what the guard is about; state it so a future trim to the bare footprint
    // (which reintroduces dashboard queueing) fails here rather than in a slow dashboard.
    expect(DEFAULT_POOL_MAX - documentedLaneFootprint).toBeGreaterThanOrEqual(3);
  });

  it("uses default, valid environment, and explicit override precedence", () => {
    expect(resolvePoolMax({ env: {} })).toBe(DEFAULT_POOL_MAX);
    expect(resolvePoolMax({ env: { FUSION_PG_POOL_MAX: "12" } })).toBe(12);
    expect(resolvePoolMax({ poolMax: 7, env: { FUSION_PG_POOL_MAX: "12" } })).toBe(7);
  });

  it.each(["", "1.5", "nope", "0", "-1", "501"])("warns and falls back for invalid environment value %j", (value) => {
    const warnings: string[] = [];
    expect(resolvePoolMax({ env: { FUSION_PG_POOL_MAX: value }, onWarning: (message) => warnings.push(message) }))
      .toBe(DEFAULT_POOL_MAX);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("FUSION_PG_POOL_MAX");
  });
});

describe("connection: createConnectionSet (embedded mode guard)", () => {
  it("throws in embedded mode without a resolved URL", async () => {
    await expect(createConnectionSet({})).rejects.toThrow(/embedded mode/);
  });
});

describe("connection: DatabaseConnectionError credential redaction (VAL-CONN-004, VAL-CONN-005)", () => {
  it("error message redacts the password from the URL", () => {
    const url = "postgresql://admin:s3cr3tP@ss@badhost.invalid:5432/fusion";
    const err = new DatabaseConnectionError(url, new Error("ECONNREFUSED"));
    expect(err.message).not.toContain("s3cr3tP@ss");
    expect(err.message).toContain("********");
    expect(err.message).toContain("ECONNREFUSED");
    expect(err.message).toContain("badhost.invalid");
  });

  it("error message redacts passwords from the cause message too", () => {
    const url = "postgresql://admin:hunter2@10.0.0.99:5432/db";
    const cause = new Error("Connection to postgresql://admin:hunter2@10.0.0.99:5432/db refused");
    const err = new DatabaseConnectionError(url, cause);
    expect(err.message).not.toContain("hunter2");
    expect(err.message).toContain("refused");
  });

  it("safeUrl property is redacted", () => {
    const url = "postgresql://admin:pw@host:5432/db";
    const err = new DatabaseConnectionError(url, new Error("fail"));
    expect(err.safeUrl).not.toContain(":pw@");
    expect(err.safeUrl).toContain("********");
  });
});

describe("connection: verifyConnection fails loudly for unreachable URLs (VAL-CONN-004)", () => {
  it("throws DatabaseConnectionError for an unreachable host", async () => {
    const badUrl = "postgresql://nobody:nobody@127.0.0.1:1/nonexistent";
    await expect(verifyConnection(badUrl, 2)).rejects.toThrow(DatabaseConnectionError);
  });

  it("the thrown error does not contain the password", async () => {
    const password = "superSecretPassword123";
    const badUrl = `postgresql://nobody:${password}@127.0.0.1:1/nonexistent`;
    try {
      await verifyConnection(badUrl, 2);
      expect.fail("Should have thrown");
    } catch (error) {
      const err = error as Error;
      expect(err.message).not.toContain(password);
    }
  });
});

pgDescribe("connection: external PostgreSQL integration (VAL-CONN-002)", () => {
  let connections: Awaited<ReturnType<typeof createConnectionSetFromUrl>> | null = null;

  afterEach(async () => {
    if (connections) {
      await connections.close();
      connections = null;
    }
  });

  it("connects to the external PostgreSQL and ping succeeds", async () => {
    const backend: ResolvedBackend = {
      mode: "external",
      runtimeUrl: PG_TEST_URL,
      migrationUrl: PG_TEST_URL,
      migrationUrlOverridden: false,
    };
    connections = await createConnectionSetFromUrl(backend, { poolMax: 2, connectTimeoutSeconds: 5 });
    await connections.ping();
  });

  it("runtime and migration Drizzle instances are usable", async () => {
    const backend: ResolvedBackend = {
      mode: "external",
      runtimeUrl: PG_TEST_URL,
      migrationUrl: PG_TEST_URL,
      migrationUrlOverridden: false,
    };
    connections = await createConnectionSetFromUrl(backend, { poolMax: 2, connectTimeoutSeconds: 5 });
    // Execute a simple query via the Drizzle runtime instance.
    const result = await connections.runtime.execute("SELECT 1 as val");
    expect(result).toBeDefined();
  });

  it("reserves dedicated health and migration work outside the runtime pool", async () => {
    const backend: ResolvedBackend = {
      mode: "external",
      runtimeUrl: PG_TEST_URL,
      migrationUrl: PG_TEST_URL,
      migrationUrlOverridden: false,
    };
    connections = await createConnectionSetFromUrl(backend, { poolMax: 1, connectTimeoutSeconds: 5 });
    const runtimeRows = await connections.runtime.execute("SELECT pg_backend_pid() AS pid") as unknown as Array<{ pid: number }>;
    const healthRows = await connections.health.execute("SELECT pg_backend_pid() AS pid") as unknown as Array<{ pid: number }>;
    const migrationRows = await connections.migration.execute("SELECT pg_backend_pid() AS pid") as unknown as Array<{ pid: number }>;
    expect(new Set([runtimeRows[0]?.pid, healthRows[0]?.pid, migrationRows[0]?.pid]).size).toBe(3);
  });

  it("keeps health probes available while the one-slot runtime pool is busy", async () => {
    const backend: ResolvedBackend = {
      mode: "external",
      runtimeUrl: PG_TEST_URL,
      migrationUrl: PG_TEST_URL,
      migrationUrlOverridden: false,
    };
    connections = await createConnectionSetFromUrl(backend, { poolMax: 1, connectTimeoutSeconds: 5 });
    const heldRuntime = connections.runtime.execute("SELECT pg_sleep(0.2)");
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(connections.ping()).resolves.toBeUndefined();
    await expect(connections.health.execute("SELECT 1")).resolves.toBeDefined();
    await heldRuntime;
  });

  it("reserves migration work on a session separate from the runtime pool", async () => {
    const backend: ResolvedBackend = {
      mode: "external",
      runtimeUrl: PG_TEST_URL,
      migrationUrl: PG_TEST_URL,
      migrationUrlOverridden: false,
    };
    connections = await createConnectionSetFromUrl(backend, { poolMax: 3, connectTimeoutSeconds: 5 });
    const runtimeRows = await connections.runtime.execute("SELECT pg_backend_pid() AS pid") as unknown as Array<{ pid: number }>;
    const migrationRows = await connections.migration.execute("SELECT pg_backend_pid() AS pid") as unknown as Array<{ pid: number }>;
    expect(migrationRows[0]?.pid).not.toBe(runtimeRows[0]?.pid);
  });

  it("close() cleanly shuts down the pool without error", async () => {
    const backend: ResolvedBackend = {
      mode: "external",
      runtimeUrl: PG_TEST_URL,
      migrationUrl: PG_TEST_URL,
      migrationUrlOverridden: false,
    };
    connections = await createConnectionSetFromUrl(backend, { poolMax: 1, connectTimeoutSeconds: 5 });
    await connections.close();
    connections = null; // prevent double-close in afterEach
  });

  it("exposes the resolved runtime pool ceiling on the connection set (RUFU-483)", async () => {
    /*
     * FNXC:PostgresPool 2026-11-06-21:23 (RUFU-483): `/metrics` renders this number as
     * `fusion_postgres_pool_max`, so the occupancy gauge's denominator comes from the pool that was
     * actually built rather than from a re-derivation of the resolution order. The dedicated
     * health/migration sessions stay `max: 1` and are excluded from it.
     */
    const backend: ResolvedBackend = {
      mode: "external",
      runtimeUrl: PG_TEST_URL,
      migrationUrl: PG_TEST_URL,
      migrationUrlOverridden: false,
    };
    connections = await createConnectionSetFromUrl(backend, { connectTimeoutSeconds: 5 });
    expect(connections.poolMax).toBe(DEFAULT_POOL_MAX);
    await connections.close();
    connections = null;

    connections = await createConnectionSetFromUrl(backend, {
      env: { FUSION_PG_POOL_MAX: "4" },
      connectTimeoutSeconds: 5,
    });
    expect(connections.poolMax).toBe(4);
  });

  it("binds runtime sessions to one project while migration sessions retain explicit bypass", async () => {
    const backend: ResolvedBackend = {
      mode: "external",
      runtimeUrl: PG_TEST_URL,
      migrationUrl: PG_TEST_URL,
      migrationUrlOverridden: false,
    };
    const bootstrap = await createConnectionSetFromUrl(backend, {
      poolMax: 1,
      connectTimeoutSeconds: 5,
    });
    await bootstrap.migration.execute(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime') THEN
          CREATE ROLE fusion_runtime NOLOGIN NOSUPERUSER;
        END IF;
        EXECUTE format('GRANT fusion_runtime TO %I', current_user);
      END $$
    `);
    await bootstrap.close();
    connections = await createConnectionSetFromUrl(backend, {
      poolMax: 1,
      connectTimeoutSeconds: 5,
      projectId: "project-a",
      useRuntimeRole: true,
    });
    const runtime = await connections.runtime.execute(
      "SELECT current_user AS current_user, current_setting('fusion.project_id', true) AS project_id, current_setting('fusion.project_bypass', true) AS bypass",
    ) as unknown as Array<{ current_user: string; project_id: string; bypass: string | null }>;
    const migration = await connections.migration.execute(
      "SELECT current_setting('fusion.project_bypass', true) AS bypass",
    ) as unknown as Array<{ bypass: string }>;
    expect(runtime[0]).toEqual({ current_user: "fusion_runtime", project_id: "project-a", bypass: null });
    expect(migration[0]).toEqual({ bypass: "on" });
  });
});

pgDescribe("connection: DATABASE_MIGRATION_URL split integration (VAL-CONN-003)", () => {
  let connections: Awaited<ReturnType<typeof createConnectionSetFromUrl>> | null = null;

  afterEach(async () => {
    if (connections) {
      await connections.close();
      connections = null;
    }
  });

  it("uses separate runtime and migration connections when split is configured", async () => {
    // Both point at the same test DB, but the resolver records the split.
    const backend: ResolvedBackend = {
      mode: "external",
      runtimeUrl: PG_TEST_URL,
      migrationUrl: PG_TEST_URL,
      migrationUrlOverridden: true,
    };
    connections = await createConnectionSetFromUrl(backend, { poolMax: 1, connectTimeoutSeconds: 5 });
    // Both instances should work.
    await connections.runtime.execute("SELECT 1");
    await connections.migration.execute("SELECT 1");
  });
});

describe("connection: pooler URL disables prepared statements and warns (VAL-CONN-008)", () => {
  it("emits the prepared-statement warning for a pooler URL without migration URL", async () => {
    // We don't connect (the pooler URL is fake); we verify the warning is emitted
    // at connection creation time. Use a custom onWarning to capture it.
    // FNXC:PostgresCutover 2026-07-05-15:50: collect ALL warnings — external
    // mode also emits the fixed-schema isolation warning (2026-06-27-10:35)
    // after the pooler warning, so capturing only the last message misses the
    // prepared-statement one.
    const capturedWarnings: string[] = [];
    const backend = resolveBackendWithOptions({
      databaseUrl: "postgresql://user:pw@xyz.pooler.supabase.com:6543/db",
    });

    // Attempt to create — this will fail to connect, but the warning is emitted
    // before the connection attempt.
    try {
      await createConnectionSetFromUrl(backend, {
        poolMax: 1,
        connectTimeoutSeconds: 2,
        onWarning: (msg) => {
          capturedWarnings.push(msg);
        },
      });
    } catch {
      // Connection failure expected (fake host)
    }
    expect(capturedWarnings.length).toBeGreaterThan(0);
    expect(capturedWarnings.some((msg) => /prepared statement/i.test(msg))).toBe(true);
  });
});

describe("connection: redactConnectionString re-export", () => {
  it("is accessible and works", () => {
    expect(redactConnectionString("postgresql://u:p@h/db")).not.toContain(":p@");
  });
});
