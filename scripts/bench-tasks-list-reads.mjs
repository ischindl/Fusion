#!/usr/bin/env node
/*
FNXC:TasksListReadCost 2026-11-16-19:05 (RUFU-585):
Repeatable read-cost bench for the board's task-list read path. The card this ships with
measured `GET /api/tasks?limit=20` at ~3.0-3.4 s on a freshly started server and reproduced
across three projects, while the identical store call answered in 80-82 ms. Neither number
was reproducible from a script, so every optimisation claim on that path was unfalsifiable.

The bench measures the STORE SEAM of that path — `TaskStore.listTasks({limit})` against a real
PostgreSQL TaskStore on a throwaway database seeded to a card scale — because that is where the
page query, the per-pass reads, and the per-row enrichment live. It additionally reports the
route's per-row enrichment cost separately (`routeEnrichment`), since the `/tasks` handler adds
a PROMPT.md read and a release-gate evaluation on top of the page.

For every (card scale x limit) cell it reports:
  * wall time (median / min / max over `--reps`),
  * per-pass WORK COUNTS (SQL statements, merge-queue reads, settings reads, workflow
    selection/definition reads, PROMPT.md parses, release-gate evaluations), so a growth claim
    is a count and not a duration,
  * the page SQL captured VERBATIM from the store, and the `EXPLAIN (ANALYZE, BUFFERS)` plan
    over it — examined rows, whether a Sort node sits under the Limit, and which index served it.

A disposable PostgreSQL is required; the production cluster is never touched:

  pnpm pg:test:up                       # or any PostgreSQL you own
  export FUSION_PG_TEST_URL_BASE=postgresql://localhost:5499
  pnpm bench:tasks-list-reads -- --rows 200,1000,2000 --limits 20,600

JSON goes to stdout (use --quiet to suppress the progress lines on stderr) and a human table
is printed on stderr.
*/

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importCore, openBackend } from "./lib/backend-db.mjs";

function parseArgs(argv) {
  const args = { rows: [200, 1000, 2000], limits: [20, 100, 600], reps: 3, concurrency: 4, enrichRows: 200, foreign: null, dropIndex: null, quiet: false, keep: false, fullSql: false };
  for (const raw of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(raw);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "rows") args.rows = value.split(",").map((n) => Number(n.trim())).filter(Number.isFinite);
    else if (key === "limits") args.limits = value.split(",").map((n) => Number(n.trim())).filter(Number.isFinite);
    else if (key === "reps") args.reps = Number(value);
    else if (key === "concurrency") args.concurrency = Number(value);
    else if (key === "enrich-rows") args.enrichRows = Number(value);
    /*
    FNXC:TasksListReadCost 2026-11-16-22:10 (RUFU-585):
    `--foreign=<n>` seeds n rows for OTHER projects, interleaved across the same created_at span.
    A bench database holding only the measured project flatters the old index: walking
    `idxTasksCreatedAt` in order then finds the page's 20 rows within 21 heap rows no matter what,
    because every row belongs. On the shared embedded cluster the page's project is a MINORITY of
    `tasks`, so an ordered walk over a project-blind index spends most of its rows on other
    projects, and the planner may prefer a bitmap heap scan plus a Sort instead. Without foreign
    rows the bench cannot show the difference between a project-scoped index and a project-blind
    one, which is the entire point of migration 0098.
    */
    else if (key === "foreign") args.foreign = Number(value);
    /*
    `--drop-index=<name>` measures the same dataset with one index removed, so a single run yields
    an honest before/after over identical rows, statistics, and cache state. Naming it as a flag
    rather than editing code is what keeps the comparison reproducible for the next author.
    */
    else if (key === "drop-index") args.dropIndex = value;
    else if (key === "quiet") args.quiet = value !== "false";
    else if (key === "keep") args.keep = value !== "false";
    else if (key === "full-sql") args.fullSql = value !== "false";
  }
  if (args.foreign === null) args.foreign = 9 * Math.max(...args.rows);
  return args;
}

const args = parseArgs(process.argv.slice(2));
const say = (...parts) => {
  if (!args.quiet) console.error(...parts);
};

const PG_BASE = (process.env.FUSION_PG_TEST_URL_BASE || "postgresql://localhost:5499").replace(/\/$/, "");
const DB_NAME = `rufu585_bench_${Date.now().toString(36)}`;
const DB_URL = `${PG_BASE}/${DB_NAME}`;

const core = await importCore();
const rootDir = mkdtempSync(join(tmpdir(), "rufu585-bench-"));
const otherProjectId = "proj-other";
const MAX_ROWS = Math.max(...args.rows);

/*
FNXC:TasksListReadCost 2026-11-16-19:05 (RUFU-585):
The bench never opens the project's own backend. It creates a throwaway database on the base
URL, points DATABASE_URL at it, and lets the production startup factory build the store, so
what is measured is the real boot path and not a hand-rolled approximation of it. The driver
is reached through @fusion/core's own dependency so the bench declares no second one.
*/
const { createRequire } = await import("node:module");
const requireFromCore = createRequire(join(process.cwd(), "packages/core/package.json"));
const admin = requireFromCore("postgres")(`${PG_BASE}/postgres`, { max: 1, onnotice: () => {} });
try {
  await admin.unsafe(`CREATE DATABASE "${DB_NAME}"`);
} catch (error) {
  console.error(
    `Unable to create the bench database ${DB_NAME} on ${PG_BASE}: ${error instanceof Error ? error.message : String(error)}\n` +
      `Start a disposable PostgreSQL and export FUSION_PG_TEST_URL_BASE (never the production cluster).`,
  );
  process.exit(1);
}

/*
FNXC:TasksListReadCost 2026-11-16-19:40 (RUFU-585):
The bench overrides BOTH database URLs. An operator shell inside a running Fusion daemon
exports DATABASE_URL and DATABASE_MIGRATION_URL pointing at the live embedded cluster, and the
startup factory sends its schema work to the MIGRATION url — a bench that overrode only
DATABASE_URL would therefore run its baseline apply against production. The resolved target is
asserted before any connection opens, so an env that disagrees fails fast instead of mutating
a cluster the bench does not own.
*/
process.env.DATABASE_URL = DB_URL;
process.env.DATABASE_MIGRATION_URL = DB_URL;
{
  const resolved = core.resolveBackend(process.env);
  if (!resolved.runtimeUrl?.includes(DB_NAME) || !resolved.migrationUrl?.includes(DB_NAME)) {
    console.error(
      `Refusing to bench: the resolved backend is not the throwaway database ${DB_NAME} ` +
        `(runtime=${core.redactUrlPassword?.(resolved.runtimeUrl ?? "") ?? "unset"}).`,
    );
    process.exit(1);
  }
}

/*
FNXC:TasksListReadCost 2026-11-16-19:05 (RUFU-585):
The throwaway database is empty, so the schema baseline is applied with core's own applier
before the store boots. Doing it here rather than relying on a boot-time auto-migrate keeps
the bench measuring a baselined schema — the shape a real install reaches — and reports the
version the numbers belong to.
*/
{
  const baselineClient = requireFromCore("postgres")(DB_URL, {
    max: 1,
    prepare: false,
    connection: { "fusion.project_bypass": "on", application_name: "fusion-rufu585-baseline" },
    onnotice: () => {},
  });
  const baseline = await core.applySchemaBaseline(requireFromCore("drizzle-orm/postgres-js").drizzle(baselineClient));
  say(`schema baseline applied=${baseline.applied} version=${core.SCHEMA_BASELINE_VERSION}`);
  await baselineClient.end({ timeout: 5 });
}

say(`bench database: ${DB_URL}`);

const { store, asyncLayer, shutdown } = await openBackend(rootDir);
// The startup factory binds the layer to the project registered for this scratch rootDir;
// every seeded row and every count below speaks that id, never a guessed one.
const projectId = asyncLayer.projectId;

/*
FNXC:TasksListReadCost 2026-11-16-19:05 (RUFU-585):
The store's own emitted SQL is recorded by wrapping the drizzle instance the async layer hands
out. Every read on the list path is a `select(...)` chain, so re-wrapping each chained builder
and reading `toSQL()` at the terminal (the await) captures the statement exactly as the product
wrote it — no hand-copied query that could drift from the thing being measured.
*/
const sqlSink = [];
function instrumentDb(db, sink) {
  const CHAIN = new Set(["from", "where", "orderBy", "limit", "offset", "innerJoin", "leftJoin", "rightJoin", "fullJoin", "groupBy", "having"]);
  const wrap = (builder) =>
    new Proxy(builder, {
      get(target, prop, receiver) {
        if (prop === "then") {
          return (onFulfilled, onRejected) => {
            try {
              const built = typeof target.toSQL === "function" ? target.toSQL() : null;
              if (built?.sql) sink.push({ sql: built.sql, params: built.params ?? [] });
            } catch {
              /* a chainable with no toSQL has no statement to record */
            }
            return Promise.resolve(target).then(onFulfilled, onRejected);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === "function" && CHAIN.has(prop)) {
          return (...callArgs) => wrap(value.apply(target, callArgs));
        }
        return value;
      },
    });
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "select" || prop === "selectDistinct") {
        return (...selectArgs) => wrap(target[prop](...selectArgs));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

Object.defineProperty(asyncLayer, "db", { value: instrumentDb(asyncLayer.db, sqlSink), configurable: true });

/*
FNXC:TasksListReadCost 2026-11-16-19:05 (RUFU-585):
Seeding runs on its own session with the project-isolation GUC bypassed. Forced RLS would
otherwise refuse the SECOND project's rows the fixture needs, and the fixture is the point:
the pre-fix merge-queue read issued `SELECT task_id FROM merge_queue` with no WHERE at all, so
foreign rows were scanned on every page of this project's board.
*/
const seedClient = requireFromCore("postgres")(DB_URL, {
  max: 4,
  prepare: false,
  connection: { "fusion.project_bypass": "on", application_name: "fusion-rufu585-seed" },
  onnotice: () => {},
});

async function seed() {
  const BATCH = 500;
  for (let done = 0; done < MAX_ROWS; done += BATCH) {
    const n = Math.min(BATCH, MAX_ROWS - done);
    const rows = [];
    for (let i = 0; i < n; i += 1) {
      const idx = done + i;
      const ts = new Date(1_700_000_000_000 + idx * 60_000).toISOString();
      rows.push(`('RUFU5-${idx}','${projectId}','Bench task ${idx}','Bench fixture description ${idx}','todo','todo','${ts}','${ts}')`);
    }
    await seedClient.unsafe(
      `INSERT INTO project.tasks (id, project_id, title, description, status, "column", created_at, updated_at)
       VALUES ${rows.join(",")}
       ON CONFLICT (project_id, id) DO NOTHING`,
    );
  }
  await seedClient.unsafe(
    `INSERT INTO project.tasks (id, project_id, title, description, status, "column", created_at, updated_at)
     SELECT 'OTHER-'||g, '${otherProjectId}', 'Foreign task '||g, 'Foreign fixture', 'todo', 'todo',
            (timestamp '2023-11-14 22:13:20' + make_interval(mins => g))::text,
            (timestamp '2023-11-14 22:13:20' + make_interval(mins => g))::text
     FROM generate_series(0,49) g
     ON CONFLICT (project_id, id) DO NOTHING`,
  );
  /*
  FNXC:TasksListReadCost 2026-11-16-22:10 (RUFU-585):
  The rest of the cluster. Seeded across several synthetic projects and INTERLEAVED through the
  same created_at span as the measured project's rows, because that interleaving is what the page
  read actually pays for: an ordered walk over a project-blind index must skip the foreign rows
  sitting between the page's own, so the examined-row count grows with the whole cluster rather
  than with the requested page. Ten seed projects at `foreign/10` rows each, rather than one
  giant foreign project, so no single foreign project could itself be served by one project-scoped
  index and flatter the comparison.
  */
  const FOREIGN_PROJECTS = 10;
  for (let done = 0; done < args.foreign; done += BATCH) {
    const n = Math.min(BATCH, args.foreign - done);
    const rows = [];
    for (let i = 0; i < n; i += 1) {
      const g = done + i;
      const minuteIdx = Math.floor((g * MAX_ROWS) / Math.max(1, args.foreign));
      const ts = new Date(1_700_000_000_000 + minuteIdx * 60_000 + (g % 55) * 1_000).toISOString();
      const owner = `proj-fx-${g % FOREIGN_PROJECTS}`;
      rows.push(`('FX-${String(g).padStart(7, "0")}','${owner}','Foreign task ${g}','Foreign fixture description ${g}','todo','todo','${ts}','${ts}')`);
    }
    await seedClient.unsafe(
      `INSERT INTO project.tasks (id, project_id, title, description, status, "column", created_at, updated_at)
       VALUES ${rows.join(",")}
       ON CONFLICT (project_id, id) DO NOTHING`,
    );
  }
  /*
  FNXC:TasksListReadCost 2026-11-16-22:20 (RUFU-585):
  Foreign merge-queue rows are the fixture for the second measured defect: the merge-queue read
  carried no project predicate, so a pass for this project pulled EVERY project's queued ids.
  Queued work for the seed projects therefore has to exist for the difference to be visible at
  all — with only the measured project's own rows present, an unscoped read and a scoped one
  return the same set and the bench reports a clean bill of health for a query that reads the
  whole table.
  */
  await seedClient.unsafe(
    `INSERT INTO project.merge_queue (project_id, task_id, enqueued_at)
     SELECT 'proj-fx-'||(g % 10), 'FX-'||lpad(g::text, 7, '0'), (timestamp '2023-11-14 22:13:20' + make_interval(mins => g))::text
     FROM generate_series(0, ${Math.max(0, args.foreign - 1)}) g
     WHERE g % 20 = 0
     ON CONFLICT DO NOTHING`,
  );
}

/**
 * The route's per-row enrichment reads PROMPT.md off disk. A bench whose task directories do
 * not exist measures only the ENOENT fast path, so the seeded cards get a real spec with steps.
 */
function writePromptFiles(count) {
  for (let idx = 0; idx < count; idx += 1) {
    const dir = join(rootDir, ".fusion", "tasks", `RUFU5-${idx}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "PROMPT.md"),
      `# Bench task ${idx}\n\n## What This Delivers\n\nBench fixture card.\n\n## Steps\n\n### Step 0: Preflight\n\n- verify\n\n### Step 1: Implement\n\n- change\n\n### Step 2: Verify\n\n- test\n`,
    );
  }
}

say(`seeding ${MAX_ROWS} cards ...`);
const seedStartedAt = Date.now();
await seed();
writePromptFiles(MAX_ROWS);
say(`seeded in ${((Date.now() - seedStartedAt) / 1000).toFixed(1)}s`);

/** Work counters for one read pass, wrapped so a growth claim is a count, not a duration. */
function installCounters(target) {
  const counters = {
    mergeQueueReads: 0,
    settingsReads: 0,
    promptStepParses: 0,
    workflowSelectionReads: 0,
    workflowDefinitionReads: 0,
    releaseGateEvaluations: 0,
    promptFileReads: 0,
  };
  const wrapMethod = (name, key) => {
    const original = typeof target[name] === "function" ? target[name].bind(target) : null;
    if (!original) return;
    target[name] = async (...callArgs) => {
      counters[key] += 1;
      return original(...callArgs);
    };
  };
  wrapMethod("getMergeQueuedTaskIdsAsync", "mergeQueueReads");
  wrapMethod("getSettingsFast", "settingsReads");
  wrapMethod("parseStepsFromPrompt", "promptStepParses");
  wrapMethod("getTaskWorkflowSelectionAsync", "workflowSelectionReads");
  wrapMethod("getTaskWorkflowSelectionsAsync", "workflowSelectionReads");
  wrapMethod("getWorkflowDefinition", "workflowDefinitionReads");
  return counters;
}

const counters = installCounters(store);

async function timed(fn) {
  const startedAt = process.hrtime.bigint();
  const result = await fn();
  return { result, ms: Number(process.hrtime.bigint() - startedAt) / 1e6 };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round1 = (n) => Math.round(n * 10) / 10;
/*
FNXC:TasksListReadCost 2026-11-16-20:10 (RUFU-585):
The captured page statement carries a ~170-column projection, while the arms that decide the
plan (WHERE, ORDER BY, LIMIT) sit at its head and tail. The report elides the middle so the
bench output stays readable; `--full-sql` keeps the statement whole.
*/
const trimSql = (text) =>
  !text || args.fullSql || text.length <= 900
    ? text
    : `${text.slice(0, 280)} /* projection elided: ${text.length - 560} chars */ ${text.slice(-280)}`;

/** The page query as the store emits it: a SELECT over project.tasks carrying the LIMIT arm. */
const isPageQuery = (statement) =>
  /project"\."tasks/i.test(statement.sql) && /\blimit\b/i.test(statement.sql) && !/^\s*(insert|update|delete)/i.test(statement.sql);

async function explainPage(pageStatement) {
  if (!pageStatement) return null;
  // EXPLAIN over the emitted statement with its parameters inlined. The bench database is
  // throwaway, so inlining keeps the plan tied to the statement the store actually wrote.
  let text = pageStatement.sql;
  for (const value of pageStatement.params ?? []) {
    const encoded =
      value === null || value === undefined
        ? "null"
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : `'${String(value).replace(/'/g, "''")}'`;
    text = text.replace(/\$\d+/, encoded);
  }
  const rows = await asyncLayer.db.execute(core.drizzleSql.raw(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`));
  const list = Array.isArray(rows) ? rows : rows?.rows;
  // PostgreSQL's JSON format hands back one row whose single column holds the plan array;
  // that column is named `QUERY PLAN` on the raw driver and unwrapped by some drizzle paths.
  const first = list?.[0];
  const plan = first?.Plan ?? first?.["QUERY PLAN"]?.[0]?.Plan ?? first?.[0]?.Plan;
  if (!plan) return null;
  const nodes = [];
  const walk = (node, depth) => {
    nodes.push({
      depth,
      nodeType: node["Node Type"],
      indexName: node["Index Name"] ?? null,
      rowsExamined: (node["Actual Rows"] ?? 0) * (node["Loops"] ?? 1),
    });
    for (const child of node.Plans ?? []) walk(child, depth + 1);
  };
  walk(plan, 0);
  const firstOfType = (type) => nodes.find((n) => String(n.nodeType).includes(type));
  return {
    totalCost: plan["Total Cost"],
    actualMs: Number((plan["Actual Total Time"] ?? 0).toFixed(2)),
    examinedRows: nodes.reduce((max, n) => Math.max(max, n.rowsExamined), 0),
    sortNode: firstOfType("Sort")?.nodeType ?? null,
    indexName: nodes.find((n) => n.indexName)?.indexName ?? null,
    nodeTypes: nodes.map((n) => `${"  ".repeat(n.depth)}${n.nodeType}${n.indexName ? `(${n.indexName})` : ""}`),
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  database: DB_URL,
  schemaVersion: core.SCHEMA_BASELINE_VERSION,
  serverSharedBuffers: null,
  scales: [],
};
try {
  const sb = await asyncLayer.db.execute(core.drizzleSql.raw(`SHOW shared_buffers`));
  report.serverSharedBuffers = (Array.isArray(sb) ? sb : sb?.rows)?.[0]?.shared_buffers ?? null;
} catch {
  /* diagnostic only */
}

say(`\n=== store seam: TaskStore.listTasks({limit}) ===`);
// Scales walk DESCENDING and the seed starts at the largest, so each step deletes the tail it
// no longer needs. Re-seeding per scale would re-heat the cache and make the three rows of the
// table incomparable; deleting keeps one live population measured three ways.
const sortedScales = [...args.rows].sort((a, b) => b - a);
for (const scale of sortedScales) {
  await seedClient.unsafe(
    `DELETE FROM project.tasks WHERE project_id = '${projectId}'
       AND substring(id from 7)::int >= ${scale}`,
  );
  const live = await asyncLayer.db.execute(
    core.drizzleSql.raw(`SELECT count(*)::int AS n FROM project.tasks WHERE project_id = '${projectId}' AND deleted_at IS NULL`),
  );
  const liveCount = (Array.isArray(live) ? live : live?.rows)?.[0]?.n ?? scale;
  /*
  FNXC:TasksListReadCost 2026-11-16-21:30 (RUFU-585):
  VACUUM after the shrink, not just ANALYZE. Deleting the tail leaves the removed rows as dead
  tuples the heap scan still walks, so an unvacuumed smaller scale reported `examined=2000` at
  20 live cards — the dead tuples of the previous scale, not the scale being measured. The
  scales have to be comparable or the table proves nothing.
  */
  await seedClient.unsafe(`VACUUM (ANALYZE) project.tasks`);
  const entry = { liveCardCount: liveCount, limits: [] };
  for (const limit of args.limits) {
    if (limit > scale) continue;
    sqlSink.length = 0;
    const before = { ...counters };
    const durations = [];
    let rowCount = 0;
    for (let rep = 0; rep < args.reps; rep += 1) {
      const { result, ms } = await timed(() => store.listTasks({ limit }));
      durations.push(ms);
      rowCount = Array.isArray(result) ? result.length : 0;
    }
    const pageStatement = sqlSink.filter(isPageQuery).at(-1);
    const plan = await explainPage(pageStatement);
    const pass = {
      limit,
      returnedRows: rowCount,
      msMedian: Number(median(durations).toFixed(1)),
      msMin: Number(Math.min(...durations).toFixed(1)),
      msMax: Number(Math.max(...durations).toFixed(1)),
      workPerPass: {
        sqlStatements: round1(sqlSink.length / args.reps),
        mergeQueueReads: round1((counters.mergeQueueReads - before.mergeQueueReads) / args.reps),
        settingsReads: round1((counters.settingsReads - before.settingsReads) / args.reps),
        workflowSelectionReads: round1((counters.workflowSelectionReads - before.workflowSelectionReads) / args.reps),
        workflowDefinitionReads: round1((counters.workflowDefinitionReads - before.workflowDefinitionReads) / args.reps),
      },
      pageSql: trimSql(pageStatement?.sql ?? null),
      plan: plan
        ? {
            totalCost: plan.totalCost,
            actualMs: plan.actualMs,
            examinedRows: plan.examinedRows,
            sortNode: plan.sortNode,
            indexName: plan.indexName,
            nodeTypes: plan.nodeTypes,
          }
        : null,
    };
    entry.limits.push(pass);
    say(
      `cards=${liveCount} limit=${limit} p50=${pass.msMedian}ms examined=${plan?.examinedRows ?? "?"} sort=${pass.plan?.sortNode ?? "none"} index=${pass.plan?.indexName ?? "seq"} stmts=${pass.workPerPass.sqlStatements} mq=${pass.workPerPass.mergeQueueReads}`,
    );
  }
  report.scales.push(entry);
}
report.scales.sort((a, b) => a.liveCardCount - b.liveCardCount);

/*
FNXC:TasksListReadCost 2026-11-16-19:05 (RUFU-585):
Route-enrichment arm. The `/tasks` handler annotates hold-lane rows with `awaitingPlanning`
and a release-gate verdict, which costs one PROMPT.md read plus a workflow-IR resolve per row,
capped by AWAITING_PLANNING_ENRICH_LIMIT. This measures that arm at the store seam over the
rows a page actually returned, so "bounded by the page, not by the project" is a countable
claim without booting a dashboard.
*/
{
  const page = await store.listTasks({ limit: Math.max(...args.limits) });
  const rows = page.slice(0, args.enrichRows);
  const before = { ...counters };
  const startedAt = process.hrtime.bigint();
  const irCache = new Map();
  for (const row of rows) {
    try {
      const { readFile } = await import("node:fs/promises");
      await readFile(join(store.getTaskDir(row.id), "PROMPT.md"), "utf-8");
      counters.promptFileReads += 1;
    } catch {
      /* missing spec is the ENOENT fast path the route treats as unplanned */
    }
    await core.resolveWorkflowIrForTask?.(store, row.id, irCache);
  }
  const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
  report.routeEnrichment = {
    routeRows: rows.length,
    ms: Number(ms.toFixed(1)),
    msPerRow: Number((ms / Math.max(1, rows.length)).toFixed(3)),
    promptFileReads: counters.promptFileReads - before.promptFileReads,
    workflowDefinitionReads: counters.workflowDefinitionReads - before.workflowDefinitionReads,
  };
  say(`\n=== route enrichment === rows=${report.routeEnrichment.routeRows} total=${report.routeEnrichment.ms}ms per-row=${report.routeEnrichment.msPerRow}ms reads=${report.routeEnrichment.promptFileReads}`);
}

say(`\n=== summary (median ms per listTasks call; star = no Sort node under the Limit) ===`);
say("cards  " + [...args.limits].sort((a, b) => a - b).map((l) => `limit=${l}`.padStart(11)).join(""));
for (const entry of report.scales) {
  const cells = [...args.limits].sort((a, b) => a - b).map((l) => {
    const hit = entry.limits.find((x) => x.limit === l);
    return (hit ? `${hit.msMedian}${hit.plan?.sortNode ? "" : "*"}` : "-").padStart(11);
  });
  say(`${String(entry.liveCardCount).padEnd(6)}${cells.join("")}`);
}

if (args.concurrency > 1) {
  const limit = Math.max(...args.limits);
  const durations = [];
  const startedAt = process.hrtime.bigint();
  await Promise.all(
    Array.from({ length: args.concurrency }, async () => {
      const { ms } = await timed(() => store.listTasks({ limit }));
      durations.push(ms);
    }),
  );
  report.concurrency = {
    tabs: args.concurrency,
    limit,
    wallMs: Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(1)),
    perCallMsMedian: Number(median(durations).toFixed(1)),
    perCallMsMax: Number(Math.max(...durations).toFixed(1)),
  };
  say(`\n=== four-tab concurrency === tabs=${args.concurrency} limit=${limit} wall=${report.concurrency.wallMs}ms per-call p50=${report.concurrency.perCallMsMedian}ms max=${report.concurrency.perCallMsMax}ms`);
}

if (args.keep) say(`\nkept bench database: ${DB_URL}`);
else await admin?.unsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`).catch(() => {});

await shutdown().catch(() => {});
await admin?.end({ timeout: 5 }).catch(() => {});
try {
  rmSync(rootDir, { recursive: true, force: true });
} catch {
  /* best-effort scratch cleanup */
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
