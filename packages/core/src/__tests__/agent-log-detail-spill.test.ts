import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
Partial `node:fs` mock, following the `agent-log-file-store.tail-window.test.ts` precedent: the real module is
kept and only `writeFileSync` is wrapped, so the seam still publishes for real and the test can arm exactly one
failing publish. That is how the Decision-3 promise is pinned — a content-addressed digest name must never
exist with half its bytes, because a file at that name is a promise nothing later can re-check.
*/
const tornPublish = vi.hoisted(() => ({ armed: false, leavePartial: false }));

/*
FNXC:AgentLogDetailSpill 2026-11-06-03:02 (RUFU-340):
The same mock also COUNTS reads. Code Review's third finding was a cost defect invisible to an assertion on
returned values: resolving spill bodies before pagination turned a bounded log page into a read of every spilled
body in the card's file — the whole-file read class RUFU-208 exists to police. A counted `node:fs` read is the only
way to pin a bound like that (the tail-window test sets the precedent); wall clock would prove nothing.
*/
const readCounter = vi.hoisted(() => ({ armed: false, spillBodyReads: 0, otherReads: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realWrite = actual.writeFileSync;
  const realRead = actual.readFileSync;
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof realWrite>) => {
      if (tornPublish.armed && typeof args[0] === "string" && args[0].endsWith(".partial")) {
        const error = new Error("simulated torn spill publish");
        if (tornPublish.leavePartial) realWrite.call(actual, args[0], args[1] as never, args[2] as never);
        throw error;
      }
      return realWrite.apply(actual, args as Parameters<typeof realWrite>);
    },
    readFileSync: (...args: Parameters<typeof realRead>) => {
      if (readCounter.armed && typeof args[0] === "string") {
        // Literal, not the imported constant: a `vi.mock` factory is hoisted above the imports, so the only
        // safe reference inside the wrapper is one that cannot be in a TDZ when node:fs first resolves.
        if (args[0].includes("agent-log-detail-spill")) readCounter.spillBodyReads += 1;
        else readCounter.otherReads += 1;
      }
      return realRead.apply(actual, args as Parameters<typeof realRead>);
    },
  } as typeof actual;
});

import {
  AGENT_LOG_DETAIL_SPILL_DIR,
  agentLogRunSpillDir,
  agentLogSpillDigest,
  agentLogTaskProducerDir,
  agentLogTaskSpillDir,
  spillAgentLogDetail,
  resolveAgentLogDetailForRead,
} from "../agents/agent-log-detail-spill.js";
import { AGENT_LOG_TOOL_DETAIL_LIMIT } from "../agents/agent-log-constants.js";
import { appendAgentLogEntriesSync, countAgentLogEntries, getAgentLogFilePath, readAgentLogEntries } from "../agents/agent-log-file-store.js";
import { getAgentLogsImpl } from "../task-store/task-artifacts-ops.js";
import type { TaskStore } from "../store.js";
import { redactSecrets } from "../secrets/redact-secrets.js";

let baseDir = "";
let taskDir = "";

beforeEach(() => {
  tornPublish.armed = false;
  tornPublish.leavePartial = false;
  baseDir = mkdtempSync(join(tmpdir(), "fusion-spill-"));
  taskDir = join(baseDir, "tasks", "RUFU-340");
  mkdirSync(taskDir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(baseDir, { recursive: true, force: true });
});

/** A payload of `units` UTF-16 code units whose tail is the only copy of the decision statement. */
function payload(units: number, tail = "SECTION-4: the blocking A/B decision") {
  const filler = "riadok sofsakého textu s díákrikami — ".repeat(400);
  let text = "";
  while (text.length < units - tail.length) text += filler;
  return `${text.slice(0, Math.max(0, units - tail.length))}${tail}`;
}

/**
 * Counted reads around one bounded read. Arming is per call so the fixture's own appends never enter the number.
 */
function measureSpillReads<T>(run: () => T | Promise<T>): Promise<{ result: T; spillBodyReads: number }> {
  return (async () => {
    readCounter.armed = true;
    readCounter.spillBodyReads = 0;
    readCounter.otherReads = 0;
    try {
      return { result: await run(), spillBodyReads: readCounter.spillBodyReads };
    } finally {
      readCounter.armed = false;
    }
  })();
}

describe("spillAgentLogDetail: the inline bound", () => {
  it("persists a detail exactly at the inline bound with no spill and no file written", () => {
    const detail = payload(AGENT_LOG_TOOL_DETAIL_LIMIT);
    expect(detail.length).toBe(AGENT_LOG_TOOL_DETAIL_LIMIT);

    const { detail: persisted, spill } = spillAgentLogDetail({ detail, type: "tool_result" }, agentLogTaskSpillDir(baseDir, "T-1"));

    expect(persisted).toBe(detail);
    expect(spill).toBeUndefined();
    expect(existsSync(join(baseDir, AGENT_LOG_DETAIL_SPILL_DIR))).toBe(false);
  });

  it("spills one code unit over the bound and names exact chars, bytes, and digest, with no prose marker", () => {
    const detail = payload(AGENT_LOG_TOOL_DETAIL_LIMIT + 1);
    const producerDir = agentLogTaskSpillDir(baseDir, "T-1");

    const { detail: persisted, spill } = spillAgentLogDetail({ detail, type: "tool_result" }, producerDir);

    expect(spill).toBeDefined();
    expect(persisted).toBe(detail.slice(0, AGENT_LOG_TOOL_DETAIL_LIMIT));
    // The whole defect class this card deletes: a loss marker written into the row.
    expect(persisted).not.toMatch(/truncat/i);
    expect(spill!.chars).toBe(detail.length);
    expect(spill!.bytes).toBe(Buffer.byteLength(detail, "utf8"));
    expect(spill!.digest).toBe(agentLogSpillDigest(detail));
    expect(spill!.body).toBe(join(producerDir, `${spill!.digest}.txt`));

    const body = readFileSync(spill!.body, "utf8");
    expect(body).toBe(detail);
    expect(Buffer.byteLength(body, "utf8")).toBe(spill!.bytes);
    // Diacritic-heavy payload (the saneca shape): bytes legitimately exceed code units and are recorded honestly.
    expect(spill!.bytes).toBeGreaterThan(spill!.chars);
  });

  it("never spills a non-tool detail, because only tool payload is bounded", () => {
    const text = payload(AGENT_LOG_TOOL_DETAIL_LIMIT * 4);

    const { detail: persisted, spill } = spillAgentLogDetail({ detail: text, type: "status" }, agentLogTaskSpillDir(baseDir, "T-1"));

    expect(persisted).toBe(text);
    expect(spill).toBeUndefined();
  });

  it("never mutates the entry handed to it, so a second sink still sees the full detail", () => {
    const detail = payload(AGENT_LOG_TOOL_DETAIL_LIMIT * 2);
    const entry = { detail, type: "tool_result" as const };

    spillAgentLogDetail(entry, agentLogTaskSpillDir(baseDir, "T-1"));

    expect(entry.detail).toBe(detail);
    expect(Object.keys(entry)).toEqual(["detail", "type"]);
  });
});

describe("spillAgentLogDetail: content addressing and per-sink ownership", () => {
  it("writes one file for the same payload spilled twice by one sink and returns an identical pointer", () => {
    const detail = payload(AGENT_LOG_TOOL_DETAIL_LIMIT * 2);
    const producerDir = agentLogTaskSpillDir(baseDir, "T-1");

    const first = spillAgentLogDetail({ detail, type: "tool_result" }, producerDir);
    const second = spillAgentLogDetail({ detail, type: "tool_result" }, producerDir);

    expect(second.spill).toEqual(first.spill);
    expect(readdirSync(producerDir)).toEqual([`${first.spill!.digest}.txt`]);
  });

  it("re-spills nothing when handed a row that already carries this sink's pointer", () => {
    const detail = payload(AGENT_LOG_TOOL_DETAIL_LIMIT * 2);
    const producerDir = agentLogTaskSpillDir(baseDir, "T-1");
    const first = spillAgentLogDetail({ detail, type: "tool_result" }, producerDir);
    const bodyMtime = readFileSync(first.spill!.body, "utf8");

    // The replay shape: prefix + pointer handed back to the seam.
    const replay = spillAgentLogDetail(
      { detail: first.detail, type: "tool_result", detailSpill: first.spill },
      producerDir,
    );

    expect(replay.detail).toBe(first.detail);
    expect(replay.spill).toEqual(first.spill);
    expect(readFileSync(first.spill!.body, "utf8")).toBe(bodyMtime);
    expect(readdirSync(producerDir)).toHaveLength(1);
  });

  it("gives each sink its own body under its own producer directory while both hold the same bytes", () => {
    const detail = payload(AGENT_LOG_TOOL_DETAIL_LIMIT * 2);
    const taskDir0 = agentLogTaskSpillDir(baseDir, "T-1");
    const runDir = agentLogRunSpillDir(baseDir, "agent-1", "run-1");

    const taskSide = spillAgentLogDetail({ detail, type: "tool_result" }, taskDir0);
    const runSide = spillAgentLogDetail({ detail, type: "tool_result" }, runDir);

    expect(taskSide.spill!.body).toContain(join(AGENT_LOG_DETAIL_SPILL_DIR, "task", "T-1"));
    expect(runSide.spill!.body).toContain(join(AGENT_LOG_DETAIL_SPILL_DIR, "run", "agent-1", "run-1"));
    expect(taskSide.spill!.digest).toBe(runSide.spill!.digest);
    expect(taskSide.spill!.body).not.toBe(runSide.spill!.body);
    expect(readFileSync(taskSide.spill!.body, "utf8")).toBe(readFileSync(runSide.spill!.body, "utf8"));
  });

  it("refuses to honour a pointer from another producer directory", () => {
    const detail = payload(AGENT_LOG_TOOL_DETAIL_LIMIT * 2);
    const taskSide = spillAgentLogDetail({ detail, type: "tool_result" }, agentLogTaskSpillDir(baseDir, "T-1"));
    const runDir = agentLogRunSpillDir(baseDir, "agent-1", "run-1");

    // A run-log row replaying a TASK-side prefix+pointer must never address the task pool.
    const runSide = spillAgentLogDetail(
      { detail: taskSide.detail, type: "tool_result", detailSpill: taskSide.spill },
      runDir,
    );

    expect(runSide.spill).toBeUndefined();
    expect(runSide.detail).toBe(taskSide.detail);
    expect(existsSync(runDir)).toBe(false);
    // The task-side body survives untouched, so the log that DOES reference it still resolves.
    expect(readFileSync(taskSide.spill!.body, "utf8")).toBe(detail);
  });

  it("derives the task-side producer directory from the task directory the caller already owns", () => {
    expect(agentLogTaskProducerDir(taskDir, "RUFU-340")).toBe(agentLogTaskSpillDir(baseDir, "RUFU-340"));
  });
});

describe("spillAgentLogDetail: redaction is a durability-seam invariant", () => {
  // One case per rule in `secrets/redact-secrets.ts`: a rule whose `[REDACTED]` output did NOT map back to
  // itself would let the engine path's second redaction change bytes that a digest already names.
  const rules: Array<{ name: string; input: string }> = [
    { name: "authorization header", input: "authorization: Bearer abcDEF123456-xyz" },
    { name: "bearer token", input: "header says Bearer abcDEF123456xyz please" },
    { name: "key assignment", input: "api_key = \"sup3rS3cretValue\" done" },
    { name: "opaque token prefix", input: "using sk-abcdef123456789 for auth" },
    { name: "long base64", input: `blob ${"Q".repeat(48)}= end` },
    { name: "long hex", input: `sha ${"0123456789abcdef".repeat(2)} end` },
  ];

  it.each(rules)("redaction rule '$name' survives the engine's double redaction and matches its naming digest", ({ input }) => {
    // The engine path redacts the same string twice — once in `AgentLogger.writeEntry`, once in the seam.
    // A rule whose `[REDACTED]` output did NOT map back to itself would let that second pass change the bytes
    // that the spill file's digest already names, so the body would silently stop matching its own address.
    const raw = `${input} ${payload(AGENT_LOG_TOOL_DETAIL_LIMIT * 2)}`;
    const once = redactSecrets(raw);
    expect(once).toContain("[REDACTED]");
    expect(redactSecrets(once)).toBe(once);

    const producerDir = agentLogTaskSpillDir(baseDir, "T-1");
    const fromRaw = spillAgentLogDetail({ detail: raw, type: "tool_result" }, producerDir);
    const fromRedacted = spillAgentLogDetail({ detail: once, type: "tool_result" }, producerDir);

    expect(fromRedacted.spill!.digest).toBe(fromRaw.spill!.digest);
    expect(fromRedacted.detail).toBe(fromRaw.detail);
    const body = readFileSync(fromRaw.spill!.body, "utf8");
    expect(body).toBe(once);
    expect(body).not.toContain(input);
    expect(agentLogSpillDigest(body)).toBe(fromRaw.spill!.digest);
  });

  it("redacts a secret out of the spill body even when the producer handed raw text", () => {
    const detail = `token=ghp_secretvalue1234567890\n${payload(AGENT_LOG_TOOL_DETAIL_LIMIT * 2)}`;

    const { spill } = spillAgentLogDetail({ detail, type: "tool_error" }, agentLogTaskSpillDir(baseDir, "T-1"));
    const body = readFileSync(spill!.body, "utf8");

    expect(body).toContain("[REDACTED]");
    expect(body).not.toContain("ghp_secretvalue1234567890");
  });
});

describe("spillAgentLogDetail: failure modes stay honest", () => {
  it("returns the inline prefix without throwing when the spill body is missing", () => {
    const detail = payload(AGENT_LOG_TOOL_DETAIL_LIMIT * 2);
    const { detail: prefix, spill } = spillAgentLogDetail({ detail, type: "tool_result" }, agentLogTaskSpillDir(baseDir, "T-1"));
    unlinkSync(spill!.body);

    const resolved = resolveAgentLogDetailForRead({ detail: prefix, detailSpill: spill });

    expect(resolved.detail).toBe(prefix);
    expect(resolved.detailSpill).toBeUndefined();
    expect(resolved.detail).not.toMatch(/truncat/i);
  });

  it("returns the inline prefix without throwing when the spill body is unreadable", () => {
    const detail = payload(AGENT_LOG_TOOL_DETAIL_LIMIT * 2);
    const { detail: prefix, spill } = spillAgentLogDetail({ detail, type: "tool_result" }, agentLogTaskSpillDir(baseDir, "T-1"));
    chmodSync(spill!.body, 0o000);

    /*
     * A privileged test user can still read a 0o000 file, so this pins the contract that holds either way:
     * the reader never throws and never invents bytes — it returns the spilled body when it can read it and
     * the honest inline prefix when it cannot, and never a marker.
     */
    const value = resolveAgentLogDetailForRead({ detail: prefix, detailSpill: spill });
    expect(value.detail === prefix || value.detail === detail).toBe(true);
    expect(value.detail).not.toMatch(/truncat/i);
    chmodSync(spill!.body, 0o600);
  });

  it("leaves nothing at the digest name when the publish fails, and no partial either", () => {
    const detail = payload(AGENT_LOG_TOOL_DETAIL_LIMIT * 2);
    const producerDir = agentLogTaskSpillDir(baseDir, "T-1");
    tornPublish.armed = true;

    const { detail: prefix, spill } = spillAgentLogDetail({ detail, type: "tool_result" }, producerDir);

    expect(spill).toBeUndefined();
    expect(prefix).toBe(detail.slice(0, AGENT_LOG_TOOL_DETAIL_LIMIT));
    expect(readdirSync(producerDir)).toEqual([]);
  });

  it("removes the partial it wrote when the rename fails after a partial survived", () => {
    const detail = payload(AGENT_LOG_TOOL_DETAIL_LIMIT * 2);
    const producerDir = agentLogTaskSpillDir(baseDir, "T-1");
    tornPublish.armed = true;
    tornPublish.leavePartial = true;

    spillAgentLogDetail({ detail, type: "tool_result" }, producerDir);

    expect(readdirSync(producerDir)).toEqual([]);
  });

  it("survives a payload that looks like nested cyclic JSON structure without changing its bytes", () => {
    // A string cannot hold a real cycle; the engine's `[Circular]` substitution is what makes cyclic tool
    // results representable, and this pins that such a rendered payload still round-trips byte-identically.
    const cyclicish = `${"[{\"a\":".repeat(2000)}${"[Circular]"}${"}]".repeat(2000)}`;

    const { spill } = spillAgentLogDetail({ detail: cyclicish, type: "tool_result" }, agentLogTaskSpillDir(baseDir, "T-1"));

    expect(readFileSync(spill!.body, "utf8")).toBe(cyclicish);
  });

  it("writes a raw file, not an envelope, so the body is exactly the redacted detail bytes", () => {
    // Diacritic-heavy filler, because a plain ASCII run would itself be redacted as a long base64 secret.
    const detail = `${payload(AGENT_LOG_TOOL_DETAIL_LIMIT + 40)}TAIL`;

    const { spill } = spillAgentLogDetail({ detail, type: "tool" }, agentLogTaskSpillDir(baseDir, "T-1"));
    const raw = readFileSync(spill!.body, "utf8");

    expect(raw).toBe(detail);
    expect(raw).not.toMatch(/"(digest|chars|bytes)"/);
  });
});

/*
FNXC:AgentLogDetailSpill 2026-11-06-02:05 (RUFU-340, Decision 12):
The inline cap is what keeps RUFU-208's O(tail) append cheap, so the largest row this card can produce is pinned
against the 64 KiB tail window rather than trusted: a maximum-size inline detail still leaves the whole row
*inside* the window, and appends after it number exactly. A spilled row is smaller still, because its detail is
replaced by a bounded prefix plus a short pointer. If a future change moves the inline cap or grows the pointer,
this case goes red at the size assertion first, which is the measurement Decision 12 asked for — a warm-cache
size miscount is a cost bug, not a numbering bug.
*/
describe("a worst-case inline row stays inside the tail window and numbers exactly", () => {
  // Module-private in the store; mirrored deliberately, the same way agent-log-file-store.tail-window.test.ts does.
  const TAIL_WINDOW_BYTES = 64 * 1024;

  it("keeps the biggest inline row under the window and every later line number exact", () => {
    const dir = join(baseDir, "tasks", "RUFU-340-TAIL");
    mkdirSync(dir, { recursive: true });

    const maxInline = payload(AGENT_LOG_TOOL_DETAIL_LIMIT);
    const first = appendAgentLogEntriesSync(dir, [
      { timestamp: "2026-01-01T00:00:00.000Z", taskId: "RUFU-340-TAIL", text: "bash", type: "tool_result", detail: maxInline, agent: "executor", durationMs: 12 },
    ]);

    const rowBytes = Buffer.byteLength(readFileSync(getAgentLogFilePath(dir), "utf8"), "utf8");
    expect(rowBytes).toBeLessThan(TAIL_WINDOW_BYTES);
    expect(first[0]?.sourceRef).toBe("agentLog:RUFU-340-TAIL:1");

    for (let i = 0; i < 5; i += 1) {
      const appended = appendAgentLogEntriesSync(dir, [
        { timestamp: `2026-01-01T00:0${i + 1}:00.000Z`, taskId: "RUFU-340-TAIL", text: "bash", type: "tool_result", detail: maxInline, agent: "executor" },
      ]);
      expect(appended[0]?.sourceRef).toBe(`agentLog:RUFU-340-TAIL:${i + 2}`);
    }

    const rows = readAgentLogEntries(dir);
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.sourceRef)).toEqual([
      "agentLog:RUFU-340-TAIL:1",
      "agentLog:RUFU-340-TAIL:2",
      "agentLog:RUFU-340-TAIL:3",
      "agentLog:RUFU-340-TAIL:4",
      "agentLog:RUFU-340-TAIL:5",
      "agentLog:RUFU-340-TAIL:6",
    ]);
    // Every row keeps its full inline bytes: numbering stayed exact without any line being clipped.
    expect(rows.every((row) => row.detail === maxInline)).toBe(true);
  });

  it("numbers exactly for a spilled row too, whose inline half is bounded by the prefix plus pointer", () => {
    const dir = join(baseDir, "tasks", "RUFU-340-SPILL-TAIL");
    mkdirSync(dir, { recursive: true });

    const spilled = appendAgentLogEntriesSync(dir, [
      { timestamp: "2026-01-01T00:00:00.000Z", taskId: "RUFU-340-SPILL-TAIL", text: "bash", type: "tool_result", detail: payload(AGENT_LOG_TOOL_DETAIL_LIMIT * 3), agent: "executor" },
    ]);
    expect(spilled[0]?.detailSpill).toBeDefined();

    const next = appendAgentLogEntriesSync(dir, [
      { timestamp: "2026-01-01T00:01:00.000Z", taskId: "RUFU-340-SPILL-TAIL", text: "ls", type: "tool_result", detail: "ok", agent: "executor" },
    ]);
    expect(next[0]?.sourceRef).toBe("agentLog:RUFU-340-SPILL-TAIL:2");
    // The reader resolves the body, so the row it hands back is bigger than the row on disk.
    expect(readAgentLogEntries(dir)[0]?.detail).toHaveLength(AGENT_LOG_TOOL_DETAIL_LIMIT * 3);
  });
});

/*
FNXC:AgentLogDetailSpill 2026-11-06-03:02 (RUFU-340):
The read-COST half of this card, pinned by counted `node:fs` reads rather than argued in prose. Code Review's third
finding: resolving pointers inside the whole-file parse turned a bounded page into a read of every spilled body in
the card's log - the whole-file read cost class RUFU-208 exists to police, reintroduced on the route that serves
`getAgentLogsImpl` (the `fn_task_logs_read` tool, the dashboard Raw Logs view, and the task log stream refresh). A
limited page now resolves the rows it returns, the same ordering `getRunLogs` already uses for run logs.
*/
describe("a bounded page pays only for the bodies it returns", () => {
  const SPILLED_ROWS = 6;

  /** Seeds a card log where every row spilled its own body; returns the payloads oldest-first. */
  function seedSpilledLog(rows = SPILLED_ROWS): string[] {
    const details: string[] = [];
    for (let index = 0; index < rows; index += 1) {
      details.push(payload(AGENT_LOG_TOOL_DETAIL_LIMIT * 2, `ODDELOK 4 riadok ${index}`));
    }
    appendAgentLogEntriesSync(taskDir, details.map((detail, index) => ({
      timestamp: `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
      taskId: "RUFU-340",
      text: `bash-${index}`,
      type: "tool_result" as const,
      detail,
    })));
    return details;
  }

  it("reads exactly the spilled bodies inside the requested window, never the whole pool", async () => {
    const details = seedSpilledLog();

    const page = await measureSpillReads(() => readAgentLogEntries(taskDir, { limit: 2 }));
    expect(page.result.map((entry) => entry.detail)).toEqual(details.slice(-2));
    // The bound itself: two rows returned, two body reads. Before the fix this counted SPILLED_ROWS.
    expect(page.spillBodyReads).toBe(2);

    // The counter is not blind - an unbounded read really does resolve every body in the file.
    const whole = await measureSpillReads(() => readAgentLogEntries(taskDir, {}));
    expect(whole.spillBodyReads).toBe(SPILLED_ROWS);
  });

  it("reads ZERO spill bodies for a count and for an empty page", async () => {
    seedSpilledLog();

    const count = await measureSpillReads(() => countAgentLogEntries(taskDir));
    expect(count.result).toBe(SPILLED_ROWS);
    expect(count.spillBodyReads).toBe(0);

    const emptyPage = await measureSpillReads(() => readAgentLogEntries(taskDir, { limit: 0 }));
    expect(emptyPage.result).toHaveLength(0);
    expect(emptyPage.spillBodyReads).toBe(0);
  });

  it("pins the bound at the production seam getAgentLogsImpl reads through", async () => {
    const details = seedSpilledLog();
    // The only members the real op touches: the buffer flush it calls first, then the path join it reads from.
    const store = {
      flushAgentLogBuffer: () => {},
      taskDir: (id: string) => join(baseDir, "tasks", id),
    } as unknown as TaskStore;

    const bounded = await measureSpillReads(() => getAgentLogsImpl(store, "RUFU-340", { limit: 1 }));
    expect(bounded.result.map((entry) => entry.detail)).toEqual([details[SPILLED_ROWS - 1]]);
    expect(bounded.spillBodyReads).toBe(1);
  });
});
