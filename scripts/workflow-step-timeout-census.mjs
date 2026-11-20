#!/usr/bin/env node
/*
FNXC:WorkflowStepTimeoutCensus 2026-11-18-02:25 (RUFU-684):
The durable answer to "how often do prompt-mode workflow steps time out, and in which lane?".

Before this script the only record of a step timeout was a History line plus an `executorLog.warn`.
History lives in `tasks.log`, which the store PRUNES on write (`task-mutation-ops.ts`:
`if (log.length > entryLimit) log.splice(0, log.length - entryLimit)`), and the per-task agent log is
capped the same way, so the class could not be counted after retention, could not be trended, and was
never attributed to a lane. The measured consequence: one 900 s ceiling bound EVERY prompt-mode lane
while the review lanes crossed it as their common case, and each crossing disposed a full-length session
and re-ran the whole attempt — a two-budget latency tax no durable surface could count.

Sources, in descending trust, and what each can and cannot prove:

1. `tasks.workflow_step_results` (durable, written by the graph's only result recorder) — the persisted
   gate ledger, hydrated through `TaskStore.listTasks` with archived cards included. A timed-out attempt
   survives here only when it was terminal for the episode: the failed row carries the canonical
   `timed out after <n>ms` sentence in `output`/`notes`, and a remediation archive keeps earlier failures
   in `priorAttempts`. An attempt that timed out and whose secondary THEN delivered a verdict persisted
   no row of its own, so pre-event counts from this source are a LOWER BOUND and are printed as such.
2. `run_audit_events` → `task:workflow-step-timeout` (durable, read through
   `TaskStore.getRunAuditEventsAsync`) — one row per timed-out attempt, emitted at the timeout seam
   itself: the only source that counts attempts rather than episodes. It exists only for runs at or after
   the commit that added it, so a zero there beside nonzero source-1 counts IS the honest gap, not a
   contradiction.
3. `tasks.log` History lines (durable but pruned to a bounded window) — the only place the fallback /
   same-model re-arm decision was ever written. Reported as window contents, never as a rate.

The lane vocabulary comes from `@fusion/core` (`classifyWorkflowPromptStepLane`) — the same function the
executor uses to pick the budget and to label the audit row — so the measurement and the fix cannot
disagree about which population they describe. A locally re-spelled classifier would be a second
authority over the same rows. The ceiling is resolved per card through `resolveEffectiveSettings`, the
same two-tier merge the engine arms its timer from, so an operator's stored workflow value is the number
reported rather than the declaration default guessed at.

Which board is measured is chosen, never inherited. Project identity is a `.fusion/project.json` marker
rather than the git root, and PostgreSQL row-level security scopes every read to the session's
`fusion.project_id`, so a census booted from a linked task worktree would silently report an empty board
and call it a zero rate. `--project <id|name>` therefore re-boots the store BOUND to the named project
(`createTaskStoreForBackend({ projectId })`), which is the documented way to address another project, and
keeps hydration on the TaskStore path rather than an ad-hoc query.

Read-only: opens the backend through the shared ops bootstrap and writes nothing.
Requires `pnpm --filter @fusion/core build` (see scripts/lib/backend-db.mjs).
*/
import process from "node:process";
import { openBackend, rowsOf } from "./lib/backend-db.mjs";

/*
The canonical sentence is minted in packages/engine/src/executor/execute-workflow-step.ts
(`workflow step timed out after ${timeoutMs}ms`) and reaches the persisted row through the graph's
`node:<id>:error` carrier. The seconds-spelled History phrasing is matched separately because it is the
only text that ever named WHICH attempt kind was disposed.
*/
const PERSISTED_TIMEOUT_RE = /workflow step timed out after (\d+)ms/i;
const HISTORY_TIMEOUT_RE = /model timed out after (\d+)s/i;
const HISTORY_REARM_RE = /starting one (?:configured [^—]* fallback|fresh same-model retry)/i;
const HISTORY_STEP_NAME_RE = /Workflow step '([^']+)'/;

const PAGE_SIZE = 500;
const AUDIT_ROW_CAP = 20_000;

function parseArgs(argv) {
  const flags = {};
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--include-deleted") flags.includeDeleted = true;
    else if (arg === "--all-projects") flags.allProjects = true;
    else if (arg === "--project") { i += 1; flags.project = args[i]; }
    else if (arg === "--limit") { i += 1; flags.limit = Number(args[i]); }
    else if (arg === "--since") { i += 1; flags.since = args[i]; }
    else if (arg === "--review-ceiling") { i += 1; flags.reviewCeiling = Number(args[i]); }
    else {
      console.error(`unknown argument: ${arg}`);
      flags.help = true;
      flags.badArgs = true;
    }
  }
  return flags;
}

function usage() {
  console.log(`Usage: node scripts/workflow-step-timeout-census.mjs [options]

Read-only census of prompt-mode workflow step timeouts per lane, from durable rows only.
Requires a built @fusion/core dist: pnpm --filter @fusion/core build

  --project <id|name>   measure one named board (re-boots the store bound to that project id;
                        required when the current directory is not that project's root)
  --all-projects        measure every registered board, each reported separately
  --limit N             scan at most N card rows per board (newest first)
  --since ISO           ignore cards whose updatedAt predates this ISO instant
  --include-deleted     also read soft-deleted rows (off by default; deleted cards are still evidence)
  --review-ceiling MS   the budget review-type rows in THIS population were actually armed with. Default:
                        the shared ceiling, because review rows in a board that predates the
                        workflowReviewStepTimeoutMs knob were armed with it. Pass the review knob's value
                        (e.g. 1800000) to measure a board whose rows were produced by a build carrying it.

With neither --project nor --all-projects the census reads the board bound to the current directory.`);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.min(rank, sorted.length - 1)];
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined) return "—";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function fmtPct(part, whole) {
  if (!whole) return "0.0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function durationMs(result) {
  const started = Date.parse(result?.startedAt ?? "");
  const completed = Date.parse(result?.completedAt ?? "");
  if (Number.isNaN(started) || Number.isNaN(completed)) return null;
  return completed >= started ? completed - started : null;
}

/*
Only the machine error carriers are searched, and only for the CANONICAL sentence. The first draft matched
`timed out after (N ms)` anywhere in the serialized row and was corrected by measurement: exactly one of
1,071 gate episodes matched, and the hit sat in a reviewer's own prose describing a deadline in the code
it had reviewed (RUFU-377). A census that counts a reviewer's quotation as a disposed session reports a
rate it invented, so the pattern requires the sentence the engine mints and looks only where the engine
writes it: `output` for a non-verdict failure, `notes` for a verdict-required one, `error` if present.
*/
function carriedTimeoutMs(record) {
  for (const field of ["output", "notes", "error"]) {
    const value = record?.[field];
    if (typeof value !== "string") continue;
    const match = PERSISTED_TIMEOUT_RE.exec(value);
    if (match) {
      const ms = Number(match[1]);
      return Number.isFinite(ms) ? ms : 0;
    }
  }
  return null;
}

/** A gate ledger entry plus every prior attempt a remediation archive kept inside it. */
function flattenAttempts(result) {
  const attempts = [{ record: result, archived: false }];
  for (const prior of result?.priorAttempts ?? []) {
    if (prior && typeof prior === "object") attempts.push({ record: prior, archived: true });
  }
  return attempts;
}

function newLaneStats() {
  return {
    episodes: 0,
    archivedAttempts: 0,
    timeoutEpisodes: 0,
    timeoutAttempts: 0,
    cleanDurations: [],
    timedOutDurations: [],
    /*
    A clean episode whose wall time exceeds ONE armed budget is a timeout the ledger never wrote: the one
    shape that proves the persisted sentence is missing rather than absent. Repair continuations share the
    signature, so the count is evidence of undercount, not a precise attempt count.
    */
    overCeilingClean: 0,
    overCeilingCleanDurations: [],
    /*
    The distribution a budget SHOULD be fitted to: episodes that delivered inside ONE armed budget are
    sessions that worked. An episode longer than one budget necessarily contained more than one session, so
    it says nothing about how long a healthy review runs. Keeping the two apart is the difference between
    fitting a budget and appeasing a hang.
    */
    withinCeilingDurations: [],
    ceilings: new Map(),
    historyTimeoutLines: 0,
    historyRearmLines: 0,
    auditRows: 0,
  };
}

/* ── which board, and how it is read ─────────────────────────────────────── */

async function listRegisteredProjects(backend) {
  return rowsOf(await backend.asyncLayer.db.execute(backend.sql`
    SELECT id, name, path FROM central."projects"
  `)).map((row) => ({ id: row.id, name: row.name, path: row.path }));
}

function selectProjects(all, wantedName) {
  const wanted = String(wantedName ?? "").trim();
  if (!wanted) return all;
  const matches = all.filter((row) => row.id === wanted || row.name === wanted);
  if (matches.length === 0) {
    const known = all.map((row) => `${row.name} (${row.id})`).join(", ");
    throw new Error(`no project matches "${wanted}". Known projects: ${known || "(none)"}`);
  }
  return matches;
}

/**
 * Re-boot a TaskStore BOUND to one project id. Row-level security filters every read by the session's
 * `fusion.project_id`, so this — not a wider query — is what makes a second board readable, and the
 * hydration stays on the same TaskStore seam the default mode uses.
 */
async function openProjectStore(core, projectId) {
  return core.createTaskStoreForBackend({
    projectId,
    skipArchiveReintegrationOnInit: true,
  });
}

async function collectTasks(store, flags) {
  const tasks = [];
  const cap = Number.isFinite(flags.limit) && flags.limit > 0 ? flags.limit : Number.POSITIVE_INFINITY;
  for (let offset = 0; tasks.length < cap; offset += PAGE_SIZE) {
    const page = await store.listTasks({
      includeArchived: true,
      includeDeleted: Boolean(flags.includeDeleted),
      limit: Math.min(PAGE_SIZE, cap - tasks.length),
      offset,
      slim: false,
      startupMemo: false,
    });
    tasks.push(...page);
    if (page.length === 0) break;
  }
  return tasks;
}

/** The ceiling the executor would have armed for this card, from the same merge the timer reads. */
function makeCeilingResolver(core, store, declDefault, reviewCeilingOverride = null) {
  const irCache = new Map();
  const bySelection = new Map();
  let unresolvable = 0;
  return {
    get unresolvable() {
      return unresolvable;
    },
    async for(task) {
      let effective = null;
      try {
        const selection = (store.getTaskWorkflowSelection?.(task.id) ?? "builtin:coding") || "builtin:coding";
        if (bySelection.has(selection)) {
          effective = bySelection.get(selection);
        } else {
          effective = await core.resolveEffectiveSettings(store, task, irCache);
          bySelection.set(selection, effective);
        }
      } catch {
        unresolvable += 1;
        return null;
      }
      const shared = Number(effective?.workflowStepTimeoutMs ?? declDefault.get("workflowStepTimeoutMs"));
      /*
      FNXC:WorkflowStepTimeoutLane 2026-11-19-07:25 (RUFU-684):
      The census measures a POPULATION OF ROWS, and a row was armed with whatever was configured on its
      day. Once RUFU-684 declares `workflowReviewStepTimeoutMs`, reading this build's declaration would
      retroactively re-arm every historical review row at the new number: its 12-minute duration would then
      bucket as "fits one budget" and the over-one-budget evidence this card was filed on (54 of 1072 gate
      episodes needing two budgets) would silently evaporate from a table that claims to be a measurement.
      So the review ceiling is the SHARED number unless the caller says the rows were produced after the
      knob shipped (`--review-ceiling`), which is the only honest way to describe a post-knob board. A row
      that names its own ceiling -- a timeout row carrying `timed out after <n>ms` -- still overrides both
      numbers at the point of use, and that is the ceiling that actually bound the episode.
      */
      const review = Number.isFinite(reviewCeilingOverride) && reviewCeilingOverride > 0
        ? reviewCeilingOverride
        : shared;
      return { shared, review };
    },
  };
}

/* ── aggregation ─────────────────────────────────────────────────────────── */

async function aggregate(core, tasks, declDefault, ceilings, reviewCeilingOverride = null) {
  const lanes = new Map();
  let withLedger = 0;

  const laneFor = (lane) => {
    if (!lanes.has(lane)) lanes.set(lane, newLaneStats());
    return lanes.get(lane);
  };
  const noteCeiling = (stats, ms) => {
    if (Number.isFinite(ms)) stats.ceilings.set(ms, (stats.ceilings.get(ms) ?? 0) + 1);
  };

  for (const task of tasks) {
    const ledger = Array.isArray(task.workflowStepResults) ? task.workflowStepResults : [];
    if (ledger.length > 0) withLedger += 1;
    const armed = ceilings ? await ceilings.for(task) : null;

    for (const stepResult of ledger) {
      const stepId = stepResult?.workflowStepId ?? null;
      if (!stepId) continue;
      const input = {
        stepId,
        name: stepResult?.workflowStepName ?? null,
        phase: stepResult?.phase ?? null,
        reviewKind: stepResult?.reviewKind ?? null,
      };
      const stats = laneFor(core.classifyWorkflowPromptStepLane(input));
      const reviewType = core.isReviewTypePromptStep(input);
      /*
       * A card whose effective settings could not be resolved contributes durations but no per-card merge,
       * so its ceiling comes from the declarations -- under the same rule as `makeCeilingResolver`: a
       * review row is assumed to have been armed with the shared number unless the caller declared a
       * post-knob population. Reading this build's review default here would re-arm history the same way.
       */
      const sharedFallback = Number(declDefault.get("workflowStepTimeoutMs"));
      const reviewFallback = Number.isFinite(reviewCeilingOverride) && reviewCeilingOverride > 0
        ? reviewCeilingOverride
        : sharedFallback;
      noteCeiling(
        stats,
        armed
          ? reviewType ? armed.review : armed.shared
          : Number(reviewType ? reviewFallback : sharedFallback),
      );

      let episodeTimeoutMs = null;
      for (const { record: attempt, archived } of flattenAttempts(stepResult)) {
        if (archived) stats.archivedAttempts += 1;
        const carried = carriedTimeoutMs(attempt);
        if (carried !== null) {
          stats.timeoutAttempts += 1;
          episodeTimeoutMs = episodeTimeoutMs ?? carried;
        }
      }
      const duration = durationMs(stepResult);
      stats.episodes += 1;
      if (episodeTimeoutMs !== null) {
        stats.timeoutEpisodes += 1;
        if (duration !== null) stats.timedOutDurations.push(duration);
        // The ceiling actually armed at the moment of the miss, read off the row rather than assumed.
        if (episodeTimeoutMs > 0) noteCeiling(stats, episodeTimeoutMs);
      } else if (duration !== null) {
        stats.cleanDurations.push(duration);
        const armedForLane = armed
          ? (reviewType ? armed.review : armed.shared)
          : Number(reviewType ? reviewFallback : sharedFallback);
        if (Number.isFinite(armedForLane) && armedForLane > 0) {
          if (duration <= armedForLane) stats.withinCeilingDurations.push(duration);
          else {
            stats.overCeilingClean += 1;
            stats.overCeilingCleanDurations.push(duration);
          }
        }
      }
    }

    for (const entry of Array.isArray(task.log) ? task.log : []) {
      const line = `${entry?.action ?? ""} ${entry?.outcome ?? ""}`;
      const stepName = HISTORY_STEP_NAME_RE.exec(line)?.[1] ?? null;
      if (HISTORY_TIMEOUT_RE.test(line)) {
        laneFor(core.classifyWorkflowPromptStepLane({ name: stepName })).historyTimeoutLines += 1;
      }
      if (HISTORY_REARM_RE.test(line)) {
        laneFor(core.classifyWorkflowPromptStepLane({ name: stepName })).historyRearmLines += 1;
      }
    }
  }

  return { lanes, withLedger };
}

async function readTimeoutAuditEvents(core, store) {
  const byLane = new Map();
  let total = 0;
  let rows;
  try {
    rows = await store.getRunAuditEventsAsync({
      mutationType: "task:workflow-step-timeout",
      limit: AUDIT_ROW_CAP,
    });
  } catch (error) {
    return { byLane, total: 0, readable: false, error: error instanceof Error ? error.message : String(error) };
  }
  for (const row of rows ?? []) {
    const meta = row?.metadata ?? {};
    const lane = core.asWorkflowStepTimeoutLane(meta?.lane) ?? "unattributable";
    const kind = typeof meta?.attemptKind === "string" ? meta.attemptKind : "unknown";
    if (!byLane.has(lane)) byLane.set(lane, { total: 0, byKind: new Map() });
    const entry = byLane.get(lane);
    entry.total += 1;
    entry.byKind.set(kind, (entry.byKind.get(kind) ?? 0) + 1);
    total += 1;
  }
  return { byLane, total, readable: true, error: null };
}

/* ── report ─────────────────────────────────────────────────────────────── */

const LANE_ORDER = ["code-review", "plan-review", "post-merge-verification", "completion-summary", "other-prompt-step"];
const laneRank = (lane) => (LANE_ORDER.indexOf(lane) === -1 ? LANE_ORDER.length : LANE_ORDER.indexOf(lane));

function printLaneTable(lanes) {
  const ordered = [...lanes.entries()].sort((a, b) => laneRank(a[0]) - laneRank(b[0]));
  console.log("");
  console.log("lane                    episodes   timedOut    rate   fits-one-budget p50/p90/p95/max  over-one-budget  wall p50/max  archived  histTo  rearm  auditRows");
  console.log("    over-one-budget = episodes whose wall time exceeds ONE armed budget (>=2 sessions); (+n) = rows that say so out loud.");
  console.log("----------------------------------------------------------------------------------------------------------------------------------------");
  const totals = { episodes: 0, timeoutEpisodes: 0, timeoutAttempts: 0, historyTimeoutLines: 0, historyRearmLines: 0, auditRows: 0 };
  for (const [lane, s] of ordered) {
    const fits = [...s.withinCeilingDurations].sort((a, b) => a - b);
    const timed = [...s.timedOutDurations].sort((a, b) => a - b);
    const multiSession = [...s.overCeilingCleanDurations, ...timed].sort((a, b) => a - b);
    totals.episodes += s.episodes;
    totals.timeoutEpisodes += s.timeoutEpisodes;
    totals.timeoutAttempts += s.timeoutAttempts;
    totals.historyTimeoutLines += s.historyTimeoutLines;
    totals.historyRearmLines += s.historyRearmLines;
    totals.auditRows += s.auditRows;
    const cleanCol = `${[50, 90, 95, 100].map((p) => fmtDuration(percentile(fits, p))).join("/")}`;
    const multiSessionCol = `${s.overCeilingClean + timed.length}${timed.length ? `(+${timed.length})` : ""} ${fmtDuration(percentile(multiSession, 50))}/${fmtDuration(percentile(multiSession, 100))}`;
    console.log(
      [
        lane.padEnd(21),
        String(s.episodes).padStart(9),
        String(s.timeoutEpisodes).padStart(10),
        fmtPct(s.timeoutEpisodes, s.episodes).padStart(7),
        cleanCol.padStart(30),
        multiSessionCol.padStart(28),
        String(s.archivedAttempts).padStart(9),
        String(s.historyTimeoutLines).padStart(7),
        String(s.historyRearmLines).padStart(6),
        String(s.auditRows).padStart(10),
      ].join(" "),
    );
  }
  console.log("---------------------------------------------------------------------------------------------------------------------------------");
  console.log(
    [
      "TOTAL".padEnd(21),
      String(totals.episodes).padStart(9),
      String(totals.timeoutEpisodes).padStart(10),
      fmtPct(totals.timeoutEpisodes, totals.episodes).padStart(7),
      `${totals.timeoutAttempts} attempt(s) named in rows, ${totals.auditRows} audit row(s)`.padStart(43),
    ].join(" "),
  );
  const overTotal = ordered.reduce((sum, [, s]) => sum + s.overCeilingClean, 0);
  const fitsTotal = ordered.reduce((sum, [, s]) => sum + s.withinCeilingDurations.length, 0);
  console.log(`  episodes that delivered inside ONE armed budget: ${fitsTotal}; episodes whose wall time needs more than one budget (so they held at least two sessions) with no timeout sentence in the row: ${overTotal}`);
  console.log("");
  console.log("Ceiling(s) armed, counted from the rows themselves (count = ledger entries at that ceiling):");
  for (const [lane, s] of ordered) {
    if (s.ceilings.size === 0) continue;
    const seen = [...s.ceilings.entries()]
      .sort((a, b) => (b[1] || 0) - (a[1] || 0))
      .map(([ms, count]) => `${Math.round(ms / 1000)}s${count ? `x${count}` : ""}`);
    console.log(`  ${lane}: ${seen.join(", ")}`);
  }

  /*
  FNXC:WorkflowStepTimeoutLane 2026-11-19-07:05 (RUFU-684):
  Once the review lanes carry their own knob, two different ceilings can appear in one table, and the
  bucketing columns silently start measuring against the NEW one. Every historical row was produced under
  whatever was armed on its day -- the shared 900 s -- so its duration can sit comfortably under the review
  ceiling this build declares and land in `fits-one-budget`, which would read as "the budget always fit"
  and erase the very evidence this card was filed on. A row that names its own ceiling (a timeout row
  carrying `timed out after <n>ms`) is the only record of the ceiling that actually bound an episode, so
  the caveat points there. Printed only when the table really shows more than one ceiling -- with one
  ceiling there is nothing to misread.
  */
  const distinctCeilings = new Set();
  for (const [, s] of ordered) {
    for (const ms of s.ceilings.keys()) distinctCeilings.add(ms);
  }
  if (distinctCeilings.size > 1) {
    const sorted = [...distinctCeilings].sort((a, b) => a - b).map((ms) => `${Math.round(ms / 1000)}s`);
    console.log("");
    console.log(`TWO CEILINGS IN ONE TABLE (${sorted.join(" vs ")}): review-type lanes resolve`);
    console.log("  `workflowReviewStepTimeoutMs` and the rest resolve `workflowStepTimeoutMs`, so the ceiling shown");
    console.log("  is what a card would be armed with TODAY. Rows written before that knob shipped were produced");
    console.log("  under the shared ceiling, and their durations land in `fits-one-budget` against a budget they");
    console.log("  were never given -- read `timedOut` and the ceiling each row names for itself as the pre-knob");
    console.log("  evidence, and do not treat the post-knob bucketing as contradicting it.");
  }
}

function printHowToRead(audit) {
  console.log("");
  console.log("How to read this table — every count is a lower bound, for a named reason:");
  console.log("  episodes     persisted gate-ledger entries for the lane, archived cards included.");
  console.log("  timedOut     entries whose persisted error carriers hold the engine's canonical");
  console.log("               `workflow step timed out after <n>ms` sentence. An attempt that timed out and");
  console.log("               whose secondary then delivered a verdict persisted NO row, so this undercounts");
  console.log("               attempts and is the floor of the floor.");
  console.log("  rate         timedOut / episodes. The ceiling TRUNCATES the duration distribution, so the");
  console.log("               survivors' clean p95 always lands just under the ceiling and proves nothing");
  console.log("               about fit. This rate is the measurement that does: a rate of r places the");
  console.log("               ceiling near the (100-r)th percentile of true durations, so a p95-fitting");
  console.log("               budget must sit above it whenever r > 5%.");
  console.log("  fits-one-budget  p50/p90/p95/max of episodes that delivered INSIDE one armed budget. An episode");
  console.log("               longer than one budget necessarily held more than one session, so only these");
  console.log("               percentiles describe how long a session that WORKS actually runs - which is the");
  console.log("               distribution a budget must be fitted to. Reading the other column instead is how");
  console.log("               a ceiling gets raised to accommodate a hang.");
  console.log("  over-one-budget  episodes whose wall time exceeds ONE armed budget, counted with the median and");
  console.log("               max of those wall times. A timeout consumes its whole budget by construction, so");
  console.log("               this set is a floor on the episodes that ran out of time; the `(+n)` suffix adds");
  console.log("               rows that say so out loud.");
  console.log("  archived     prior attempts a remediation archive kept inside a live ledger entry.");
  console.log("  archived     prior attempts a remediation archive kept inside a live ledger entry.");
  console.log("  histTo/rearm History lines naming a timeout / a rearmed second attempt. `tasks.log` is");
  console.log("               pruned on write, so these are window contents and never a rate.");
  console.log("  auditRows    durable `task:workflow-step-timeout` rows - one per timed-out ATTEMPT, the");
  console.log("               only count that needs no inference. Zero beside a nonzero timedOut column");
  console.log("               means the population predates the event.");
  console.log("");
  console.log(`audit event readable: ${audit.readable}${audit.error ? ` (error: ${audit.error})` : ""}; rows: ${audit.total}`);
  if (audit.total === 0) {
    console.log("HONEST MEASUREMENT GAP: no `task:workflow-step-timeout` rows exist for the population above.");
    console.log("Before that event a timed-out-then-succeeded attempt persisted nothing durable at all, so");
    console.log("every count in this table is a LOWER BOUND on the attempts that timed out and MUST NOT be");
    console.log("read as the lane's timeout rate.");
  }
  for (const [lane, entry] of audit.byLane) {
    const kinds = [...entry.byKind.entries()].map(([kind, count]) => `${kind}=${count}`).join(", ");
    console.log(`  audit ${lane}: ${entry.total}${kinds ? ` (${kinds})` : ""}`);
  }
}

/* ── entry ──────────────────────────────────────────────────────────────── */

const flags = parseArgs(process.argv);
if (flags.help) {
  usage();
  process.exitCode = flags.badArgs ? 1 : 0;
} else {
  let backend = null;
  const extraShutdowns = [];
  try {
    backend = await openBackend(process.cwd());
    const core = backend.core;
    const declDefault = new Map((core.BUILTIN_WORKFLOW_SETTINGS ?? []).map((setting) => [setting.id, setting.default]));

    console.log("Prompt-mode workflow step timeout census - durable rows only");
    console.log("=================================================================");
    console.log(`declaration defaults: workflowStepTimeoutMs=${declDefault.get("workflowStepTimeoutMs")}ms, workflowReviewStepTimeoutMs=${declDefault.get("workflowReviewStepTimeoutMs")}ms (undefined = the workflow declares no per-lane knob yet)`);

    let boards;
    if (flags.allProjects) {
      boards = await listRegisteredProjects(backend);
    } else if (flags.project) {
      boards = selectProjects(await listRegisteredProjects(backend), flags.project);
    } else {
      boards = [{ id: null, name: "(board bound to the current directory)", path: process.cwd() }];
    }

    let legendAudit = { byLane: new Map(), total: 0, readable: true, error: null };
    for (const board of boards) {
      let store = backend.store;
      let shutdownBoard = null;
      if (board.id) {
        const booted = await openProjectStore(core, board.id);
        extraShutdowns.push(booted.shutdown);
        store = booted.taskStore;
        shutdownBoard = booted.shutdown;
      }
      const tasks = await collectTasks(store, flags);
      const ceilings = makeCeilingResolver(core, store, declDefault, flags.reviewCeiling);
      const tally = await aggregate(core, tasks, declDefault, ceilings, flags.reviewCeiling);
      const audit = await readTimeoutAuditEvents(core, store);
      for (const [lane, entry] of audit.byLane) {
        if (!tally.lanes.has(lane)) tally.lanes.set(lane, newLaneStats());
        tally.lanes.get(lane).auditRows = entry.total;
      }
      legendAudit = audit;

      console.log("");
      console.log(`BOARD ${board.name}${board.id ? ` (${board.id})` : ""}  ${board.path}`);
      console.log(`  cards scanned: ${tasks.length}, with a persisted gate ledger: ${tally.withLedger}`);
      if (ceilings.unresolvable > 0) {
        console.log(`  cards whose effective ceiling could not be resolved: ${ceilings.unresolvable} (they contribute durations, not ceilings)`);
      }
      printLaneTable(tally.lanes);
      /*
       * Which ceiling the bucketing columns used is part of the measurement, not an implementation detail:
       * the same 12-minute row reads as "fit" under one assumption and "over budget" under the other.
       */
      const postKnob = Number.isFinite(flags.reviewCeiling) && flags.reviewCeiling > 0;
      console.log("");
      console.log(postKnob
        ? `  review-lane ceiling assumed: ${Math.round(flags.reviewCeiling / 1000)}s (from --review-ceiling)`
        : "  review-lane ceiling assumed: the shared `workflowStepTimeoutMs`, because rows written before the");
      if (!postKnob) {
        console.log("  `workflowReviewStepTimeoutMs` knob shipped were armed with it. Pass --review-ceiling <ms> to");
        console.log("  measure a board whose rows came from a build that carries the review knob.");
      }
      await shutdownBoard?.().catch(() => {});
    }

    printHowToRead(legendAudit);
  } catch (error) {
    console.error(`census failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    for (const shutdown of extraShutdowns) await shutdown().catch(() => {});
    await backend?.shutdown?.().catch(() => {});
  }
}
