import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import test from "node:test";

import {
  BASELINE_COUNTERS,
  CENSUS_SQL,
  CENSUS_STATES,
  buildCensusReport,
  censusStateFor,
  envelopeAuthor,
  evaluateBaseline,
  main,
  renderText,
} from "../census-log-recent-sufficiency.mjs";

/*
FNXC:TaskLogSufficiencyCensus 2026-11-20-22:05 (RUFU-636):
These tests drive the census WITHOUT a database, and the injected `core` is deliberately a table of
VERDICTS rather than a re-implementation of the shipped helpers.

The census's job is not to decide sufficiency — `taskLogEnvelopeProves`, `pickTaskLogEnvelope`, and
`withholdReasonForGatedRow` decide, and the core unit matrix (`task-log-recent-sufficiency.test.ts`) is
what pins THEIR behavior. The census's own contract is the layer above: which STATE a verdict maps to,
which AUTHOR a row is labelled with, whether a proved-or-refused repair is reported, what counts and what
exits. A fake that recomputed the sufficiency arithmetic here would test the fake, and its agreement with
the shipped code would be an accident of two transcriptions. So each fixture row says "the shipped helpers
returned this", and every assertion below is about the census's mapping, counts, rendering, and exit code.
*/

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-20T12:00:00.000Z");

/** The shipped helpers as a lookup table: each fixture row declares the verdicts it stands for. */
function stubCore() {
  return {
    STALLED_REVIEW_WINDOW_MS: HOUR,
    parseTaskLogRecent: (value) => (value && typeof value === "object" ? value : null),
    pickTaskLogEnvelope: ({ rollup, legacyLogRecent, legacyTimingTotalMs }) => ({
      logRecent: rollup?.logRecent ?? legacyLogRecent ?? null,
      timingTotalMs: legacyTimingTotalMs ?? rollup?.timingTotalMs ?? null,
    }),
    taskLogEnvelopeProves: (envelope, options) => {
      // An envelope with no verdict fixture is a valid one; NO envelope is the shipped `no-envelope` verdict.
      const verdict = envelope
        ? (envelope.__verdict ?? { proves: true, reason: null, reasons: [] })
        : { proves: false, reason: "no-envelope", reasons: ["no-envelope"] };
      if (options.windowStartMs === null) return envelope?.__unstamped ?? verdict;
      return verdict;
    },
    withheldReasonsFor: (envelope) => envelope?.__atRisk ?? [],
    withholdReasonForGatedRow: ({ envelope }) => envelope?.__withhold ?? null,
    rawTaskLogHistoryStamps: (entries) => new Set(entries.map((entry) => (typeof entry === "string" ? entry : entry?.timestamp)).filter(Boolean)),
  };
}

function harness(overrides = {}) {
  const core = stubCore();
  const nowMs = NOW;
  const horizonDurationMs = HOUR;
  const bound = new Date(nowMs - horizonDurationMs).toISOString();
  const report = buildCensusReport({
    core,
    rows: [],
    rollups: new Map(),
    sideEntries: new Map(),
    nowMs,
    horizonDurationMs,
    bound,
    readCap: 256,
    flaggedIds: [],
    ...overrides,
  });
  return { report, bound };
}

/** A live-card row as the census selects it — five columns, and no History column among them. */
function card(taskId, envelope, extra = {}) {
  return {
    task_id: taskId,
    updated_at: "2026-11-20T11:00:00.000Z",
    legacy_timing_total_ms: 1000,
    legacy_recent: envelope ?? null,
    legacy_projection_at: envelope ? "2026-11-20T11:00:00.000Z" : null,
    ...extra,
  };
}

function envelope(reasons, fields = {}) {
  return { v: 1, __verdict: { proves: false, reason: reasons[0] ?? null, reasons }, ...fields };
}

test("every state the census can name is one of the six, and a verdict maps to exactly one", () => {
  const { report } = harness({
    rows: [
      card("FN-A", null),
      card("FN-B", envelope(["unparseable-entries"], { unparseableCount: 3 })),
      card("FN-C", envelope(["dropped-match-in-window"], { reenqueueNewestDroppedAt: NOW - 60_000 })),
      card("FN-D", envelope(["dropped-match-in-window"], { invalidTransitionNewestDroppedAt: NOW - 60_000 })),
      card("FN-E", envelope(["unknown-envelope-version"], { v: 3 })),
      card("FN-F", envelope(["unknown-envelope-version"], { v: 2 })),
      card("FN-G", envelope(["unparseable-latest"])),
      card("FN-H", envelope(["dropped-match-in-window"])),
      card("FN-I", { v: 1 }),
    ],
  });

  assert.deepEqual(report.states, {
    "envelope-absent": 1,
    "unparseable-entries": 1,
    "reenqueue-churn-drop-in-window": 1,
    "invalid-transition-drop-in-window": 1,
    "unreadable-envelope": 2,
    "other:unparseable-latest": 1,
    "other:dropped-match-in-window": 1,
    sufficient: 1,
  });
  // A reason the six states do not name keeps its own bucket instead of folding into its neighbour.
  assert.equal(CENSUS_STATES.length, 6);
  assert.ok(!CENSUS_STATES.includes("other:unparseable-latest"));
  assert.equal(
    censusStateFor({ verdict: { proves: false, reasons: ["no-envelope"] }, envelope: null, legacyRaw: null, rollupRowPresent: false }),
    "envelope-absent",
  );
});

test("an author that authored nothing is absent, and an author whose artifact cannot be read is unreadable", () => {
  // A legacy `log_recent` reached us but no envelope came back: unreadable, not absent.
  assert.equal(
    censusStateFor({ verdict: { proves: false, reasons: ["no-envelope"] }, envelope: null, legacyRaw: { v: 9 }, rollupRowPresent: false }),
    "unreadable-envelope",
  );
  // A rollup ROW exists with a null envelope (its jsonb is not an object with a numeric `v`) — same state.
  assert.equal(
    censusStateFor({ verdict: { proves: false, reasons: ["no-envelope"] }, envelope: null, legacyRaw: null, rollupRowPresent: true }),
    "unreadable-envelope",
  );
});

test("the author label follows the shipped precedence rule, including its two odd corners", () => {
  const rollup = { computedAt: "2026-11-20T10:00:00.000Z", logRecent: { v: 1 }, entryCount: 3, timingTotalMs: 1 };
  assert.equal(envelopeAuthor({ envelope: { v: 1 }, rollup, legacyProjectionAt: "2026-11-20T09:00:00.000Z", legacyLogRecent: { v: 1 } }), "rollup");
  assert.equal(envelopeAuthor({ envelope: { v: 1 }, rollup, legacyProjectionAt: "2026-11-20T11:00:00.000Z", legacyLogRecent: { v: 1 } }), "legacy-pair");
  // Equal stamps belong to the rollup, and an unparseable legacy stamp means legacy is not in the race.
  assert.equal(envelopeAuthor({ envelope: { v: 1 }, rollup, legacyProjectionAt: rollup.computedAt, legacyLogRecent: { v: 1 } }), "rollup");
  assert.equal(envelopeAuthor({ envelope: { v: 1 }, rollup, legacyProjectionAt: "not-a-stamp", legacyLogRecent: { v: 1 } }), "rollup");
  assert.equal(envelopeAuthor({ envelope: { v: 1 }, rollup: undefined, legacyProjectionAt: null, legacyLogRecent: { v: 1 } }), "legacy-pair");
  assert.equal(envelopeAuthor({ envelope: null, rollup, legacyProjectionAt: null, legacyLogRecent: null }), "none");
});

test("author provenance is reported per insufficient row, which is the catch-up coverage split", () => {
  const core = stubCore();
  const nowMs = NOW;
  const bound = new Date(nowMs - HOUR).toISOString();
  const rollups = new Map([
    ["FN-ROLLED", { entryCount: 4, timingTotalMs: 10, logRecent: envelope(["unparseable-entries"]), computedAt: "2026-11-20T12:00:00.000Z" }],
  ]);
  const report = buildCensusReport({
    core,
    rows: [
      card("FN-ROLLED", null, { legacy_projection_at: "2026-11-20T01:00:00.000Z" }),
      card("FN-LEGACY", envelope(["unparseable-entries"])),
      card("FN-NONE", null, { legacy_projection_at: null }),
    ],
    rollups,
    sideEntries: new Map(),
    nowMs,
    horizonDurationMs: HOUR,
    bound,
    readCap: 256,
    flaggedIds: ["FN-ROLLED", "FN-LEGACY", "FN-NONE"],
  });

  const byId = new Map(report.insufficient.map((row) => [row.taskId, row]));
  assert.equal(byId.get("FN-ROLLED").author, "rollup");
  assert.equal(byId.get("FN-LEGACY").author, "legacy-pair");
  assert.equal(byId.get("FN-NONE").author, "none");
  assert.deepEqual(report.authors, { rollup: 1, "legacy-pair": 1, none: 1 });
  // The stamps behind every label are printed, so a label is checkable rather than trusted.
  assert.deepEqual(byId.get("FN-ROLLED").stamps, { rollupComputedAt: "2026-11-20T12:00:00.000Z", legacyProjectionAt: "2026-11-20T01:00:00.000Z" });
});

test("a flagged row is reported repairable or withheld for its one proof, and the reason is the shipped word", () => {
  const missing = envelope(["dropped-match-in-window"], { reenqueueNewestDroppedAt: NOW - 60_000, __withhold: "side-missing-named-timestamp", __atRisk: ["stale-matches-reenqueueAt"] });
  const repaired = envelope(["unparseable-entries"], { __withhold: null });
  const behind = envelope(["unparseable-entries"], { __withhold: "side-behind-author" });
  const { report } = harness({
    rows: [card("FN-MISS", missing), card("FN-OK", repaired), card("FN-BEHIND", behind), card("FN-UNREAD", envelope(["unknown-envelope-version"], { v: 2 }))],
    sideEntries: new Map([["FN-MISS", [{ timestamp: "2026-11-20T11:30:00.000Z" }]], ["FN-OK", []]]),
    flaggedIds: ["FN-MISS", "FN-OK", "FN-BEHIND"],
  });

  const byId = new Map(report.insufficient.map((row) => [row.taskId, row]));
  assert.equal(byId.get("FN-MISS").repair, "withheld:side-missing-named-timestamp");
  assert.deepEqual(byId.get("FN-MISS").atRiskLines, ["stale-matches-reenqueueAt"]);
  assert.equal(byId.get("FN-OK").repair, "repairable");
  assert.equal(byId.get("FN-BEHIND").repair, "withheld:side-behind-author");
  // A row the census refused to interpret is never offered a repair it cannot prove.
  assert.equal(byId.get("FN-UNREAD").repair, "not-read");
  assert.deepEqual(report.repairs, { repairable: 1, withheld: { "side-missing-named-timestamp": 1, "side-behind-author": 1 } });
  assert.equal(report.flagged.ids, 3);
  assert.equal(report.flagged.boundedReads, 1, "one bounded batch read however many cards it names");
});

test("the warning the board would emit is readable off the report, and the counts are the same numbers", () => {
  const { report } = harness({
    rows: [card("FN-A", envelope(["unparseable-entries"], { __withhold: "side-history-absent" }))],
    flaggedIds: ["FN-A"],
  });
  const text = renderText(report, { baseline: "matched (matches the recorded baseline)" });
  assert.match(text, /side-history-absent 1/);
  assert.match(text, /unparseable-entries\s+1/);
  assert.match(text, /matches the recorded baseline/);
});

test("the baseline round-trips: matched counts exit 0, a rise and an unrecorded drop both fail --strict", async () => {
  const measured = { insufficientRows: 4, unreadableEnvelopes: 0 };
  assert.deepEqual(BASELINE_COUNTERS, ["insufficientRows", "unreadableEnvelopes"]);

  const absent = evaluateBaseline({ measured, baseline: null, strict: true });
  assert.equal(absent.status, "absent");
  assert.equal(absent.exitCode, 0, "no baseline is not a failure — the first run has nothing to compare to");

  const matched = evaluateBaseline({ measured, baseline: measured, strict: true });
  assert.equal(matched.status, "matched");
  assert.equal(matched.exitCode, 0);

  const rise = evaluateBaseline({ measured, baseline: { ...measured, insufficientRows: 2 }, strict: true });
  assert.equal(rise.status, "regression");
  assert.equal(rise.exitCode, 1);
  assert.match(rise.message, /insufficientRows 2 -> 4/);

  // lower-count-fails: an unrecorded improvement fails too, so the number cannot drift either way.
  const dropped = evaluateBaseline({ measured, baseline: { ...measured, insufficientRows: 9 }, strict: true });
  assert.equal(dropped.status, "improved-unrecorded");
  assert.equal(dropped.exitCode, 1);
  assert.equal(evaluateBaseline({ measured, baseline: { ...measured, insufficientRows: 9 }, strict: false }).exitCode, 0);

  const dir = mkdtempSync(join(tmpdir(), "census-baseline-"));
  const path = join(dir, "baseline.json");
  try {
    const collected = {
      core: stubCore(),
      rows: [card("FN-A", envelope(["unparseable-entries"]))],
      boardPath: "(test)",
      projectId: "(test)",
      nowMs: NOW,
      horizonDurationMs: HOUR,
      bound: new Date(NOW - HOUR).toISOString(),
      readCap: 256,
      flaggedIds: [],
    };
    const code = await main(["--json", "--update-baseline"], { collected, baselinePath: path, baseline: null });
    assert.equal(code, 0, "recording a baseline is not itself a failure");
    const written = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(written.version, 1);
    assert.equal(written.insufficientRows, 1);
    assert.equal(written.unreadableEnvelopes, 0);
    assert.equal(written.states["unparseable-entries"], 1);
    // The stored file IS a snapshot of a report, so re-measuring the same board reads back "matched".
    const replay = await main(["--strict", "--json"], { collected, baselinePath: path, baseline: written });
    assert.equal(replay, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unnameable envelope exits the census non-zero instead of guessing, and bad arguments exit 1", async () => {
  const collected = {
    core: stubCore(),
    rows: [card("FN-OK", { v: 1 }), card("FN-V2", envelope(["unknown-envelope-version"], { v: 2 }))],
    boardPath: "(test)",
    projectId: "(test)",
    nowMs: NOW,
    horizonDurationMs: HOUR,
    bound: new Date(NOW - HOUR).toISOString(),
    readCap: 256,
    flaggedIds: ["FN-V2"],
  };
  const strict = await main(["--strict"], { collected, baseline: { insufficientRows: 1, unreadableEnvelopes: 1 } });
  assert.equal(strict, 1, "one unnameable envelope outranks a matching baseline");
  const lenient = await main([], { collected, baseline: { insufficientRows: 1, unreadableEnvelopes: 1 } });
  assert.equal(lenient, 1, "the refusal to guess is not gated on --strict");
  assert.equal(await main(["--nope"], { collected }), 1);
  assert.equal(await main(["--help"], { collected }), 0);
});

test("the census's own query never names the History column, a lane, or a star", () => {
  const sql = CENSUS_SQL;
  // Mask the two envelope columns the census IS allowed to read, then no bare `log` token may remain.
  const masked = sql.replaceAll("log_recent", "ENVELOPE_COL").replaceAll("log_projection_at", "ENVELOPE_STAMP_COL");
  assert.equal(/(^|[\s,("])log([\s,)"]|$)/.test(masked), false, `the History column leaked into the census query: ${sql}`);
  assert.match(sql, /t\.log_recent/);
  assert.match(sql, /t\.log_projection_at/);
  assert.match(sql, /t\.timing_total_ms/);
  assert.match(sql, /t\.updated_at/);
  assert.match(sql, /deleted_at IS NULL/, "liveness is the delete marker, never a lane");
  assert.equal(/\bSELECT\s+\*/.test(sql), false);
  for (const lane of ["todo", "in-progress", "in-review", "done", "triage"]) {
    assert.equal(sql.includes(`"${lane}"`) || sql.includes(`'${lane}'`), false, `lane literal ${lane} in the census query`);
  }
  // The text the test reads is the text the runner executes — one statement, not a copy of it.
  assert.ok(CENSUS_SQL.includes("project.\"tasks\" t"));
});

test("the census asks the shipped helpers and spells no sufficiency arithmetic of its own", () => {
  const source = readFileSync(new URL("../census-log-recent-sufficiency.mjs", import.meta.url), "utf8");
  // Code-construct guards: the moment one of these appears, the census has grown a second decision.
  for (const forbidden of [".unparseableCount", "provablyComplete", ".v !==", "parseProjectionTimestamp", "mergeTaskLogViews", "row.log"]) {
    assert.equal(source.includes(forbidden), false, `the census re-spells a shipped decision (${forbidden})`);
  }
  for (const shipped of ["taskLogEnvelopeProves", "pickTaskLogEnvelope", "withholdReasonForGatedRow", "readTaskLogEntriesBatch", "readTaskLogRollups", "withheldReasonsFor", "horizonFromServedWindows", "taskLogHistoryReadBound"]) {
    assert.ok(source.includes(`core.${shipped}`), `the census must reach ${shipped} through the shipped module surface`);
  }
});
