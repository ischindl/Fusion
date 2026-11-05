/**
 * RUFU-208 — per-append cost and line-numbering contract for the agent-log append path.
 *
 * The reported symptom was cost, not correctness: `inspectAgentLogTail` read the whole `agent-log.jsonl` on
 * every append (17.3 % self time in one 15 s production dashboard profile). Wall-clock assertions are banned
 * here, so cost is observed as **bytes read per append** through a recording `node:fs` wrapper, and correctness
 * is observed as the `lineNo` / `sourceRef` the same append returns — asserted on the same call, because a warm
 * sequence that measures only bytes cannot see the post-append newline-total advance.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendAgentLogEntriesSync,
  getAgentLogFilePath,
  pruneAgentLogFiles,
  readAgentLogEntries,
} from "../agents/agent-log-file-store.js";
import type { AgentLogFileAppendInput, StoredAgentLogEntry } from "../agents/agent-log-file-store.js";

/*
 * FNXC:AgentLogAppendPerf 2026-11-04-23:34:
 * Mirrors of two module-private constants in `agent-log-file-store.ts`, duplicated rather than exported:
 * `packages/core/src/agents/index.ts` re-exports that module with `export *`, so a test-only export would widen
 * the public surface (and pull `pnpm check:mock-completeness` into scope). `CACHE_CAPACITY` drives the residency
 * fixtures below, so those cases scale with the real bound instead of going vacuously false if it changes.
 */
const TAIL_WINDOW_BYTES = 64 * 1024;
const CACHE_CAPACITY = 128;

const recorder = vi.hoisted(() => ({
  armed: false,
  readSyncBytes: 0,
  readFileSyncCalls: 0,
  readFileSyncBytes: 0,
  openSyncCalls: 0,
  fstatSyncCalls: 0,
  closeSyncCalls: 0,
  appendFileSyncCalls: 0,
}));

type FsModule = typeof import("node:fs");

/*
 * FNXC:AgentLogAppendPerf 2026-11-04-23:34:
 * Partial `node:fs` mock: every primitive delegates to the real implementation, so behavior is unmodified and
 * only the byte accounting is added. Spreading `importOriginal()` matters — the append path now uses
 * `openSync`/`fstatSync`/`readSync`/`closeSync`, and a whole-module fake that omits them breaks the writer.
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<FsModule>();
  return {
    ...actual,
    openSync: ((...args: unknown[]) => {
      if (recorder.armed) recorder.openSyncCalls += 1;
      return (actual.openSync as (...a: unknown[]) => number)(...args);
    }) as FsModule["openSync"],
    fstatSync: ((...args: unknown[]) => {
      if (recorder.armed) recorder.fstatSyncCalls += 1;
      return (actual.fstatSync as (...a: unknown[]) => unknown)(...args);
    }) as FsModule["fstatSync"],
    closeSync: ((...args: unknown[]) => {
      if (recorder.armed) recorder.closeSyncCalls += 1;
      return (actual.closeSync as (...a: unknown[]) => void)(...args);
    }) as FsModule["closeSync"],
    readSync: ((...args: unknown[]) => {
      const bytesRead = (actual.readSync as (...a: unknown[]) => number)(...args);
      if (recorder.armed) recorder.readSyncBytes += bytesRead;
      return bytesRead;
    }) as FsModule["readSync"],
    readFileSync: ((...args: unknown[]) => {
      const content = (actual.readFileSync as (...a: unknown[]) => string | Buffer)(...args);
      if (recorder.armed) {
        recorder.readFileSyncCalls += 1;
        recorder.readFileSyncBytes += Buffer.byteLength(
          typeof content === "string" ? content : content.toString("utf8"),
          "utf8",
        );
      }
      return content;
    }) as FsModule["readFileSync"],
    appendFileSync: ((...args: unknown[]) => {
      if (recorder.armed) recorder.appendFileSyncCalls += 1;
      return (actual.appendFileSync as (...a: unknown[]) => void)(...args);
    }) as FsModule["appendFileSync"],
  };
});

const tempDirs: string[] = [];

function createTaskDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusion-agent-log-tail-window-"));
  tempDirs.push(dir);
  return dir;
}

/** Task dir nested one level under a `tasksDir` root, for the `pruneAgentLogFiles` arms. */
function createTaskDirUnder(pruneRoot: string, taskId: string): string {
  const dir = join(pruneRoot, taskId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  disarm();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function disarm(): void {
  recorder.armed = false;
  recorder.readSyncBytes = 0;
  recorder.readFileSyncCalls = 0;
  recorder.readFileSyncBytes = 0;
  recorder.openSyncCalls = 0;
  recorder.fstatSyncCalls = 0;
  recorder.closeSyncCalls = 0;
  recorder.appendFileSyncCalls = 0;
}

interface RecordedAppend {
  lineNo: number[];
  sourceRef: string[];
  /** Bytes this one append pulled off the file — the cost signal that replaces any wall-clock assertion. */
  readBytes: number;
  readFileSyncCalls: number;
  readSyncBytes: number;
}

/**
 * Measure exactly one `appendAgentLogEntriesSync` call: numbering and recorded bytes together. This single call
 * site is what makes the post-append newline-total advance observable — a numbering case and a bytes case
 * recorded separately would each stay green while the advance drifted by one.
 */
function recordAppend(taskDir: string, entries: AgentLogFileAppendInput[]): RecordedAppend {
  disarm();
  recorder.armed = true;
  try {
    const appended = appendAgentLogEntriesSync(taskDir, entries);
    return {
      lineNo: appended.map((stored) => stored.lineNo),
      sourceRef: appended.map((stored) => stored.sourceRef),
      readBytes: recorder.readSyncBytes + recorder.readFileSyncBytes,
      readFileSyncCalls: recorder.readFileSyncCalls,
      readSyncBytes: recorder.readSyncBytes,
    };
  } finally {
    disarm();
  }
}

let entrySeq = 0;

function entry(taskId = "FN-1", timestamp = new Date(Date.now() - 60_000).toISOString()): AgentLogFileAppendInput {
  entrySeq += 1;
  return { timestamp, taskId, text: `probe-${entrySeq}`, type: "text" };
}

/** Compact minimal row (~105 bytes) so a 20 000-row seed stays in the single-megabyte range. */
function seedRow(index: number, options: { taskId?: string; timestamp?: string; text?: string } = {}): string {
  return JSON.stringify({
    timestamp: options.timestamp ?? `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    taskId: options.taskId ?? "FN-1",
    text: options.text ?? `seed-row-${String(index).padStart(6, "0")}`,
    type: "text",
  });
}

/** Rows a retention prune must keep: their timestamps are inside any positive retention window. */
function freshRow(index: number, taskId = "FN-1"): string {
  return seedRow(index, {
    taskId,
    timestamp: new Date(Date.now() - 3_600_000).toISOString(),
    text: `fresh-row-${index}`,
  });
}

function expiredRow(index: number, taskId = "FN-1"): string {
  return seedRow(index, { taskId, timestamp: "2000-01-01T00:00:00.000Z", text: `expired-row-${index}` });
}

function serializeAppend(input: AgentLogFileAppendInput): string {
  return `${JSON.stringify({
    timestamp: input.timestamp,
    taskId: input.taskId,
    text: input.text,
    type: input.type,
  })}\n`;
}

/** Write N valid JSONL rows in one `writeFileSync`; returns the byte size written. */
function seedRows(taskDir: string, rows: number, options: { unterminated?: boolean } = {}): number {
  const body = Array.from({ length: rows }, (_, index) => seedRow(index)).join("\n");
  const content = options.unterminated ? body : `${body}\n`;
  writeFileSync(getAgentLogFilePath(taskDir), content, "utf8");
  return Buffer.byteLength(content, "utf8");
}

/** Over-window seed: asserts the window assumption so a future window enlargement cannot soften the bound. */
function seedOverWindow(taskDir: string, rows: number, options: { unterminated?: boolean } = {}): number {
  const size = seedRows(taskDir, rows, options);
  expect(size).toBeGreaterThan(TAIL_WINDOW_BYTES);
  return size;
}

function rawBytes(taskDir: string): string {
  return readFileSync(getAgentLogFilePath(taskDir), "utf8");
}

function persistedWithText(taskDir: string, text: string): StoredAgentLogEntry | undefined {
  return readAgentLogEntries(taskDir).find((stored) => stored.text === text);
}

/**
 * One Decision 5 row → the four observations the design is judged on. `content === null` means the file is
 * absent outright. Every `expectedLineNo` is a value captured from the pre-fix implementation in the
 * `preflight-golden` task document, not a number chosen to fit this implementation.
 */
function assertDerivationRow(name: string, content: string | null, expectedLineNo: number): void {
  const taskDir = createTaskDir();
  const filePath = getAgentLogFilePath(taskDir);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  if (content !== null) writeFileSync(filePath, content, "utf8");

  const input = entry();
  const recorded = recordAppend(taskDir, [input]);

  expect(recorded.lineNo, name).toEqual([expectedLineNo]);
  expect(recorded.sourceRef, name).toEqual([`agentLog:${input.taskId}:${expectedLineNo}`]);
  expect(persistedWithText(taskDir, input.text)?.lineNo, `${name}: reader re-derivation`).toBe(expectedLineNo);

  const raw = rawBytes(taskDir);
  expect(raw.startsWith(content ?? ""), `${name}: pre-existing content preserved byte-for-byte`).toBe(true);
  const appendedSlice = raw.slice((content ?? "").length);
  const boundaryNewline = (content ?? "").length > 0 && !(content ?? "").endsWith("\n") ? "\n" : "";
  expect(appendedSlice, `${name}: appended slice is boundary newline + exactly one row`).toBe(
    `${boundaryNewline}${serializeAppend(input)}`,
  );
  expect(appendedSlice.includes("\n\n"), `${name}: no blank-line artifact`).toBe(false);
}

/** Assert a whole sequence end-to-end: reader re-derivation, byte-exact rows, and no blank-line artifact. */
function expectSequence(
  taskDir: string,
  inputs: AgentLogFileAppendInput[],
  expectedLineNos: number[],
): void {
  const raw = rawBytes(taskDir);
  expect(raw.includes("\n\n"), "no blank-line artifact").toBe(false);
  inputs.forEach((input, index) => {
    expect(persistedWithText(taskDir, input.text)?.lineNo, `reader lineNo for ${input.text}`).toBe(
      expectedLineNos[index],
    );
    expect(raw).toContain(serializeAppend(input).trimEnd());
  });
}

describe("agent-log append cost bound (RUFU-208)", () => {
  it("reads at most the tail window on every append to an under-window file", () => {
    const taskDir = createTaskDir();
    const size = seedRows(taskDir, 40);
    expect(size).toBeLessThan(TAIL_WINDOW_BYTES);

    for (let index = 0; index < 3; index += 1) {
      const recorded = recordAppend(taskDir, [entry()]);
      expect(recorded.readBytes, `append ${index + 1} bytes`).toBeLessThanOrEqual(TAIL_WINDOW_BYTES);
      expect(recorded.readFileSyncCalls, `append ${index + 1} whole-file reads`).toBe(0);
    }
  });

  it("streams the pre-window prefix once, then stays inside the window for a 20 000-row log", () => {
    const taskDir = createTaskDir();
    const size = seedOverWindow(taskDir, 20_000);

    const appends: RecordedAppend[] = [];
    const inputs: AgentLogFileAppendInput[] = [];
    for (let index = 0; index < 6; index += 1) {
      const input = entry();
      inputs.push(input);
      appends.push(recordAppend(taskDir, [input]));
    }

    const [cold, ...warm] = appends;
    // Reading more than the window here is the signature that the cold pass streamed the prefix through
    // `readSync`; a recompute that skipped the prefix would make every bound below vacuous.
    expect(cold.readBytes, "cold pass streams the pre-window prefix").toBeGreaterThan(TAIL_WINDOW_BYTES);
    expect(cold.readBytes).toBeLessThanOrEqual(size + TAIL_WINDOW_BYTES);
    for (const [index, recorded] of warm.entries()) {
      expect(recorded.readBytes, `warm append ${index + 2} bytes`).toBeLessThanOrEqual(TAIL_WINDOW_BYTES);
      expect(recorded.readFileSyncCalls, `warm append ${index + 2} whole-file reads`).toBe(0);
    }
    // "At most one whole-file pass per process per file": only one append may exceed the window.
    expect(appends.filter((recorded) => recorded.readBytes > TAIL_WINDOW_BYTES)).toHaveLength(1);
    expect(appends.reduce((total, recorded) => total + recorded.readFileSyncCalls, 0)).toBe(0);

    // Cost, without correctness: the six appends keep the numbering a full-file reader derives.
    expect(appends.map((recorded) => recorded.lineNo)).toEqual([
      [20_001], [20_002], [20_003], [20_004], [20_005], [20_006],
    ]);
    expect(appends.map((recorded) => recorded.sourceRef)).toEqual(
      [20_001, 20_002, 20_003, 20_004, 20_005, 20_006].map((lineNo) => [`agentLog:FN-1:${lineNo}`]),
    );
    expectSequence(taskDir, inputs, [20_001, 20_002, 20_003, 20_004, 20_005, 20_006]);
  });
});

describe("agent-log append numbering across the enumerated data states", () => {
  it("matches the golden derivation table for every Decision 5 state", () => {
    const longTerminated = `${seedRow(0, { text: "x".repeat(200_000) })}\n`;
    expect(Buffer.byteLength(longTerminated, "utf8")).toBeGreaterThan(TAIL_WINDOW_BYTES);

    assertDerivationRow("missing file", null, 1);
    assertDerivationRow("empty file", "", 1);
    assertDerivationRow("only a newline", "\n", 2);
    assertDerivationRow("terminated rows", `${seedRow(1)}\n${seedRow(2)}\n`, 3);
    assertDerivationRow("terminated with empty last row", `${seedRow(3)}\n\n`, 3);
    assertDerivationRow("unterminated complete row", `${seedRow(4)}\n${seedRow(5)}`, 3);
    assertDerivationRow("zero-newline truncated tail", '{"timestamp":"2026-01-01T00:00:00.000Z"', 2);
    assertDerivationRow("over-window single line, terminated", longTerminated, 2);
    assertDerivationRow("over-window single line, unterminated", longTerminated.slice(0, -1), 2);
  });

  it("numbers a multi-entry batch on an unterminated tail with a single boundary newline", () => {
    const taskDir = createTaskDir();
    writeFileSync(getAgentLogFilePath(taskDir), seedRow(0), "utf8");

    const inputs = [entry(), entry(), entry()];
    const recorded = recordAppend(taskDir, inputs);

    expect(recorded.lineNo).toEqual([2, 3, 4]);
    expect(recorded.sourceRef).toEqual(["agentLog:FN-1:2", "agentLog:FN-1:3", "agentLog:FN-1:4"]);
    expect(rawBytes(taskDir).startsWith(`${seedRow(0)}`)).toBe(true);
    expectSequence(taskDir, inputs, [2, 3, 4]);
  });

  it("preserves a truncated tail on an over-window log and numbers the next physical line", () => {
    const taskDir = createTaskDir();
    const rows = 1_200;
    const size = seedOverWindow(taskDir, rows);
    const seeded = rawBytes(taskDir);
    const lines = seeded.split("\n");
    const truncated = `${lines.slice(0, -2).join("\n")}\n${lines[rows - 1].slice(0, 24)}`;
    expect(truncated.endsWith("\n")).toBe(false);
    writeFileSync(getAgentLogFilePath(taskDir), truncated, "utf8");

    const input = entry();
    const recorded = recordAppend(taskDir, [input]);

    expect(recorded.lineNo).toEqual([rows + 1]);
    expect(recorded.readBytes).toBeLessThanOrEqual(size + TAIL_WINDOW_BYTES);
    const after = rawBytes(taskDir);
    expect(after.startsWith(truncated), "truncated line preserved byte-for-byte").toBe(true);
    expect(after).toContain(serializeAppend(input).trimEnd());
    expect(after.includes("\n\n")).toBe(false);
    expect(persistedWithText(taskDir, input.text)?.lineNo).toBe(rows + 1);
  });

  it("counts CRLF rows exactly as the previous split(\"\\n\") did", () => {
    const taskDir = createTaskDir();
    writeFileSync(getAgentLogFilePath(taskDir), `${seedRow(0)}\r\n${seedRow(1)}\r\n`, "utf8");

    const input = entry();
    const recorded = recordAppend(taskDir, [input]);

    expect(recorded.lineNo).toEqual([3]);
    expect(persistedWithText(taskDir, input.text)?.lineNo).toBe(3);
  });

  it("counts newlines correctly when a multibyte character straddles the window boundary", () => {
    const taskDir = createTaskDir();
    // The emoji sits at a fixed byte offset from the file start, so the file is sized to put the window
    // boundary inside its 4 bytes: windowStart = size - window must fall in [emojiStart, emojiStart + 4).
    const textPrefix = `{"timestamp":"2026-01-01T00:00:00.000Z","taskId":"FN-1","text":"`;
    const emojiStart = Buffer.byteLength(textPrefix, "utf8");
    const tail = `tail","type":"text"}\n`;
    // size = emojiStart + 4 + filler + tail, and windowStart = size - window, so a filler sized to land the
    // boundary two bytes into the emoji is solvable in closed form.
    const fillerLength = TAIL_WINDOW_BYTES - 3 - Buffer.byteLength(tail, "utf8");
    expect(fillerLength).toBeGreaterThan(0);
    const filler = "a".repeat(fillerLength);
    const content = `${textPrefix}😀${filler}${tail}`;
    const windowStart = Buffer.byteLength(content, "utf8") - TAIL_WINDOW_BYTES;
    expect(emojiStart < windowStart && windowStart < emojiStart + 4).toBe(true);
    writeFileSync(getAgentLogFilePath(taskDir), content, "utf8");

    const input = entry();
    const recorded = recordAppend(taskDir, [input]);

    // Over-window and cold, so the pass reads the prefix — but the count is exact either way: a 0x0A byte is
    // never a UTF-8 continuation byte, so splitting a multibyte character cannot lose or add a line.
    expect(recorded.lineNo).toEqual([2]);
    expect(recorded.readBytes).toBeLessThanOrEqual(Buffer.byteLength(content, "utf8") + TAIL_WINDOW_BYTES);
    expect(persistedWithText(taskDir, input.text)?.lineNo).toBe(2);
    expect(persistedWithText(taskDir, `😀${filler}tail`), "seed row survives the split read").toBeDefined();
  });

  it("keeps numbering exact while the file grows from under-window to over-window", () => {
    const taskDir = createTaskDir();
    const rows = 630;
    const size = seedRows(taskDir, rows);
    expect(size).toBeLessThan(TAIL_WINDOW_BYTES);

    const inputs: AgentLogFileAppendInput[] = [];
    const expected: number[] = [];
    for (let batch = 0; batch < 6; batch += 1) {
      const batchInputs = Array.from({ length: 10 }, () => entry());
      const firstExpected = rows + batch * 10 + 1;
      inputs.push(...batchInputs);
      expected.push(...batchInputs.map((_, offset) => firstExpected + offset));
      const recorded = recordAppend(taskDir, batchInputs);
      expect(recorded.lineNo).toEqual(batchInputs.map((_, offset) => firstExpected + offset));
      expect(recorded.readBytes, `batch ${batch} stays window-bounded`).toBeLessThanOrEqual(
        TAIL_WINDOW_BYTES,
      );
    }
    expect(Buffer.byteLength(rawBytes(taskDir), "utf8")).toBeGreaterThan(TAIL_WINDOW_BYTES);
    expectSequence(taskDir, inputs, expected);
  });
});

describe("agent-log append fence transitions", () => {
  it("recomputes exactly when a raw appendFileSync bypass grows the file between store appends", () => {
    const taskDir = createTaskDir();
    seedRows(taskDir, 2);

    expect(recordAppend(taskDir, [entry()]).lineNo).toEqual([3]);

    // A writer outside this module: the (dev, ino, size) fence must notice it, not trust the advanced entry.
    appendFileSync(getAgentLogFilePath(taskDir), `${seedRow(90)}\n`, "utf8");

    const input = entry();
    const recorded = recordAppend(taskDir, [input]);
    expect(recorded.lineNo).toEqual([5]);
    expect(recorded.sourceRef).toEqual(["agentLog:FN-1:5"]);
    expect(persistedWithText(taskDir, input.text)?.lineNo).toBe(5);
    expect(readAgentLogEntries(taskDir)).toHaveLength(5);
    expect(recorded.readBytes).toBeLessThanOrEqual(TAIL_WINDOW_BYTES);
  });

  it("recomputes exactly when the same path is rewritten at a different byte length", () => {
    const taskDir = createTaskDir();
    seedRows(taskDir, 5);
    expect(recordAppend(taskDir, [entry()]).lineNo).toEqual([6]);

    writeFileSync(getAgentLogFilePath(taskDir), `${seedRow(70)}\n${seedRow(71)}\n`, "utf8");

    const input = entry();
    expect(recordAppend(taskDir, [input]).lineNo).toEqual([3]);
    expect(persistedWithText(taskDir, input.text)?.lineNo).toBe(3);
  });

  it("numbers correctly after pruneAgentLogFiles replaces the file through a new inode", () => {
    const pruneRoot = createTaskDir();
    const taskDir = createTaskDirUnder(pruneRoot, "FN-1");
    writeFileSync(
      getAgentLogFilePath(taskDir),
      `${expiredRow(0)}\n${expiredRow(1)}\n${freshRow(0)}\n${freshRow(1)}\n${freshRow(2)}\n`,
      "utf8",
    );

    expect(recordAppend(taskDir, [entry()]).lineNo).toEqual([6]);
    expect(pruneAgentLogFiles(pruneRoot, 1)).toMatchObject({ prunedFiles: 1, prunedEntries: 2 });

    const input = entry();
    const recorded = recordAppend(taskDir, [input]);
    expect(recorded.lineNo).toEqual([5]);
    expect(persistedWithText(taskDir, input.text)?.lineNo).toBe(5);
    expect(readAgentLogEntries(taskDir)).toHaveLength(5);
    expect(recorded.readBytes).toBeLessThanOrEqual(TAIL_WINDOW_BYTES);
  });

  it("restarts numbering at line one after pruneAgentLogFiles removes the log outright", () => {
    const pruneRoot = createTaskDir();
    const taskDir = createTaskDirUnder(pruneRoot, "FN-2");
    const expiredTimestamp = "2000-01-01T00:00:00.000Z";
    writeFileSync(getAgentLogFilePath(taskDir), `${expiredRow(0, "FN-2")}\n${expiredRow(1, "FN-2")}\n`, "utf8");

    // This append leaves every row — including its own — past a 1-day retention window, so the prune takes its
    // unlink arm and the tracked newline total for a now-absent path must not survive it.
    expect(recordAppend(taskDir, [entry("FN-2", expiredTimestamp)]).lineNo).toEqual([3]);
    expect(pruneAgentLogFiles(pruneRoot, 1)).toMatchObject({ prunedFiles: 1, prunedEntries: 3 });
    expect(existsSync(getAgentLogFilePath(taskDir))).toBe(false);

    const input = entry("FN-2");
    const recorded = recordAppend(taskDir, [input]);
    expect(recorded.lineNo).toEqual([1]);
    expect(recorded.sourceRef).toEqual(["agentLog:FN-2:1"]);
    expect(recorded.readBytes).toBeLessThanOrEqual(TAIL_WINDOW_BYTES);
    expect(recorded.readFileSyncCalls).toBe(0);
    expect(rawBytes(taskDir)).toBe(serializeAppend(input));
  });
});

describe("agent-log newline-total residency is bounded and loss-free", () => {
  /**
   * Fill tracked-path residency with fresh task dirs. Each dir's file is seeded raw so the recorded store append
   * is the call that inserts its entry — a dir whose file was created by that same append is an ENOENT path at
   * inspect time and inserts nothing.
   */
  function fillResidency(count: number): void {
    for (let index = 0; index < count; index += 1) {
      const dir = createTaskDir();
      writeFileSync(getAgentLogFilePath(dir), `${freshRow(0)}\n${freshRow(1)}\n`, "utf8");
      appendAgentLogEntriesSync(dir, [entry("FN-FILL")]);
    }
  }

  it("evicts the oldest tracked path once residency is full, then re-arms it exactly", () => {
    const probeDir = createTaskDir();
    const probeSize = seedOverWindow(probeDir, 1_500);

    const first = recordAppend(probeDir, [entry()]);
    expect(first.lineNo).toEqual([1_501]);
    expect(first.readBytes, "probe cold pass streams the prefix").toBeGreaterThan(TAIL_WINDOW_BYTES);

    // One entry per fresh dir: `CACHE_CAPACITY` later paths must displace the oldest tracked entry.
    fillResidency(CACHE_CAPACITY);

    const evicted = recordAppend(probeDir, [entry()]);
    expect(evicted.lineNo, "an evicted path still numbers exactly").toEqual([1_502]);
    expect(evicted.readBytes, "probe entry was evicted, so a recompute ran").toBeGreaterThan(
      TAIL_WINDOW_BYTES,
    );
    expect(evicted.readBytes).toBeLessThanOrEqual(probeSize + 2 * TAIL_WINDOW_BYTES);
    expect(evicted.readFileSyncCalls).toBe(0);

    const rearmed = recordAppend(probeDir, [entry()]);
    expect(rearmed.lineNo).toEqual([1_503]);
    expect(rearmed.readBytes, "the re-seeded entry is resident again").toBeLessThanOrEqual(TAIL_WINDOW_BYTES);
  });

  it("keeps numbering and stored rows exact for every path, including an evicted one", () => {
    const dirs: string[] = [];
    for (let index = 0; index <= CACHE_CAPACITY; index += 1) {
      const dir = createTaskDir();
      dirs.push(dir);
      writeFileSync(getAgentLogFilePath(dir), `${freshRow(0)}\n${freshRow(1)}\n`, "utf8");
      const recorded = recordAppend(dir, [entry()]);
      expect(recorded.lineNo, `dir ${index} numbering while eviction runs`).toEqual([3]);
    }

    const first = dirs[0];
    const rowsBefore = readAgentLogEntries(first);
    expect(rowsBefore).toHaveLength(3);

    const reopened = recordAppend(first, [entry()]);
    expect(reopened.lineNo).toEqual([4]);
    expect(reopened.sourceRef).toEqual(["agentLog:FN-1:4"]);
    const rowsAfter = readAgentLogEntries(first);
    expect(rowsAfter).toHaveLength(4);
    expect(rowsAfter.slice(0, 3).map((stored) => stored.lineNo)).toEqual(
      rowsBefore.map((stored) => stored.lineNo),
    );
  });
});

describe("agent-log fence-warm sequences (the post-append advance is observable)", () => {
  /*
   * FNXC:AgentLogAppendPerf 2026-11-04-23:34:
   * No external write may sit between these appends: a sequence that perturbs (dev, ino, size) forces the exact
   * recompute that hides a wrong advance, and a warm sequence that measures only bytes cannot see a wrong
   * newlineCount. Both signals are therefore asserted on the same calls.
   *  - a wrong `newlineCount` advance (a line-count delta, or +1 for the separator byte) shows up as numbering
   *    drift while reads stay window-bounded;
   *  - a wrong `size` advance (separator byte omitted) shows up as a window-bound breach on the next append,
   *    because the fence then disagrees and the prefix is streamed again.
   */
  it("numbers 7 consecutive appends on an over-window terminated seed with window-bounded reads", () => {
    const taskDir = createTaskDir();
    const seededRows = 1_500;
    const size = seedOverWindow(taskDir, seededRows);

    const records: RecordedAppend[] = [];
    const lineNos: number[] = [];
    const inputs: AgentLogFileAppendInput[] = [];
    const step = (batch: AgentLogFileAppendInput[]) => {
      inputs.push(...batch);
      const recorded = recordAppend(taskDir, batch);
      records.push(recorded);
      lineNos.push(...recorded.lineNo);
    };

    step([entry()]);
    step([entry()]);
    step([entry()]);
    step([entry(), entry(), entry()]);
    step([entry()]);

    // Golden sequence captured from the pre-fix implementation: [1501..1507].
    expect(lineNos).toEqual([1_501, 1_502, 1_503, 1_504, 1_505, 1_506, 1_507]);
    expect(records[0].readBytes, "only the first pass may stream the file").toBeLessThanOrEqual(
      size + TAIL_WINDOW_BYTES,
    );
    for (const [index, recorded] of records.slice(1).entries()) {
      expect(recorded.readBytes, `warm append ${index + 2}`).toBeLessThanOrEqual(TAIL_WINDOW_BYTES);
      expect(recorded.readFileSyncCalls, `warm append ${index + 2} whole-file reads`).toBe(0);
    }
    expectSequence(taskDir, inputs, [1_501, 1_502, 1_503, 1_504, 1_505, 1_506, 1_507]);
  });

  it("numbers the same 7 appends when the seeded tail is unterminated so the separator byte is in play", () => {
    const taskDir = createTaskDir();
    const seededRows = 1_500;
    const size = seedOverWindow(taskDir, seededRows, { unterminated: true });

    const records: RecordedAppend[] = [];
    const lineNos: number[] = [];
    const inputs: AgentLogFileAppendInput[] = [];
    const step = (batch: AgentLogFileAppendInput[]) => {
      inputs.push(...batch);
      const recorded = recordAppend(taskDir, batch);
      records.push(recorded);
      lineNos.push(...recorded.lineNo);
    };

    step([entry()]);
    step([entry()]);
    step([entry()]);
    step([entry(), entry(), entry()]);
    step([entry()]);

    // This is the state where advancing a *line count* by payload newlines over-counts: the first payload adds
    // two 0x0A bytes (boundary newline + row terminator) while the physical line count rises by one per row.
    // Golden sequence: [1501..1507].
    expect(lineNos).toEqual([1_501, 1_502, 1_503, 1_504, 1_505, 1_506, 1_507]);
    expect(records[0].readBytes).toBeLessThanOrEqual(size + TAIL_WINDOW_BYTES);
    for (const [index, recorded] of records.slice(1).entries()) {
      expect(recorded.readBytes, `warm append ${index + 2} after the separator-carrying payload`).toBeLessThanOrEqual(
        TAIL_WINDOW_BYTES,
      );
      expect(recorded.readFileSyncCalls, `warm append ${index + 2} whole-file reads`).toBe(0);
    }
    expectSequence(taskDir, inputs, [1_501, 1_502, 1_503, 1_504, 1_505, 1_506, 1_507]);
  });

  it("numbers an under-window unterminated seed across 4 consecutive appends as [2,3,4,5]", () => {
    const taskDir = createTaskDir();
    writeFileSync(getAgentLogFilePath(taskDir), seedRow(0), "utf8");

    const lineNos: number[] = [];
    const inputs: AgentLogFileAppendInput[] = [];
    for (let index = 0; index < 4; index += 1) {
      const input = entry();
      inputs.push(input);
      const recorded = recordAppend(taskDir, [input]);
      lineNos.push(...recorded.lineNo);
      expect(recorded.readBytes).toBeLessThanOrEqual(TAIL_WINDOW_BYTES);
      expect(recorded.readFileSyncCalls).toBe(0);
    }

    // Golden sequence: [2,3,4,5]. Cheap redundancy for the unterminated-tail state where bytes carry no
    // information, because the window covers the file.
    expect(lineNos).toEqual([2, 3, 4, 5]);
    expectSequence(taskDir, inputs, [2, 3, 4, 5]);
  });

  it("keeps the separator-carrying payload warm: the next append neither re-streams nor renumbers", () => {
    const taskDir = createTaskDir();
    seedOverWindow(taskDir, 1_200, { unterminated: true });

    const first = recordAppend(taskDir, [entry()]);
    expect(first.lineNo).toEqual([1_201]);
    // The first payload carries the boundary newline, so the cached size must land exactly on the file. An
    // under-count there is invisible to numbering (the recompute fixes it) and visible only as this bound.
    const second = recordAppend(taskDir, [entry()]);
    expect(second.lineNo).toEqual([1_202]);
    expect(second.readBytes, "warm append after the separator-carrying payload").toBeLessThanOrEqual(
      TAIL_WINDOW_BYTES,
    );
    expect(second.readSyncBytes).toBeGreaterThan(0);
    expect(second.readFileSyncCalls).toBe(0);
  });
});
