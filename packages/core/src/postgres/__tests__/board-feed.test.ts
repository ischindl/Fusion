/*
FNXC:BoardFeedProjection 2026-11-08-18:52 (RUFU-902):
Measurement and correctness harness for the board-feed projection. MEASURED WHY:
`GET /api/tasks/page?limit=100` answers in 12,95 s median and `board-workflows` in 17,21 s; a
100-row board page transfers ~91 kB, i.e. ~24 467 B of hydrated row per card. Allocation sampling
over 60 s of production traffic took 788 MB, ~90 % of it inside the pg driver building full rows
(`DataRow` 53 %, `fromJson` 35 %); the app-side hydration everyone had been attacking — `rowToTask`,
61,8 µs/row after RUFU-871's parse-once pass — is only 8 % of it. The only lever left reaches the
SELECT list, which is what `resolveBoardFeedProjection` narrows.

TWO HALVES, because the claim has two halves:

  1. The SHAPE half (always on, no database). The projection is a strict subset of the slim read, it
     drops exactly the columns `compactBoardFeedRow` already discards, and hydrating a projected row
     then compacting yields the identical `Task` to hydrating the slim row then compacting — across
     the populated / empty / duplicate / absent states. Plus the flag default and the byte ratchet.
  2. The SQL half (real PostgreSQL, `pgDescribe`). The `source_metadata` allowlist expression agrees
     with `projectBoardSourceMetadata` row-for-row, and the projection reflects a mutation inside the
     same transaction boundary while a rolled-back mutation leaves it untouched.

The split is load-bearing, not convenience. A fake store cannot have the bugs the transaction half
guards against, and asserting the SQL's meaning in TypeScript would pin a JS re-implementation
rather than what the server does. This is the same shape RUFU-615 settled for
`project.fusion_task_log_projections()`: transliterate in SQL, hold it equal against the real
function, row-for-row, on a real server.

Run the expensive report (it only prints; the assertions below always run):

  FUSION_BOARD_FEED_BENCH=1 nice -n 10 pnpm --filter @fusion/core exec vitest run \
    src/postgres/__tests__/board-feed.test.ts --reporter=basic
*/
import { describe, expect, it } from "vitest";
import { Column, eq, is, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  BOARD_FEED_DROPPED_COLUMNS,
  BOARD_FEED_PROJECTION_ENV,
  BOARD_FEED_TOKEN_USAGE_NULL_COLUMNS,
  BOARD_SOURCE_METADATA_KEYS,
  isBoardFeedProjectionEnabled,
  resolveBoardFeedProjection,
} from "../board-feed.js";
import { TASK_SLIM_PROJECTION } from "../../task-store/async/async-persistence.js";
import { TASK_JSONB_COLUMNS } from "../../task-store/persistence.js";
import { pgRowToTaskRow, rowToTask } from "../../task-store/serialization.js";
import {
  BOARD_DESCRIPTION_PREVIEW_CHARS,
  compactBoardFeedRow,
  projectBoardSourceMetadata,
} from "../../task-store/reads.js";
import { tasks as tasksTable } from "../schema/project.js";
import postgres from "postgres";
import {
  createTaskStoreForTest,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";

/* ------------------------------------------------------------------ shared fixture */

/** One PostgreSQL-shaped row with realistic bytes in every payload the board feed can drop. */
function boardShapedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const stamp = "2026-11-08T18:00:00.000Z";
  return {
    id: "RUFU-902",
    /*
     * Pinned, not omitted. `rowToTask` mints a fresh `lineageId` for any row that arrives without
     * one, so an omitting fixture compares two different UUIDs and reports a parity difference that
     * is the fixture's, not the projection's.
     */
    lineageId: "lineage-rufu-902",
    projectId: "/test/rufu-902",
    column: "in-review",
    status: null,
    paused: 0,
    userPaused: 0,
    pausedReason: null,
    title: "Derive the board feed in Postgres",
    description: "requirement sentence. ".repeat(80),
    summary: "reviewer summary sentence. ".repeat(60),
    createdAt: stamp,
    updatedAt: stamp,
    columnMovedAt: stamp,
    steps: Array.from({ length: 6 }, (_u, n) => ({ id: `s${n}`, name: `step ${n}`, status: "done", required: true })),
    stepReports: Array.from({ length: 4 }, (_u, n) => ({ stepId: `s${n}`, body: `report body ${n} ${"detail ".repeat(40)}` })),
    comments: Array.from({ length: 8 }, (_u, n) => ({ id: `c${n}`, author: "reviewer", body: `comment body ${n} ${"detail ".repeat(40)}`, createdAt: stamp })),
    steeringComments: Array.from({ length: 4 }, (_u, n) => ({ id: `sc${n}`, author: "operator", body: `steering ${n} ${"detail ".repeat(30)}`, createdAt: stamp })),
    recommendations: Array.from({ length: 3 }, (_u, n) => ({ id: `r${n}`, body: `recommendation ${n} ${"detail ".repeat(40)}` })),
    workflowStepResults: Array.from({ length: 3 }, (_u, n) => ({ stepId: `step-${n}`, status: "passed", verdict: "APPROVE", summary: `finding text ${n} ${"detail ".repeat(40)}`, finishedAt: stamp })),
    sourceMetadata: {
      planEvidence: { spec: "spec text ".repeat(400), fingerprint: "fp-902" },
      staleSpecFingerprint: "x".repeat(900),
      agentName: "Executor",
      issueUrl: "https://example.invalid/902",
      wipAdmissionStall: { signature: "sweep:902", firstAt: stamp, ageMs: 60_000 },
      fusionBranchContext: { assignmentMode: "exclusive" },
    },
    tokenUsageInputTokens: 12_000,
    tokenUsageOutputTokens: 3_000,
    tokenUsageCachedTokens: 900,
    tokenUsageTotalTokens: 15_900,
    tokenUsageCacheWriteTokens: 0,
    tokenUsageFirstUsedAt: stamp,
    tokenUsageLastUsedAt: stamp,
    tokenUsageModelProvider: "anthropic",
    tokenUsageModelId: "claude-x",
    tokenUsagePerModel: [{ modelId: "claude-x", totalTokens: 15_900 }],
    ...overrides,
  };
}

/**
 * Apply the projection to a row the way the server would, driven by the projection object itself
 * rather than a hand-copied list: a key the projection does not name is absent from the row; a key
 * it names with the NULL usage literal arrives as SQL NULL; every other key is copied.
 *
 * `source_metadata` is projected through the REAL `projectBoardSourceMetadata`, because that is the
 * equivalence the pgDescribe half below proves against a live server. Simulating it a second time
 * here would only prove a copy agrees with itself.
 */
function applyProjectionToRow(
  row: Record<string, unknown>,
  projection: Record<string, PgColumnOrSql>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, expression] of Object.entries(projection)) {
    if (key === "sourceMetadata") {
      out.sourceMetadata = row.sourceMetadata == null
        ? (row.sourceMetadata ?? null)
        : projectBoardSourceMetadata(row.sourceMetadata as never);
      continue;
    }
    // A real column transfers what the row holds; any other expression here is the usage NULL
    // literal, which must arrive as SQL NULL rather than as an absent key.
    if (is(expression, Column)) {
      if (key in row) out[key] = row[key];
    } else {
      out[key] = null;
    }
  }
  return out;
}

/**
 * Render a Drizzle `SQL` expression the way the driver will send it, so "what the executed SELECT
 * looks like" is a real observable rather than a guess.
 *
 * A hand-rolled walk over `queryChunks` is NOT a substitute: literals arrive wrapped in `StringChunk`
 * nested one level below the fragment that owns them, and a walk that collects the easy nodes returns
 * a truncated statement that still satisfies every `toContain` below. `SQL` also exposes no `.sql`
 * accessor in drizzle-orm 0.45. Rendering through the dialect the backend actually uses is the only
 * spelling that cannot quietly assert on a partial string, and it also proves the embedded column
 * renders as an identifier (`"project"."tasks"."source_metadata"`) rather than a bound parameter.
 */
function renderSql(expression: unknown): { text: string; params: unknown[] } {
  const query = new PgDialect().sqlToQuery(expression as never);
  return { text: query.sql, params: query.params as unknown[] };
}

type PgColumnOrSql = Column | SQL;

/** Hydrate exactly the way the list path does: PG row -> TaskRow -> Task -> board compaction. */
function hydrateBoardRow(row: Record<string, unknown>, includeTokenUsage: boolean) {
  const taskRow = pgRowToTaskRow<{ [K in string]: unknown }>(row, TASK_JSONB_COLUMNS);
  const task = rowToTask(taskRow as never);
  compactBoardFeedRow(task, { includeTokenUsage });
  return task;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function serializedBytes(value: unknown): number {
  return value === undefined ? 0 : JSON.stringify(value).length;
}

/* ------------------------------------------------------------------ 1. shape */

describe("board-feed projection — shape invariants the parity claim rests on", () => {
  const off = resolveBoardFeedProjection(TASK_SLIM_PROJECTION, { includeTokenUsage: false });
  const on = resolveBoardFeedProjection(TASK_SLIM_PROJECTION, { includeTokenUsage: true });
  const slimKeys = Object.keys(TASK_SLIM_PROJECTION);

  it("is a strict subset of the slim read and never invents a column", () => {
    for (const [label, projection] of [["cost hidden", off], ["cost visible", on]] as const) {
      const keys = Object.keys(projection);
      expect(keys.length, `${label}: not narrower than the slim read`).toBeLessThan(slimKeys.length);
      for (const key of keys) {
        expect(slimKeys, `${label}: projection invented ${key}`).toContain(key);
      }
    }
  });

  it("drops exactly the columns board compaction already discards, and nothing else", () => {
    const keys = Object.keys(off);
    for (const column of BOARD_FEED_DROPPED_COLUMNS) {
      expect(keys, `${column} survived a drop the compaction already performs`).not.toContain(column);
    }
    // The board renders these, so dropping them would be a visible regression, not a saving.
    for (const column of ["id", "column", "status", "paused", "pausedReason", "updatedAt", "workflowStepResults", "steps", "attachments", "description"]) {
      expect(keys, `the board renders ${column} and the projection stopped selecting it`).toContain(column);
    }
    // `log` and `search_vector` are already gone from the slim read; the board feed must not buy them back.
    expect(keys).not.toContain("log");
    expect(keys).not.toContain("searchVector");
  });

  it("NULLs the usage guard columns instead of omitting them, and omits the rest of the family", () => {
    /*
     * `rowToTask` decides "no usage" with a strict `=== null` probe. An ABSENT guard key reads as
     * "usage present" and builds a tokenUsage object of `undefined`s — a shape the board has never
     * served, and one no parity test would catch unless it is asserted directly.
     */
    const keys = Object.keys(off);
    for (const column of BOARD_FEED_TOKEN_USAGE_NULL_COLUMNS) {
      expect(keys, `${column} was omitted; the guard would then misfire`).toContain(column);
      expect(is(off[column], Column), `${column} must be a NULL literal, not the real column`).toBe(false);
    }
    const stillTransferred = keys.filter((key) => key.startsWith("tokenUsage") && !BOARD_FEED_TOKEN_USAGE_NULL_COLUMNS.includes(key));
    expect(stillTransferred, "the rest of the tokenUsage family must stop transferring with the guard").toEqual([]);
    // With the cost badge visible, the whole family comes back as real columns.
    for (const column of BOARD_FEED_TOKEN_USAGE_NULL_COLUMNS) {
      expect(is(on[column], Column), `${column} must be the real column when cost is visible`).toBe(true);
    }
    expect(Object.keys(on).filter((key) => key.startsWith("tokenUsage")).length).toBeGreaterThan(BOARD_FEED_TOKEN_USAGE_NULL_COLUMNS.length);
  });

  it("projects source_metadata key-by-key rather than transferring the blob", () => {
    expect(is(off.sourceMetadata, Column), "source_metadata must be a derived expression, not the column").toBe(false);
    const { text: rendered, params } = renderSql(off.sourceMetadata);
    /*
     * Structural, not prose: the three `CASE` arms each answer a state the JS allowlist handles
     * differently, so all three must be present in the executed SQL. Asserting the arms is asserting
     * code shape (permitted); asserting a comment or a date stamp would not be. The length floor is
     * what makes the rest of this block mean something — a truncated render satisfies every
     * `toContain` below while proving nothing.
     */
    expect(rendered.length, "the rendered statement is too short to be the whole projection").toBeGreaterThan(300);
    expect(rendered).toContain("jsonb_typeof");
    expect(rendered).toContain("jsonb_each");
    expect(rendered).toContain("jsonb_object_agg");
    expect(rendered).toContain("'{}'::jsonb");
    expect(rendered).toContain("ELSE");
    // The embedded column must reach PostgreSQL as an identifier; as a bound parameter it would be
    // a text literal and `jsonb_typeof(text)` raises a type error on the first board read.
    expect(rendered).toContain('"source_metadata"');
    for (const key of BOARD_SOURCE_METADATA_KEYS) {
      expect(params, `allowlist omitted ${key}`).toContain(key);
    }
  });
});

/* ------------------------------------------------------------------ 2. parity */

describe("board-feed projection — byte-identical board rows (parity, no database)", () => {
  type FeedState = { label: string; row: Record<string, unknown> };

  const states: FeedState[] = [
    { label: "populated", row: boardShapedRow() },
    {
      label: "empty",
      row: boardShapedRow({
        sourceMetadata: {},
        comments: [],
        steeringComments: [],
        stepReports: [],
        recommendations: [],
        workflowStepResults: [],
        steps: [],
        summary: "",
        description: "",
        tokenUsageInputTokens: null,
        tokenUsageOutputTokens: null,
        tokenUsageCachedTokens: null,
        tokenUsageTotalTokens: null,
        tokenUsagePerModel: [],
      }),
    },
    {
      // The state RUFU-883 exists for: the same comment record several times over.
      label: "duplicate",
      row: boardShapedRow({
        comments: Array.from({ length: 8 }, () => ({ id: "c-dup", author: "reviewer", body: "one sentence repeated", createdAt: "2026-11-08T18:00:00.000Z" })),
        workflowStepResults: [
          { stepId: "code-review", status: "passed", verdict: "APPROVE", summary: "same finding", finishedAt: "2026-11-08T18:00:00.000Z" },
          { stepId: "code-review", status: "failed", verdict: "REVISE", summary: "same finding", finishedAt: "2026-11-08T18:00:00.000Z" },
        ],
        sourceMetadata: { agentName: "Executor", planEvidence: { spec: "spec text ".repeat(400) } },
      }),
    },
    {
      // Absent, not empty: the shape a narrow read produces for a card that never wrote the payload.
      label: "absent",
      row: (() => {
        const row = boardShapedRow();
        for (const key of ["summary", "comments", "steeringComments", "stepReports", "recommendations", "sourceMetadata", "tokenUsagePerModel"]) {
          delete row[key];
        }
        return row;
      })(),
    },
    {
      label: "null source metadata",
      row: boardShapedRow({ sourceMetadata: null }),
    },
  ];

  for (const includeTokenUsage of [false, true]) {
    for (const state of states) {
      it(`hydrates identically with the cost badge ${includeTokenUsage ? "visible" : "hidden"} — ${state.label}`, () => {
        const projection = resolveBoardFeedProjection(TASK_SLIM_PROJECTION, { includeTokenUsage });
        const viaSlim = hydrateBoardRow({ ...state.row }, includeTokenUsage);
        const viaProjection = hydrateBoardRow(applyProjectionToRow({ ...state.row }, projection), includeTokenUsage);
        expect(viaProjection).toStrictEqual(viaSlim);
      });
    }
  }

  it("never truncates a description the compaction would not have truncated anyway", () => {
    /*
     * Deliberately NOT projected into SQL: `left(description, 400)` server-side would hand
     * `compactBoardFeedRow` a string already at the cap, so it would stop setting
     * `descriptionTruncated` — a silently different card. Truncation stays in JS and this names why.
     */
    const long = hydrateBoardRow({ ...boardShapedRow(), description: "x".repeat(BOARD_DESCRIPTION_PREVIEW_CHARS + 100) }, false);
    expect(long.description).toHaveLength(BOARD_DESCRIPTION_PREVIEW_CHARS);
    expect(long.descriptionTruncated).toBe(true);
    const short = hydrateBoardRow({ ...boardShapedRow(), description: "short" }, false);
    expect(short.descriptionTruncated).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ 3. cost ratchet */

describe("board-feed projection — strictly fewer columns and bytes per row", () => {
  const row = boardShapedRow();

  /** Bytes the driver would build for one row under a given projection. */
  function bytesFor(projection: Record<string, PgColumnOrSql>): number {
    return Object.keys(projection).reduce((sum, key) => sum + serializedBytes(row[key]), 0);
  }

  it("transfers strictly fewer bytes per row than the slim read it replaces", () => {
    const slim = bytesFor(TASK_SLIM_PROJECTION as Record<string, PgColumnOrSql>);
    const off = bytesFor(resolveBoardFeedProjection(TASK_SLIM_PROJECTION, { includeTokenUsage: false }));
    const on = bytesFor(resolveBoardFeedProjection(TASK_SLIM_PROJECTION, { includeTokenUsage: true }));
    expect(off).toBeGreaterThan(0);
    expect(off).toBeLessThan(slim);
    // Cost visible is the weaker of the two shapes; it still has to beat the old read.
    expect(on).toBeLessThan(slim);
  });

  it("selects strictly fewer columns per row than the slim read", () => {
    expect(Object.keys(resolveBoardFeedProjection(TASK_SLIM_PROJECTION, { includeTokenUsage: false })).length)
      .toBeLessThan(Object.keys(TASK_SLIM_PROJECTION).length);
  });

  it.skipIf(!process.env.FUSION_BOARD_FEED_BENCH)(
    "prints the per-row column and byte report (report-only, FUSION_BOARD_FEED_BENCH=1)",
    () => {
      const slim = Object.keys(TASK_SLIM_PROJECTION);
      const off = resolveBoardFeedProjection(TASK_SLIM_PROJECTION, { includeTokenUsage: false });
      const on = resolveBoardFeedProjection(TASK_SLIM_PROJECTION, { includeTokenUsage: true });
      const repeats = 7;
      const measure = (p: Record<string, PgColumnOrSql>) => median(Array.from({ length: repeats }, () => bytesFor(p)));
      const slimBytes = median(Array.from({ length: repeats }, () => bytesFor(TASK_SLIM_PROJECTION as Record<string, PgColumnOrSql>)));
      const heavy = [...BOARD_FEED_DROPPED_COLUMNS, "sourceMetadata"];
      const lines = [
        "",
        "=== BOARD FEED (per row, median of 7, fixture-shaped row) ===",
        "shape".padEnd(42) + "cols".padEnd(8) + "B/row".padEnd(10) + "saved B/row",
        `slim read (today's board feed)`.padEnd(42) + String(slim.length).padEnd(8) + String(slimBytes).padEnd(10) + "0",
        `board feed, cost hidden`.padEnd(42) + String(Object.keys(off).length).padEnd(8) + String(measure(off)).padEnd(10) + String(slimBytes - measure(off)),
        `board feed, cost visible`.padEnd(42) + String(Object.keys(on).length).padEnd(8) + String(measure(on)).padEnd(10) + String(slimBytes - measure(on)),
        "",
        `payload columns no longer transferred: ${heavy.join(", ")}`,
        `their share of the slim row: ${heavy.reduce((s, c) => s + serializedBytes(row[c]), 0)} B/row`,
        `100-card page at these figures: ${(measure(off) * 100 / 1024).toFixed(1)} kB vs ${(slimBytes * 100 / 1024).toFixed(1)} kB`,
        "NOT measured here: PostgreSQL CPU. Projecting source_metadata decompresses it server-side;",
        "RUFU-615 rejected that trade for `log` at 4,5-11,5 s per full-board read. See the module's risk note.",
      ];
      // eslint-disable-next-line no-console
      console.log(lines.join("\n"));
      expect(measure(off)).toBeLessThan(slimBytes);
    },
  );
});

/* ------------------------------------------------------------------ 4. flag */

describe("board-feed projection — one flag, default OFF", () => {
  it("is OFF with no environment at all, and with every unset spelling", () => {
    expect(isBoardFeedProjectionEnabled({})).toBe(false);
    for (const value of ["", " ", "0", "false", "no", "off", "random"]) {
      expect(isBoardFeedProjectionEnabled({ [BOARD_FEED_PROJECTION_ENV]: value }), `${value} enabled the flag`).toBe(false);
    }
  });

  it("is ON only for the four documented affirmative spellings", () => {
    for (const value of ["1", "true", "TRUE", " yes ", "On"]) {
      expect(isBoardFeedProjectionEnabled({ [BOARD_FEED_PROJECTION_ENV]: value }), `${value} did not enable the flag`).toBe(true);
    }
  });

  it("names one environment variable, so rollback is one unset", () => {
    expect(BOARD_FEED_PROJECTION_ENV).toBe("FUSION_BOARD_FEED_PROJECTION");
  });
});

/* ------------------------------------------------------------------ 4b. transaction semantics, locally */

/*
FNXC:BoardFeedProjection 2026-11-08-18:52 (RUFU-902):
The half of the transaction contract that lives in THIS code, proven without a server. A projection
is a pure function of the row the read handle is looking at, so it cannot outlive a write: the two
properties below are (a) a mutation is visible to a read taken on the same handle, in the same
transaction, and (b) a rolled-back mutation leaves the projection untouched. The fake handle models
exactly one thing Postgres guarantees — staged writes are visible to the writer and vanish on
rollback — and everything else is the real projection path.

What this CANNOT prove is that the SQL text agrees with `projectBoardSourceMetadata`, and what it
must not be read as claiming is the server's own NOTIFY-on-commit behaviour. That is the gated
half below. Passing here while the SQL diverges is the failure mode to stay alert for.
*/
describe("board-feed projection — derived per read, refreshed by the write and discarded by its rollback", () => {
  it("a read inside the transaction sees the mutation; after a rollback it never happened", async () => {
    const committed: Record<string, unknown> = boardShapedRow({
      sourceMetadata: { agentName: "Executor", planEvidence: { spec: "spec text ".repeat(400) } },
    });
    const projection = resolveBoardFeedProjection(TASK_SLIM_PROJECTION, { includeTokenUsage: false });
    const readVia = (row: Record<string, unknown>) => applyProjectionToRow(structuredClone(row), projection);

    const before = readVia(committed);
    expect(before.column).toBe("in-review");

    const ROLLBACK = "rufu-902-forced-rollback";
    let insideAfterMutation: Record<string, unknown> | undefined;
    // A transaction that mutates, re-reads through its own handle, then aborts.
    await expect((async () => {
      const staged = structuredClone(committed);
      staged.column = "done";
      staged.sourceMetadata = {
        agentName: "Reviewer-after-mutation",
        planEvidence: { spec: "different spec " + "x".repeat(900) },
      };
      insideAfterMutation = readVia(staged);
      throw new Error(ROLLBACK);
    })()).rejects.toThrow(ROLLBACK);

    // Property 1: the mutation refreshes the representation inside its own transaction boundary.
    expect(insideAfterMutation?.column).toBe("done");
    expect((insideAfterMutation?.sourceMetadata as Record<string, unknown>).agentName).toBe("Reviewer-after-mutation");
    // Derived per read, not memoised: the off-allowlist payload stayed out even after it grew.
    expect((insideAfterMutation?.sourceMetadata as Record<string, unknown>).planEvidence).toBeUndefined();

    // Property 2: the rolled-back mutation changed nothing a reader can observe.
    expect(readVia(committed)).toStrictEqual(before);
    expect(readVia(committed).column).toBe("in-review");
  });

  it("holds no state between reads: two calls with the same row are equal, and the objects are not shared", () => {
    const row = boardShapedRow();
    const projection = resolveBoardFeedProjection(TASK_SLIM_PROJECTION, { includeTokenUsage: false });
    const first = applyProjectionToRow(row, projection);
    const second = applyProjectionToRow(row, projection);
    expect(second).toStrictEqual(first);
    expect(second).not.toBe(first);
    // And the projection object itself carries no rows: building it twice yields independent objects.
    expect(resolveBoardFeedProjection(TASK_SLIM_PROJECTION, { includeTokenUsage: false })).not.toBe(resolveBoardFeedProjection(TASK_SLIM_PROJECTION, { includeTokenUsage: false }));
  });
});

/* ------------------------------------------------------------------ 5. real PostgreSQL */

/*
 * The server's own two properties, and the SQL↔TypeScript equivalence. Gated on a live probe of
 * the same `FUSION_PG_TEST_URL_BASE` the harness dials, rather than on `pgDescribe`'s
 * "is PG_TEST_SKIP set" rule: a port that answers TCP but rejects authentication passes
 * `pgDescribe`'s check and then fails the whole file, and a deployment whose test server is not
 * reachable must stay green. The probe is a `SELECT 1` on its own connection; it creates nothing.
 *
 * If this skips on your machine, the two properties above are NOT proven here — they are proven
 * against a real server only, and the skip is the gap, not a pass.
 */
let pgServerUsable = false;
try {
  const probeClient = postgres(process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432", {
    max: 1,
    connect_timeout: 3,
    onnotice: () => {},
  });
  const probeRows = await probeClient`SELECT 1 AS ok`;
  pgServerUsable = probeRows[0]?.ok === 1;
  await probeClient.end({ timeout: 2 }).catch(() => undefined);
} catch {
  pgServerUsable = false;
}
const pgTest = pgServerUsable ? describe : describe.skip;

pgTest("board-feed projection against a real PostgreSQL (transaction semantics)", () => {
  it("reflects a mutation inside the same transaction, and is untouched by a rolled-back one", async () => {
    const h: PgTestHarness = await createTaskStoreForTest({ prefix: "fusion_board_feed" });
    try {
      const created = await h.store.createTask({ title: "RUFU-902 projection", description: "before" });
      const id = created.id;
      const projection = resolveBoardFeedProjection(TASK_SLIM_PROJECTION, { includeTokenUsage: false });
      const readProjected = (handle: { select: (p: unknown) => { from: (t: unknown) => { where: (w: unknown) => Promise<Record<string, unknown>[]> } } }) =>
        handle.select(projection).from(tasksTable).where(eq(tasksTable.id, id)) as Promise<Record<string, unknown>[]>;

      /*
       * The mutation is (a) a lane move — a board-visible column — and (b) a `source_metadata` write
       * that adds BOTH an allowlisted key and an off-allowlist key. The second is what proves the
       * allowlist is re-derived per read rather than memoised: if anything cached the projected
       * object, the new `agentName` would not appear.
       */
      const ROLLBACK = "rufu-902-forced-rollback";
      let insideBefore: Record<string, unknown> | undefined;
      let insideAfter: Record<string, unknown> | undefined;
      await expect(h.layer.transaction(async (tx) => {
        insideBefore = (await readProjected(tx as never))[0];
        await tx.update(tasksTable).set({
          column: "done",
          sourceMetadata: {
            agentName: "Reviewer-after-mutation",
            planEvidence: { spec: "spec text ".repeat(400) },
          },
        }).where(eq(tasksTable.id, id));
        insideAfter = (await readProjected(tx as never))[0];
        throw new Error(ROLLBACK);
      })).rejects.toThrow(ROLLBACK);

      // Property 1: the mutation itself refreshes the derived representation, in its own transaction.
      expect(insideBefore?.column).toBe("in-review");
      expect(insideAfter?.column, "the projection did not reflect the mutation in its own transaction").toBe("done");
      expect((insideAfter?.sourceMetadata as Record<string, unknown> | undefined)?.agentName)
        .toBe("Reviewer-after-mutation");

      // Property 2: the rolled-back mutation changed nothing, exactly as a NOTIFY on that handle is discarded.
      const afterRollback = (await readProjected(h.layer.db as never))[0];
      expect(afterRollback?.column, "a rolled-back mutation moved the card").toBe("in-review");
      expect((afterRollback?.sourceMetadata as Record<string, unknown> | undefined)?.agentName)
        .not.toBe("Reviewer-after-mutation");
    } finally {
      await h.teardown();
    }
  }, 180_000);

  it("agrees with projectBoardSourceMetadata row-for-row", async () => {
    const h: PgTestHarness = await createTaskStoreForTest({ prefix: "fusion_board_feed_eq" });
    try {
      /*
       * One row per state `projectBoardSourceMetadata` distinguishes. `jsonb_typeof` splits these
       * five ways, and collapsing them is precisely how a SQL transliteration goes quietly wrong:
       * an object keeps allowlisted keys, an array becomes {}, a scalar and a JSON null pass
       * through, and a SQL NULL must stay NULL so `branchContext` still hydrates as undefined.
       */
      const shapes: Array<Record<string, unknown> | null | string | unknown[]> = [
        { planEvidence: { spec: "big" }, agentName: "Executor", issueUrl: "https://example.invalid/1", handoffFrom: "p1", unknownKey: "drop me" },
        {},
        [],
        "just a string",
        null,
        { issueInfo: "not a metadata key", wipAdmissionStall: { signature: "sweep:902" } },
      ];
      const created: string[] = [];
      for (const [index, shape] of shapes.entries()) {
        const task = await h.store.createTask({ title: `RUFU-902 shape ${index}`, description: `shape ${index}` });
        created.push(task.id);
        // Written raw: `updateTask` would refuse or reshape several of these states.
        await h.adminSql`UPDATE project.tasks SET source_metadata = ${shape === null ? null : JSON.stringify(shape)}::jsonb WHERE id = ${task.id}`;
      }

      const projection = resolveBoardFeedProjection(TASK_SLIM_PROJECTION, { includeTokenUsage: false });
      for (const [index, shape] of shapes.entries()) {
        const [row] = await h.layer.db.select(projection).from(tasksTable).where(eq(tasksTable.id, created[index]!));
        expect(row, `shape ${index} produced no row`).toBeDefined();
        expect(row.sourceMetadata, `shape ${index} diverged from the TypeScript allowlist`)
          .toStrictEqual(projectBoardSourceMetadata(shape as never));
      }

      // The off-allowlist payload must not be transferred at all — that is the entire point.
      const [firstRow] = await h.layer.db.select(projection).from(tasksTable).where(eq(tasksTable.id, created[0]!));
      const projectedMeta = firstRow!.sourceMetadata as Record<string, unknown>;
      expect(projectedMeta.planEvidence).toBeUndefined();
      expect(projectedMeta.agentName).toBe("Executor");
    } finally {
      await h.teardown();
    }
  }, 180_000);
});
