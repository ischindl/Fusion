/*
FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
`tasks.log` was the single heaviest column on the live board (31.4 MB of 73.6 MB, 42.7% of live-row
bytes over 2 417 rows) and the only reason a board refresh had to read it: five read-time derivations
(`computeTimedExecutionMs`, `detectStalledReview`, `hasRecentReasonDrivenStall`,
`getLatestLogTimestamp`, `countRecentIdenticalStallEntries`) consume it. A SQL-side derivation of the
same five signals was prototyped, proven equivalent (482 709 entries → 12 939 kept) and REJECTED on
cost: 4.5-11.5 s of PostgreSQL CPU per full-board read, because locating `[timing]` entries or the max
timestamp forces per-row jsonb expansion and ANY per-row touch of `log` decompresses the whole 31 MB
(no-`log` baseline: 0.2-0.35 s). The rejected shape is therefore off the table permanently: a
derivation of these signals may only run where the full log is already in memory — at WRITE time.

This module owns that write-time derivation. It is a pure function of the whole log array (never an
append delta) so a wholesale `task.log = []` rewrite is correct by construction, and its output is
carried by two narrow columns: `tasks.timing_total_ms` and `tasks.log_recent`.

Two implementations of the same rules exist on purpose: this TypeScript one (the write seam) and
`project.fusion_task_log_projections()` in migration 0092 (the one-time backfill only). They are held
equal by `__tests__/postgres/task-log-projections.pg.test.ts`; neither may be edited without the other.

The projection is a TIMESTAMP-SIGNAL ENVELOPE, not a slice of the log. A slice cannot reproduce two of
the five rules provably: `getLatestLogTimestamp` is a MAX over the WHOLE log (a tail slice loses the
max when timestamps are non-monotonic), and `detectStalledReview` matches
`STALLED_REVIEW_INVALID_TRANSITION_PATTERN` against `outcome` too, which is capped at 4 000 chars per
entry — so any truncated-outcome slice is not match-equivalent. Storing signals instead keeps every
pattern match running against full text, where the full text still exists: at write time.

FNXC:TaskLogProjections 2026-11-21-00:55 (RUFU-636):
WHO READS THE PROOF. The paragraphs above describe what the envelope holds; what RUFU-615 left unfinished was
who consumes its self-assessment. Its docstring promised "a reader whose window cannot be proved keeps the
`log` column instead", and no reader did: all four resolvers computed `provablyComplete` and every caller
ignored it — and RUFU-312 then made EVERY list read log-free while the badges kept being derived, so the
promise became structurally unkeepable (a board refresh has no `log` to keep). What ships instead is ONE
verdict, {@link taskLogEnvelopeProves}, asked by the four resolvers here and by the two log-free badge sites
in `reads.ts` (`listTasksImpl`, `hydrateSearchTaskRows`). A row whose envelope cannot answer for the window
that read serves gets its recent History back through ONE `readTaskLogEntriesBatch` statement, bounded per
row to the horizon those badges consult ({@link horizonFromServedWindows} — a derivation with a longer
lookback must register there or the fallback must not serve its badge), and it may answer only when the four
ground-truth proofs in {@link withholdReasonForGatedRow} hold. Proof 4 exists because the envelope has two
authors: the rollup one derives over the MERGED legacy+side view while storing a SIDE-row count, and
`catchUpLegacyTaskLogEntries` copies only lines stamped `>= backfilledAt` for 200 tasks per pass, so an
envelope can name an in-window line `project.task_log_entries` never received — and a newest-only comparison
passes such a row, serving a `matchCount` LOWER than today's. A repair that cannot prove it holds the card's
History, line by named line, is a worse answer than the card already had, so every failed proof keeps
today's answer and tallies its fixed reason (`side-history-absent`, `side-window-truncated`,
`side-behind-author`, `side-missing-named-timestamp`, `over-row-cap`), announced once per pass by the gate's
single `storeLog.warn`. `timedExecutionMs` is never served from the fallback: it sums the whole History and
reads no timestamp, so a horizon-bounded fetch can only undercount a figure both authors store exactly.
Contract prose: docs/storage.md → "Derived task-log projection columns".
*/

import type { TaskLogEntry } from "../types.js";
import { computeTimedExecutionMs } from "../tasks/log-timing.js";
import {
  IN_REVIEW_STALL_LOG_PREFIX,
  type InReviewStallCode,
  type InReviewStallSignal,
} from "../tasks/in-review-stall.js";
import {
  STALLED_REVIEW_INVALID_TRANSITION_PATTERN,
  STALLED_REVIEW_INVALID_TRANSITION_THRESHOLD,
  STALLED_REVIEW_REENQUEUE_PATTERN,
  STALLED_REVIEW_REENQUEUE_THRESHOLD,
  STALLED_REVIEW_WINDOW_MS,
  type StalledReviewSignal,
} from "../tasks/stalled-review-detector.js";

/**
 * Envelope shape version. A reader that cannot recognise the version treats it as absent.
 *
 * FNXC:TaskLogProjections 2026-11-19-19:56 (RUFU-636):
 * THE BUMP RULE. Raising this constant must make BOTH envelope authors refuse, and only one of them does it
 * by comparison: `parseTaskLogRecent` (the legacy `tasks.log_recent` author) rejects a `v` it does not name,
 * while `parseRollupEnvelope` (`task-log-entries.ts`, module-private, and not editable from this card)
 * types ANY numeric `v` as an envelope because the rollup is written by the code that is always in step
 * with itself. So after a bump the rollup lane is the ONLY one that can hand a reader arithmetic this
 * module never authored, and the refusal that protects readers lives in {@link taskLogEnvelopeProves}
 * alone, reported as `unknown-envelope-version`. Duplicating the comparison into a parser would put the
 * rule in two places again, which is the defect RUFU-636 exists to remove.
 *
 * Consequence to keep honest until a bump actually lands: while this stays 1 only a hand-authored or
 * future-shaped rollup can trip the refusal, so the branch is exercised by unit fixtures rather than by
 * production rows — and a reader must still refuse rather than derive, never "assume it is close enough".
 */
export const LOG_RECENT_SCHEMA_VERSION = 1;

/**
 * The byte ceiling the envelope must respect. PostgreSQL diverts a value out of line once the tuple
 * passes `toast_tuple_threshold` (default 2040 bytes), and the whole point of `log_recent` is that a
 * board read never pays a TOAST fetch — an envelope that overflows reintroduces exactly the read
 * amplification this task exists to remove. Asserted against the worst-case fixture in the pg test.
 */
export const LOG_RECENT_INLINE_BYTE_BUDGET = 2_040;

/**
 * Per-array ceilings — they exist because the byte budget is finite, and they are made honest by a
 * companion `…NewestDroppedAt` marker: a reader whose window starts before that boundary CANNOT prove
 * its answer from the envelope, and the resolver says so through `provablyComplete`.
 *
 * FNXC:TaskLogProjections 2026-11-21-00:55 (RUFU-636): the flag this cap earns finally has a reader, and it
 * is not the one RUFU-615's docstring described. A log-free board read cannot "keep the `log` column" — it
 * decided its SELECT before the rows arrived — so a drop whose newest marker still sits inside the served
 * window routes the card through the sufficiency gate in `reads.ts`: ONE horizon-bounded read of
 * `project.task_log_entries`, which answers only when its four ground-truth proofs hold and otherwise keeps
 * the answer produced below. For this module's callers the flag stays informational — a resolver still
 * returns the stored (possibly understated) count and says so through `provablyComplete`, and suppressing it
 * here would turn a conservative badge into a missing one. For the gate the same verdict is load-bearing,
 * which is exactly why both ask {@link taskLogEnvelopeProves} rather than restating it. What never changed is
 * the direction of the error: a `stalledReview` `matchCount` is understated, never invented upward past the
 * stored array. Do not re-add "keeps the `log` column" here unless a reader really can — the fallback is the
 * side table, never `log`.
 * Both thresholds these signals feed are 3 and 2, so a cap of 16 covers any reportable episode with headroom.
 */
export const LOG_RECENT_MATCH_ARRAY_CAP = 16;
export const LOG_RECENT_TAIL_ARRAY_CAP = 16;

/** Ceiling on the stored trailing-run reason; a longer reason is marked truncated, never silently clipped. */
export const LOG_RECENT_TAIL_REASON_MAX_CHARS = 200;

/** Column names, exported so the descriptor, the migration and the guard test cite one source. */
export const TASK_TIMING_TOTAL_MS_COLUMN = "timingTotalMs";
export const TASK_LOG_RECENT_COLUMN = "logRecent";
/*
FNXC:TaskLogSideTable 2026-11-01-17:40 (RUFU-312):
The author-stamp column for the pairing below. A pure append can no longer reach these columns (writing
`tasks` is exactly what RUFU-312 removes from the append path), so the envelope has a second author —
`project.task_log_rollup` — and each author has to say when it authored. `pickTaskLogEnvelope` reads the
comparison; a reader that guessed from `updated_at` would credit a badge to a status change.
*/
export const TASK_LOG_PROJECTION_AT_COLUMN = "logProjectionAt";

export interface TaskLogRecentEnvelope {
  v: number;
  /** Verbatim `timestamp` string of the entry holding the MAX parseable timestamp over the WHOLE log. */
  latestAt: string | null;
  /** Verbatim `timestamp` string of the newest parseable `In-review stall surfaced [` entry. */
  stallSurfacedAt: string | null;
  /** Entries whose `timestamp` failed the shared strict parse rule — the envelope's own sufficiency proof. */
  unparseableCount: number;
  /** Re-enqueue-churn match timestamps in log-array order (the reader's `firstMatchAt` is array order, not time order). */
  reenqueueAt: string[];
  reenqueueNewestDroppedAt: number | null;
  invalidTransitionAt: string[];
  invalidTransitionNewestDroppedAt: number | null;
  tailCode: string | null;
  tailReason: string | null;
  tailReasonTruncated: boolean;
  tailCount: number;
  /** Trailing-run timestamps in WALK order (newest first), which is what the reader consumes. */
  tailAt: string[];
  tailTruncated: boolean;
}

export interface TaskLogProjections {
  timingTotalMs: number;
  logRecent: TaskLogRecentEnvelope;
}

/*
FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
THE SHARED TIMESTAMP RULE. Both implementations parse timestamps with this shape and NOTHING else,
because `Date.parse` is implementation-defined (`"2026-10-10 19:13"` parses in V8 and reads differently
in PostgreSQL) and an equivalence proof cannot rest on it. Strict ISO-8601 with an explicit `Z` or
`±HH:MM` offset, calendar-validated, result in milliseconds = floor(microseconds / 1000). Anything
else is an unparseable entry: excluded from the envelope AND counted, and that count is what tells a
reader the envelope cannot prove its answer.
*/
const ISO_8601_STRICT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** @returns milliseconds since the epoch, or `null` when the string is not a strictly-valid UTC instant. */
export function parseProjectionTimestamp(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = ISO_8601_STRICT.exec(raw);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12) return null;
  // Year 0099 means 1900 to the JavaScript Date constructor and 99 to PostgreSQL, so both reject it.
  if (year < 1000) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  // Leap seconds are rejected rather than normalised: PostgreSQL's cast would shift the instant, and a
  // silent one-second disagreement between the two implementations is worse than an unparseable entry.
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMinutes = 0;
  const zone = m[8]!;
  if (zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const offHour = Number(zone.slice(1, 3));
    const offMinute = Number(zone.slice(4, 6));
    if (offHour > 23 || offMinute > 59) return null;
    offsetMinutes = sign * (offHour * 60 + offMinute);
  }
  // Extra fractional digits are truncated toward zero, matching the SQL side's microsecond floor.
  const frac = m[7] ?? "";
  const microseconds = frac.length === 0 ? 0 : Number(frac.padEnd(6, "0").slice(0, 6));
  const base = Date.UTC(year, month - 1, day, hour, minute, second, 0) - offsetMinutes * 60_000;
  if (!Number.isFinite(base)) return null;
  return base + Math.floor(microseconds / 1000);
}

/** A matched entry kept for a windowed rule; `ord` preserves log-array order across the retention cut. */
interface MatchCandidate {
  readonly ord: number;
  readonly timestamp: string;
  readonly tsMs: number;
}

/**
 * Retain the `cap` candidates with the LARGEST timestamps and return them in log-array order, so a
 * window filter applied to them reproduces the reader's `filter()` order — `firstMatchAt` and
 * `lastMatchAt` are array-order values and both reach the operator-visible reason sentence.
 */
function retainNewestInArrayOrder(candidates: MatchCandidate[], cap: number): { kept: MatchCandidate[]; newestDroppedAt: number | null } {
  if (candidates.length <= cap) return { kept: candidates, newestDroppedAt: null };
  const byTime = [...candidates].sort((a, b) => b.tsMs - a.tsMs);
  const keptSet = new Set(byTime.slice(0, cap));
  return {
    kept: candidates.filter((c) => keptSet.has(c)),
    // Every dropped candidate is older than every kept one, so the newest dropped one IS the boundary.
    newestDroppedAt: byTime[cap]?.tsMs ?? null,
  };
}

/** Empty envelope: what a row with no usable log entries carries. The SQL backfill produces the same value. */
export function emptyTaskLogRecent(): TaskLogRecentEnvelope {
  return {
    v: LOG_RECENT_SCHEMA_VERSION,
    latestAt: null,
    stallSurfacedAt: null,
    unparseableCount: 0,
    reenqueueAt: [],
    reenqueueNewestDroppedAt: null,
    invalidTransitionAt: [],
    invalidTransitionNewestDroppedAt: null,
    tailCode: null,
    tailReason: null,
    tailReasonTruncated: false,
    tailCount: 0,
    tailAt: [],
    tailTruncated: false,
  };
}

interface DerivableEntry {
  action: string;
  outcome: string;
  timestamp: string;
}

/*
FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
THE MALFORMED-`log` CONTRACT, mirrored rather than invented. `rowToTask` assigns
`fromJson<TaskLogEntry[]>(row.log) || []` and `pgRowToTaskRow` has already re-`JSON.stringify`-ed every
non-string jsonb value — so a jsonb-typed `string` (one live row has one today) arrives as a JS STRING
and every reader iterates it character-wise and finds nothing. A non-array log therefore derives the
empty envelope, which is exactly what `jsonb_typeof(log) <> 'array'` means on the SQL side. Neither
implementation repairs the row.
*/
function toDerivableEntries(log: unknown): DerivableEntry[] {
  if (!Array.isArray(log)) return [];
  const entries: DerivableEntry[] = [];
  for (const raw of log) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    entries.push({
      action: typeof entry.action === "string" ? entry.action : "",
      outcome: typeof entry.outcome === "string" ? entry.outcome : "",
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
    });
  }
  return entries;
}

/*
FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
`countRecentIdenticalStallEntries` walks the log BACKWARDS and stops at the first entry that is not a
stall entry of the SAME code and reason as the live signal. That makes the answer a property of the
trailing run alone: if the newest trailing stall entry does not match the signal the count is 0, and
when it does match, "matches the live signal" and "matches the newest trailing entry" are the same
predicate. So the write seam computes the run against the newest entry's own identity and the reader
only has to test the live signal against the stored identity.
*/
function deriveStallTail(entries: DerivableEntry[]): Pick<
  TaskLogRecentEnvelope,
  "tailCode" | "tailReason" | "tailReasonTruncated" | "tailCount" | "tailAt" | "tailTruncated"
> {
  const none = { tailCode: null as string | null, tailReason: null as string | null, tailReasonTruncated: false, tailCount: 0, tailAt: [] as string[], tailTruncated: false };
  const last = entries[entries.length - 1];
  if (!last) return none;
  const code = stallCodeOfEntry(last.action);
  if (code === null) return none;
  const reason = (stallReasonOfEntry(last.action) ?? "").trim();
  let count = 0;
  const at: string[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (stallCodeOfEntry(entry.action) !== code) break;
    if ((stallReasonOfEntry(entry.action) ?? "").trim() !== reason) break;
    count += 1;
    // Walk order is newest-first, so the retained array is exactly the prefix the reader would walk.
    if (at.length < LOG_RECENT_TAIL_ARRAY_CAP) at.push(entry.timestamp);
  }
  return {
    tailCode: code,
    tailReason: reason.length > LOG_RECENT_TAIL_REASON_MAX_CHARS
      ? reason.slice(0, LOG_RECENT_TAIL_REASON_MAX_CHARS)
      : reason,
    tailReasonTruncated: reason.length > LOG_RECENT_TAIL_REASON_MAX_CHARS,
    tailCount: count,
    tailAt: at,
    tailTruncated: count > LOG_RECENT_TAIL_ARRAY_CAP,
  };
}

/** `In-review stall surfaced [<code>]: <reason>` — the shape a surfaced stall is logged in. */
function stallCodeOfEntry(action: string): string | null {
  if (!action.startsWith(IN_REVIEW_STALL_LOG_PREFIX)) return null;
  const rest = action.slice(IN_REVIEW_STALL_LOG_PREFIX.length);
  const close = rest.indexOf("]");
  if (close <= 0) return null;
  return rest.slice(0, close);
}

function stallReasonOfEntry(action: string): string | null {
  const code = stallCodeOfEntry(action);
  if (code === null) return null;
  return action.slice(`${IN_REVIEW_STALL_LOG_PREFIX}${code}]:`.length);
}

/** The pure write-time derivation. Called from the column descriptors and from every log-writing UPDATE seam. */
export function deriveTaskLogProjections(log: unknown): TaskLogProjections {
  const entries = toDerivableEntries(log);
  // One shared `[timing]` arithmetic: the reader's exported function, never a second implementation.
  const timingTotalMs = computeTimedExecutionMs(entries as TaskLogEntry[]);

  let latestAt: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  let stallSurfacedAt: string | null = null;
  let stallSurfacedMs = Number.NEGATIVE_INFINITY;
  let unparseableCount = 0;
  const reenqueue: MatchCandidate[] = [];
  const invalidTransition: MatchCandidate[] = [];

  for (let ord = 0; ord < entries.length; ord += 1) {
    const entry = entries[ord]!;
    const tsMs = parseProjectionTimestamp(entry.timestamp);
    if (tsMs === null) {
      unparseableCount += 1;
      continue;
    }
    // Independent tests, exactly as the reader runs them: one entry can match both heuristics.
    if (entry.action.includes(STALLED_REVIEW_REENQUEUE_PATTERN)) {
      reenqueue.push({ ord, timestamp: entry.timestamp, tsMs });
    }
    if (
      STALLED_REVIEW_INVALID_TRANSITION_PATTERN.test(entry.action)
      || STALLED_REVIEW_INVALID_TRANSITION_PATTERN.test(entry.outcome)
    ) {
      invalidTransition.push({ ord, timestamp: entry.timestamp, tsMs });
    }
    if (tsMs > latestMs) {
      latestMs = tsMs;
      latestAt = entry.timestamp;
    }
    if (entry.action.startsWith(IN_REVIEW_STALL_LOG_PREFIX) && tsMs > stallSurfacedMs) {
      stallSurfacedMs = tsMs;
      stallSurfacedAt = entry.timestamp;
    }
  }

  const reenqueueRetained = retainNewestInArrayOrder(reenqueue, LOG_RECENT_MATCH_ARRAY_CAP);
  const invalidRetained = retainNewestInArrayOrder(invalidTransition, LOG_RECENT_MATCH_ARRAY_CAP);

  return {
    timingTotalMs,
    logRecent: {
      v: LOG_RECENT_SCHEMA_VERSION,
      latestAt,
      stallSurfacedAt,
      unparseableCount,
      reenqueueAt: reenqueueRetained.kept.map((c) => c.timestamp),
      reenqueueNewestDroppedAt: reenqueueRetained.newestDroppedAt,
      invalidTransitionAt: invalidRetained.kept.map((c) => c.timestamp),
      invalidTransitionNewestDroppedAt: invalidRetained.newestDroppedAt,
      ...deriveStallTail(entries),
    },
  };
}

/**
 * JSON string for the SQLite-shaped descriptor. Derived for ANY value the column can hold, including
 * `null` and a non-array, because the backfill derives the empty envelope for those rows too — a row
 * whose `log` is NULL still has to be answered from `log_recent` once the reader stops loading `log`.
 */
export function serializeTaskLogRecent(log: unknown): string {
  return JSON.stringify(deriveTaskLogProjections(log).logRecent);
}

/** Defensive read of the jsonb column: an unknown or future shape reads as absent, never as a partial truth. */
export function parseTaskLogRecent(value: unknown): TaskLogRecentEnvelope | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  if (raw.v !== LOG_RECENT_SCHEMA_VERSION) return null;
  const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    v: LOG_RECENT_SCHEMA_VERSION,
    latestAt: typeof raw.latestAt === "string" ? raw.latestAt : null,
    stallSurfacedAt: typeof raw.stallSurfacedAt === "string" ? raw.stallSurfacedAt : null,
    unparseableCount: typeof raw.unparseableCount === "number" ? raw.unparseableCount : 0,
    reenqueueAt: strArray(raw.reenqueueAt),
    reenqueueNewestDroppedAt: typeof raw.reenqueueNewestDroppedAt === "number" ? raw.reenqueueNewestDroppedAt : null,
    invalidTransitionAt: strArray(raw.invalidTransitionAt),
    invalidTransitionNewestDroppedAt: typeof raw.invalidTransitionNewestDroppedAt === "number" ? raw.invalidTransitionNewestDroppedAt : null,
    tailCode: typeof raw.tailCode === "string" ? raw.tailCode : null,
    tailReason: typeof raw.tailReason === "string" ? raw.tailReason : null,
    tailReasonTruncated: raw.tailReasonTruncated === true,
    tailCount: typeof raw.tailCount === "number" ? raw.tailCount : 0,
    tailAt: strArray(raw.tailAt),
    tailTruncated: raw.tailTruncated === true,
  };
}

/*
FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
THE WRITE PAIRING INVARIANT — no SQL statement may write `log` without also writing
`timing_total_ms` and `log_recent`. This is the single helper every targeted log-writing UPDATE seam
uses; the full-row path gets the same values from the column descriptors.
`__tests__/task-log-projection-pairing.test.ts` holds the seam list, because a raw
`tx.update(tasks).set({ log })` that skips this call silently drifts the projection, and a badge then
disagrees with the card it came from.
*/
export function withTaskLogProjections<T extends Record<string, unknown>>(updates: T): Record<string, unknown> {
  // `undefined` is how Drizzle spells "do not touch this column", so pairing must not fire for it —
  // writing a fresh envelope while leaving `log` alone is exactly the drift this invariant prevents.
  if (!("log" in updates) || updates.log === undefined) return updates;
  const derived = deriveTaskLogProjections(updates.log);
  return {
    ...updates,
    [TASK_TIMING_TOTAL_MS_COLUMN]: derived.timingTotalMs,
    [TASK_LOG_RECENT_COLUMN]: derived.logRecent,
    // FNXC:TaskLogSideTable 2026-11-01-17:40 (RUFU-312): this lane authored the envelope, so it stamps
    // its own authorship in the same statement. Never a caller-supplied value: the witness is only worth
    // anything while exactly two writers can set it, and each sets it last.
    [TASK_LOG_PROJECTION_AT_COLUMN]: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * THE ONE SUFFICIENCY DECISION (RUFU-636).
 *
 * FNXC:TaskLogProjections 2026-11-19-19:48 (RUFU-636):
 * RUFU-615 shipped four resolvers that each computed their own `provablyComplete` and ONE reader that
 * consulted none of them: `grep provablyComplete packages` resolved inside this file alone, so the
 * docstring promise "a reader whose window cannot be proved keeps the `log` column instead" described a
 * reader that does not exist, and a log-free board read answered not-stalled / 0 ms / an undercounted
 * `matchCount` from an envelope it never proved. The defect of THAT shape was not the answer, it was the
 * number of answers: four resolvers plus a gate deciding the same question in six places is how a badge
 * and a gate start disagreeing about one card. So the judgement is one function, called
 * {@link taskLogEnvelopeProves}, and every consumer — all four resolvers AND the read gate in
 * `reads.ts` — asks IT. A second sufficiency expression anywhere (in a resolver, in `reads.ts`, or in the
 * census) is the bug class this card exists to remove.
 *
 * What the verdict is NOT is a licence to answer. It says only what the ENVELOPE can prove. Whether a
 * log-free row may answer at all additionally requires the four ground-truth proofs over the side table
 * (see the gate's docblock in `reads.ts`), because the envelope has two authors and the rollup author
 * derives over the MERGED legacy+side view while storing a SIDE-row count — so the envelope can name
 * History lines `project.task_log_entries` never received.
 * ------------------------------------------------------------------ */

/**
 * The closed vocabulary of ways an envelope fails to prove what a full-History read would have answered.
 * Fixed strings: the census groups by them, and the gate names them in its one operator-visible warning,
 * so a new member must be added here first and never invented at a call site.
 */
export type TaskLogEnvelopeInsufficiency =
  /** Neither author authored anything: no rollup row and no legacy `log_recent` pair. */
  | "no-envelope"
  /** A `v` this module cannot name. Reachable ONLY through the rollup author — see the version rule below. */
  | "unknown-envelope-version"
  /** `unparseableCount > 0`: entries the shared parse rule rejected are invisible to every stored signal. */
  | "unparseable-entries"
  /** A match array was capped and the newest dropped match sits inside the window being asked about. */
  | "dropped-match-in-window"
  /** A stored MAX stamp (`latestAt` / `stallSurfacedAt`) fails the shared parse rule. */
  | "unparseable-latest";

export interface TaskLogEnvelopeSufficiency {
  /** True when NOTHING about this envelope is unprovable *for the question that was asked*. */
  proves: boolean;
  /** The headline reason in the fixed order below; `null` exactly when `proves`. */
  reason: TaskLogEnvelopeInsufficiency | null;
  /** Every applicable reason, in that same fixed order. What a narrower question is scoped against. */
  reasons: readonly TaskLogEnvelopeInsufficiency[];
}

/** Reasons that mean "derive NOTHING from this envelope", whatever is being derived. */
export const TASK_LOG_ENVELOPE_ANSWER_SUPPRESSING: readonly TaskLogEnvelopeInsufficiency[] = [
  "no-envelope",
  "unknown-envelope-version",
  "unparseable-entries",
];

/** What {@link stalledReviewFromProjection} may not answer through: the windowed match arithmetic. */
export const TASK_LOG_ENVELOPE_SCOPE_WINDOW_MATCH: readonly TaskLogEnvelopeInsufficiency[] = [
  ...TASK_LOG_ENVELOPE_ANSWER_SUPPRESSING,
  "dropped-match-in-window",
];

/** What the two MAX-stamp resolvers may not answer through. */
export const TASK_LOG_ENVELOPE_SCOPE_MAX_STAMPS: readonly TaskLogEnvelopeInsufficiency[] = [
  ...TASK_LOG_ENVELOPE_ANSWER_SUPPRESSING,
  "unparseable-latest",
];

/**
 * What {@link countIdenticalStallFromProjection} may not answer through. The trailing run's own facts
 * (`tailTruncated`, `tailReasonTruncated`, `tailCount`) are NOT here: they are properties of one stored
 * run rather than of the envelope's arithmetic, and the resolver combines them with this scope so the
 * version rule cannot be re-implemented beside them.
 */
export const TASK_LOG_ENVELOPE_SCOPE_TAIL_RUN: readonly TaskLogEnvelopeInsufficiency[] = TASK_LOG_ENVELOPE_ANSWER_SUPPRESSING;

/**
 * The version rule, in exactly one place, on purpose. `parseTaskLogRecent` (the LEGACY author) refuses an
 * unknown `v` by comparison, so a legacy envelope reaching a reader always carries `v === 1`;
 * `parseRollupEnvelope` (`task-log-entries.ts`, module-private) types ANY numeric `v` as an envelope, so
 * the rollup author is the only lane that can hand a reader arithmetic this module never authored. That
 * asymmetry is why the refusal lives here and in neither parser: `task-log-entries.ts` is not edited by
 * this card, and a reader-side rule duplicated into a parser would be two rules again.
 *
 * Consequence to keep honest: while `LOG_RECENT_SCHEMA_VERSION` stays 1, only a hand-authored or
 * future-shaped rollup can trip this. When the version IS bumped, `parseRollupEnvelope` still accepts it,
 * so this helper — not the parser — is what makes every reader refuse the envelope instead of deriving
 * from arithmetic it cannot name.
 */
export function taskLogEnvelopeProves(
  envelope: TaskLogRecentEnvelope | null | undefined,
  options: { windowStartMs: number | null },
): TaskLogEnvelopeSufficiency {
  const reasons: TaskLogEnvelopeInsufficiency[] = [];
  if (!envelope) {
    reasons.push("no-envelope");
  } else {
    if (envelope.v !== LOG_RECENT_SCHEMA_VERSION) reasons.push("unknown-envelope-version");
    if (envelope.unparseableCount > 0) reasons.push("unparseable-entries");
    /*
    * A cap is only a proven gap when the cut edge is inside the window being asked about: the markers name
    * the NEWEST dropped candidate, and every other dropped one is older, so a marker older than the window
    * start proves nothing in the window was lost. `windowStartMs: null` means the caller asks no windowed
    * question at all (the MAX-stamp and trailing-run resolvers) — and then a marker's coverage is UNKNOWN,
    * so it is still recorded as a fact while staying out of the headline: `sufficiencyProves` is what turns
    * "this verdict never asked about windows" into "the window question is NOT proven", which is the only
    * reading under which a resolver that skipped the window can neither be lied to nor silently ignored.
    */
    const windowStartMs = options.windowStartMs;
    const droppedMarkers = [envelope.reenqueueNewestDroppedAt, envelope.invalidTransitionNewestDroppedAt]
      .filter((ms): ms is number => typeof ms === "number");
    if (windowStartMs === null ? droppedMarkers.length > 0 : droppedMarkers.some((ms) => ms >= windowStartMs)) {
      reasons.push("dropped-match-in-window");
    }
    const stampUnparseable = (raw: string | null): boolean =>
      typeof raw === "string" && parseProjectionTimestamp(raw) === null;
    if (stampUnparseable(envelope.latestAt) || stampUnparseable(envelope.stallSurfacedAt)) {
      reasons.push("unparseable-latest");
    }
  }
  const asked = (reason: TaskLogEnvelopeInsufficiency): boolean =>
    options.windowStartMs !== null || reason !== "dropped-match-in-window";
  const headline = reasons.find(asked) ?? null;
  return { proves: headline === null, reason: headline, reasons };
}

/** Does this verdict leave `question`'s reasons untripped? The only legal way to consume a verdict. */
export function sufficiencyProves(
  verdict: TaskLogEnvelopeSufficiency,
  question: readonly TaskLogEnvelopeInsufficiency[],
): boolean {
  return !verdict.reasons.some((reason) => question.includes(reason));
}

/** True when the verdict carries `reason`. Used where one reason alone already means "answer nothing". */
export function sufficiencyHas(
  verdict: TaskLogEnvelopeSufficiency,
  reason: TaskLogEnvelopeInsufficiency,
): boolean {
  return verdict.reasons.includes(reason);
}

/* ------------------------------------------------------------------ *
 * THE FALLBACK'S OWN GROUND TRUTH (RUFU-636).
 *
 * FNXC:TaskLogProjections 2026-11-19-19:48 (RUFU-636):
 * An envelope that cannot prove its answer sends the read to `project.task_log_entries`, because that is
 * the table that holds History today. The side table is NOT automatically the truth though, and the reason
 * is RUFU-312's authoring split: `appendTaskLogEntries` derives the rollup over the MERGED legacy+side view
 * (`merged: mergeTaskLogViews(legacy ?? [], side, cap)`) while storing `entryCount: sideCount`, and
 * `catchUpLegacyTaskLogEntries` copies legacy lines only when stamped `>= backfilledAt`, for
 * `TASK_LOG_CATCH_UP_TASK_LIMIT = 200` tasks per pass. So an envelope can name an in-window History line
 * the side table never received. Reading such a window and ANSWERING produces a `matchCount` LOWER than today's envelope
 * answer — a repair that is worse than the defect. Hence four proofs, in this fixed order, every one of
 * them computed from data the read pass already holds (no extra statement), and every failure keeps today's
 * answer while naming its fixed reason in the site's single warning.
 *
 * These are pure so both the read gate in `reads.ts` and `scripts/census-log-recent-sufficiency.mjs` ask
 * the identical question against a real database.
 * ------------------------------------------------------------------ */

/** How many gated rows one board-read pass may re-fetch, whatever the page size. */
export const LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP = 16;

/**
 * How many side rows a single gated row may transfer. Strictly below `getTaskActivityLogEntryLimit()`
 * (1 000) on purpose: the horizon bound is what should make this unreachable, so a row that reaches it is
 * a card whose History is denser than the bound assumes, and the honest answer to "what is in your window"
 * from a window we ran out of room to read is "unknown", not a truncated count.
 */
export const LOG_RECENT_SUFFICIENCY_READ_ROW_CAP = 256;

/** Why a gated row's fallback was refused. Fixed vocabulary: the warning and the census group by it. */
export type TaskLogSufficiencyWithholdReason =
  | "side-history-absent"
  | "side-window-truncated"
  | "side-behind-author"
  | "side-missing-named-timestamp"
  | "over-row-cap";

/** Anything carrying a raw stamp. The proofs read the timestamp and NOTHING else. */
export interface TaskLogHistoryStamp {
  readonly timestamp?: string | null;
}

/** Either shape a History line arrives in: the stored entry object, or its bare stamp. */
export type TaskLogHistoryStamps = readonly (string | TaskLogHistoryStamp | null | undefined)[];

/** The raw stamps of a returned History window, in whatever shape the caller holds them in. */
export function rawTaskLogHistoryStamps(entries: TaskLogHistoryStamps): Set<string> {
  const present = new Set<string>();
  for (const entry of entries) {
    if (typeof entry === "string") present.add(entry);
    else if (typeof entry?.timestamp === "string") present.add(entry.timestamp);
  }
  return present;
}

/** The per-field vocabulary {@link withheldReasonsFor} reports, beside the envelope-level reasons. */
export type TaskLogSufficiencyFieldReason =
  | "stale-matches-reenqueueAt"
  | "stale-matches-invalidTransitionAt"
  | "stale-trailing-run-tailAt"
  | "stale-latest-surfaced-at";

/**
 * The instant a horizon-bounded History read must reach, as a DURATION, computed in ONE place from the
 * windows the served badges actually consult: the churn detector's `STALLED_REVIEW_WINDOW_MS` and the
 * operator-resolved `inReviewStalledThresholdMs`. A future derivation with a longer lookback has to
 * register here or it must not be served by the fallback — an unregistered longer window would silently
 * read a bound too short and undercount.
 *
 * FNXC:TaskLogProjections 2026-11-19-19:48 (RUFU-636): a non-finite or absent threshold is not "no
 * threshold": it means the caller resolved nothing, and the churn window alone still has to be covered.
 */
export function horizonFromServedWindows(inReviewStalledThresholdMs?: number | null): number {
  const resolved = typeof inReviewStalledThresholdMs === "number" && Number.isFinite(inReviewStalledThresholdMs)
    ? Math.max(0, inReviewStalledThresholdMs)
    : 0;
  return Math.max(STALLED_REVIEW_WINDOW_MS, resolved);
}

/**
 * The bound text for one gated row. `task_log_entries.timestamp` is `text`, so the table's ordering — and
 * `readTaskLogEntriesBatch`'s `>=` comparison — are lexicographic; the bound is therefore built in the
 * ISO shape the writer and migration 0093 use, never as an epoch number.
 */
export function taskLogHistoryReadBound(nowMs: number, horizonDurationMs: number): string {
  return new Date(nowMs - horizonDurationMs).toISOString();
}

/**
 * Proof 4 — `sideHoldsNamedTimestamps`. The returned window must contain EVERY timestamp the envelope
 * itself names for that row and that is still in play: all of `reenqueueAt`, `invalidTransitionAt` and
 * `tailAt`, plus `stallSurfacedAt` and `latestAt`. Membership is exact on RAW strings, which is sound
 * because the envelope stores stamps verbatim (see {@link TaskLogRecentEnvelope}) — parsing or reformatting
 * here would compare two different renderings of one stamp and prove nothing.
 *
 * A named stamp is required UNLESS it is provably older than both gates that would let it answer: it
 * PARSES before the horizon AND its raw text sorts below the bound the read used. The conjunction is what
 * makes the exemption honest, and its two halves are different measurements because the two gates disagree
 * about legacy rows — the horizon is a `parseProjectionTimestamp` (strict ISO) comparison while the SQL
 * bound is a text comparison, so a legacy non-ISO stamp that `Date.parse` still reads can sit inside the
 * window yet sort below the bound, and a bound that could never return a line the derivation would have
 * counted is exactly the silent undercount this proof exists to refuse.
 *
 * FNXC:TaskLogProjections 2026-11-20-16:55 (RUFU-636): the requirement was first written as the union
 * ("require when it parses in-horizon OR it sorts with the bound"), which is the same set except for one
 * shape, and that shape is a legacy row's: a stamp `parseProjectionTimestamp` refuses AND that sorts below
 * the bound is neither provably in play nor provably returned, so an OR read "nothing is required" and the
 * gate repaired a card whose History it had no way to reproduce — the undercount, wearing a green badge. A
 * stamp whose age cannot be established is not a stamp that cannot matter, so the exemption is a
 * conjunction and an unparseable named stamp always withholds.
 *
 * `tailAt` is required although no badge served at the gated sites reads it. Stated conservative bias: a
 * History that is missing a line its own author named is not a proved History, whatever is served today.
 */
export function sideHoldsNamedTimestamps(
  envelope: TaskLogRecentEnvelope | null | undefined,
  returned: TaskLogHistoryStamps,
  options: { bound: string | null; horizonMs: number },
): boolean {
  if (!envelope) return true;
  const present = rawTaskLogHistoryStamps(returned);
  const named: string[] = [
    ...envelope.reenqueueAt,
    ...envelope.invalidTransitionAt,
    ...envelope.tailAt,
  ];
  for (const single of [envelope.stallSurfacedAt, envelope.latestAt]) {
    if (typeof single === "string") named.push(single);
  }
  for (const stamp of named) {
    if (namedStampProvablyOutreach(stamp, options)) continue;
    if (!present.has(stamp)) return false;
  }
  return true;
}

/**
 * Whether a named stamp is provably beyond the reach of BOTH the horizon (so no served badge can consult
 * it) and the text-ordered read bound (so the read could not have returned it). Only a stamp that PARSES
 * can be proved old; see {@link sideHoldsNamedTimestamps} for why an unparseable one never is.
 */
function namedStampProvablyOutreach(
  stamp: string,
  options: { bound: string | null; horizonMs: number },
): boolean {
  const parsed = parseProjectionTimestamp(stamp);
  if (parsed === null) return false;
  if (parsed >= options.horizonMs) return false;
  return options.bound === null || stamp < options.bound;
}

/**
 * The four ground-truth proofs for one gated row, in their fixed order, returning the reason to withhold
 * or `null` when the row may answer from the returned History.
 *
 * Proof 3 is a newest-only comparison and is NOT sufficient on its own — that gap is why proof 4 exists
 * (see the section header above). Proof 3 compares raw text for the same reason the bound does; an
 * unparseable `latestAt` never reaches here as a doubt because `unparseable-latest` gates the row first,
 * and it is refused rather than trusted if it somehow does.
 */
export function withholdReasonForGatedRow(input: {
  envelope: TaskLogRecentEnvelope | null | undefined;
  entries: readonly TaskLogHistoryStamp[];
  readCap: number;
  bound: string;
  horizonMs: number;
}): TaskLogSufficiencyWithholdReason | null {
  const { envelope, entries, readCap, bound, horizonMs } = input;
  if (entries.length === 0) return "side-history-absent";
  if (entries.length >= readCap) return "side-window-truncated";
  if (typeof envelope?.latestAt === "string") {
    let newest: string | null = null;
    for (const entry of entries) {
      const raw = entry.timestamp;
      if (typeof raw !== "string") continue;
      if (newest === null || raw > newest) newest = raw;
    }
    if (newest === null || newest < envelope.latestAt) return "side-behind-author";
  }
  if (!sideHoldsNamedTimestamps(envelope, entries, { bound, horizonMs })) return "side-missing-named-timestamp";
  return null;
}

/**
 * What an envelope is reaching for that a fallback could not prove: the five envelope-level reasons from
 * the one sufficiency decision, followed per field by the named in-horizon lines the envelope carries.
 *
 * The defaults are deliberately conservative — window start 0, horizon 0, nothing proved present — which
 * reads as "every line this envelope names is at risk". That is the census's field test: it has to answer
 * which rows the fallback COULD repair before any read has run. A caller that has read the side table
 * passes `present` (the raw stamps that came back) and the same horizon/bound it read with, and the
 * per-field half then names only the lines actually proved absent, which is the same arithmetic as proof 4.
 *
 * There is no `stale-latest-at`: `latestAt`'s presence is what proof 3 already refuses a window over, so a
 * separate code for it would be two names for one fact. It is still *required* by proof 4.
 */
export function withheldReasonsFor(
  envelope: TaskLogRecentEnvelope | null | undefined,
  options: {
    windowStartMs?: number | null;
    horizonMs?: number;
    bound?: string | null;
    present?: ReadonlySet<string>;
  } = {},
): Array<TaskLogEnvelopeInsufficiency | TaskLogSufficiencyFieldReason> {
  const windowStartMs = options.windowStartMs ?? 0;
  const horizonMs = options.horizonMs ?? 0;
  const bound = options.bound ?? null;
  const present = options.present ?? new Set<string>();
  const verdict = taskLogEnvelopeProves(envelope, { windowStartMs });
  const reasons: Array<TaskLogEnvelopeInsufficiency | TaskLogSufficiencyFieldReason> = [...verdict.reasons];
  if (!envelope) return reasons;
  const atRisk = (stamp: string): boolean =>
    !namedStampProvablyOutreach(stamp, { bound, horizonMs }) && !present.has(stamp);
  const fieldReasons: Array<[readonly string[], TaskLogSufficiencyFieldReason]> = [
    [envelope.reenqueueAt, "stale-matches-reenqueueAt"],
    [envelope.invalidTransitionAt, "stale-matches-invalidTransitionAt"],
    [envelope.tailAt, "stale-trailing-run-tailAt"],
  ];
  for (const [stamps, reason] of fieldReasons) {
    if (stamps.some(atRisk) && !reasons.includes(reason)) reasons.push(reason);
  }
  if (typeof envelope.stallSurfacedAt === "string" && atRisk(envelope.stallSurfacedAt)) {
    reasons.push("stale-latest-surfaced-at");
  }
  return reasons;
}

/**
 * Spend this pass's budget. Rows the envelope was authored for come first, because a row with no envelope
 * at all has no named lines to repair against and is the population the side table is LEAST likely to be
 * able to answer; within each class the page order is preserved so the choice never depends on a hash.
 * The over-cap remainder keeps today's answer — it is not a failure, it is the population the single
 * warning must name.
 *
 * FNXC:TaskLogProjections 2026-11-20-21:33 (RUFU-636): the budget is deliberately PER PASS and holds no
 * memory of a previous refusal. A standing withhold would be a 15-minute delay on the exact card the next
 * pass could repair — `catchUpLegacyTaskLogEntries` runs periodically and delivers the line a proof named
 * missing — while `LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP` already bounds what a sustained refusal can cost.
 * A rule the shipped pass does not apply is worse than no rule, so no cooldown state exists here.
 */
export function pickSufficiencyGateRows(input: {
  candidates: readonly string[];
  hasEnvelope: ReadonlyMap<string, boolean>;
  cap?: number;
}): { selected: string[]; overCap: string[] } {
  const cap = input.cap ?? LOG_RECENT_SUFFICIENCY_GATE_ROW_CAP;
  const selected: string[] = [];
  const overCap: string[] = [];
  const ordered = [...input.candidates].sort((a, b) => {
    const left = input.hasEnvelope.get(a) ? 0 : 1;
    const right = input.hasEnvelope.get(b) ? 0 : 1;
    return left - right;
  });
  for (const id of ordered) {
    if (selected.length >= cap) {
      overCap.push(id);
      continue;
    }
    selected.push(id);
  }
  return { selected, overCap };
}

/* ------------------------------------------------------------------ *
 * Reader-side resolvers. Each one answers "can this envelope PROVE the answer a full-log read would
 * have produced?" through `provablyComplete`, scoped out of the ONE verdict above (RUFU-636). What a
 * caller CANNOT do is re-read the `log` column per row, because a log-free caller did not select it:
 * the fallback is ONE horizon-bounded batch read of `project.task_log_entries` taken at the two
 * log-free derivation sites in `reads.ts`, and it answers only when its own four ground-truth proofs
 * hold. Where the flag is false and a fallback is impossible, the reader keeps the answer below and
 * says so through that site's single warning — it never answers "no History" from an unproved window.
 * ------------------------------------------------------------------ */

/** What the envelope may stand in for. `logLoaded` stays the caller's authority, defaulting to true. */
export interface TaskLogProjectionInput {
  /** The row carried the `log` column — the log-based path wins and stays byte-identical to today. */
  logLoaded?: boolean;
  projection?: TaskLogRecentEnvelope | null;
}

/** Opt-in by construction: absent input or a loaded log means today's code path, so no existing caller changes. */
export function projectionOverride(input: TaskLogProjectionInput | undefined): TaskLogRecentEnvelope | null {
  if (input?.logLoaded !== false) return null;
  return input.projection ?? null;
}

export interface StalledReviewProjectionResult {
  signal: Omit<StalledReviewSignal, "reason"> | undefined;
  /**
   * False when the envelope cannot prove the window's contents. That is a statement about the ENVELOPE, and
   * it licenses an answer from a proved History only: the row's own loaded `log`, or a fallback window whose
   * four ground-truth proofs held (RUFU-636). Where neither exists the caller keeps the signal below and
   * says so through its one warning — it never answers "no History" from an unproved window.
   */
  provablyComplete: boolean;
}

/**
 * Windowed `detectStalledReview` arithmetic over the stored match timestamps. Both patterns and both
 * thresholds are the detector's own; the envelope only records WHICH entries matched, because only
 * the writer ever sees an uncapped `outcome`.
 */
export function stalledReviewFromProjection(
  envelope: TaskLogRecentEnvelope,
  options: { now?: number; windowMs?: number },
): StalledReviewProjectionResult {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? STALLED_REVIEW_WINDOW_MS;
  const windowStart = now - windowMs;
  /*
  FNXC:TaskLogProjections 2026-11-19-19:48 (RUFU-636): the window arithmetic is unchanged; what changed is
  WHO decides sufficiency. An envelope whose version cannot be named is now refused exactly like one with
  unparseable entries (it was derived by arithmetic this module never authored), while a cap-drop marker
  still answers with the stored matches and says `provablyComplete: false` — that undercount is precisely
  the answer the read gate falls back to when its own four proofs fail, so suppressing it here would turn
  a conservative badge into a missing one.
  */
  const verdict = taskLogEnvelopeProves(envelope, { windowStartMs: windowStart });
  if (!sufficiencyProves(verdict, TASK_LOG_ENVELOPE_ANSWER_SUPPRESSING)) {
    return { signal: undefined, provablyComplete: false };
  }
  const indicesInWindow = (list: string[]): number[] => {
    const out: number[] = [];
    for (let i = 0; i < list.length; i += 1) {
      const ms = parseProjectionTimestamp(list[i]);
      if (ms !== null && ms >= windowStart && ms <= now) out.push(i);
    }
    return out;
  };
  const reenqueueHits = indicesInWindow(envelope.reenqueueAt);
  const invalidHits = indicesInWindow(envelope.invalidTransitionAt);
  const provablyComplete = sufficiencyProves(verdict, TASK_LOG_ENVELOPE_SCOPE_WINDOW_MATCH);

  if (reenqueueHits.length >= STALLED_REVIEW_REENQUEUE_THRESHOLD) {
    return {
      provablyComplete,
      signal: {
        heuristic: "reenqueue-churn",
        matchCount: reenqueueHits.length,
        firstMatchAt: envelope.reenqueueAt[reenqueueHits[0]!] ?? "",
        lastMatchAt: envelope.reenqueueAt[reenqueueHits[reenqueueHits.length - 1]!] ?? "",
      },
    };
  }
  if (invalidHits.length >= STALLED_REVIEW_INVALID_TRANSITION_THRESHOLD) {
    return {
      provablyComplete,
      signal: {
        heuristic: "invalid-transition-loop",
        matchCount: invalidHits.length,
        firstMatchAt: envelope.invalidTransitionAt[invalidHits[0]!] ?? "",
        lastMatchAt: envelope.invalidTransitionAt[invalidHits[invalidHits.length - 1]!] ?? "",
      },
    };
  }
  return { signal: undefined, provablyComplete };
}

/** MAX-over-whole-log timestamp; `-Infinity` mirrors the log-based helper's "no candidate" answer. */
export function latestLogTimestampFromProjection(envelope: TaskLogRecentEnvelope): { ms: number; provablyComplete: boolean } {
  // FNXC:TaskLogProjections 2026-11-19-19:48 (RUFU-636): one verdict, scoped to THIS question; the
  // returned `-Infinity` answers are byte-identical to RUFU-615's, only their authority moved.
  const verdict = taskLogEnvelopeProves(envelope, { windowStartMs: null });
  if (!sufficiencyProves(verdict, TASK_LOG_ENVELOPE_ANSWER_SUPPRESSING)) {
    return { ms: Number.NEGATIVE_INFINITY, provablyComplete: false };
  }
  if (envelope.latestAt === null) return { ms: Number.NEGATIVE_INFINITY, provablyComplete: true };
  const ms = parseProjectionTimestamp(envelope.latestAt);
  return { ms: ms ?? Number.NEGATIVE_INFINITY, provablyComplete: sufficiencyProves(verdict, TASK_LOG_ENVELOPE_SCOPE_MAX_STAMPS) };
}

/** MAX ts over the stall prefix; the caller applies the LIVE threshold — a setting is never baked into the column. */
export function stallSurfacedAtFromProjection(envelope: TaskLogRecentEnvelope): { ms: number | null; provablyComplete: boolean } {
  // FNXC:TaskLogProjections 2026-11-19-19:48 (RUFU-636): see `latestLogTimestampFromProjection`.
  const verdict = taskLogEnvelopeProves(envelope, { windowStartMs: null });
  if (!sufficiencyProves(verdict, TASK_LOG_ENVELOPE_ANSWER_SUPPRESSING)) {
    return { ms: null, provablyComplete: false };
  }
  if (envelope.stallSurfacedAt === null) return { ms: null, provablyComplete: true };
  const ms = parseProjectionTimestamp(envelope.stallSurfacedAt);
  return { ms, provablyComplete: sufficiencyProves(verdict, TASK_LOG_ENVELOPE_SCOPE_MAX_STAMPS) };
}

export interface IdenticalStallProjectionResult {
  count: number;
  /** False when the stored run identity cannot be proved equal to (or different from) the live signal. */
  provablyComplete: boolean;
}

/**
 * Trailing-run answer. `signal` is the LIVE stall signal the caller just computed; the run was keyed on
 * the newest trailing stall entry's own identity, so an identity test is the whole decision.
 */
export function countIdenticalStallFromProjection(
  envelope: TaskLogRecentEnvelope,
  signal: Pick<InReviewStallSignal, "code" | "reason">,
  progressAt?: number,
): IdenticalStallProjectionResult {
  const trimmedReason = signal.reason.trim();
  // FNXC:TaskLogProjections 2026-11-19-19:48 (RUFU-636): the trailing run is not a windowed question, so
  // no cap marker is asked about; the envelope-level refusal is the tail-run scope, and the run's own
  // facts stay in the return below, where RUFU-615 put them.
  const verdict = taskLogEnvelopeProves(envelope, { windowStartMs: null });
  if (envelope.tailCode === null || envelope.tailCount === 0) return { count: 0, provablyComplete: true };
  if (envelope.tailCode !== signal.code) return { count: 0, provablyComplete: true };
  if (envelope.tailReasonTruncated) {
    // A clipped reason cannot prove equality; it can still disprove it when the live reason diverges.
    if (!trimmedReason.startsWith(envelope.tailReason ?? "")) return { count: 0, provablyComplete: true };
    return { count: 0, provablyComplete: false };
  }
  if ((envelope.tailReason ?? "") !== trimmedReason) return { count: 0, provablyComplete: true };
  let count = 0;
  for (const ts of envelope.tailAt) {
    const observedAt = parseProjectionTimestamp(ts);
    if (progressAt !== undefined && observedAt !== null && progressAt > observedAt) break;
    count += 1;
  }
  return {
    count,
    provablyComplete: !envelope.tailTruncated
      && count === envelope.tailCount
      && sufficiencyProves(verdict, TASK_LOG_ENVELOPE_SCOPE_TAIL_RUN),
  };
}

export function stallReasonOfTaskLogEntry(action: string): string | null {
  return stallReasonOfEntry(action);
}

export function stallCodeOfTaskLogEntry(action: string): InReviewStallCode | null {
  return stallCodeOfEntry(action) as InReviewStallCode | null;
}
