/*
FNXC:TaskLogProjections 2026-11-20-17:40 (RUFU-636):
ACCEPTANCE SUITE FOR THE LOG-FREE SUFFICIENCY GATE.

RUFU-615 shipped an envelope sufficiency proof that no reader consulted, and RUFU-312 then made every
list read log-free while still deriving the stall badges from that unproved envelope. The defect this
file exists to keep dead is a SILENT ONE: an envelope that cannot prove its recent window answers
"not stalled", `0 ms`, or an undercounted `matchCount` — and because that count is embedded in the
operator-visible stall-reason sentence, an approximation is a wrong answer, not a cheap one.

Every card here is seeded in the shape the census measures, through the seams that produce that shape:

  * the LEGACY author (the row's own `log_recent` pair, stamped `log_projection_at`) is written raw,
    because a compound `updateTask({log})` is what authors it;
  * `project.task_log_entries` rows are written RAW, because `appendTaskLogEntries` — and the
    `catchUpLegacyTaskLogEntries` copy pass that calls it — RE-AUTHORS the rollup over the MERGED
    legacy+side view. A fixture that populated the side table through those seams would author the
    very envelope whose insufficiency it is trying to stage, and the gate would never fire;
  * the repaired arm runs the REAL copy pass (`catchUpLegacyTaskLogEntries`) rather than inserting
    rows by hand, so "what a completed catch-up does" is the thing under test.

The arms are the census's own populations, one per withhold reason, plus the repair, plus board/search
parity, plus the two cost claims the gate rests on: a sufficient row costs zero extra statements, and a
gated pass costs at most one however many cards it names.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  pgDescribe as pgTest,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  LOG_RECENT_MATCH_ARRAY_CAP,
  LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP,
  LOG_RECENT_SUFFICIENCY_READ_ROW_CAP,
  deriveTaskLogProjections,
} from "../../task-store/task-log-projections.js";
import { catchUpLegacyTaskLogEntries, readTaskLogEntries, taskLogProjectId } from "../../task-store/task-log-entries.js";
import { getTaskActivityLogEntryLimit } from "../../task-store/comments.js";
import { STALLED_REVIEW_REENQUEUE_PATTERN } from "../../tasks/stalled-review-detector.js";
import { storeLog } from "../../store.js";
import type { Task, TaskLogEntry } from "../../types.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A stamp `minutesAgo` minutes before now, in the exact ISO shape the writer and migration 0093 use. */
function stamp(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * MINUTE).toISOString();
}

function jsonParam(value: unknown): string {
  return JSON.stringify(value);
}

/** The stamped shape the writer and migration 0093 use, which the text-ordered bound must match. */
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Churn lines that light the re-enqueue badge: the action carries the detector's own pattern constant,
 * and `count` above `LOG_RECENT_MATCH_ARRAY_CAP` is what forces the envelope to drop a match inside the
 * window, which is the insufficiency the gate is built to notice.
 */
function churnLog(count: number, startMinutesAgo = 40): TaskLogEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: stamp(startMinutesAgo - i),
    action: STALLED_REVIEW_REENQUEUE_PATTERN,
    outcome: "requeued",
  }));
}

const TIMING_LINE = (minutesAgo: number, ms: number): TaskLogEntry => ({
  timestamp: stamp(minutesAgo),
  action: `[timing] step 2 completed in ${ms}ms`,
  outcome: "",
});

/** Seed a card as the LEGACY author would have left it: the array, its derived pair, and its stamp. */
async function seedLegacyAuthor(
  h: SharedPgTaskStoreHarness,
  id: string,
  options: {
    log: readonly TaskLogEntry[];
    /** NULLs the derived pair, which is the pre-column row shape (census population `no-envelope`). */
    blankPair?: boolean;
    /** NULLs the legacy array while the derived pair is still authored from `log` (RUFU-635's side-only row). */
    nullLog?: boolean;
    column?: string;
    quietMinutesAgo?: number;
  },
): Promise<void> {
  const sql = h.adminSql();
  const derived = deriveTaskLogProjections(options.log);
  const quiet = options.quietMinutesAgo ?? 30 * 60;
  const anchor = new Date(Date.now() - quiet * MINUTE).toISOString();
  await sql`
    INSERT INTO project.tasks (
      id, project_id, title, description, "column", steps, current_step,
      dependencies, log, timing_total_ms, log_recent, log_projection_at,
      created_at, updated_at, column_moved_at, workflow_step_results
    ) VALUES (
      ${id}, '', ${"sufficiency gate fixture"}, ${"seeded by RUFU-636"}, ${options.column ?? "in-review"},
      '[]', 0, '[]',
      ${options.nullLog ? null : jsonParam(options.log)}::jsonb,
      ${options.blankPair ? null : derived.timingTotalMs},
      ${options.blankPair ? null : jsonParam(derived.logRecent)}::jsonb,
      ${options.blankPair ? null : new Date().toISOString()},
      ${anchor}, ${anchor}, ${anchor}, '[]'
    )
    -- Re-seeding the SAME card is how the cost test changes one card's envelope without changing the
    -- page's row count, which is what makes the two statement measurements comparable at all.
    ON CONFLICT (project_id, id) DO UPDATE SET
      "column" = excluded."column",
      log = excluded.log,
      timing_total_ms = excluded.timing_total_ms,
      log_recent = excluded.log_recent,
      log_projection_at = excluded.log_projection_at,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      column_moved_at = excluded.column_moved_at
  `;
  // A freshly created card may already own side rows; a fixture that means "the copy never arrived"
  // has to say so, or proof 1 measures somebody else's History.
  await sql`DELETE FROM project.task_log_entries WHERE task_id = ${id}`;
}

/**
 * Write side rows WITHOUT re-authoring the rollup — the only way to stage an envelope that is behind
 * the side table, or a side table that is behind the envelope. `seq` is left to its default so the
 * writer's own ordering never decides an assertion here.
 */
async function insertSideRows(
  h: SharedPgTaskStoreHarness,
  id: string,
  entries: readonly TaskLogEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const sql = h.adminSql();
  for (const entry of entries) {
    await sql`
      INSERT INTO project.task_log_entries (project_id, task_id, "timestamp", action, outcome)
      VALUES ('', ${id}, ${entry.timestamp}, ${entry.action}, ${entry.outcome ?? ""})
    `;
  }
}

/** The copy pass's own gate: legacy lines stamped BEFORE `backfilledAt` are the excluded population. */
async function setBackfillMarker(h: SharedPgTaskStoreHarness, backfilledAt: string): Promise<void> {
  const sql = h.adminSql();
  await sql`
    INSERT INTO project.task_log_backfill_marker (project_id, backfilled_at)
    VALUES ('', ${backfilledAt})
    ON CONFLICT (project_id) DO UPDATE SET backfilled_at = excluded.backfilled_at
  `;
}

/** One read of the board's own feed for one card, in the shape the dashboard asks for. */
async function readBoardCard(store: ReturnType<SharedPgTaskStoreHarness["store"]>, id: string): Promise<Task | undefined> {
  const tasks = await store.listTasks({ columns: ["in-review"] as never, slim: true, startupMemo: false });
  return tasks.find((t) => t.id === id);
}

/** The same card as a log-LOADED read answers it — the ground truth a repaired card must match. */
async function readLoadedCard(store: ReturnType<SharedPgTaskStoreHarness["store"]>, id: string): Promise<Task | undefined> {
  // `slim` implies `excludeLog`, so the ground-truth read asks for the log column and no compaction.
  const tasks = await store.listTasks({ columns: ["in-review"] as never, startupMemo: false });
  return tasks.find((t) => t.id === id);
}

/**
 * Churn lines packed into one span instead of one per minute, so a fixture that stages a window fuller
 * than the read cap can put every stamp inside the horizon the read actually uses.
 */
function denseChurnLog(count: number, spanMinutesAgo: number): TaskLogEntry[] {
  const spanMs = spanMinutesAgo * MINUTE;
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(Date.now() - spanMs + Math.round((i * spanMs) / count)).toISOString(),
    action: STALLED_REVIEW_REENQUEUE_PATTERN,
    outcome: "requeued",
  }));
}

/**
 * Render one instant in a NON-ISO-offset textual shape a real parser accepts (`Date.parse` agrees) while
 * its raw TEXT sorts below an ISO bound covering the same instant. A negative offset moves the wall clock
 * backwards, which is the direction that matters: the legacy writer's output is what `collectRecentMatches`
 * compared, and the side table is compared as TEXT.
 */
function withOffsetText(instantMs: number, offset: "-05:00" | "+14:00"): string {
  const [hh, mm] = offset.slice(1).split(":").map(Number);
  const shift = (hh! * 60 + mm!) * 60_000 * (offset.startsWith("-") ? -1 : 1);
  return `${new Date(instantMs + shift).toISOString().replace(/Z$/, "")}${offset}`;
}

/** Strips the wall clock so two reads taken apart in time stay comparable. */
function badgeOf(task: Task | undefined) {
  if (!task) return undefined;
  const strip = <T extends { observedAt?: string } | undefined>(signal: T) => {
    if (!signal) return signal;
    const { observedAt, ...rest } = signal;
    return rest;
  };
  return {
    stalledReview: task.stalledReview,
    inReviewStalled: strip(task.inReviewStalled),
    stallReason: strip(task.stallReason),
  };
}

/**
 * Statement-level counter for the batched History read — the ONE seam whose cost this card's claims are
 * about, counted by wrapping the shipped implementation rather than by watching the server.
 *
 * `pg_stat_database.xact_commit` was the first instrument and is the wrong one: the read runs inside the
 * same transaction envelope as the page's other statements, and the database's committed-transaction
 * counter was measured reporting +0 across a pass that demonstrably ran the fallback. A wrapper that
 * delegates to the real function counts the round-trip the claim actually names, and records the two
 * per-row facts the claim is bounded by — how many rows carried a bound, and which carried none.
 */
const batchReads = vi.hoisted(() => ({
  calls: [] as Array<{ rowCount: number; bounded: string[]; unbounded: string[]; boundValues: string[]; cap: number | undefined }>,
}));

vi.mock("../../task-store/task-log-entries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../task-store/task-log-entries.js")>();
  const readTaskLogEntriesBatch = (
    ...args: Parameters<typeof actual.readTaskLogEntriesBatch>
  ): ReturnType<typeof actual.readTaskLogEntriesBatch> => {
    const [client, projectId, taskIds, options] = args;
    const ids = [...new Set(taskIds)];
    const boundValues = ids
      .map((id) => options?.bounds?.get(id))
      .filter((value): value is string => typeof value === "string");
    batchReads.calls.push({
      rowCount: ids.length,
      bounded: ids.filter((id) => typeof options?.bounds?.get(id) === "string"),
      unbounded: ids.filter((id) => typeof options?.bounds?.get(id) !== "string"),
      boundValues,
      cap: options?.cap,
    });
    return actual.readTaskLogEntriesBatch(client, projectId, taskIds, options);
  };
  return { ...actual, readTaskLogEntriesBatch };
});

function resetBatchReads(): void {
  batchReads.calls.length = 0;
}


pgTest("the log-free sufficiency gate (RUFU-636)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_log_gate" });
  let warn: ReturnType<typeof vi.spyOn>;
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  /*
  FNXC:TaskLogProjections 2026-11-20-21:33 (RUFU-636):
  The harness reset is registered on purpose. Every measurement in this file is a WHOLE-PAGE statement
  count or a whole-page warning tally, and the page is every card the board can see: without the reset,
  a fixture left behind by an earlier case is silently gated by the next case, its reason lands in that
  case's single warning line, and a cost claim that says "one statement per pass" measures somebody
  else's cards.
  */
  beforeEach(h.beforeEach);
  beforeEach(() => {
    warn = vi.spyOn(storeLog, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  /*
  Census population 1 — `no-envelope` plus `dropped-match-in-window`, with an empty side table. This is
  the merge hazard the card names: a legacy array holding recent lines the copy pass excludes
  (stamped before `backfilledAt`) is the population the census measured at 3 cards / 16 033 rows, and it
  is exactly the population a side-table read cannot repair. Today's capped answer must SURVIVE, and
  surviving must not mean `undefined`, because a cleared churn badge is a false "not stalled".
  */
  it("keeps today's capped churn answer and names side-history-absent when the side table holds none of the History", async () => {
    const store = h.store();
    const id = "RUFU-GATE-ABSENT";
    const churn = churnLog(LOG_RECENT_MATCH_ARRAY_CAP + 4);
    await seedLegacyAuthor(h, id, { log: [...churn, TIMING_LINE(3 * 24 * 60, 5_000)] });

    const card = await readBoardCard(store, id);
    expect(card, "the fixture vanished from the board feed").toBeTruthy();
    expect(card!.stalledReview, "the churn badge went undefined — a cleared badge is the false answer this gate must never serve")
      .toBeTruthy();
    expect(card!.stalledReview!.matchCount, "an unprovable fallback must leave the capped envelope answer standing")
      .toBe(LOG_RECENT_MATCH_ARRAY_CAP);
    expect(card!.log, "the served row must keep the hydrated empty array — the fallback is derivation input only")
      .toEqual([]);
    expect(card!.timedExecutionMs, "timedExecutionMs sums the WHOLE History and may not be recomputed from a horizon-bounded read")
      .toBe(5_000);

    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes("[log-recent-sufficiency]")), "a withheld fallback that is invisible is the defect").toHaveLength(1);
    expect(lines[0]).toContain("side-history-absent=1");
  });

  /*
  The repair, run through the seam that produces the real repaired state: the copy pass. After it the
  envelope is STILL capped (the match arrays are capped no matter how complete the data is), so the gate
  still fires and now PASSES its four proofs, and the card must answer the way the data answers.
  */
  it("repairs the churn badge to the log-loaded count once the real copy pass delivers the lines", async () => {
    const store = h.store();
    const id = "RUFU-GATE-REPAIR";
    const churn = churnLog(LOG_RECENT_MATCH_ARRAY_CAP + 4);
    await seedLegacyAuthor(h, id, { log: churn });
    // The copy pass is eligible only for lines stamped at or after its marker, so this is the shape
    // where the second pass delivers what the first one excluded.
    await setBackfillMarker(h, stamp(2 * 24 * 60));

    const before = await readBoardCard(store, id);
    expect(before!.stalledReview!.matchCount).toBe(LOG_RECENT_MATCH_ARRAY_CAP);
    warn.mockClear();

    const copy = await catchUpLegacyTaskLogEntries(h.layer(), {});
    expect(copy.copiedEntryCount).toBeGreaterThan(0);

    const after = await readBoardCard(store, id);
    expect(after!.stalledReview!.matchCount, "a provably complete History must ANSWER, not sit withheld")
      .toBe(churn.length);
    const loaded = await readLoadedCard(store, id);
    expect(badgeOf(after), "a repaired card must agree with a log-loaded read of the same card")
      .toEqual(badgeOf(loaded));
    expect(loaded!.stalledReview!.matchCount, "the log-loaded ground truth must be the lit badge the repair was measured against")
      .toBe(churn.length);
    expect(after!.log, "the repair stays a derivation input; the served row's payload never widens")
      .toEqual([]);
    expect(warn.mock.calls.map((call) => String(call[0])).some((line) => line.includes("[log-recent-sufficiency]")),
      "a pass that repaired every row has nothing to withhold")
      .toBe(false);
  });

  /*
  Census population 2 — `side-window-truncated`: the horizon genuinely holds more lines than the read
  may carry, so no answer can be proved from a window that is by construction a slice.
  */
  it("names side-window-truncated and keeps today's answer when the horizon holds at least the read cap", async () => {
    const store = h.store();
    const id = "RUFU-GATE-TRUNCATED";
    await seedLegacyAuthor(h, id, { log: churnLog(LOG_RECENT_MATCH_ARRAY_CAP + 4, 30) });
    await insertSideRows(h, id, denseChurnLog(LOG_RECENT_SUFFICIENCY_READ_ROW_CAP + 44, 50));

    const card = await readBoardCard(store, id);
    expect(card!.stalledReview!.matchCount).toBe(LOG_RECENT_MATCH_ARRAY_CAP);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes("[log-recent-sufficiency]"))).toHaveLength(1);
    expect(lines[0]).toContain("side-window-truncated=1");
    expect(
      await readTaskLogEntries(h.layer().db as never, taskLogProjectId(h.layer()), id),
      "the fixture must really have staged a horizon fuller than the read cap — a withheld arm that withholds for nothing proves nothing",
    ).toHaveLength(LOG_RECENT_SUFFICIENCY_READ_ROW_CAP + 44);
  });

  /*
  Proof 3 — `side-behind-author`. The side table's newest line is OLDER than the newest line the picked
  envelope itself carries: a legacy line the copy pass never received sits above everything the fetch
  returned. Deriving from that window would clear a badge the envelope can still name, so the row keeps
  today's answer. This is the case a newest-only freshness comparison is not the right test for — the
  window can be fresh-looking and still be missing the author's newest line.
  */
  it("names side-behind-author when the window is missing the envelope's own newest line", async () => {
    const store = h.store();
    const id = "RUFU-GATE-BEHIND";
    // The envelope's newest line is the last churn entry; the side rows stop 25 minutes short of it.
    await seedLegacyAuthor(h, id, { log: churnLog(LOG_RECENT_MATCH_ARRAY_CAP + 4, 30) });
    await insertSideRows(h, id, churnLog(6, 90).map((entry) => ({ ...entry, action: "unrelated older work" })));

    const card = await readBoardCard(store, id);
    expect(card!.stalledReview!.matchCount, "a window behind the author must not be allowed to clear the badge").toBe(LOG_RECENT_MATCH_ARRAY_CAP);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes("[log-recent-sufficiency]"))).toHaveLength(1);
    expect(lines[0]).toContain("side-behind-author=1");
  });

  /*
  Proof 4 — `side-missing-named-timestamp`, the shape the card required: the side table holds a line
  NEWER than anything the author saw, so a newest-only comparison passes it, while an in-horizon line the
  envelope NAMES is absent from the window. Deriving here yields a `matchCount` LOWER than today's, which
  is a worse answer than the card already had. The assertion is therefore not just the reason but the
  count: the served badge may not go down.
  */
  it("names side-missing-named-timestamp and never serves a count lower than today's", async () => {
    const store = h.store();
    const id = "RUFU-GATE-NAMED";
    const churn = churnLog(LOG_RECENT_MATCH_ARRAY_CAP + 4, 30);
    await seedLegacyAuthor(h, id, { log: churn });
    const missing = churn[4];
    await insertSideRows(h, id, [
      // Everything else the author named, plus one line NEWER than the envelope's own newest — so the
      // only thing that can refuse this window is the named stamp it does not hold.
      ...churn.filter((entry) => entry !== missing && entry !== churn[churn.length - 1]),
      { timestamp: stamp(1), action: "a line the author never saw", outcome: "" },
    ]);

    const card = await readBoardCard(store, id);
    expect(card!.stalledReview!.matchCount, "an undercounted fallback is worse than today's answer, not a weaker repair")
      .toBe(LOG_RECENT_MATCH_ARRAY_CAP);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes("[log-recent-sufficiency]"))).toHaveLength(1);
    expect(lines[0]).toContain("side-missing-named-timestamp=1");

    // Closed the other way. Once the copy pass delivers the two lines the side table was missing, the same
    // card's window PROVES: the reason is gone and the count is the same number. The withhold was a bound on
    // a repair, not a different answer, and a gate that could never be satisfied would be a permanent badge.
    await insertSideRows(h, id, [missing!, churn[churn.length - 1]!]);
    warn.mockClear();
    const after = await readBoardCard(store, id);
    // The repair also UNCAPS the figure: today's 16 was the retention cap over 20 real lines, and a proved
    // window answers with the count the log arithmetic gives. That is the number the card exists to fix.
    expect(after!.stalledReview!.matchCount, "a proved window answers with the true count, not the capped sample")
      .toBe(churn.length);
    expect(warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("[log-recent-sufficiency]")))
      .toEqual([]);
  });

  /*
  Census population `no-envelope` on the IN-REVIEW-QUIET badge — the card's own motivating symptom: a
  review lane that reports quiet for 24 h while History arrived minutes ago. With no envelope at all the
  log-free read has no log candidate, so it anchors on `columnMovedAt` and reports a stall the data
  contradicts. The two arms are the difference between a refusal and a repair: an empty side table keeps
  the false badge (and names why), while a side table holding the recent line proves its window and the
  false badge disappears.
  */
  it("clears a false 24-hour in-review stall only when the History that proves it wrong is proved complete", async () => {
    const store = h.store();
    const repaired = "RUFU-GATE-QUIET-REPAIR";
    const withheld = "RUFU-GATE-QUIET-WITHHELD";
    const recentLine: TaskLogEntry = { timestamp: stamp(5), action: "Merge attempt finished cleanly", outcome: "" };
    await seedLegacyAuthor(h, repaired, { log: [], blankPair: true, quietMinutesAgo: 30 * 60 });
    await seedLegacyAuthor(h, withheld, { log: [], blankPair: true, quietMinutesAgo: 30 * 60 });
    await insertSideRows(h, repaired, [recentLine]);

    const quiet = await readBoardCard(store, withheld);
    expect(quiet!.inReviewStalled, "with no envelope and no side rows the read anchors on the lane stamp — that is the false badge this card found")
      .toBeTruthy();
    expect(quiet!.inReviewStalled!.quietMs).toBeGreaterThanOrEqual(DAY);
    expect(quiet!.inReviewStalled!.lastActivitySource).not.toBe("log");
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("side-history-absent=1");

    warn.mockClear();
    const fixed = await readBoardCard(store, repaired);
    expect(fixed!.inReviewStalled, "a card whose History arrived 5 minutes ago is not quiet for a day")
      .toBeUndefined();
    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("[log-recent-sufficiency]"));
    expect(lines, "one pass, one voice — both cards were read together").toHaveLength(1);
    expect(lines[0], "the tally counts the refused card ONLY, which is how the repaired one is visible in the same line")
      .toContain("side-history-absent=1");
  });

  /*
  Surface parity. The searched page and the board run the same derivation through different hydration
  helpers, and RUFU-479 already proved they read the same COLUMN set; this proves they also read the same
  HISTORY decision, on one repaired card, one withheld card, and one sufficient card in the same page.
  */
  it("answers the searched page and the board the same way for every gated shape", async () => {
    const store = h.store();
    const repaired = "RUFU-GATE-PARITY-REPAIR";
    const withheld = "RUFU-GATE-PARITY-WITHHELD";
    const sufficient = "RUFU-GATE-PARITY-SUFFICIENT";
    await seedLegacyAuthor(h, repaired, { log: churnLog(LOG_RECENT_MATCH_ARRAY_CAP + 4) });
    await seedLegacyAuthor(h, sufficient, { log: churnLog(4) });
    await setBackfillMarker(h, stamp(2 * 24 * 60));
    await catchUpLegacyTaskLogEntries(h.layer(), {});
    /*
    The withheld card is seeded AFTER the copy pass, so its side table stays empty while its legacy lines
    remain inside the churn window — the population the NEXT pass repairs. Until then both surfaces owe the
    same honest answer, and a parity test that only compared repaired cards would miss a gate wired into
    one hydration helper and not the other.
    */
    await seedLegacyAuthor(h, withheld, { log: churnLog(LOG_RECENT_MATCH_ARRAY_CAP + 4) });

    const board = await store.listTasks({ columns: ["in-review"] as never, slim: true, startupMemo: false });
    const page = await store.listCurrentTasksPage({ query: "sufficiency gate fixture", limit: 50 });
    for (const id of [repaired, withheld, sufficient]) {
      const fromBoard = board.find((t) => t.id === id);
      const fromSearch = page.tasks.find((t) => t.id === id);
      expect(fromSearch, `${id} vanished from the searched page`).toBeTruthy();
      expect(badgeOf(fromSearch), `${id} answers differently on the searched page than on the board`)
        .toEqual(badgeOf(fromBoard));
    }
    // The comparison has to compare three DIFFERENT answers, or equality across surfaces proves nothing.
    expect(board.find((t) => t.id === repaired)!.stalledReview!.matchCount).toBe(LOG_RECENT_MATCH_ARRAY_CAP + 4);
    expect(board.find((t) => t.id === withheld)!.stalledReview!.matchCount).toBe(LOG_RECENT_MATCH_ARRAY_CAP);
    expect(board.find((t) => t.id === sufficient)!.stalledReview!.matchCount).toBe(4);
  });

  /*
  The two cost claims the gate rests on, measured over the SAME two cards so the only thing that differs
  between the arms is whether each envelope can prove its own window: a proving page costs nothing extra,
  and a page whose cards both need the fallback costs ONE batched read — not one per card, which is the
  N+1 RUFU-312's cutover was built to avoid and the shape a naive fallback would have reintroduced. The
  per-row bound is asserted beside it because an unbounded fallback re-imports the byte cost the whole
  cheap read exists to remove, and a page-wide bound deletes one card's History to save another's.
  */
  it("costs no extra statement when the envelopes prove their windows and exactly one when they all need the fallback", async () => {
    const store = h.store();
    const idA = "RUFU-GATE-COST-A";
    const idB = "RUFU-GATE-COST-B";
    await seedLegacyAuthor(h, idA, { log: churnLog(4) });
    await seedLegacyAuthor(h, idB, { log: churnLog(6) });
    const pass = async () => {
      resetBatchReads();
      warn.mockClear();
      await store.listTasks({ columns: ["in-review"] as never, slim: true, startupMemo: false });
      // A COPY, deliberately: the counter is one live array, so a captured reference would also charge
      // every read that happens AFTER the measured pass to it. That is how this assertion first reported
      // three statements for a one-statement pass.
      return [...batchReads.calls];
    };

    const proving = await pass();
    expect((await readBoardCard(store, idA))!.stalledReview!.matchCount, "the proving arm must be a real badge, not an absent one")
      .toBe(4);
    expect(proving, "a page whose rows all prove their window must not spend the fallback at all").toHaveLength(0);
    expect(warn.mock.calls.map((call) => String(call[0])).some((line) => line.includes("[log-recent-sufficiency]")),
      "a pass that spent nothing has nothing to warn about")
      .toBe(false);

    // Same page, same two rows; only the sufficiency of their envelopes changes.
    await seedLegacyAuthor(h, idA, { log: churnLog(LOG_RECENT_MATCH_ARRAY_CAP + 4, 30) });
    await seedLegacyAuthor(h, idB, { log: churnLog(LOG_RECENT_MATCH_ARRAY_CAP + 9, 30) });
    const gated = await pass();
    for (const id of [idA, idB]) {
      expect((await readBoardCard(store, id))!.stalledReview!.matchCount).toBe(LOG_RECENT_MATCH_ARRAY_CAP);
    }
    expect(gated, "the fallback is ONE batched read per pass, however many cards it names").toHaveLength(1);
    const [call] = gated;
    expect([idA, idB].every((id) => call!.bounded.includes(id)), "every gated row travels in that one statement")
      .toBe(true);
    expect(call!.unbounded, "an unbounded gated row would transfer a card's whole retained History")
      .toEqual([]);
    expect(call!.boundValues.every((value) => ISO_STAMP.test(value)), "the bound is the writer's ISO shape — the column is text and orders lexicographically")
      .toBe(true);
    expect(call!.cap! < getTaskActivityLogEntryLimit(), "the per-row read cap stays strictly below the retention limit")
      .toBe(true);
  });

  /*
  Census population `no-envelope`'s neighbour: a row whose LEGACY array is NULL because it was written after
  the cutover, with its History living only in the side table. RUFU-635's first case is a WRITE claim; from
  the read side the contract is that this card answers from its envelope — the badge and the timing figure a
  hydrated read gives — and pays NOTHING for the sufficiency fallback, because an envelope authored over the
  side rows is exactly what proves its own window. If this card ever starts costing a re-read, the envelope
  stopped proving, which is the regression worth a red test.
  */
  it("answers a side-only card from its envelope at zero extra cost, and the same way a hydrated read does", async () => {
    const store = h.store();
    const id = "RUFU-GATE-SIDE-ONLY";
    const history: TaskLogEntry[] = [...churnLog(6), TIMING_LINE(2 * 60, 4_200)];
    await seedLegacyAuthor(h, id, { log: history, nullLog: true });
    await insertSideRows(h, id, history);

    resetBatchReads();
    const slim = await readBoardCard(store, id);
    expect(slim!.stalledReview!.matchCount, "the side table IS the History for a row whose legacy array is NULL")
      .toBe(6);
    expect(slim!.timedExecutionMs, "the envelope's own figure answers a proving row")
      .toBe(4_200);
    expect([...batchReads.calls], "a proving row must not spend the sufficiency fallback")
      .toEqual([]);

    const loaded = await readLoadedCard(store, id);
    expect(badgeOf(loaded), "the hydrated read and the log-free read must not disagree about this card")
      .toEqual(badgeOf(slim));
    // `timedExecutionMs` is a SLIM projection field — a full read carries the log and leaves the figure to
    // its consumer — so the hydrated side is compared through the same arithmetic the slim path applies.
    expect(store.computeTimedExecutionMs(loaded!.log ?? []), "the whole-History sum the hydrated read would give")
      .toBe(slim!.timedExecutionMs);
  });

  /*
  Today's second false negative: an envelope carrying `unparseableCount > 0` answers NOTHING at all even when
  the churn line sits inside the window, so the log-free read calls the card not-stalled. The fallback runs,
  PROVES its window over a faithful copy, and the badge that comes back must be the badge the full History
  gives — the derivation's own conservatism about the unparseable line is a property of the ENVELOPE, not a
  reason to deny an answer the log arithmetic supports. A repair that invented a figure the full History does
  not give would be worse than the false negative it replaced, so parity is the assertion.
  */
  it("answers an unparseable-entry card exactly as a log-loaded read does, on both badge dimensions", async () => {
    const store = h.store();
    const id = "RUFU-GATE-UNPARSEABLE";
    const history: TaskLogEntry[] = [
      // Stamped FIRST and in the space-separated form the strict parser refuses, so `latestAt` — which the
      // newest-entry rule takes over parsed instants — stays parseable and the row reaches the gate at all.
      { timestamp: "2026-11-19 08:00:00", action: "a line no parser agrees on", outcome: "" },
      ...churnLog(6),
      TIMING_LINE(2 * 60, 4_200),
    ];
    await seedLegacyAuthor(h, id, { log: history });
    await insertSideRows(h, id, history);

    resetBatchReads();
    const slim = await readBoardCard(store, id);
    const slimReads = [...batchReads.calls];
    const loaded = await readLoadedCard(store, id);
    expect(slim!.stalledReview, "the envelope answers NOTHING for this shape, so a badge here can only come from a proved window")
      .toBeTruthy();
    expect(badgeOf(slim), "the repaired answer must be the answer the full History gives")
      .toEqual(badgeOf(loaded));
    expect(slimReads, "the fallback ran for the row whose envelope could not prove itself")
      .toHaveLength(1);
    expect(store.computeTimedExecutionMs(loaded!.log ?? []), "timing keeps the envelope's whole-History figure, which for this card is the same sum either way")
      .toBe(slim!.timedExecutionMs);
  });

  /*
  Why proof 4 is a UNION over the parsed instant and the raw text, measured on a real PostgreSQL: this line's
  UTC instant is inside the horizon, but its raw text sorts BELOW the ISO bound the side table is compared
  with, so the bounded read cannot return it. A fallback that answered from that window would report a
  History missing a line its own author named — an undercount that looks like a repair. The row is withheld
  instead, which is the class of bug a text-comparing bound silently creates.
  */
  it("withholds a row whose in-window line sorts below the text bound instead of repairing it from a window that cannot hold it", async () => {
    const store = h.store();
    const id = "RUFU-GATE-ODD-SLOT";
    const churn = churnLog(LOG_RECENT_MATCH_ARRAY_CAP + 1, 55);
    const odd = withOffsetText(Date.now() - 30 * MINUTE, "-05:00");
    await seedLegacyAuthor(h, id, {
      log: [...churn, { timestamp: odd, action: STALLED_REVIEW_REENQUEUE_PATTERN, outcome: "requeued" }],
    });
    // The copy pass saw every line EXCEPT the odd-text one, and holds a line newer than it — so the only
    // proof this shape can fail is the named-timestamp one, which is the point.
    await insertSideRows(h, id, [
      ...churn,
      { timestamp: stamp(5), action: "a line the author never saw", outcome: "" },
    ]);

    resetBatchReads();
    const card = await readBoardCard(store, id);
    expect(card!.stalledReview!.matchCount, "today's capped answer survives; a window that cannot hold a named line is not a repair")
      .toBe(LOG_RECENT_MATCH_ARRAY_CAP);
    expect([...batchReads.calls], "the fallback must ASK — silence here would mean the row was never gated")
      .toHaveLength(1);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes("[log-recent-sufficiency]"))).toHaveLength(1);
    expect(lines[0]).toContain("side-missing-named-timestamp=1");
  });

  /*
  The over-cap arm: more cards need the fallback than one pass may read. The budget is spent, the remainder
  keeps today's answer — the capped figure, never `undefined`, which would be a cleared badge — and the pass
  produces ONE warning carrying one tally per reason over the whole page. A cap that silently did nothing is
  indistinguishable from a cap that silently fabricated an answer.
  */
  it("announces one warning naming the row cap when more cards need the fallback than one pass may read", async () => {
    const store = h.store();
    const ids = Array.from(
      { length: LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP + 4 },
      (_, i) => `RUFU-GATE-OVERCAP-${i}`,
    );
    for (const id of ids) {
      await seedLegacyAuthor(h, id, { log: churnLog(LOG_RECENT_MATCH_ARRAY_CAP + 3, 30) });
    }

    resetBatchReads();
    const page = await store.listTasks({ columns: ["in-review"] as never, slim: true, startupMemo: false });
    expect(page.filter((task) => ids.includes(task.id))).toHaveLength(ids.length);
    expect([...batchReads.calls], "the pass still reads at most one batch, however many cards it named as candidates")
      .toHaveLength(1);
    expect([...batchReads.calls][0]!.rowCount, "the budget is the row cap, not the candidate count")
      .toBe(LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP);
    for (const id of ids) {
      expect(page.find((task) => task.id === id)!.stalledReview!.matchCount, `${id} was answered from a fabricated figure`)
        .toBe(LOG_RECENT_MATCH_ARRAY_CAP);
    }

    const lines = warn.mock.calls.map((call) => String(call[0]));
    const announced = lines.filter((line) => line.includes("[log-recent-sufficiency]"));
    expect(announced, "one warning for the whole pass, whatever the page").toHaveLength(1);
    expect(announced[0]).toContain(`side-history-absent=${LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP}`);
    expect(announced[0]).toContain(`over-row-cap=${ids.length - LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP}`);
  });
});
