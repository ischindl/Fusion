import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/*
FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
The carrier census. Every object that physically carries `detail` from a producer to a persisted row or an
emitted frame must carry the pointer, or be proven non-lossy. Each row between a producer and disk is a
hand-written literal in this codebase, so a field can die silently in the middle of a working pipeline — which
is exactly how the batch path lost fields before FN-253. Assertions are behavioral wherever the carrier is
reachable, and structural only where the carrier IS the structure (a hand-written field list), never a comment.
*/
import type { AgentLogEntry, TaskStore } from "../types.js";
import { appendAgentLogBatchImpl, flushAgentLogBufferImpl } from "../task-store/agent-logs.js";
import { appendAgentLogImpl } from "../task-store/workflow-integrity.js";
import { appendAgentLogEntriesSync, readAgentLogEntries } from "../agents/agent-log-file-store.js";
import { AgentStore } from "../agents/agent-store.js";
import { AGENT_LOG_DETAIL_SPILL_DIR } from "../agents/agent-log-detail-spill.js";
import { AGENT_LOG_TOOL_DETAIL_LIMIT } from "../agents/agent-log-constants.js";

const TASK_ID = "RUFU-340";

/** A diacritic-heavy oversized payload whose tail is the only copy of a decision statement. */
function oversizedDetail(units = AGENT_LOG_TOOL_DETAIL_LIMIT * 2): string {
  const filler = "riadok sofsakého textu s díákrikami — ";
  const tail = "ODDELOK 4: konkretne blokujuci stav A/B";
  let text = "";
  while (text.length < units - tail.length) text += filler;
  return `${text.slice(0, Math.max(0, units - tail.length))}${tail}`;
}

interface Harness {
  store: TaskStore;
  frames: Array<{ event: string; args: unknown[] }>;
  rootDir: string;
  taskDir: string;
  rows: () => Array<Record<string, unknown>>;
}

/**
 * A duck-typed store handed to the REAL append implementations. Deliberately not a mock of the seam: the
 * functions under test are the production carriers, so only what they never consult is absent.
 */
function makeHarness(rootDir: string): Harness {
  const frames: Array<{ event: string; args: unknown[] }> = [];
  const taskDir = join(rootDir, ".fusion", "tasks", TASK_ID);
  const store = {
    backendMode: true,
    fusionDir: join(rootDir, ".fusion"),
    tasksDir: join(rootDir, ".fusion", "tasks"),
    agentLogBuffer: [] as Array<Record<string, unknown>>,
    agentLogFlushTimer: null,
    taskDir: (id: string) => join(rootDir, ".fusion", "tasks", id),
    emit: (event: string, ...args: unknown[]) => {
      frames.push({ event, args });
    },
    flushAgentLogBuffer: () => flushAgentLogBufferImpl(store as unknown as TaskStore),
    scanAndRecordCitations: () => [],
    recordGoalCitations: async () => {},
  } as unknown as TaskStore;
  mkdirSync(taskDir, { recursive: true });
  return {
    store,
    frames,
    rootDir,
    taskDir,
    rows: () => readFileSync(join(taskDir, "agent-log.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

let rootDir = "";

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "fusion-rufu340-census-"));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe("carrier census: single-entry buffer path", () => {
  it("carries the pointer in the buffered element, the emitted frame, and the persisted row", async () => {
    const h = makeHarness(rootDir);
    const detail = oversizedDetail();

    await appendAgentLogImpl(h.store, TASK_ID, "read", "tool_result", detail, "executor");

    const buffered = (h.store.agentLogBuffer as Array<Record<string, unknown>>)[0];
    expect(buffered).toBeDefined();
    const bufferPointer = buffered?.detailSpill as AgentLogEntry["detailSpill"];
    expect(bufferPointer?.body).toContain(join(AGENT_LOG_DETAIL_SPILL_DIR, "task", TASK_ID));
    expect(buffered?.detail).toBe(detail.slice(0, AGENT_LOG_TOOL_DETAIL_LIMIT));

    const frame = h.frames.find((entry) => entry.event === "agent:log")?.args[0] as Record<string, unknown>;
    const framePointer = frame?.detailSpill as AgentLogEntry["detailSpill"];
    expect(framePointer).toEqual(bufferPointer);
    expect(frame?.detail).toBe(buffered?.detail);

    h.store.flushAgentLogBuffer();
    const row = h.rows()[0];
    // EMIT EQUALS PERSISTED, pointer included: the frame fired before the flush and matches the row anyway.
    expect(row.detailSpill).toEqual(framePointer);
    expect(row.detail).toBe(frame.detail);
    expect(existsSync(bufferPointer!.body)).toBe(true);

    // And the reader closes the third side: read equals the emitted input, tail section included.
    const [read] = readAgentLogEntries(h.taskDir, {});
    expect(read?.detail).toBe(detail);
  });

  it("keeps a row with no oversized detail pointer-free, unchanged", async () => {
    const h = makeHarness(rootDir);

    await appendAgentLogImpl(h.store, TASK_ID, "status", "status", "Reviewer using model: x/y", "executor");
    h.store.flushAgentLogBuffer();

    expect(h.rows()[0]).not.toHaveProperty("detailSpill");
  });
});

describe("carrier census: batch path", () => {
  it("carries the pointer through the normalizer, the batch-to-disk literal, and the hand-picked emit list", async () => {
    const h = makeHarness(rootDir);
    const detail = oversizedDetail();

    await appendAgentLogBatchImpl(h.store, [
      { taskId: TASK_ID, text: "bash", type: "tool_result", detail, agent: "executor", durationMs: 12 },
    ]);

    const row = h.rows()[0];
    const rowPointer = row?.detailSpill as AgentLogEntry["detailSpill"];
    expect(rowPointer?.body).toContain(join(AGENT_LOG_DETAIL_SPILL_DIR, "task", TASK_ID));
    expect(row?.detail).toBe(detail.slice(0, AGENT_LOG_TOOL_DETAIL_LIMIT));

    const frame = h.frames.find((entry) => entry.event === "agent:log")?.args[0] as Record<string, unknown>;
    // The emit is a hand-picked seven-key conditional list, not a spread: a missing key here means the live
    // frame and the row this same call wrote disagree.
    expect(frame?.detailSpill).toEqual(rowPointer);
    expect(frame?.detail).toBe(row?.detail);
    expect(frame?.durationMs).toBe(12);

    expect(readAgentLogEntries(h.taskDir, {})[0]?.detail).toBe(detail);
  });

  it("honours a pointer already resolved by the engine fan-out instead of re-deriving one", async () => {
    const h = makeHarness(rootDir);
    const detail = oversizedDetail();
    const producerDir = join(rootDir, ".fusion", AGENT_LOG_DETAIL_SPILL_DIR, "task", TASK_ID);

    await appendAgentLogBatchImpl(h.store, [
      { taskId: TASK_ID, text: "bash", type: "tool_result", detail, agent: "executor" },
    ]);
    const first = h.rows()[0]!.detailSpill as AgentLogEntry["detailSpill"];

    // Replay of the already-persisted pair (prefix + pointer), the shape a re-flushed buffer presents.
    await appendAgentLogBatchImpl(h.store, [
      { taskId: TASK_ID, text: "bash", type: "tool_result", detail: (h.rows()[0]!.detail as string), detailSpill: first, agent: "executor" },
    ]);

    const rows = h.rows();
    expect(rows[1]!.detailSpill).toEqual(first);
    expect(rows[1]!.detail).toBe(rows[0]!.detail);
    expect(existsSync(join(producerDir, `${first.digest}.txt`))).toBe(true);
  });
});

describe("carrier census: the append writer itself", () => {
  it("spills at its own entry so a caller that hands a raw oversized detail still persists prefix plus pointer", () => {
    const h = makeHarness(rootDir);
    const detail = oversizedDetail();

    const [returned] = appendAgentLogEntriesSync(h.taskDir, [
      { timestamp: new Date().toISOString(), taskId: TASK_ID, text: "edit", type: "tool", detail },
    ]);

    expect(returned?.detailSpill?.body).toContain(join(AGENT_LOG_DETAIL_SPILL_DIR, "task", TASK_ID));
    // The append RETURN value is what the batch sink emits from, so it must equal the row, not carry the body.
    expect(returned?.detail).toBe(h.rows()[0]!.detail);
    expect(returned?.detail).not.toBe(detail);
    expect(readAgentLogEntries(h.taskDir, {})[0]?.detail).toBe(detail);
  });
});

describe("carrier census: the run-log sink", () => {
  it("resolves its own pair under the run producer directory and emits exactly what it wrote", async () => {
    const agentRoot = mkdtempSync(join(tmpdir(), "fusion-rufu340-run-"));
    mkdirSync(join(agentRoot, ".fusion", "agents"), { recursive: true });
    const agentStore = new AgentStore({ rootDir: join(agentRoot, ".fusion") });
    const frames: Array<{ agentId: string; runId: string; entry: AgentLogEntry }> = [];
    agentStore.on("run:log", (agentId: string, runId: string, entry: AgentLogEntry) => {
      frames.push({ agentId, runId, entry });
    });
    const detail = oversizedDetail();

    await agentStore.appendRunLog("agent-1", "run-1", {
      timestamp: new Date().toISOString(),
      taskId: TASK_ID,
      text: "bash",
      type: "tool_result",
      detail,
    });

    const rawRow = JSON.parse(
      readFileSync(join(agentRoot, ".fusion", "agents", "agent-1-runlogs-run-1.jsonl"), "utf8").trim(),
    ) as AgentLogEntry;
    const pointer = rawRow.detailSpill;
    expect(pointer?.body).toContain(join(AGENT_LOG_DETAIL_SPILL_DIR, "run", "agent-1", "run-1"));
    expect(rawRow.detail).toBe(detail.slice(0, AGENT_LOG_TOOL_DETAIL_LIMIT));
    // The emitted frame equals the persisted row, pointer included (Decision 1's first invariant).
    expect(frames[0]?.entry.detail).toBe(rawRow.detail);
    expect(frames[0]?.entry.detailSpill).toEqual(pointer);
    // And the reader closes the third side: what `getRunLogs` returns equals the input bytes exactly.
    const [readBack] = await agentStore.getRunLogs("agent-1", "run-1");
    expect(readBack?.detail).toBe(detail);
    expect(readBack?.detailSpill).toBeUndefined();

    // Decision 2's identity premise, re-proved here: the run pool's referrer resolves from path arithmetic.
    const tasksDir = join(agentRoot, ".fusion", "tasks");
    expect(dirname(join(agentRoot, ".fusion", "agents"))).toBe(dirname(tasksDir));
    agentStore.close();
    rmSync(agentRoot, { recursive: true, force: true });
  });

  it("resolves the pointer in every getRunLogs shape, including a limited page", async () => {
    const agentRoot = mkdtempSync(join(tmpdir(), "fusion-rufu340-run2-"));
    mkdirSync(join(agentRoot, ".fusion", "agents"), { recursive: true });
    const agentStore = new AgentStore({ rootDir: join(agentRoot, ".fusion") });
    const detail = oversizedDetail();

    await agentStore.appendRunLog("agent-1", "run-1", {
      timestamp: new Date().toISOString(), taskId: TASK_ID, text: "a", type: "tool_result", detail,
    });
    await agentStore.appendRunLog("agent-1", "run-1", {
      timestamp: new Date().toISOString(), taskId: TASK_ID, text: "b", type: "tool_result", detail,
    });

    const all = await agentStore.getRunLogs("agent-1", "run-1");
    const limited = await agentStore.getRunLogs("agent-1", "run-1", { limit: 1 });

    expect(all).toHaveLength(2);
    expect(all.every((entry) => entry.detail === detail)).toBe(true);
    expect(limited).toHaveLength(1);
    expect(limited[0]?.detail).toBe(detail);
    expect(limited[0]?.detailSpill).toBeUndefined();
    agentStore.close();
    rmSync(agentRoot, { recursive: true, force: true });
  });
});

describe("carrier census: structural carriers", () => {
  /**
   * These two carriers ARE their field lists: `flushPendingEntries` builds NEW objects for the batch call
   * (which is what preserves the caller's entry for the run-log fan-out) and the positional fallback has no
   * pointer slot at all. A behavior test cannot reach either without mocking the seam away, which is the one
   * thing forbidden, so the guard is structural — asserted on the call shape, not on a comment.
   */
  const engineLogger = () => {
    const path = resolve(__dirname, "../../../engine/src/agents/agent-logger.ts");
    return readFileSync(path, "utf8");
  };

  it("lists the pointer in flushPendingEntries' hand-written batch literal", () => {
    const source = engineLogger();
    const batchCall = source.slice(source.indexOf("appendAgentLogBatch("));
    const literal = batchCall.slice(0, batchCall.indexOf(".catch("));

    expect(literal).toContain("detailSpill");
    expect(literal).toContain("detail: entry.detail");
    // The literal must stay a literal: a spread would silently share the caller's pointer across sinks.
    expect(literal).not.toContain("...entry");
  });

  it("leaves the positional fallback pointer-less on purpose, sourcing the pointer from the sink's seam", () => {
    const source = engineLogger();
    const fallback = source.slice(source.indexOf("appendAgentLog(entry.taskId"));
    const call = fallback.slice(0, fallback.indexOf(")") + 1);

    expect(call).toContain("entry.detail");
    expect(call).not.toContain("detailSpill");
  });

  it("keeps the engine memory ceiling above the inline bound so overflow spills instead of truncating", () => {
    const source = engineLogger();
    const declared = /TOOL_RESULT_MEMORY_CEILING\s*=\s*([\d_]+)/.exec(source);
    expect(declared).not.toBeNull();
    const ceiling = Number(declared![1].replace(/_/g, ""));
    expect(ceiling).toBeGreaterThan(AGENT_LOG_TOOL_DETAIL_LIMIT);
    // The producer must not hold an inline bound of its own any more.
    expect(source).not.toMatch(/^\s*const TOOL_RESULT_DETAIL_LIMIT\b/m);
    expect(source).not.toMatch(/^\s*const TOOL_RESULT_DETAIL_TRUNCATION_NOTICE\b/m);
    expect(source).not.toMatch(/^\s*function truncateToolResultDetail\b/m);
  });
});
