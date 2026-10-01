import { afterAll, beforeAll, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import {
  SCHEMA_MUTATION_LOCK_TIMEOUT_MS,
  SchemaMutationLockTimeoutError,
  acquireSchemaMutationLocks,
  acquireSqliteMigrationStateLock,
} from "../postgres/advisory-locks.js";
import { PG_TEST_URL_BASE, pgDescribe } from "../__test-utils__/pg-test-harness.js";

/*
FNXC:SchemaLockDeadline 2026-09-23-06:30:
STAS-251. Every boot passes through acquireSchemaMutationLocks before it can apply schema
versions, and that wait used to be unbounded: one session that died holding
fusion:sqlite-migration-state or fusion:schema-applier parked every later boot in a queue
nothing could report, because the caller-facing ceiling gave up first and recorded nothing.
Advisory locks are cluster-wide, so these cases run against the test server's own
maintenance database, hold each lock only long enough to prove the bound bites, and never
touch a Fusion table.
*/

const HOLDER_HOLD_MS = 700;
const BUDGET_MS = 250;

type Executable = {
  execute(query: ReturnType<typeof sql.raw>): Promise<unknown>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function sessionLockTimeoutMs(client: Executable): Promise<number> {
  const rows = (await client.execute(
    sql.raw(`SELECT setting::bigint AS ms FROM pg_settings WHERE name = 'lock_timeout'`),
  )) as Array<{ ms: string }>;
  return Number(rows[0]?.ms ?? Number.NaN);
}

async function holdAdvisoryLock(client: Sql, key: string, holdMs: number): Promise<void> {
  await client.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    await sleep(holdMs);
  });
}

pgDescribe("schema mutation lock wait is bounded and loud (STAS-251)", () => {
  const targetUrl = `${PG_TEST_URL_BASE}/postgres`;
  let pool: Sql;
  let holder: Sql;
  let db: PostgresJsDatabase<Record<string, never>>;

  beforeAll(() => {
    pool = postgres(targetUrl, { max: 1, prepare: false });
    holder = postgres(targetUrl, { max: 1, prepare: false });
    db = drizzle(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await holder?.end();
  });

  it("sets a transaction-local lock_timeout and never leaks it onto the pooled connection", async () => {
    const insideTransaction = await db.transaction(async (tx) => {
      await acquireSchemaMutationLocks(tx);
      return sessionLockTimeoutMs(tx);
    });

    expect(insideTransaction).toBe(SCHEMA_MUTATION_LOCK_TIMEOUT_MS);
    await expect(sessionLockTimeoutMs(db)).resolves.toBe(0);
  });

  it("rejects loudly instead of queueing forever behind a stalled sqlite-migration-state holder", async () => {
    const holding = holdAdvisoryLock(holder, "fusion:sqlite-migration-state", HOLDER_HOLD_MS);
    await sleep(120);
    const startedAt = Date.now();

    const error = await db
      .transaction((tx) => acquireSqliteMigrationStateLock(tx, BUDGET_MS))
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SchemaMutationLockTimeoutError);
    expect(String(error)).toContain("fusion:sqlite-migration-state");
    expect(Date.now() - startedAt).toBeLessThan(HOLDER_HOLD_MS);

    await holding;
  });

  it("bounds the narrower fusion:schema-applier wait the same way", async () => {
    const holding = holdAdvisoryLock(holder, "fusion:schema-applier", HOLDER_HOLD_MS);
    await sleep(120);

    const error = await db
      .transaction((tx) => acquireSchemaMutationLocks(tx, BUDGET_MS))
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SchemaMutationLockTimeoutError);
    expect(String(error)).toContain("fusion:schema-applier");

    await holding;
  });
});
