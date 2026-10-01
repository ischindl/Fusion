/*
FNXC:TaskStoreBootAttribution 2026-09-26-19:20:
RUFU-275 — the saneca-scale store-open cost made attributable as a calibrated fixture, not an
arbitrary seed. The profile is the one the field failure had: >300 live cards whose aggregate
inline `log` jsonb is tens of MB (log ≈94% of card bytes, mean card ≈96 KB, one card ≈1.9 MB),
plus a cold archive holding the fattest completed cards. A tiny seed passes for unrelated
reasons and proves nothing.

This is a deliberate calibrated PERFORMANCE fixture (full-suite pg lane; never the merge gate).
It attributes WHICH store-open backlog phase eats the budget — the legacy-adoption census, the
archive-reintegration reads, the forced patchnode reconcile — and proves at the ISSUED-SQL level
(postgres-js `debug` wire capture, not just the hydrated row shape) whether the boot census asks
PostgreSQL for the heavy `log` column.

FNXC:TaskStoreLightBoot 2026-09-26-19:31 (RUFU-275 Step 2):
The shipped contract pinned here: a FULL init keeps naming `log` (host boots keep the backlog —
intentionally unchanged), while a LIGHT init ({skipArchiveReintegration, skipPatchnodeReconcile})
issues no tasks SELECT naming `log` and finishes inside an absolute 20 s ceiling — never a
timing ratio, which is what makes this fixture CI-stable.
*/
import { expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql as dsql } from "drizzle-orm";
import { TaskStore } from "../../store.js";
import { upsertArchivedTask } from "../../async-stores/async-archive-db.js";
import { createAsyncDataLayer } from "../../postgres/data-layer.js";
import type { PostgresConnections } from "../../postgres/connection.js";
import {
  LEGACY_ADOPTION_DRAINED_MARKER,
  MIGRATION_BOOKKEEPING_TABLE,
} from "../../postgres/schema-applier.js";
import { listArchivedTaskEntriesPageTolerant } from "../../task-store/async/async-archive-lineage.js";
import { createTaskStoreForTest, pgDescribe } from "../../__test-utils__/pg-test-harness.js";

/*
Calibrated saneca profile (measured board: 315 task.json mirrors / 30.18 MB / median 71 KB /
max 1.9 MB / 61 files >200 KB), mapped onto rows:
- 310 live cards across todo/in-progress/in-review/done; each log ≈40 entries × ~2.6 KB ≈ 105 KB
  (aggregate ≈28 MB live log — matches the 95.7 KB board mean and the "tens of MB" total).
- one card reseeded to ≈1.9 MB (largest-card case).
- 25 live `archived`-column cards at ≈224 KB log (the lane the slim:false live page reads whole).
- 60 cold archive entries at ≈200 KB task_json (completed cards carry the fattest logs).
*/
const PROJECT_ID = "rufu275";
const LIVE_CARDS = 310;
const LIVE_ARCHIVED_CARDS = 25;
const ARCHIVED_CARDS = 60;
const LOG_ENTRIES_PER_CARD = 40;
/*
FNXC:TaskStoreBootAttribution 2026-09-26-20:42 (RUFU-275 merge):
Calibrated per-entry size. Wire-measured on the seeded board, one log entry renders to 2,124 B
(repeat('payload-', 256) = 2,048 B of content + 76 B of jsonb key/quote/timestamp overhead), NOT
the 2.8 KB an earlier note assumed. That 33 % overestimate is what made MAX_CARD_ENTRIES 700 land
at 1.487 MB and fail this fixture's own largest-card floor — the entry count is derived from the
measured per-entry size, never the reverse.
*/
const ENTRY_PAYLOAD_REPEAT = 256; // ≈2,124 B per rendered log entry (see note above)
const MAX_CARD_ENTRIES = 900; // 900 × 2,124 B ≈ 1.91 MB — the saneca largest-card case (SANE-084 = 1,883 KB)
/**
 * Absolute light-boot ceiling: comfortably inside the shipped 30 s fn-extension boot budget
 * (packages/cli/src/extension.ts EXTENSION_STORE_BOOT_TIMEOUT_MS) — a ceiling, never a ratio.
 */
const LIGHT_BOOT_CEILING_MS = 20_000;

interface PhaseMeasurement {
  phase: string;
  ms: number;
  hydratedLogBytes: number;
}

/*
FNXC:TaskStoreBootAttribution 2026-09-26-20:42 (RUFU-275 merge):
Wire matcher for "this issued SELECT names the heavy `log` column". Drizzle qualifies every
projection column, so the captured statement text is `"tasks"."log"`, never a bare `log`.
`/\b"log"\b/` can therefore never match it — a quoted identifier is already its own boundary, and
between `.` and `"` there is no word/non-word transition for `\b` to assert. That made the
positive pin (cold init names `log`) unsatisfiable and both negative pins vacuously true. Match
the exact quoted token instead: the negative pins now actually prove the slim projection excludes
the column, and the positive pin proves the archive live page pulls it.
*/
const SELECTS_LOG_COLUMN = /"log"/;

pgDescribe("store-open boot backlog attribution at saneca scale (RUFU-275)", () => {
  it("attributes the open backlog and pins the census read shape", async () => {
  const measurements: PhaseMeasurement[] = [];
  const record = (phase: string, startedAt: number, hydratedLogBytes = 0): void => {
    measurements.push({ phase, ms: Date.now() - startedAt, hydratedLogBytes });
  };

  const harness = await createTaskStoreForTest({ prefix: "rufu275boot", copyFromGolden: true, projectId: PROJECT_ID });
  // Raw admin connection for the bulk seed and marker bookkeeping (test-instance superuser).
  const admin = postgres(harness.testUrl, { max: 2, prepare: false, onnotice: () => {} });

  // Instrumented runtime client: the postgres-js `debug` hook sees every statement string
  // exactly as it goes over the wire, so the log-column proof reads the ISSUED SELECT list.
  const issued: string[] = [];
  let capturing = false;
  const instrumented = postgres(harness.testUrl, {
    max: 4,
    prepare: false,
    connection: { "fusion.project_id": PROJECT_ID },
    onnotice: () => {},
    debug: (_id: unknown, text: unknown) => {
      if (capturing && typeof text === "string") issued.push(text);
    },
  });

  let measuredStore: TaskStore | undefined;
  try {
    // ---- Calibrated seed (server-side generation: no ~40 MB client transfer) ----
    const seedStart = Date.now();
    await admin`
      INSERT INTO project.tasks (id, project_id, title, description, "column", created_at, updated_at, log)
      SELECT
        'RUFU275-' || lpad(g::text, 4, '0'),
        ${PROJECT_ID},
        'Calibrated card ' || g,
        repeat('seed description ', 40),
        (ARRAY['todo','in-progress','in-review','done'])[1 + (g % 4)],
        to_char(timestamptz '2026-08-01T00:00:00Z' + (g * 60) * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        to_char(timestamptz '2026-08-01T00:00:00Z' + (g * 60) * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        (SELECT jsonb_agg(jsonb_build_object('action', 'tool', 'timestamp', to_char(timestamptz '2026-08-01T00:00:00Z' + i * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'content', repeat('payload-', ${ENTRY_PAYLOAD_REPEAT}::int)) ORDER BY i)
           FROM generate_series(1, ${LOG_ENTRIES_PER_CARD}::int) i)
      FROM generate_series(1, ${LIVE_CARDS}::int) g
    `;
    await admin`
      UPDATE project.tasks
         SET log = (SELECT jsonb_agg(jsonb_build_object('action', 'tool', 'timestamp', to_char(timestamptz '2026-08-01T00:00:00Z' + i * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'content', repeat('payload-', ${ENTRY_PAYLOAD_REPEAT}::int)) ORDER BY i)
                      FROM generate_series(1, ${MAX_CARD_ENTRIES}::int) i)
       WHERE id = 'RUFU275-' || lpad(${LIVE_CARDS}::text, 4, '0')
    `;
    // 25 live `archived`-column cards with fat logs: archive reintegration reads its live page
    // with slim:false — the FULL row, `log` included — so this is the boot phase that pulls the
    // heaviest bytes on a board whose archived lane holds completed cards.
    await admin`
      INSERT INTO project.tasks (id, project_id, title, description, "column", created_at, updated_at, log)
      SELECT
        'RUFU275B-' || lpad(g::text, 4, '0'),
        ${PROJECT_ID},
        'Calibrated archived-lane card ' || g,
        repeat('seed description ', 40),
        'archived',
        to_char(timestamptz '2026-07-20T00:00:00Z' + (g * 60) * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        to_char(timestamptz '2026-07-20T00:00:00Z' + (g * 60) * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        (SELECT jsonb_agg(jsonb_build_object('action', 'tool', 'timestamp', to_char(timestamptz '2026-07-20T00:00:00Z' + i * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'content', repeat('payload-', ${ENTRY_PAYLOAD_REPEAT}::int)) ORDER BY i)
           FROM generate_series(1, ${LOG_ENTRIES_PER_CARD * 2}::int) i)
      FROM generate_series(1, ${LIVE_ARCHIVED_CARDS}::int) g
    `;
    // Cold archive snapshots: build GENUINE entries through the store's own serializer (so
    // reintegration restores them exactly like the field board), then inject the calibrated
    // fat log into each snapshot server-side — completed cards carry the fattest logs.
    const archiveSeedDb = drizzle(admin);
    for (let g = 1; g <= ARCHIVED_CARDS; g++) {
      const created = await harness.store.createTask({ title: `Calibrated archived card ${g}`, description: `repeat-seed ${g}` });
      const entry = await harness.store.taskToArchiveEntry(created, "2026-07-15T00:00:00.000Z");
      await upsertArchivedTask(archiveSeedDb, entry, PROJECT_ID);
    }
    await admin`
      UPDATE archive.archived_tasks
         SET task_json = jsonb_set(
               task_json::jsonb,
               '{log}',
               (SELECT coalesce(jsonb_agg(jsonb_build_object('action', 'tool', 'timestamp', to_char(timestamptz '2026-07-05T00:00:00Z' + i * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'content', repeat('payload-', ${ENTRY_PAYLOAD_REPEAT}::int)) ORDER BY i), '[]'::jsonb)
                  FROM generate_series(1, ${LOG_ENTRIES_PER_CARD * 2}::int) i)
             )::text
       WHERE project_id = ${PROJECT_ID}
    `;
    const seedMs = Date.now() - seedStart;
    // Physically remove the createTask-seeded live originals: the cold snapshot is the fixture's
    // archived card, and reintegration must see the saneca shape (live row absent, snapshot present).
    await admin`DELETE FROM project.tasks WHERE id LIKE 'FN-%'`;

    /*
    FNXC:TaskStoreBootAttribution 2026-09-26-20:42 (RUFU-275 merge):
    Calibre gate: the fixture must reproduce the board's weight or the numbers are meaningless.
    The `archived`-lane count is sampled HERE, before any measurement phase, because phase 5's
    full `init()` runs archive reintegration, which moves every live `archived`-column card to
    done. Asserting the seeded sentinel-lane size after that mutating pass asks for the pre-init
    shape on a post-init board and can only fail; the calibre of a seeded lane belongs with the seed.
    */
    const [bytesRow] = await admin`
      SELECT (SELECT sum(octet_length(log::text)) FROM project.tasks) AS live_log_bytes,
             (SELECT count(*) FROM project.tasks) AS live_rows,
             (SELECT count(*) FROM project.tasks WHERE "column" = 'archived') AS archived_lane_rows,
             (SELECT sum(octet_length(task_json)) FROM archive.archived_tasks) AS archived_bytes
    `;
    expect(Number(bytesRow.live_rows)).toBeGreaterThanOrEqual(LIVE_CARDS);
    expect(Number(bytesRow.live_log_bytes)).toBeGreaterThan(25_000_000);
    expect(Number(bytesRow.archived_lane_rows)).toBe(LIVE_ARCHIVED_CARDS);

    // ---- Measurement store: own instrumented layer; the harness store stays idle ----
    const instrumentedDb = drizzle(instrumented);
    const connections = {
      runtime: instrumentedDb,
      migration: instrumentedDb,
      health: instrumentedDb,
      close: async () => {},
      backend: {
        mode: "external",
        runtimeUrl: harness.testUrl,
        migrationUrl: harness.testUrl,
        migrationUrlOverridden: false,
      },
    } as unknown as PostgresConnections;
    measuredStore = new TaskStore(harness.rootDir, undefined, {
      asyncLayer: createAsyncDataLayer(connections, { projectId: PROJECT_ID }),
    });
    const store = measuredStore;

    // ---- Phase equivalents on the same calibrated data (startupMemo off: real reads) ----
    // 1. The census EXACTLY as boot calls it today, wire-captured: the slim projection excludes
    //    `log`, so what derive:true costs is PER-ROW DERIVATION CPU, not bytes.
    capturing = true;
    let t = Date.now();
    const censusOn = await store.listTasks({ slim: true, startupMemo: false });
    record("census.listTasks({slim:true}) [boot shape]", t, censusOn.reduce((s, x) => s + JSON.stringify(x.log ?? []).length, 0));
    const censusOnSql = issued.splice(0);

    // 2. The same census with derivation off — what the Step 2 fix shape removes is the derive pass.
    capturing = true;
    t = Date.now();
    const censusOff = await store.listTasks({ slim: true, derive: false, startupMemo: false });
    record("census.listTasks({slim:true,derive:false}) [fix shape]", t, 0);
    const censusOffSql = issued.splice(0);
    capturing = false;

    // 3. The archive-reintegration cold page — exactly the boot read (page limit 100 cold).
    t = Date.now();
    const coldPage = await listArchivedTaskEntriesPageTolerant(store.asyncLayer!.db, 100, 0, PROJECT_ID);
    record("archive cold page (60×200KB task_json)", t, coldPage.reduce((s, row) => s + (row.entry ? JSON.stringify(row.entry).length : 0), 0));

    // 4. Forced patchnode reconcile (full backlog pass as init runs it).
    t = Date.now();
    await store.reconcilePatchnodeLedger({ force: true });
    record("patchnode.reconcile({force:true})", t);

    // 5. A real cold FULL init (drained marker cleared) with issued-SQL capture. This includes
    //    archive reintegration restoring the eligible cold cards — the mutation cost saneca paid.
    const markerClear = async (): Promise<void> => {
      await store.asyncLayer!.db.execute(
        dsql`DELETE FROM public.${dsql.identifier(MIGRATION_BOOKKEEPING_TABLE)} WHERE version = ${LEGACY_ADOPTION_DRAINED_MARKER}`,
      );
    };
    const markerPresent = async (): Promise<boolean> => {
      const rows = (await store.asyncLayer!.db.execute(
        dsql`SELECT version FROM public.${dsql.identifier(MIGRATION_BOOKKEEPING_TABLE)} WHERE version = ${LEGACY_ADOPTION_DRAINED_MARKER}`,
      )) as unknown as unknown[];
      return rows.length > 0;
    };
    await markerClear();
    expect(await markerPresent()).toBe(false);
    issued.length = 0;
    capturing = true;
    t = Date.now();
    await store.init();
    record("init() full cold (incl. archive restore)", t);
    capturing = false;

    // 6. Second open: the drained marker must short-circuit the adoption census.
    expect(await markerPresent()).toBe(true);
    const warmStore = new TaskStore(harness.rootDir, undefined, {
      asyncLayer: createAsyncDataLayer(connections, { projectId: PROJECT_ID }),
    });
    t = Date.now();
    await warmStore.init();
    record("init() second open (drained marker)", t);
    await warmStore.close();

    // ---- The Step 1 attribution numbers ----
    const report = measurements
      .map((m) => `  ${m.phase}: ${m.ms} ms (hydrated payload ${m.hydratedLogBytes.toLocaleString()} bytes)`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.log(
      `\nRUFU-275 boot attribution — board: ${LIVE_CARDS} live cards ≈${(Number(bytesRow.live_log_bytes) / 1e6).toFixed(1)} MB inline log + ${ARCHIVED_CARDS} archived ≈${(Number(bytesRow.archived_bytes) / 1e6).toFixed(1)} MB task_json (seed ${seedMs} ms)\n${report}\n`,
    );

    // ---- Structural invariants (never timing ratios, which flake) ----
    // The fix-shape census returns the SAME row set (adoption consumes ids/status/column only)…
    expect(new Set(censusOff.map((task) => task.id))).toEqual(new Set(censusOn.map((task) => task.id)));
    expect(censusOn.length).toBeGreaterThanOrEqual(LIVE_CARDS);
    /*
    FNXC:TaskStoreBootAttribution 2026-09-26-19:24 (Step 1, premise corrected by measurement):
    The hydrated census rows carry almost no log bytes in EITHER shape — the slim row mapper
    restores `log` to `[]` — so the hydrated shape cannot distinguish the two census reads. The
    wire capture below is what does (see wire proof 1). The archive-reintegration phase is the
    other byte source: its live-column page reads `slim:false` (the full row, `log` included) and
    its cold page parses every archived `task_json` whole, which the light boot skips.
    */
    expect(censusOn.reduce((s, task) => s + (task.log?.length ?? 0), 0)).toBeLessThan(100_000);
    expect(censusOff.reduce((s, task) => s + (task.log?.length ?? 0), 0)).toBe(0);
    // Calibre via SQL (rows are slim-hydrated, so the fat column is measured where it lives).
    const [maxCardRow] = await admin`
      SELECT octet_length(log::text) AS log_bytes FROM project.tasks WHERE id = 'RUFU275-0310'
    `;
    expect(Number(maxCardRow.log_bytes)).toBeGreaterThan(1_500_000);
    /*
    FNXC:TaskStoreBootAttribution 2026-09-26-20:42 (RUFU-275 merge):
    The sentinel-lane calibre assertion moved up to the seed gate above. Here the lane is already
    drained by phase 5's full init (archive reintegration moved those cards to done) — which is
    exactly the boot work RUFU-275's light boot skips, so re-reading the lane at this point
    measures the pass's mutation, not the seed.
    */

    /*
    FNXC:TaskStoreBootAttribution 2026-09-26-20:42 (RUFU-275 merge):
    Wire proof 1 — direction corrected by measurement, because `slim: true` alone does NOT keep
    `log` off the wire. With the derive pass on, the issued SELECT enumerates every task column
    including `"log"`; `derive: false` (the shipped Step 2 fix) is what yields the log-free
    projection. So the pre-fix census shape MUST name the column and the fix shape MUST NOT.
    The earlier note claimed the opposite ("BOTH census shapes hydrate ~zero log bytes") because it
    read the HYDRATED row shape, which the slim mapper restores to `log: []` in both shapes; only
    the wire capture distinguishes them. Pinned in both directions so a regression that re-enables
    derivation on the boot path fails here.
    */
    const tasksSelectsFrom = (statements: string[]) => statements.filter(
      (statement) => /^\s*SELECT/i.test(statement) && /FROM\s+"?project"?\."?tasks"?/i.test(statement),
    );
    const censusTasksSelects = tasksSelectsFrom(censusOnSql);
    expect(censusTasksSelects.length).toBeGreaterThan(0);
    expect(censusTasksSelects.some((statement) => SELECTS_LOG_COLUMN.test(statement))).toBe(true);
    const censusOffTasksSelects = tasksSelectsFrom(censusOffSql);
    expect(censusOffTasksSelects.length).toBeGreaterThan(0);
    expect(censusOffTasksSelects.some((statement) => SELECTS_LOG_COLUMN.test(statement))).toBe(false);

    // Wire proof 2: cold init DOES name `log` — the archive-reintegration live page (slim:false)
    // is the boot phase that pulls the fattest column off the wire.
    const coldInitTasksSelects = issued.filter(
      (statement) => /^\s*SELECT/i.test(statement) && /FROM\s+"?project"?\."?tasks"?/i.test(statement),
    );
    expect(coldInitTasksSelects.length).toBeGreaterThan(0);
    /*
    FNXC:TaskStoreBootAttribution 2026-09-26-19:24 (Step 1 baseline):
    A tasks SELECT issued during a FULL cold init names `log` (full-row archived-lane read).
    This stays TRUE after the fix by design — host-path boots keep the complete backlog; the
    RUFU-275 light boot is the shape asserted (in phase 7 below) to never name `log`.
    */
    expect(coldInitTasksSelects.some((statement) => SELECTS_LOG_COLUMN.test(statement))).toBe(true);

    // 7. Light boot (the shipped RUFU-275 fix shape) on the same board, wire-captured.
    const lightStore = new TaskStore(harness.rootDir, undefined, {
      asyncLayer: createAsyncDataLayer(connections, { projectId: PROJECT_ID }),
    });
    issued.length = 0;
    capturing = true;
    t = Date.now();
    await lightStore.init({ skipArchiveReintegration: true, skipPatchnodeReconcile: true });
    record("init() light boot [fix shape]", t);
    capturing = false;
    const lightMs = measurements[measurements.length - 1]!.ms;
    await lightStore.close();

    /*
    FNXC:TaskStoreLightBoot 2026-09-26-19:31 (RUFU-275 Step 2):
    The light boot's wire contract: no tasks SELECT issued during a light init names the heavy
    `log` column — the archive live page (the only boot read that enumerated it) never runs.
    Plus the absolute budget ceiling: saneca crossed the shipped 30 s extension timeout; a board
    of this calibre must light-boot far inside it on any hardware (measured single-digit ms on
    warm-marker state here). No timing RATIOS — ratios flake; ceilings only.
    */
    const lightTasksSelects = issued.filter(
      (statement) => /^\s*SELECT/i.test(statement) && /FROM\s+"?project"?\."?tasks"?/i.test(statement),
    );
    expect(lightTasksSelects.some((statement) => SELECTS_LOG_COLUMN.test(statement))).toBe(false);
    expect(lightMs).toBeLessThan(LIGHT_BOOT_CEILING_MS);

    // Sanity: the measurement phases all ran (the report above is the deliverable).
    expect(measurements.length).toBe(7);
  } finally {
    capturing = false;
    if (measuredStore) await measuredStore.close().catch(() => {});
    await instrumented.end({ timeout: 2 }).catch(() => {});
    await admin.end({ timeout: 2 }).catch(() => {});
    await harness.teardown();
  }
}, 240_000);
});
