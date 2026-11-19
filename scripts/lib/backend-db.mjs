/**
 * FNXC:PostgresCutover 2026-07-05-13:00:
 * Shared PostgreSQL backend access for operational scripts.
 *
 * The ops/maintenance scripts under scripts/ used to open `.fusion/fusion.db`
 * directly (node:sqlite or the sqlite3 CLI). After the PostgreSQL cutover the
 * live data lives in the embedded PostgreSQL cluster (or an external cluster
 * via DATABASE_URL), so a direct SQLite open would silently operate on a
 * stale/empty marker file. Every script now boots the real backend through
 * @fusion/core's startup factory via this helper.
 *
 * Requires packages/core to be built (`pnpm --filter @fusion/core build`).
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stagePostgresMigrations } from "./stage-postgres-migrations.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Stage the PostgreSQL migration SQL into core's dist. `tsc` emits
 * only JS, so a bare build used to leave dist without src/postgres/migrations/*.sql;
 * the schema applier resolves them relative to the compiled file (__dirname/migrations).
 *
 * FNXC:SchemaAssetPairing 2026-11-17-16:23 (RUFU-548): now delegates to the shared
 * staging helper so every writer produces the SAME remove-before-copy mirror — the
 * previous additive copy here could never purge a stale basename left behind when a
 * migration file is renamed, which is the same drift class the new
 * scripts/check-dist-migration-assets.mjs validator refuses. src-missing keeps the
 * historical no-op (an import of an already-built dist must not fail on tree shape).
 * The FNXC:AutomationIsolation 2026-07-13-22:37 requirement — stage EVERY versioned
 * migration, not merely the initial baseline — is carried by the helper's whole-directory
 * mirror.
 */
function ensureMigrationsStaged() {
  stagePostgresMigrations({
    repoRoot,
    destDir: resolve(repoRoot, "packages/core/dist/postgres/migrations"),
  });
}

/* FNXC:OperatorScriptLaneAssumptions 2026-07-31-02:10: exported so operator scripts can reach core
   helpers (lane resolution) through the SAME staged-dist seam `openBackend` already uses, rather than
   each growing its own dist path — `@fusion/core` is not resolvable from the repo-root `scripts/`. */
export async function importCore() {
  ensureMigrationsStaged();
  try {
    return await import(pathToFileURL(resolve(repoRoot, "packages/core/dist/index.js")).href);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to import packages/core/dist/index.js (${message}). Run: pnpm --filter @fusion/core build`,
    );
  }
}

/**
 * Boot a PostgreSQL-backed TaskStore for the given project root.
 *
 * Returns `{ core, store, asyncLayer, sql, schema, shutdown }`:
 * - `core` — the @fusion/core module (for helpers like recordRunAuditEvent).
 * - `store` — the initialized TaskStore (backend mode).
 * - `asyncLayer` — the AsyncDataLayer; `asyncLayer.db.execute(sql\`...\`)`
 *   runs raw SQL. Project tables are schema-qualified (`project."tasks"`).
 * - `sql` — the drizzle-orm `sql` template tag (re-exported as drizzleSql).
 * - `schema` — postgresSchema (drizzle table objects, e.g. schema.project.tasks).
 * - `shutdown` — releases the pool and stops an embedded cluster this boot
 *   started. Always call it in `finally`.
 *
 * Throws when PostgreSQL cannot start. These scripts must never fall back to
 * the removed SQLite runtime.
 */
export async function openBackend(rootDir = process.cwd(), options = {}) {
  const core = await importCore();
  const boot = await core.createTaskStoreForBackend({
    rootDir,
    skipArchiveReintegrationOnInit: options.skipArchiveReintegrationOnInit === true,
  });
  const asyncLayer = boot.taskStore.getAsyncLayer();
  if (!asyncLayer) {
    await boot.shutdown().catch(() => {});
    throw new Error("Backend TaskStore has no AsyncDataLayer; cannot run this script.");
  }
  return {
    core,
    store: boot.taskStore,
    asyncLayer,
    sql: core.drizzleSql,
    schema: core.postgresSchema,
    shutdown: boot.shutdown,
  };
}

/**
 * Normalize a drizzle `db.execute(...)` result to a plain array of rows.
 * postgres-js returns a RowList (array-like); this keeps call sites simple.
 */
export function rowsOf(result) {
  if (Array.isArray(result)) return [...result];
  if (result && Array.isArray(result.rows)) return [...result.rows];
  return [];
}
