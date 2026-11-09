import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { AgentLogDetailSpill, AgentLogEntry } from "../types.js";
import {
  AGENT_LOG_FILENAME,
  buildAgentLogSourceRef,
} from "./agent-log-constants.js";
import {
  agentLogSpillDigestFromFileName,
  agentLogSpillReferrerLog,
  agentLogTaskProducerDir,
  isAgentLogSpillBodyFileName,
  isAgentLogSpillDigest,
  isAgentLogSpillPartialFileName,
  listAgentLogSpillProducerDirs,
  resolveAgentLogDetailsForRead,
  spillAgentLogDetail,
} from "./agent-log-detail-spill.js";
import { createLogger } from "../process/logger.js";

const log = createLogger("agent-log-file-store");

export interface StoredAgentLogEntry extends AgentLogEntry {
  lineNo: number;
  sourceRef: string;
}

export interface AgentLogFileStoreReadOptions {
  limit?: number;
  offset?: number;
  type?: AgentLogEntry["type"];
  startTime?: string;
  endTime?: string | null;
}

export interface AgentLogFileAppendInput {
  timestamp: string;
  taskId: string;
  text: string;
  type: AgentLogEntry["type"];
  detail?: string | null;
  /**
   * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
   * The out-of-line pointer must exist on the APPEND input as well as on the row type: adding it to only one
   * of the two silently drops it at the serialize boundary, so the row would carry a prefix that names no
   * body and the spilled bytes would be unreachable.
   */
  detailSpill?: AgentLogDetailSpill;
  agent?: AgentLogEntry["agent"] | null;
  durationMs?: number | null;
  timeToFirstTokenMs?: number | null;
}

interface AgentLogJsonlRow {
  timestamp: string;
  taskId: string;
  text: string;
  type: AgentLogEntry["type"];
  detail?: string;
  /** Persisted pointer shape (RUFU-340). The resolved body is never a persisted field. */
  detailSpill?: AgentLogDetailSpill;
  agent?: AgentLogEntry["agent"];
  durationMs?: number;
  timeToFirstTokenMs?: number;
}

export function getAgentLogFilePath(taskDir: string): string {
  return join(taskDir, AGENT_LOG_FILENAME);
}

export function appendAgentLogEntriesSync(
  taskDir: string,
  entries: AgentLogFileAppendInput[],
): StoredAgentLogEntry[] {
  if (entries.length === 0) return [];

  /*
   * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
   * The spill seam runs HERE, at the sole task-log append writer's entry, before serialization — not inside
   * `serializeEntry`. That placement is load-bearing: the rows returned below are the very objects
   * `appendAgentLogBatchImpl` emits `agent:log` from, so resolving during serialization would hand the
   * emitted frame a full body while disk held prefix+pointer (the same defect, inverted), while resolving
   * here makes emitted-equals-persisted true by construction. The returned rows therefore keep
   * prefix+pointer as well; only a read surface resolves.
   */
  const resolvedEntries = entries.map((entry) => {
    const { detail, spill } = spillAgentLogDetail(
      { detail: entry.detail, type: entry.type, ...(entry.detailSpill && { detailSpill: entry.detailSpill }) },
      agentLogTaskProducerDir(taskDir, entry.taskId),
    );
    return {
      ...entry,
      ...(detail !== undefined && { detail }),
      ...(spill !== undefined && { detailSpill: spill }),
    };
  });

  const filePath = getAgentLogFilePath(taskDir);
  mkdirSync(dirname(filePath), { recursive: true });
  /*
   * FNXC:AgentLogging 2026-09-05-22:05:
   * FN-9263 requires an interrupted JSONL write to cost at most the interrupted entry. Prefix the next
   * append with a boundary newline when its existing tail is unterminated so returned line numbers stay
   * aligned with physical lines. This read-then-append tail check is intentionally not atomic across writers.
   */
  const { lineCount: startingLineNo, endsWithNewline } = inspectAgentLogTail(filePath);
  const payload = `${startingLineNo > 0 && !endsWithNewline ? "\n" : ""}${resolvedEntries
    .map((entry) => serializeEntry(entry))
    .join("")}`;
  appendFileSync(filePath, payload, "utf8");
  /*
   * FNXC:AgentLogAppendPerf 2026-11-04-23:34:
   * The advance runs only after a successful write, so a throwing `appendFileSync` leaves the cached newline
   * total untouched. It is the sole code that keeps the next append fence-warm; see the invariant note above
   * `AGENT_LOG_TAIL_WINDOW_BYTES` for why it moves a raw newline total and never a line count.
   */
  advanceNewlineTotalAfterAppend(filePath, payload);

  return resolvedEntries.map((entry, index) => materializeEntry(entry, startingLineNo + index + 1));
}

export function readAgentLogEntries(
  taskDir: string,
  options: AgentLogFileStoreReadOptions = {},
): StoredAgentLogEntry[] {
  const entries = readAllAgentLogEntries(taskDir, options);
  const offset = Math.max(0, options.offset ?? 0);
  let window: StoredAgentLogEntry[];
  if (options.limit == null) {
    window = offset === 0 ? entries : entries.slice(0, Math.max(0, entries.length - offset));
  } else {
    const limit = Math.max(0, options.limit);
    const endExclusive = Math.max(0, entries.length - offset);
    const startInclusive = Math.max(0, endExclusive - limit);
    window = entries.slice(startInclusive, endExclusive);
  }
  /*
   * FNXC:AgentLogDetailSpill 2026-11-06-03:02 (RUFU-340):
   * Resolution runs AFTER pagination, never inside `readAllAgentLogEntries`. This route serves one page of a
   * card's log to `getAgentLogsImpl`, the dashboard Raw Logs view, and the task log stream; resolving before
   * the slice would read and materialise EVERY spilled body in the file to answer a 50-row request — the
   * whole-file read cost class RUFU-208 exists to police, reintroduced on a hot read surface. A limited page
   * therefore resolves the rows it returns, which is the same ordering `getRunLogs` already uses for run logs.
   */
  return resolveAgentLogDetailsForRead(window);
}

export function countAgentLogEntries(
  taskDir: string,
  options: Omit<AgentLogFileStoreReadOptions, "limit" | "offset"> = {},
): number {
  /*
   * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
   * A count never returns a `detail`, and `readAllAgentLogEntries` no longer resolves at all, so counting costs
   * one parse of the rows and zero spill-body reads.
   */
  return readAllAgentLogEntries(taskDir, options).length;
}

export function readAgentLogEntriesByTimeRange(
  taskDir: string,
  startTime: string,
  endTime: string | null,
  options: Omit<AgentLogFileStoreReadOptions, "startTime" | "endTime"> = {},
): StoredAgentLogEntry[] {
  // Same bound as `readAgentLogEntries`: only the rows this surface actually returns are resolved.
  return resolveAgentLogDetailsForRead(readAllAgentLogEntries(taskDir, {
    ...options,
    startTime,
    endTime,
  }));
}

function readAllAgentLogEntries(
  taskDir: string,
  options: Omit<AgentLogFileStoreReadOptions, "limit" | "offset"> = {},
): StoredAgentLogEntry[] {
  const filePath = getAgentLogFilePath(taskDir);
  if (!existsSync(filePath)) {
    return [];
  }

  const content = readFileSync(filePath, "utf8");
  if (content.length === 0) {
    return [];
  }

  const lines = content.split("\n");
  const entries: StoredAgentLogEntry[] = [];
  const skippedLines: Array<{ lineNo: number; message: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (!rawLine) continue;
    const lineNo = index + 1;
    try {
      const parsed = JSON.parse(rawLine) as Partial<AgentLogJsonlRow>;
      if (
        typeof parsed.timestamp !== "string"
        || typeof parsed.taskId !== "string"
        || typeof parsed.text !== "string"
        || typeof parsed.type !== "string"
      ) {
        throw new Error("missing required agent-log fields");
      }
      const entry = materializeEntry(parsed as AgentLogFileAppendInput, lineNo);
      if (options.type != null && entry.type !== options.type) {
        continue;
      }
      if (options.startTime != null && entry.timestamp < options.startTime) {
        continue;
      }
      if (options.endTime != null && entry.timestamp > options.endTime) {
        continue;
      }
      entries.push(entry);
    } catch (error) {
      skippedLines.push({
        lineNo,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const firstSkipped = skippedLines[0];
  if (firstSkipped) {
    log.warn(
      `Skipped ${skippedLines.length} malformed JSONL line(s) in ${filePath}; first line ${firstSkipped.lineNo}: ${firstSkipped.message}`,
    );
  }

  /*
   * FNXC:AgentLogDetailSpill 2026-11-06-03:02 (RUFU-340):
   * This reader deliberately returns rows that are NOT body-resolved: it parses the whole file to answer a
   * filtered/paged request, and a spill body may only be read for a row that is actually being returned (see
   * `readAgentLogEntries`). It remains the only route that parses the file and it stays append-free (see
   * `docs/solutions/logic-errors/agent-log-read-route-is-append-free.md`). Resolution belongs in neither this
   * function nor `materializeEntry`, because the latter also builds the rows the append writer returns and
   * emits — a resolve there would put the full body on a frame while disk held prefix+pointer. A legacy
   * oversized row with no pointer is returned exactly as stored, marker invented or not: the VIEW clamps, the
   * reader does not.
   */
  return entries;
}

function normalizeTimingMs(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round(value);
}

/*
 * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
 * Both helpers below are pure (de)serializers: they neither truncate, nor redact, nor hash, nor touch the
 * filesystem. Truncation used to live in exactly these two functions — which is why the loss happened twice,
 * once into the row and again into every read of a legacy oversized row. Sizing is the seam's job
 * (`appendAgentLogEntriesSync` resolves before either runs); keeping these pure is what lets an emitted
 * frame and a persisted row be the same bytes.
 */
function serializeEntry(entry: AgentLogFileAppendInput): string {
  const durationMs = normalizeTimingMs(entry.durationMs);
  const timeToFirstTokenMs = normalizeTimingMs(entry.timeToFirstTokenMs);
  const row: AgentLogJsonlRow = {
    timestamp: entry.timestamp,
    taskId: entry.taskId,
    text: entry.text,
    type: entry.type,
    ...(entry.detail !== undefined && entry.detail !== null && { detail: entry.detail }),
    ...(entry.detailSpill !== undefined && { detailSpill: entry.detailSpill }),
    ...(entry.agent != null && { agent: entry.agent }),
    ...(durationMs !== undefined && { durationMs }),
    ...(timeToFirstTokenMs !== undefined && { timeToFirstTokenMs }),
  };
  return `${JSON.stringify(row)}\n`;
}

function materializeEntry(entry: AgentLogFileAppendInput, lineNo: number): StoredAgentLogEntry {
  const durationMs = normalizeTimingMs(entry.durationMs);
  const timeToFirstTokenMs = normalizeTimingMs(entry.timeToFirstTokenMs);
  return {
    timestamp: entry.timestamp,
    taskId: entry.taskId,
    text: entry.text,
    type: entry.type,
    ...(entry.detail !== undefined && entry.detail !== null && { detail: entry.detail }),
    ...(entry.detailSpill !== undefined && { detailSpill: entry.detailSpill }),
    ...(entry.agent != null && { agent: entry.agent }),
    ...(durationMs !== undefined && { durationMs }),
    ...(timeToFirstTokenMs !== undefined && { timeToFirstTokenMs }),
    lineNo,
    sourceRef: buildAgentLogSourceRef(entry.taskId, lineNo),
  };
}

/*
FNXC:AgentLogAppendPerf 2026-11-04-23:34:
RUFU-208. Measured field evidence (v0.78.0-beta.4, 2026-09-09): `inspectAgentLogTail` held 17.3 % self time in
one 15 s production dashboard CPU profile — the second-biggest frame in that window — and 0.1 % in an 18 s
profile taken ten minutes later. The variance is the shape of the defect: a burst cost that scales with
whatever agent-log file happens to be large, not steady-state load. The cause was one whole-file
`readFileSync(path, "utf8")` plus a `split("\n")` per append: a ~14k-line / ~10 MB log allocated ~10 MB of
string plus a 14 060-element array just to answer "how many lines" and "is the last byte a newline", on the
main thread.

INVARIANT — an append costs O(tail), never O(file). Steady state reads at most `AGENT_LOG_TAIL_WINDOW_BYTES`
per append and never calls `readFileSync` from this path. Do not go back to a whole-file read here. The
whole-content readers that intentionally stay are `readAllAgentLogEntries` (a read must parse every row to
serve the dashboard log views and the agent-activity API) and `pruneAgentLogFiles` (a prune must rewrite every
kept row). Neither shares the *tail* need, and both were enumerated rather than opportunistically rewritten.

Exactness, not approximation: the returned `lineCount` becomes the `lineNo` / `sourceRef`
(`agentLog:{taskId}:{lineNo}` from `buildAgentLogSourceRef`) that `migrateAgentLogEntriesImpl` persists into
goal citations and deduplicates on, while `readAllAgentLogEntries` re-derives the same number from the physical
line index. A near-miss count would desynchronize writer-stamped from reader-derived numbers and collide
distinct citation identities. So the newline answer is bounded but exact, and the line answer is exact or
recomputed — never estimated.

Closed derivation table — the entire contract, and the two marked rows are the whole off-by-one class:
  missing file                    -> lineCount 0, endsWithNewline true
  size 0                          -> lineCount 0, endsWithNewline true (NOT 1: there is no last byte to read,
                                     and `newlines + (endsWithNewline ? 0 : 1)` would answer 1 here)
  "\n"                            -> newlines 1, terminated     -> lineCount 1
  "a\nb\n" (terminated rows)      -> newlines 2, terminated     -> lineCount 2
  "a\n\n" (empty last row)        -> newlines 2, terminated     -> lineCount 2
  "a\nb"  (unterminated row)      -> newlines 1, unterminated   -> lineCount 2  == newlines + 1
  '{"timestamp":…' (truncated)    -> newlines 0, unterminated   -> lineCount 1  == newlines + 1, and that 1 is
                                     what makes `startingLineNo > 0 && !endsWithNewline` true so FN-9263's
                                     boundary newline is actually inserted
  one line longer than the window, terminated   -> lineCount 1
  one line longer than the window, unterminated -> lineCount 1, and the WINDOW's newline count is not the
                                     total: a cold cache must stream the whole file
A bare newline sum answers one unit too low for every file whose last byte is not 0x0A — exactly the "no
trailing newline" and "last line mid-write" states — and collapses the separator rule to false. `deriveLineCount`
below is the ONLY place a newline quantity becomes a line count; the window path, the cold recompute and the
post-append advance all route through it. `agent-log-file-store.test.ts` ("separates an append after a complete
JSON row without a trailing newline", "adds one separator after a truncated tail across consecutive appends",
"starts missing and empty logs at line one…") is the behavioral pin.

Why bytes and never `toString("utf8")` for counting: a UTF-8 continuation byte is always >= 0x80, so a 0x0A byte
is necessarily a real newline. Byte counting is therefore immune to a multibyte character straddling the window
boundary, and CRLF keeps the pre-existing count because `split("\n")` also counted the 0x0A of every pair.

Cache = the authoritative raw newline TOTAL per resolved path; entries hold `{ dev, ino, size, newlineCount }`
and never file content. An entry is trusted only while `fstatSync` agrees on all three of device, inode and byte
size — any mismatch means truncation, rewrite, replacement or a foreign append, and the total is then recomputed
exactly from bytes. That fence is what makes the bypassing writers safe: `pruneAgentLogFiles` changes size or
inode (tmp + rename) or unlinks the log outright, and the store test helpers append JSONL with raw
`appendFileSync`. `ENOENT` DELETES the entry so a file later created at a recycled inode can never inherit a
stale total. Residency is capped at `AGENT_LOG_TAIL_CACHE_CAPACITY` with oldest-inserted eviction; entries are
four numbers, so the bound costs no meaningful memory — what it bounds is how many distinct task logs one
long-lived dashboard process tracks before a recompute, and eviction is loss-free because an evicted path
recomputes exactly on its next append. Residual accepted risk: a writer that changed the newline count while
leaving device, inode AND size byte-identical would go unnoticed, and no path in this repository can do that.

The capacity is mirrored by `agent-log-file-store.tail-window.test.ts`, which derives its residency fixtures
from that mirror; change one and change the other.

The post-append advance is the only code keeping the warm path warm, so it must stay byte-exact:
`newlineCount += <0x0A bytes in the payload>` and `size += <utf-8 bytes of the payload>`, never a line-count
delta — the boundary separator byte terminates an existing line rather than creating one, so a line-count delta
over-counts on precisely the unterminated-tail state. A miscounted `size` is not a numbering bug but a silent
cost bug: the fence would disagree on every following append and the file would be streamed again, visible only
through the recorded-bytes bound in the tail-window test.

Rejected alternative: the durable per-task sidecar the report offered. It adds a second artifact per task with
its own invalidation surface (the prune unlink / tmp+rename arms, raw helper appends, and task-directory
copy/restore or forensic re-import would each pair a log with the wrong sidecar or none), doubles write syscalls,
and buys nothing against the reported cost, which is burst load inside one long-lived dashboard process where an
in-process cache stays warm. If field evidence later shows a cold recompute is still visible, the sidecar is the
approved next step on this same fence, filed as its own task.

Retained from FN-9263: the read-then-append sequence is still intentionally not atomic across writers.
*/
const AGENT_LOG_TAIL_WINDOW_BYTES = 64 * 1024;

/** Chunk size for the memory-bounded cold recompute; the pass never builds the file string. */
const AGENT_LOG_NEWLINE_SCAN_CHUNK_BYTES = 64 * 1024;

/** Max distinct task logs whose newline totals are tracked. Mirrored in the tail-window test. */
const AGENT_LOG_NEWLINE_TOTAL_CAPACITY = 128;

const NEWLINE_BYTE = 0x0a;

interface AgentLogNewlineTotal {
  dev: number;
  ino: number;
  size: number;
  newlineCount: number;
}

/**
 * Per resolved-path authoritative raw newline totals. `Map` insertion order is residency order, so the first
 * key is always the oldest tracked path and is what eviction drops.
 */
const newlineTotals = new Map<string, AgentLogNewlineTotal>();

/**
 * The ONE derivation that turns a newline quantity into a line count, mirroring the pre-RUFU-208
 * `lines.at(-1) === "" ? lines.length - 1 : lines.length` over `split("\n")` byte for byte.
 *
 * An unterminated final byte means the last line has no terminator yet and must still be counted
 * (`newlineCount + 1`), while a zero-byte file has no line at all — the mirror trap, because the same
 * expression would answer 1 there.
 */
function deriveLineCount(size: number, newlineCount: number, endsWithNewline: boolean): number {
  if (size === 0) return 0;
  return newlineCount + (endsWithNewline ? 0 : 1);
}

/** Count 0x0A bytes in `buffer[start..end)`. Byte-level, so multibyte content cannot shift the total. */
function countNewlineBytes(buffer: Buffer, start: number, end: number): number {
  let count = 0;
  for (let index = start; index < end; index += 1) {
    if (buffer[index] === NEWLINE_BYTE) count += 1;
  }
  return count;
}

/**
 * Count the 0x0A bytes `text` will occupy once written as UTF-8, without encoding it.
 *
 * Every UTF-8 multi-byte sequence has all bytes >= 0x80 and Node replaces a lone surrogate with U+FFFD (three
 * bytes, all >= 0x80), so a 0x0A byte exists if and only if the string carries a "\n" code unit. The byte size
 * still comes from `Buffer.byteLength`, which counts surrogate pairs and replacements correctly.
 */
function countNewlineBytesInText(text: string): number {
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
}

/** Read into `buffer` from `start`, looping on short reads; returns the number of bytes actually filled. */
function readBufferAt(fd: number, buffer: Buffer, start: number): number {
  let filled = 0;
  while (filled < buffer.length) {
    const bytesRead = readSync(fd, buffer, filled, buffer.length - filled, start + filled);
    if (bytesRead <= 0) break;
    filled += bytesRead;
  }
  return filled;
}

/** Stream `0x0A` bytes over `[start, end)` in fixed chunks through an open descriptor; never builds a string. */
function countNewlineBytesInFileRange(fd: number, start: number, end: number): number {
  const chunkSize = Math.min(AGENT_LOG_NEWLINE_SCAN_CHUNK_BYTES, end - start);
  if (chunkSize <= 0) return 0;
  const chunk = Buffer.alloc(chunkSize);
  let count = 0;
  let position = start;
  while (position < end) {
    const bytesRead = readSync(fd, chunk, 0, Math.min(chunk.length, end - position), position);
    if (bytesRead <= 0) break;
    count += countNewlineBytes(chunk, 0, bytesRead);
    position += bytesRead;
  }
  return count;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/** Fence check: the cached total is authoritative only while device, inode AND byte size all agree. */
function readFencedNewlineTotal(cacheKey: string, stat: Stats): number | null {
  const entry = newlineTotals.get(cacheKey);
  if (!entry) return null;
  if (entry.dev !== stat.dev || entry.ino !== stat.ino || entry.size !== stat.size) return null;
  return entry.newlineCount;
}

function rememberNewlineTotal(
  cacheKey: string,
  dev: number,
  ino: number,
  size: number,
  newlineCount: number,
): void {
  if (!newlineTotals.has(cacheKey) && newlineTotals.size >= AGENT_LOG_NEWLINE_TOTAL_CAPACITY) {
    const oldest = newlineTotals.keys().next();
    if (!oldest.done) newlineTotals.delete(oldest.value);
  }
  newlineTotals.set(cacheKey, { dev, ino, size, newlineCount });
}

/**
 * Fold a just-written payload into the tracked newline total.
 *
 * No entry means there is nothing to advance: either the path was never tracked (its next inspect computes the
 * total from bytes) or the entry was dropped, and inventing one here would need a `dev`/`ino` this call does not
 * have. A zero-length payload advances both terms by zero.
 */
function advanceNewlineTotalAfterAppend(filePath: string, payload: string): void {
  const entry = newlineTotals.get(resolve(filePath));
  if (!entry) return;
  entry.newlineCount += countNewlineBytesInText(payload);
  entry.size += Buffer.byteLength(payload, "utf8");
}

/**
 * Answer the only two questions an append asks about the existing file: the number of physical lines already
 * present and whether a boundary newline is needed. Cost is O(tail) — see the invariant note above
 * `AGENT_LOG_TAIL_WINDOW_BYTES`. Failure semantics stay bug-compatible with the whole-file read it replaced:
 * only `ENOENT` maps to the missing-file answer, every other open or stat error propagates.
 */
function inspectAgentLogTail(filePath: string): { lineCount: number; endsWithNewline: boolean } {
  const cacheKey = resolve(filePath);
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch (error) {
    if (isMissingFileError(error)) {
      newlineTotals.delete(cacheKey);
      return { lineCount: 0, endsWithNewline: true };
    }
    throw error;
  }

  try {
    const stat = fstatSync(fd);
    if (stat.size === 0) {
      rememberNewlineTotal(cacheKey, stat.dev, stat.ino, 0, 0);
      return { lineCount: 0, endsWithNewline: true };
    }

    const windowStart = Math.max(0, stat.size - AGENT_LOG_TAIL_WINDOW_BYTES);
    const window = Buffer.alloc(stat.size - windowStart);
    const windowFilled = readBufferAt(fd, window, windowStart);
    if (windowFilled === 0) {
      // Truncated to nothing between the stat and the read: nothing is knowable, so answer like an empty file
      // and refuse to cache a total this snapshot never observed.
      newlineTotals.delete(cacheKey);
      return { lineCount: 0, endsWithNewline: true };
    }

    const observedSize = windowStart + windowFilled;
    const endsWithNewline = window[windowFilled - 1] === NEWLINE_BYTE;
    const windowNewlineCount = countNewlineBytes(window, 0, windowFilled);
    const observedWholeSnapshot = windowFilled === window.length;

    let newlineCount: number;
    if (windowStart === 0) {
      // The window covers the file, so this IS the file's total newline count — a newline quantity that becomes
      // a line count only through `deriveLineCount`, never on its own.
      newlineCount = windowNewlineCount;
    } else {
      const fenced = readFencedNewlineTotal(cacheKey, stat);
      if (fenced != null) {
        newlineCount = fenced;
      } else {
        // Cold or invalidated pass: stream the pre-window prefix through the same descriptor, capped at the
        // recorded size so a concurrent append cannot inflate the snapshot. The prefix read is what makes an
        // over-window recompute observably exceed the window in the recorded-bytes tests.
        newlineCount = windowNewlineCount + countNewlineBytesInFileRange(fd, 0, windowStart);
      }
    }

    if (observedWholeSnapshot) {
      rememberNewlineTotal(cacheKey, stat.dev, stat.ino, observedSize, newlineCount);
    }

    return {
      lineCount: deriveLineCount(observedSize, newlineCount, endsWithNewline),
      endsWithNewline,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Prune agent log JSONL files by removing entries older than the retention cutoff.
 * Only affects tasks whose directory exists under `tasksDir`.
 *
 * @param tasksDir - Root `.fusion/tasks/` directory
 * @param retentionDays - Number of days to retain; 0 or negative disables pruning
 * @param scanTaskIds - Optional set of task IDs to scope pruning to. If omitted, all task subdirectories are scanned.
 * @returns Counts of pruned files and approximate bytes freed.
 */
export function pruneAgentLogFiles(
  tasksDir: string,
  retentionDays: number,
  scanTaskIds?: Set<string>,
): { prunedFiles: number; prunedEntries: number; freedBytes: number } & PruneAgentLogSpillCounts {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0 || !existsSync(tasksDir)) {
    // A pass that never ran examined nothing, which is the honest zero for the spill counters too.
    return { prunedFiles: 0, prunedEntries: 0, freedBytes: 0, spillDirsExamined: 0, spillBodiesDeleted: 0, spillBytesFreed: 0, spillDirsRemoved: 0 };
  }

  const cutoffIso = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const cutoffMs = Date.now() - retentionDays * 86_400_000;
  const baseDir = baseDirOf(tasksDir);
  let prunedFiles = 0;
  let prunedEntries = 0;
  let freedBytes = 0;

  const entries = readdirSync(tasksDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (scanTaskIds != null && !scanTaskIds.has(entry.name)) continue;

    const taskDirPath = join(tasksDir, entry.name);
    const filePath = getAgentLogFilePath(taskDirPath);
    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, "utf8");
      if (content.length === 0) continue;

      const lines = content.split("\n");
      const keptLines: string[] = [];
      let removed = 0;

      for (const line of lines) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { timestamp?: unknown };
          const ts = typeof parsed.timestamp === "string" ? parsed.timestamp : null;
          if (ts != null && ts < cutoffIso) {
            removed += 1;
            continue;
          }
        } catch {
          // Malformed line — keep it (don't destroy data we can't parse)
        }
        keptLines.push(line);
      }

      if (removed > 0) {
        const newSize = keptLines.map((l) => l.length + 1).reduce((a, b) => a + b, 0);
        freedBytes += content.length - newSize;
        prunedEntries += removed;

        if (keptLines.length === 0) {
          unlinkSync(filePath);
          prunedFiles += 1;
        } else {
          // Atomic-ish rewrite: write to temp then rename
          const tmpPath = filePath + ".tmp";
          writeFileSync(tmpPath, keptLines.join("\n") + "\n", "utf8");
          renameSync(tmpPath, filePath);
          prunedFiles += 1;
        }
      }
    } catch (err) {
      log.warn(`Failed to prune agent log file ${filePath}`, err);
    }
  }

  return { prunedFiles, prunedEntries, freedBytes, ...reclaimAgentLogSpillBodies(baseDir, cutoffMs, scanTaskIds) };
}

/**
 * The `.fusion` directory a `tasks`/`agents` sibling layout implies - the pool's base. Both writer sides derive
 * the pool from this level (see `agentLogSpillBaseFromAgentsDir`), so reclaim enumerates from here and cannot
 * address a different pool than the one the writers write into.
 */
function baseDirOf(tasksDir: string): string {
  return dirname(tasksDir);
}

/** Counts contributed by the spill-body sweep of a prune pass (additive to the historical three fields). */
export interface PruneAgentLogSpillCounts {
  /** Producer directories whose mtime aged past the retention window and were therefore examined. */
  spillDirsExamined: number;
  /** Spill bodies deleted because no row of their own referrer log named them. */
  spillBodiesDeleted: number;
  spillBytesFreed: number;
  /** Producer directories removed after their last body went (an empty directory is pure clutter). */
  spillDirsRemoved: number;
}

/**
 * Reclaim out-of-line agent-log detail bodies whose referrer log no longer references them.
 *
 * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
 * The invariant this function exists to honour: **a reclaim pass must not delete a spill body whose referencing
 * log it did not examine.** The consequences are all load-bearing:
 * - It is POOL-DRIVEN: producer directories are enumerated from the pool (`task/<taskId>`, `run/<agentId>/<runId>`)
 *   and each one's referrer is derived by path arithmetic. It never iterates logs, and there is no reverse index
 *   to drift out of date.
 * - It covers BOTH families. A sweep that walked only `task/` would be exactly the bug this card removes, just
 *   moved from write time to delete time.
 * - It is BOUNDED: a directory younger than the retention window cannot have lost its referencing row in this
 *   pass (rows only leave through a prune with the same cutoff), so its mtime alone licenses a SKIP. Deletion is
 *   bounded per FILE: only a body whose own mtime is past the horizon is a candidate, because the directory stamp
 *   is captured before the loop while another process may still be spilling into it. One referrer read per aged
 *   directory, never one per body.
 * - It matches references by DIGEST, the only identifier two processes can agree on about one file; a path from
 *   the writer's own root is never compared to a path from this process's root.
 * - It FAILS CLOSED: an unreadable referrer, an unreadable directory, or an unresolvable producer identity all
 *   leave every byte in place. A missing referrer is the one readable verdict — a log that is gone references
 *   nothing, which is also the shape left behind by the run above, where the last row of a task log pruned the
 *   file away entirely.
 * - It runs AFTER the JSONL rewrite above, so the references it collects are the KEPT rows, and a body whose last
 *   referring row just aged out dies in the same pass it became unreachable.
 * - `scanTaskIds` scopes the task family only: a task directory outside the set had no log re-read here, so its
 *   bodies are out of scope, while run-family producers are always in scope because their referrer is read here.
 */
function reclaimAgentLogSpillBodies(baseDir: string, cutoffMs: number, scanTaskIds?: Set<string>): PruneAgentLogSpillCounts {
  const counts: PruneAgentLogSpillCounts = { spillDirsExamined: 0, spillBodiesDeleted: 0, spillBytesFreed: 0, spillDirsRemoved: 0 };

  for (const producer of listAgentLogSpillProducerDirs(baseDir)) {
    if (producer.family === "task" && producer.taskId && scanTaskIds != null && !scanTaskIds.has(producer.taskId)) continue;
    if (producer.mtimeMs >= cutoffMs) continue;

    const referrer = agentLogSpillReferrerLog(baseDir, producer);
    if (referrer == null) continue;
    counts.spillDirsExamined += 1;

    let referenced: Set<string>;
    try {
      referenced = existsSync(referrer) ? referencedSpillBodies(readFileSync(referrer, "utf8")) : new Set();
    } catch (err) {
      log.warn(`Skipped agent-log spill reclaim for ${producer.dir}; its referrer ${referrer} could not be read`, err);
      continue;
    }

    let remaining: number;
    try {
      for (const name of readdirSync(producer.dir)) {
        const bodyPath = join(producer.dir, name);
        try {
          const stat = statSync(bodyPath);
          if (!stat.isFile()) continue;
          const isPartial = isAgentLogSpillPartialFileName(name);
          if (!isPartial && !isAgentLogSpillBodyFileName(name)) continue;
          /*
           * FNXC:AgentLogDetailSpill 2026-11-06-03:02 (RUFU-340):
           * The AGE bound is per FILE and governs BOTH classes. The directory mtime licenses only the
           * EXAMINATION — `listAgentLogSpillProducerDirs` captures every directory's stamp BEFORE this loop, and
           * the loop then whole-file-reads each aged referrer (multi-MB per directory), while the writer is a
           * DIFFERENT process: the dashboard daemon runs this maintenance pass while the engine and pi-CLI append
           * agent logs into the same pool. A payload spilled into a directory whose captured stamp is aged — a
           * resumed task, a long-lived run — is therefore young, and deleting it would leave its just-written row
           * pointing at nothing and silently degrade it to the 4 096-char prefix. That is Decision 8's "only AGED
           * files" clause and the protection Decision 11 claims for a row still sitting in the buffer; the stamp
           * that decides is the file's own.
           */
          if (stat.mtimeMs >= cutoffMs) continue;
          if (!isPartial) {
            /*
             * FNXC:AgentLogDetailSpill 2026-11-06-03:02 (RUFU-340):
             * Membership is tested on the DIGEST the file is named for, never on a path string. The writer and
             * this reclaimer derive the pool from their own `rootDir`, so one real directory spelled two ways (a
             * symlinked project root, the macOS `/private` class) used to make every body in the pool look
             * unreferenced. `bodyPath` stays only as the location to unlink. See
             * `agentLogSpillDigestFromFileName` for the full reasoning.
             */
            const digest = agentLogSpillDigestFromFileName(name);
            if (digest === null || referenced.has(digest)) continue;
          }
          // Aged and unaddressed: an unreferenced body, or a publish that never renamed (a publish in flight is
          // younger than the window, so the age check above already spared it).
          unlinkSync(bodyPath);
          counts.spillBodiesDeleted += 1;
          counts.spillBytesFreed += stat.size;
        } catch (err) {
          log.warn(`Failed to reclaim agent-log spill file ${bodyPath}`, err);
        }
      }
    } catch (err) {
      log.warn(`Failed to list agent-log spill directory ${producer.dir}`, err);
      continue;
    }

    try {
      remaining = readdirSync(producer.dir).length;
      if (remaining === 0) {
        rmdirSync(producer.dir);
        counts.spillDirsRemoved += 1;
      }
    } catch {
      // An empty-directory race (a fresh spill published into it) is a normal outcome and costs nothing.
    }
  }

  return counts;
}

/**
 * Every spill body a JSONL row still points at, as the DIGEST the body file is named for.
 *
 * FNXC:AgentLogDetailSpill 2026-11-06-03:02 (RUFU-340):
 * The set is keyed by digest, not by path, because a pointer's `body` string belongs to the process that wrote
 * it: engine/CLI derive the pool from `process.cwd()` while the dashboard resolves the project path from
 * settings, and `resolve()` keeps two spellings of one real directory apart. A path-keyed set therefore reported
 * every body in the pool as unreferenced the moment a project root was symlinked or aliased, and an aged pass
 * unlinked evidence its rows still named. A digest is content-addressed and root-independent, so it is the only
 * key that can be compared across processes.
 */
function referencedSpillBodies(content: string): Set<string> {
  const referenced = new Set<string>();
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { detailSpill?: { digest?: unknown; body?: unknown } };
      const spill = parsed?.detailSpill;
      if (!spill) continue;
      if (isAgentLogSpillDigest(spill.digest)) {
        referenced.add(spill.digest);
        continue;
      }
      /*
       * A pointer whose `digest` field is absent or malformed still names a body FILE, so its basename is taken —
       * validated by the same predicate, and never the path, whose spelling is the writer's business. Keeping a
       * byte some row mentions is the conservative direction; deleting it on a malformed field is not.
       */
      if (typeof spill.body === "string" && spill.body.length > 0) {
        const digest = agentLogSpillDigestFromFileName(basename(spill.body));
        if (digest !== null) referenced.add(digest);
      }
    } catch {
      // A malformed row is kept by the prune above, so it may still reference a body. Ignoring its pointer is
      // the conservative direction only for THAT line, and every other line of the file is still consulted.
    }
  }
  return referenced;
}
