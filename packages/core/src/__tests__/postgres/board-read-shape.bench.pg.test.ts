/*
FNXC:TaskLogProjections 2026-10-10-19:55 (RUFU-615):
This is a MEASUREMENT harness, not a test. It is skipped unless `FUSION_BOARD_BENCH=1`, because seeding a
2 417-row board with 31 MB of task history is minutes of work that the suite has no reason to pay. Run it
with:

  FUSION_BOARD_BENCH=1 FUSION_PG_TEST_URL_BASE=postgresql://localhost:25432 \
    pnpm --filter @fusion/core exec vitest run \
    src/__tests__/postgres/board-read-shape.bench.pg.test.ts --reporter=dot --silent=false

The board it builds is SYNTHETIC with a distribution matched to the live one, measured on 2026-10-10 over
2 417 live rows: 31.4 MB of `log` (42.7% of live-row bytes), 17 rows between 0.5 MB and 2.2 MB, the rest a
few KB each. The live embedded cluster is never connected to — only a copy of a real board is, per the
task's testing constraints — and the cluster was not running at measurement time, so the shape rather than
the bytes was reproduced. `scripts/bench-board-read-shapes.mjs` records how to re-run this against a
restored copy instead.
*/

import { beforeAll, afterAll, it, expect } from "vitest";
import { createSharedPgTaskStoreTestHarness } from "./pg-task-store-test-harness";
import type { PgTestContext } from "./pg-test-harness";
import { tasks as tasksTable } from "../../postgres/schema/project";
import { LOG_RECENT_INLINE_BYTE_BUDGET } from "../../task-store/task-log-projections";

const RUN = process.env.FUSION_BOARD_BENCH === "1";
const benchIt = RUN ? it : it.skip;

/** Matched to the live board measured 2026-10-10: 2 417 rows, 31.4 MB of log, 17 heavy rows. */
const BOARD_ROWS = 2_417;
const HEAVY_ROWS = 17;
const HEAVY_BYTES = 1_100_000;
const LIGHT_BYTES = 5_300;

function logOfChars(target: number, seed: number): unknown[] {
  const entries: unknown[] = [];
  let chars = 0;
  let i = 0;
  const base = Date.UTC(2026, 9, 10, 12, 0, 0);
  while (chars < target) {
    const pad = Math.min(4_000, target - chars);
    const outcome = `${((seed + i) % 9_973).toString(36).padStart(4, "x")}${"y".repeat(pad)}`;
    entries.push({
      timestamp: new Date(base + i * 60_000).toISOString(),
      action: `step-${i % 40} progress`,
      outcome,
    });
    chars += outcome.length + 60;
    i += 1;
  }
  return entries;
}

const h = createSharedPgTaskStoreTestHarness("board_read_bench");

beforeAll(h.beforeAll);
afterAll(h.afterAll);

benchIt("benchmarks every read shape the callers can ask for", async () => {
  const store = h.store();
  const layer = h.layer();
  const columns = ["intake", "hold", "todo", "in-progress", "review", "done"] as const;

  // Seed in batches; each row gets a PROMPT.md so `slim` has the same work it has in production.
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < BOARD_ROWS; i += 1) {
    const heavy = i < HEAVY_ROWS;
    const id = `RUFU-${String(i).padStart(5, "0")}`;
    rows.push({
      id,
      projectId: "",
      title: `Board row ${i}`,
      description: "Bench row",
      status: null,
      column: columns[i % columns.length],
      priority: "normal",
      labels: "[]",
      dependencies: "[]",
      source: "manual",
      prompt: null,
      log: JSON.stringify(logOfChars(heavy ? HEAVY_BYTES : LIGHT_BYTES, i)),
      timingTotalMs: 0,
      logRecent: { v: 1, latestAt: null },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  for (let i = 0; i < rows.length; i += 50) {
    for (const row of rows.slice(i, i + 50)) {
      await layer.insert(tasksTable).values(row as never).onConflictDoNothing();
    }
    await store.writeTaskDocument({
      id: rows[i]!.id as string,
      title: `Board row ${i}`,
      description: "Bench row",
      priority: "normal",
      labels: [],
      dependencies: [],
      source: "manual",
      prompt: "## Steps\n1. do the thing\n",
      status: null,
      log: [],
    });
  }

  const shapes: Array<[string, Record<string, unknown>]> = [
    ["today's board (default derive, full row)", {}],
    ["derive:false", { derive: false }],
    ["excludeLog (fixed)", { derive: false, excludeLog: true }],
    ["slim + excludeLog (no PROMPT.md parse)", { slim: true, excludeLog: true, startupMemo: false }],
    ["slim (PROMPT.md parse included)", { slim: true, startupMemo: false }],
    ["derive:true + excludeLog (projections answer)", { excludeLog: true }],
  ];

  const report: string[] = [];
  for (const [label, opts] of shapes) {
    // Warm the cache once, then measure three runs and keep the median: the first run pays catalog,
    // page-cache, and prepared-statement costs no steady-state board refresh pays.
    await store.listTasks(opts as never);
    const samples: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const t0 = process.hrtime.bigint();
      const rowsOut = await store.listTasks(opts as never);
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
      if (run === 0) {
        report.push(`${label}: ${rowsOut.length} rows`);
      }
    }
    samples.sort((a, b) => a - b);
    report.push(`  median ${samples[1]!.toFixed(1)} ms  (min ${samples[0]!.toFixed(1)}, max ${samples[2]!.toFixed(1)})`);
  }
  console.log("\n=== RUFU-615 board read shapes ===\n" + report.join("\n") + "\n");

  // The bench is only meaningful if the two shapes differ, so assert the difference exists.
  const fullMs = await store.listTasks({});
  expect(fullMs.length).toBe(BOARD_ROWS);
  const narrow = await store.listTasks({ excludeLog: true });
  expect(narrow.length).toBe(BOARD_ROWS);
  expect(JSON.stringify(narrow[0]!.log)).toBe("[]");
  expect(LOG_RECENT_INLINE_BYTE_BUDGET).toBeLessThan(LIGHT_BYTES);
}, 900_000);
