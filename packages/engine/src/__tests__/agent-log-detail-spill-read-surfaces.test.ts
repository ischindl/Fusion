import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore, type AgentLogEntry, type TaskStore } from "@fusion/core";
import {
  appendAgentLogEntriesSync,
  readAgentLogEntries,
} from "../../../core/src/agents/agent-log-file-store.js";
import { AGENT_LOG_DETAIL_SPILL_DIR } from "../../../core/src/index.js";
import { AGENT_LOG_TOOL_DETAIL_LIMIT } from "../../../core/src/agents/agent-log-constants.js";
import { AgentLogger } from "../agents/agent-logger.js";
import {
  AGENT_LOG_READ_DETAIL_PREVIEW_MAX,
  buildTaskAgentLogReadText,
  renderAgentLogEntries,
} from "../agent-tools.js";

/*
FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
The read-surface half of the spill card. Every surface that shows a tool payload now receives the FULL spilled
body from the storage reader, so what these tests pin is the two-sided contract: (1) a surface asked for the
whole payload gets the exact bytes that were emitted, tail section included, and (2) a surface that asks for a
preview says so with a real count and a real remedy. Before this card the preview's own sentence told the
reader to "use detail: full … to retrieve the complete payload" while no copy of the remainder existed
anywhere; that sentence is only honest now that the remainder is on disk.
*/

vi.mock("../logger.js", () => ({
  createLogger: () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const TASK_ID = "RUFU-340";
const TAIL = "ODDELOK 4: konkretne blokujuci stav A/B";

/** Section-4-shaped payload: the decision statement sits past the inline bound, in a section that survives. */
function payloadWithTail(units = AGENT_LOG_TOOL_DETAIL_LIMIT * 2): string {
  const filler = "riadok sofsakého textu s díákrikami — ";
  let text = "";
  while (text.length < units - TAIL.length) text += filler;
  return `${text.slice(0, Math.max(0, units - TAIL.length))}${TAIL}`;
}

let taskDir = "";
let agentRoot = "";

/*
FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
`writeEntry` fires an IMMEDIATE flush without awaiting it (`void this.flushPendingEntries()`), so `await
logger.flush()` only joins the buffer IT still owns — a tool row already handed to that detached flush can still
be mid-write when the call resolves. Reading the JSONL right then was a real flake (a half-written line parsed as
"unterminated string"), so every sink in this file registers its write here and the tests drain the list before
reading. Production is unaffected: the session end awaits the logger's own flush of everything it buffered.
*/
const inFlightWrites: Promise<unknown>[] = [];

function trackWrite<T extends Promise<unknown>>(write: T): T {
  inFlightWrites.push(write);
  return write;
}

async function settleWrites(): Promise<void> {
  for (let pass = 0; pass < 6; pass += 1) {
    const pending = inFlightWrites.splice(0);
    if (pending.length > 0) {
      await Promise.allSettled(pending);
      continue;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  taskDir = mkdtempSync(join(tmpdir(), "fusion-rufu340-read-"));
  agentRoot = mkdtempSync(join(tmpdir(), "fusion-rufu340-read-run-"));
  inFlightWrites.length = 0;
});

afterEach(() => {
  rmSync(taskDir, { recursive: true, force: true });
  rmSync(agentRoot, { recursive: true, force: true });
});

/** A store port backed by the production JSONL writer/reader, as in the RUFU-233 fidelity harness. */
function fileBackedStore(): TaskStore {
  return {
    appendAgentLogBatch: async (entries: Parameters<NonNullable<TaskStore["appendAgentLogBatch"]>>[0]) => {
      trackWrite(appendAgentLogEntriesSyncTask(taskDir, entries));
    },
  } as unknown as TaskStore;
}

function appendAgentLogEntriesSyncTask(taskDir: string, entries: Parameters<NonNullable<TaskStore["appendAgentLogBatch"]>>[0]): Promise<unknown> {
  return Promise.resolve().then(() => {
    appendAgentLogEntriesSync(taskDir, entries.map((entry) => ({ ...entry, timestamp: new Date().toISOString() })));
  });
}

describe("tool read surface: fn_task_logs_read", () => {
  function readText(detail: "preview" | "full"): string {
    const entries = readAgentLogEntries(taskDir, {});
    return buildTaskAgentLogReadText(entries, {
      taskId: TASK_ID,
      total: entries.length,
      limit: 25,
      offset: 0,
      detail,
    });
  }

  it("returns the emitted tail bytes when the caller asks for full detail", async () => {
    const detail = payloadWithTail();
    const logger = new AgentLogger({
      store: fileBackedStore(),
      taskId: TASK_ID,
      agent: "executor",
      persistAgentToolOutput: true,
    });

    logger.onToolEnd("bash", false, detail);
    await logger.flush();
    await settleWrites();

    const text = readText("full");
    expect(text).toContain(TAIL);
    // The persisted row itself carries no marker, so nothing here can be a loss notice.
    expect(text).not.toMatch(/\[tool output truncated/i);
    expect(text).not.toContain("[Detail preview truncated");
  });

  it("names the omitted count in preview mode and points at a remedy that now exists", () => {
    const detail = payloadWithTail();
    appendAgentLogEntriesSync(taskDir, [
      { timestamp: new Date().toISOString(), taskId: TASK_ID, text: "bash", type: "tool_result", detail },
    ]);

    const resolved = readAgentLogEntries(taskDir, {})[0]!;
    expect(resolved.detail).toBe(detail);

    const text = readText("preview");
    const omitted = /(\d+) characters omitted/.exec(text);
    expect(omitted).not.toBeNull();
    // The count is real: the preview plus the named remainder account for the whole payload, which is only
    // checkable because the payload the reader holds IS the emitted payload.
    const omittedCount = Number(omitted![1]);
    expect(omittedCount).toBeGreaterThan(0);
    expect(text).toContain(detail.slice(0, detail.length - omittedCount).slice(-120));
    expect(text).toContain('detail: "full"');
    expect(text).not.toContain(TAIL);

    // The renderer's bounded form and the tool's full form describe the SAME bytes — the preview is a view
    // decision, not a storage limit: `renderAgentLogEntries` clips, `detail: "full"` does not.
    expect(renderAgentLogEntries([resolved], { detailPreviewMax: AGENT_LOG_READ_DETAIL_PREVIEW_MAX }))
      .toContain("characters omitted");
    expect(renderAgentLogEntries([resolved])).toContain(TAIL);
  });

  it("shows a within-bound payload with no preview notice at all", () => {
    const detail = "kompilac prebehol bez chýb";
    appendAgentLogEntriesSync(taskDir, [
      { timestamp: new Date().toISOString(), taskId: TASK_ID, text: "bash", type: "tool_result", detail },
    ]);

    const text = readText("preview");
    expect(text).toContain(detail);
    expect(text).not.toContain("characters omitted");
  });

  /*
   * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
   * The response budget still exists — an agent's context is not an unbounded sink — but in full mode it now
   * gives up whole rows first and says so, and a cut that lands inside one oversized payload names its own size
   * instead of repeating advice that cannot be followed. This is the case the old byte-trim got wrong: at
   * `limit=1` a 40 KB payload was cut with a hint to lower the limit.
   */
  it("withholds whole rows and names the size when a full-detail response exceeds the budget", () => {
    const huge = payloadWithTail(40_000);
    appendAgentLogEntriesSync(taskDir, [
      { timestamp: new Date().toISOString(), taskId: TASK_ID, text: "prvy", type: "status" },
      { timestamp: new Date().toISOString(), taskId: TASK_ID, text: "bash", type: "tool_result", detail: huge },
    ]);

    const text = readText("full");
    expect(text.length).toBeLessThanOrEqual(12_000 + 400);
    expect(text).toContain("characters of the newest row exceed this response budget");
    expect(text).not.toContain("use a smaller limit, offset, or type filter for more");
    // The stored copy is untouched by any of this: the budget is a view bound, not a write bound.
    expect(readAgentLogEntries(taskDir, {})[1]!.detail).toBe(huge);
  });

  it("drops the older row rather than a slice of the payload when two complete rows cannot both fit", () => {
    const first = payloadWithTail(9_000);
    appendAgentLogEntriesSync(taskDir, [
      { timestamp: new Date().toISOString(), taskId: TASK_ID, text: "prvy", type: "tool_result", detail: first },
      { timestamp: new Date().toISOString(), taskId: TASK_ID, text: "druhy", type: "tool_result", detail: payloadWithTail(9_000) },
    ]);

    const text = readText("full");
    expect(text).toContain("1 older row withheld");
    expect(text).not.toContain("characters of the newest row exceed");
    expect(text.length).toBeLessThanOrEqual(12_000 + 400);
  });
});

describe("the two-producer fan-out (Decision 15)", () => {
  it("yields one pointer per sink, each resolvable to the same bytes, and keeps the caller's entry whole", async () => {
    const detail = payloadWithTail();
    mkdirSync(join(agentRoot, "agents"), { recursive: true });
    const agentStore = new AgentStore({ rootDir: agentRoot });
    const handedToRunSink: AgentLogEntry[] = [];

    const logger = new AgentLogger({
      store: fileBackedStore(),
      taskId: TASK_ID,
      agent: "executor",
      persistAgentToolOutput: true,
      appendLog: async (entry) => {
        handedToRunSink.push(entry);
        await trackWrite(agentStore.appendRunLog("agent-1", "run-1", entry));
      },
    });

    logger.onToolEnd("bash", false, detail);
    await logger.flush();
    await settleWrites();

    const taskRow = JSON.parse(
      readFileSync(join(taskDir, "agent-log.jsonl"), "utf8").trim().split("\n")[0]!,
    ) as AgentLogEntry;
    const runRow = JSON.parse(
      readFileSync(join(agentRoot, "agents", "agent-1-runlogs-run-1.jsonl"), "utf8").trim(),
    ) as AgentLogEntry;

    // Each sink owns its body: two rows, two producer directories, same digest.
    expect(taskRow.detailSpill!.body).toContain(join(AGENT_LOG_DETAIL_SPILL_DIR, "task", TASK_ID));
    expect(runRow.detailSpill!.body).toContain(join(AGENT_LOG_DETAIL_SPILL_DIR, "run", "agent-1", "run-1"));
    expect(runRow.detailSpill!.digest).toBe(taskRow.detailSpill!.digest);
    expect(taskRow.detail).toBe(runRow.detail);

    // Both bodies hold the emitted bytes.
    expect(readFileSync(taskRow.detailSpill!.body, "utf8")).toBe(detail);
    expect(readFileSync(runRow.detailSpill!.body, "utf8")).toBe(detail);

    // The fan-out must not have consumed the payload for the second sink.
    expect(handedToRunSink[0]!.detail).toBe(detail);

    // And each reader independently returns those bytes.
    expect(readAgentLogEntries(taskDir, {})[0]!.detail).toBe(detail);
    expect((await agentStore.getRunLogs("agent-1", "run-1"))[0]!.detail).toBe(detail);
    agentStore.close();
  });
});

/*
FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
Symptom verification, written against the reported failure rather than the fix. The original card ran a tool
whose result was a four-section report; sections 1-3 filled past character 4 096 and section 4 - the one holding
the concrete blocking state the executor then had to act on - was never seen again. Both layers cut it with the
SAME bound (the engine's `TOOL_RESULT_DETAIL_LIMIT` and the JSONL writer's inline bound were both 4 096), and
each left its own prose inside `detail`, so the surviving row read like evidence about the output rather than a
note about storage. The assertions below are the three things that were false then: the payload past the bound
still exists, the row says precisely how much of it it is holding, and no prose placeholder sits in a persisted
`detail`.
*/
describe("symptom: a decision statement past character 4096 survives", () => {
  const SECTION_4 = "ODDELOK 4: blokovany stav - chyla pristupovy token, osvedcenie je potrebne obnovit manualne.";

  function fourSectionReport(): string {
    const filler = "analyza vypisu nastroja, riadok za riadkom, bez dalsieho vyznamu - ";
    const body = (unit: string): string => {
      let chunk = "";
      while (chunk.length < 1_800) chunk += unit;
      return chunk;
    };
    const sections = [body(filler), body(filler), body(filler)];
    const prefix = sections.map((section, index) => `ODDELOK ${index + 1}\n${section}\n`).join("\n");
    expect(prefix.length).toBeGreaterThan(AGENT_LOG_TOOL_DETAIL_LIMIT);
    return `${prefix}ODDELOK 4\n${SECTION_4}`;
  }

  it("persists a pointer instead of a cut, and returns the section the old code destroyed", async () => {
    const report = fourSectionReport();
    const logger = new AgentLogger({
      store: fileBackedStore(),
      taskId: TASK_ID,
      agent: "executor",
      persistAgentToolOutput: true,
    });

    logger.onToolEnd("bash", false, report);
    await logger.flush();
    await settleWrites();

    const rawLine = readFileSync(join(taskDir, "agent-log.jsonl"), "utf8").trim();
    const persisted = JSON.parse(rawLine) as AgentLogEntry;

    // 1. What the old code wrote here was the payload's first 4 096 characters and nothing else.
    expect(persisted.detail).toHaveLength(AGENT_LOG_TOOL_DETAIL_LIMIT);
    expect(report.length).toBeGreaterThan(AGENT_LOG_TOOL_DETAIL_LIMIT);

    // 2. The row now names the whole payload exactly: chars, bytes, and the digest of the stored bytes.
    expect(persisted.detailSpill?.chars).toBe(report.length);
    expect(persisted.detailSpill?.bytes).toBe(Buffer.byteLength(report, "utf8"));

    // 3. Neither placeholder the card removes is representable in a persisted row.
    expect(rawLine.toLowerCase()).not.toContain("truncat");

    // The reported loss itself: the reader hands back section 4, and so does the agent-facing tool in full mode.
    expect(readAgentLogEntries(taskDir, {})[0]!.detail).toBe(report);
    const entries = readAgentLogEntries(taskDir, {});
    expect(buildTaskAgentLogReadText(entries, { taskId: TASK_ID, total: entries.length, limit: 25, offset: 0, detail: "full" }))
      .toContain(SECTION_4);
  });
});
