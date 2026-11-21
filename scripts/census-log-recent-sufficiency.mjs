#!/usr/bin/env node
/*
FNXC:TaskLogSufficiencyCensus 2026-11-20-22:05 (RUFU-636):
The durable answer to "does any live card actually need the log-free badge fallback, and which rows could
the fallback genuinely repair?".

The operator's original question was one SQL line, recorded on the card:

    select count(*) from project.tasks where coalesce((log_recent->>'unparseableCount')::int,0) > 0;

It cannot be answered any more, and not because the count changed. RUFU-312 gave the envelope TWO authors:
the legacy `tasks.log_recent` / `tasks.log_projection_at` pair, and `project.task_log_rollup`, which every
pure append re-authors over the MERGED legacy+side view. `pickTaskLogEnvelope` reads the newer stamp of the
two, so a post-cutover card usually answers from the rollup while its legacy column is NULL and its History
is full. A query over `tasks.log_recent` alone therefore counts the fallback author only: it reads 0 for the
usual modern shape and misses every rollup row — a number that looks like "no card needs the gate" and
proves nothing.

This census asks the shipped question instead and re-spells NOTHING:

* the envelope per card comes from `pickTaskLogEnvelope`, fed by `readTaskLogRollups` (the shipped rollup
  reader, which is also what types an unknown `v` as an envelope instead of refusing it) and
  `parseTaskLogRecent` for the legacy half — the identical call `reads.ts` makes;
* sufficiency comes from `taskLogEnvelopeProves`, asked with the SAME window the board read asks
  (`now - STALLED_REVIEW_WINDOW_MS`) plus the unstamped question: the same helper the resolvers and the read
  gate consume, so the census, the badge, and the gate cannot disagree about the population they describe;
* the repairability verdict comes from `withholdReasonForGatedRow` — the four ground-truth proofs the read
  path applies — against `project.task_log_entries` through the shipped `readTaskLogEntriesBatch`, bounded
  per row to the shipped horizon. There is no hand-rolled second reader and no classification in SQL: SQL
  selects columns, the shipped code decides.

Per insufficient card the report names its state, the fixed reasons, WHICH AUTHOR the picked envelope came
from, and whether the side table could prove a repair (`repairable`) or would be refused, for what reason
(`withheld:<reason>`). The author split is the diagnostic half: legacy-author rows are exactly the
population `catchUpLegacyTaskLogEntries` can leave partly uncopied (it copies only lines stamped
`>= backfilledAt`, `TASK_LOG_CATCH_UP_TASK_LIMIT = 200` tasks per pass), which is the fact proof 4 exists
for. `entry_count` is used NOWHERE as a completeness witness: it counts side rows while the envelope was
authored over the merged view, so a count comparison is wrong in both directions.

The census itself issues no write: one SELECT, one rollup read, one bounded side-table read. Stated exactly
because it is not the whole truth about the process — booting a TaskStore through the shared ops bootstrap
runs that store's OWN startup maintenance (measured on a live board: `init:task-log-catch-up` copied 5
legacy entries for one project during the census's boot). That is the bootstrap's contract, not a census
write, and it is why the census is a tool to run rather than a cron job: its boot costs what a boot costs.
The only file this script writes is its own baseline, and only under `--update-baseline`.

The baseline is per-board by nature — it records what ONE project's cards measured — so it is deliberately
NOT committed to the repository; `--strict` without one reports `absent` and exits 0.

Requires `pnpm --filter @fusion/core build` (scripts/lib/backend-db.mjs).
*/
import process from "node:process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { openBackend, rowsOf } from "./lib/backend-db.mjs";

/* ── the query, in one place, exported so its shape is checkable ─────────── */

/*
FNXC:TaskLogSufficiencyCensus 2026-11-20-22:05 (RUFU-636):
Five `tasks` columns and nothing else. Three omissions are the contract, and
`scripts/__tests__/census-log-recent-sufficiency.test.mjs` holds all three:

* `tasks.log` NEVER appears. The History column is the fat row RUFU-312 moved content out of; a census that
  selected it would answer the operator's question by measuring the very thing this card exists to stop
  reading — and would flatter itself, because a card with a 4 MB array and a 300-byte envelope looks
  identical under every other column.
* no lane literal. Liveness is `deleted_at IS NULL`, never `column = '…'`: a lane vocabulary belongs to a
  workflow, not to a census, and `scripts/check-sql-column-literals.mjs` scans `scripts/` for exactly this
  substitution.
* no `SELECT *`, so a column added to `tasks` tomorrow cannot quietly join the measurement.

Project scope is row-level security's, not a predicate here — the same convention
`scripts/audit-task-id-collisions.mjs` uses against `project."tasks"`. The rollup is read through
`readTaskLogRollups`, not joined here, because the shipped reader is what types an unknown envelope `v`.
*/
export const CENSUS_SQL = `
      SELECT t.id                  AS task_id,
             t.updated_at          AS updated_at,
             t.timing_total_ms     AS legacy_timing_total_ms,
             t.log_recent          AS legacy_recent,
             t.log_projection_at   AS legacy_projection_at
        FROM project."tasks" t
       WHERE t.deleted_at IS NULL
       ORDER BY t.id
    `;

export function censusRowsStatement(sqlTag) {
  return sqlTag.raw(CENSUS_SQL);
}

/* ── the six states, named once ─────────────────────────────────────────── */

/**
 * The six states the card asked for. A reason the six do not name gets its OWN state rather than a fold:
 * `unparseable-latest` and a drop whose marker is neither churn array are real facts, and folding them into
 * the nearest neighbour would understate exactly what the operator is reading this census to learn.
 */
export const CENSUS_STATES = Object.freeze([
  "sufficient",
  "unparseable-entries",
  "reenqueue-churn-drop-in-window",
  "invalid-transition-drop-in-window",
  "envelope-absent",
  "unreadable-envelope",
]);

/**
 * One card's state, from the shipped verdict. `rollupRowPresent` is what separates an author that authored
 * nothing from an author whose artifact this build cannot read: `readTaskLogRollups` returns a row whose
 * `logRecent` is null for a rollup jsonb that is not an object with a numeric `v`, and the shipped pick
 * then hands back whatever the other half offered — so without the row's existence the two read alike.
 */
export function censusStateFor({ verdict, envelope, legacyRaw, rollupRowPresent }) {
  if (verdict?.proves) return "sufficient";
  const reasons = verdict?.reasons ?? [];
  const rawPresent = (legacyRaw !== null && legacyRaw !== undefined) || rollupRowPresent;
  if (reasons.includes("unknown-envelope-version")) return "unreadable-envelope";
  if (reasons.includes("no-envelope")) return rawPresent ? "unreadable-envelope" : "envelope-absent";
  if (reasons.includes("unparseable-entries")) return "unparseable-entries";
  if (reasons.includes("dropped-match-in-window")) {
    if (typeof envelope?.reenqueueNewestDroppedAt === "number") return "reenqueue-churn-drop-in-window";
    if (typeof envelope?.invalidTransitionNewestDroppedAt === "number") return "invalid-transition-drop-in-window";
    return "other:dropped-match-in-window";
  }
  return `other:${reasons[0] ?? "unknown"}`;
}

/* ── authorship provenance (report-only) ────────────────────────────────── */

/**
 * Which author the picked envelope came from — a REPORT field that decides nothing.
 *
 * FNXC:TaskLogSufficiencyCensus 2026-11-20-22:05 (RUFU-636):
 * `pickTaskLogEnvelope` answers "which envelope do I hand back", not "which author chose it", and this card
 * does not edit that module. The census therefore mirrors its precedence rule over the two stamps it already
 * holds — including the rule's two odd corners: an unparseable legacy stamp means the legacy author is not
 * in the race at all, and equal stamps go to the rollup. Every state and every repair verdict still comes
 * from the envelope the shipped pick returned, so a drift here mislabels one column of the report; it can
 * never misclassify a card. Both stamps ride in `--json` so any single row's label is checkable.
 */
export function envelopeAuthor({ envelope, rollup, legacyProjectionAt, legacyLogRecent }) {
  if (!envelope) return "none";
  if (!rollup) return legacyLogRecent ? "legacy-pair" : "none";
  if (!legacyProjectionAt) return "rollup";
  const legacyMs = Date.parse(legacyProjectionAt);
  const rollupMs = Date.parse(rollup.computedAt);
  const legacyWins = !Number.isNaN(legacyMs) && (Number.isNaN(rollupMs) || rollupMs < legacyMs);
  return legacyWins ? "legacy-pair" : "rollup";
}

/* ── the report ─────────────────────────────────────────────────────────── */

/**
 * One row per live card, then the counts. `core` is the shipped module surface (a census runs against
 * `packages/core/dist`, see scripts/lib/backend-db.mjs) and EVERY judgement below is delegated to it; the
 * census computes windows, arithmetic appears nowhere.
 */
export function buildCensusReport(input) {
  const {
    core,
    rows,
    rollups = new Map(),
    sideEntries = new Map(),
    nowMs,
    horizonDurationMs,
    bound,
    readCap,
    flaggedIds = [],
  } = input;
  const windowStartMs = nowMs - core.STALLED_REVIEW_WINDOW_MS;
  const horizonMs = nowMs - horizonDurationMs;
  const flagged = new Set(flaggedIds);

  const report = {
    generatedAt: new Date(nowMs).toISOString(),
    cardsScanned: rows.length,
    states: {},
    insufficient: [],
    flagged: { ids: flaggedIds.length, readCap, bound, horizonMs, boundedReads: flaggedIds.length > 0 ? 1 : 0 },
    repairs: { repairable: 0, withheld: {} },
    unreadableEnvelopes: [],
    authors: { rollup: 0, "legacy-pair": 0, none: 0 },
  };
  const tally = (state) => { report.states[state] = (report.states[state] ?? 0) + 1; };

  for (const row of rows) {
    const taskId = String(row.task_id);
    const rollup = rollups.get(taskId);
    const legacyLogRecent = core.parseTaskLogRecent(row.legacy_recent);
    const picked = core.pickTaskLogEnvelope({
      rollup,
      legacyProjectionAt: row.legacy_projection_at,
      legacyTimingTotalMs: row.legacy_timing_total_ms,
      legacyLogRecent,
    });
    const envelope = picked.logRecent;
    const windowed = core.taskLogEnvelopeProves(envelope, { windowStartMs });
    const unstamped = core.taskLogEnvelopeProves(envelope, { windowStartMs: null });
    const state = censusStateFor({
      verdict: windowed,
      envelope,
      legacyRaw: row.legacy_recent,
      rollupRowPresent: rollup !== undefined,
    });
    tally(state);
    if (state === "sufficient") continue;

    const author = envelopeAuthor({
      envelope,
      rollup,
      legacyProjectionAt: row.legacy_projection_at,
      legacyLogRecent,
    });
    report.authors[author] = (report.authors[author] ?? 0) + 1;
    if (state === "unreadable-envelope") report.unreadableEnvelopes.push(taskId);

    /* The field-level half: which named lines are at risk, and which this read has now proved present. */
    const returned = sideEntries.get(taskId) ?? [];
    const present = core.rawTaskLogHistoryStamps(returned);
    const atRisk = core.withheldReasonsFor(envelope, { windowStartMs, horizonMs, bound, present })
      .filter((reason) => !windowed.reasons.includes(reason));

    let repair = "not-read";
    if (flagged.has(taskId)) {
      const reason = core.withholdReasonForGatedRow({ envelope, entries: returned, readCap, bound, horizonMs });
      if (reason === null) {
        repair = "repairable";
        report.repairs.repairable += 1;
      } else {
        repair = `withheld:${reason}`;
        report.repairs.withheld[reason] = (report.repairs.withheld[reason] ?? 0) + 1;
      }
    }

    report.insufficient.push({
      taskId,
      state,
      author,
      reasons: [...windowed.reasons, ...unstamped.reasons.filter((r) => !windowed.reasons.includes(r))],
      atRiskLines: atRisk,
      repair,
      updatedAt: row.updated_at ?? null,
      stamps: { rollupComputedAt: rollup?.computedAt ?? null, legacyProjectionAt: row.legacy_projection_at ?? null },
    });
  }
  return report;
}

/* ── baseline semantics (lower-count-fails) ─────────────────────────────── */

export const BASELINE_COUNTERS = Object.freeze(["insufficientRows", "unreadableEnvelopes"]);

export function baselineSnapshot(report) {
  return {
    version: 1,
    insufficientRows: report.insufficient.length,
    unreadableEnvelopes: report.unreadableEnvelopes.length,
    states: report.states,
    measuredAt: report.generatedAt,
  };
}

/**
 * The semantics `scripts/lifecycle-column-census.mjs` ships: a RISE fails, and an unrecorded DROP fails
 * too, so the number cannot drift either way without a commit that says so. Two counters, both of which the
 * operator acts on: rows whose envelope cannot prove the answer, and rows whose envelope this build refuses
 * to interpret at all.
 */
export function evaluateBaseline({ measured, baseline, strict }) {
  if (!baseline) {
    return { status: "absent", exitCode: 0, changes: [], message: "no baseline recorded — run with --update-baseline to record one" };
  }
  if (baseline.corrupt === true) {
    return { status: "corrupt", exitCode: 1, changes: [], message: "baseline file does not parse" };
  }
  const changes = [];
  for (const key of BASELINE_COUNTERS) {
    const stored = Number(baseline[key]);
    const now = Number(measured[key]);
    if (!Number.isFinite(stored)) changes.push({ key, from: null, to: now, direction: "unrecorded" });
    else if (now > stored) changes.push({ key, from: stored, to: now, direction: "rise" });
    else if (now < stored) changes.push({ key, from: stored, to: now, direction: "drop" });
  }
  const status = changes.length === 0
    ? "matched"
    : changes.some((change) => change.direction !== "drop") ? "regression" : "improved-unrecorded";
  return {
    status,
    exitCode: status === "matched" ? 0 : strict ? 1 : 0,
    changes,
    message: status === "matched"
      ? "matches the recorded baseline"
      : `${status}: ${changes.map((c) => `${c.key} ${c.from ?? "unset"} -> ${c.to}`).join(", ")}`,
  };
}

/* ── rendering ──────────────────────────────────────────────────────────── */

export function renderText(report, extras = {}) {
  const lines = [];
  lines.push(`Live cards scanned: ${report.cardsScanned}`);
  lines.push(`Fallback horizon bound: ${report.flagged.bound}  (per-row read cap ${report.flagged.readCap} rows)`);
  lines.push(`Cards the fallback was asked about: ${report.flagged.ids}, through ${report.flagged.boundedReads} bounded batch read(s)`);
  lines.push("");
  lines.push("  state                                   cards");
  for (const [state, count] of Object.entries(report.states).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${state.padEnd(40)} ${String(count).padStart(6)}`);
  }
  lines.push("");
  lines.push(`  insufficient: ${report.insufficient.length}  (envelope author: rollup ${report.authors.rollup}, legacy-pair ${report.authors["legacy-pair"]}, none ${report.authors.none})`);
  const withheld = Object.entries(report.repairs.withheld).map(([reason, count]) => `withheld:${reason} ${count}`).join(", ");
  lines.push(`  fallback verdict: repairable ${report.repairs.repairable}, ${withheld || "withheld 0"}`);
  if (report.unreadableEnvelopes.length > 0) {
    lines.push("");
    lines.push(`  REFUSING TO GUESS: ${report.unreadableEnvelopes.length} envelope(s) carry a shape or version this build's parser cannot name:`);
    for (const id of report.unreadableEnvelopes.slice(0, 20)) lines.push(`    ${id}`);
    if (report.unreadableEnvelopes.length > 20) lines.push(`    … and ${report.unreadableEnvelopes.length - 20} more`);
  }
  if (report.insufficient.length > 0) {
    lines.push("");
    lines.push("  per-card detail (first 25):");
    for (const row of report.insufficient.slice(0, 25)) {
      lines.push(`    ${row.taskId}  ${row.state}  author=${row.author}  repair=${row.repair}`);
      if (row.reasons.length > 0) lines.push(`      reasons: ${row.reasons.join(", ")}`);
      if (row.atRiskLines.length > 0) lines.push(`      named lines the side table must still prove: ${row.atRiskLines.join(", ")}`);
    }
    if (report.insufficient.length > 25) lines.push(`    … and ${report.insufficient.length - 25} more (use --json for all)`);
  }
  if (extras.baseline) lines.push("", `  baseline: ${extras.baseline}`);
  return lines.join("\n");
}

/* ── collection (the only DB-touching half) ─────────────────────────────── */

export async function collectCensus(deps = {}) {
  const projectDir = resolve(deps.projectDir ?? process.cwd());
  const backend = deps.backend ?? await openBackend(projectDir);
  const ownsBackend = !deps.backend;
  try {
    const { core, asyncLayer, sql } = backend;
    const projectId = core.taskLogProjectId(asyncLayer);
    const rows = rowsOf(await asyncLayer.db.execute(censusRowsStatement(sql)));
    const ids = rows.map((row) => String(row.task_id));
    const rollups = await core.readTaskLogRollups(asyncLayer.db, projectId, ids);

    const nowMs = deps.nowMs ?? Date.now();
    /*
    FNXC:TaskLogSufficiencyCensus 2026-11-20-22:05 (RUFU-636):
    The census resolves NO project settings, so the horizon it measures is the shipped default the helper
    falls back to (the churn window alone). That is stated rather than hidden: an operator who configured a
    longer `inReviewStalledThresholdMs` is looking at a horizon SHORTER than their own board's, and the
    `flagged.bound` line is where that difference is visible.
    */
    const horizonDurationMs = core.horizonFromServedWindows(null);
    const bound = core.taskLogHistoryReadBound(nowMs, horizonDurationMs);
    const readCap = core.LOG_RECENT_SUFFICIENCY_READ_ROW_CAP;
    const windowStartMs = nowMs - core.STALLED_REVIEW_WINDOW_MS;

    const flaggedIds = [];
    for (const row of rows) {
      const picked = core.pickTaskLogEnvelope({
        rollup: rollups.get(String(row.task_id)),
        legacyProjectionAt: row.legacy_projection_at,
        legacyTimingTotalMs: row.legacy_timing_total_ms,
        legacyLogRecent: core.parseTaskLogRecent(row.legacy_recent),
      });
      if (core.taskLogEnvelopeProves(picked.logRecent, { windowStartMs }).proves) continue;
      flaggedIds.push(String(row.task_id));
    }

    /*
    Every flagged card gets the SAME horizon bound — never `null`, which is the seam's UNBOUNDED arm and
    would transfer a retained History no badge can consult. One call, chunked inside the shipped reader.
    */
    const bounds = new Map(flaggedIds.map((id) => [id, bound]));
    const sideEntries = flaggedIds.length > 0
      ? await core.readTaskLogEntriesBatch(asyncLayer.db, projectId, flaggedIds, { cap: readCap, bounds })
      : new Map();

    return { core, projectId, boardPath: projectDir, rows, rollups, sideEntries, nowMs, horizonDurationMs, bound, readCap, flaggedIds };
  } finally {
    if (ownsBackend) await backend.shutdown?.().catch(() => {});
  }
}

/* ── CLI ────────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const flags = { json: false, strict: false, updateBaseline: false, help: false, projectDir: null, badArgs: [] };
  for (const raw of argv) {
    if (raw === "--json") flags.json = true;
    else if (raw === "--strict") flags.strict = true;
    else if (raw === "--update-baseline") flags.updateBaseline = true;
    else if (raw === "--help" || raw === "-h") flags.help = true;
    else if (raw.startsWith("--project-dir=")) flags.projectDir = raw.slice("--project-dir=".length);
    else flags.badArgs.push(raw);
  }
  return flags;
}

function usage() {
  console.log(`Usage: node scripts/census-log-recent-sufficiency.mjs [flags]

Read-only census of the log-free badge envelope: which live cards' envelope cannot prove the answer the
board would derive from full History, and which of those the bounded side-table fallback could prove.

  --json                  machine-readable report on stdout
  --strict                exit non-zero when the counts disagree with the recorded baseline
  --update-baseline       record the measured counts as the baseline (the only write this script performs)
  --project-dir=<path>    board to measure (default: the current directory's project)
  --help                  this text

The baseline path is overridable for tests through FUSION_LOG_RECENT_CENSUS_BASELINE_PATH.
Requires a built core: pnpm --filter @fusion/core build`);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = process.env.FUSION_LOG_RECENT_CENSUS_BASELINE_PATH
  ?? join(HERE, "lib", "census-log-recent-sufficiency-baseline.json");

function readBaseline(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { corrupt: true };
  }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const flags = parseArgs(argv);
  if (flags.help) {
    usage();
    return flags.badArgs.length > 0 ? 1 : 0;
  }
  if (flags.badArgs.length > 0) {
    console.error(`unknown argument(s): ${flags.badArgs.join(" ")}`);
    usage();
    return 1;
  }

  const baselinePath = deps.baselinePath ?? BASELINE_PATH;
  const collected = deps.collected ?? await collectCensus({ projectDir: flags.projectDir ?? process.cwd() });
  const report = buildCensusReport(collected);
  const baselineResult = evaluateBaseline({
    measured: baselineSnapshot(report),
    baseline: deps.baseline ?? readBaseline(baselinePath),
    strict: flags.strict,
  });
  if (flags.updateBaseline) {
    writeFileSync(baselinePath, `${JSON.stringify(baselineSnapshot(report), null, 2)}\n`);
  }

  /*
  FNXC:TaskLogSufficiencyCensus 2026-11-20-22:05 (RUFU-636):
  An envelope this build cannot name is not a row to be counted into a histogram — it is a census whose
  arithmetic belongs to another version, so the run exits non-zero rather than reporting a number the
  reader cannot trust. That is the same refusal `taskLogEnvelopeProves` applies to a reader.
  */
  const refuseToGuess = report.unreadableEnvelopes.length > 0;

  if (flags.json) {
    console.log(JSON.stringify({ ...report, baseline: { path: baselinePath, ...baselineResult } }, null, 2));
  } else {
    console.log("Log-free badge envelope sufficiency census — live cards, envelope only, never the History column");
    console.log("==============================================================================================");
    console.log(`board: ${collected.boardPath ?? "(injected)"}   project: ${collected.projectId ?? "(injected)"}`);
    console.log("");
    console.log(renderText(report, {
      baseline: `${baselineResult.status} (${baselineResult.message})${refuseToGuess ? " — exits 1: an envelope shape is unnameable" : ""}`,
    }));
  }
  return refuseToGuess ? 1 : baselineResult.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`census failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
