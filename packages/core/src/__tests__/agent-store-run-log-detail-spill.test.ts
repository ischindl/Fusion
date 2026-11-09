import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

/*
FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
This file replaces `agent-store-run-log-detail-bound.test.ts`, which asserted the contract this card removes:
that the run-log sink cuts `detail` at the inline bound and pastes
`AGENT_LOG_TOOL_DETAIL_TRUNCATION_NOTICE` into the durable row. A test that pins a deliberately removed contract
guards nothing, so the assertions are replaced rather than loosened. What is RETAINED here on purpose is the
64 KB outer guard on `text`: RUFU-340 does not touch the `text` contract, and this is the only place that guard
is covered.
*/
import type { AgentLogEntry } from "../types.js";
import { AgentStore } from "../agents/agent-store.js";
import { AGENT_LOG_TOOL_DETAIL_LIMIT } from "../agents/agent-log-constants.js";
import { AGENT_LOG_DETAIL_SPILL_DIR, agentLogSpillDigest } from "../agents/agent-log-detail-spill.js";

/** Diacritic-heavy so the pointer's byte count differs from its character count by construction. */
function oversizedDetail(units = AGENT_LOG_TOOL_DETAIL_LIMIT * 3): string {
  const filler = "riadok sofsakého textu s díákrikami — ";
  const tail = "KONIEC: blokujúci stav, ktorý nesmie zmiznúť";
  let text = "";
  while (text.length < units - tail.length) text += filler;
  return `${text.slice(0, Math.max(0, units - tail.length))}${tail}`;
}

describe("AgentStore run-log detail spill", () => {
  let rootDir: string;
  let store: AgentStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "fusion-agent-run-log-spill-"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(rootDir, "agents"), { recursive: true });
    store = new AgentStore({ rootDir });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const durableRow = async (agentId: string, runId: string): Promise<AgentLogEntry> => {
    const raw = await readFile(join(rootDir, "agents", `${agentId}-runlogs-${runId}.jsonl`), "utf8");
    return JSON.parse(raw.trim()) as AgentLogEntry;
  };

  it("persists the prefix plus a pointer and returns the emitted bytes to the reader", async () => {
    const detail = oversizedDetail();
    const emitted: AgentLogEntry[] = [];
    store.on("run:log", (_agentId, _runId, entry) => emitted.push(entry));

    await store.appendRunLog("agent-001", "run-001", {
      timestamp: "2026-11-08T00:00:00.000Z",
      taskId: "RUFU-340",
      text: "fn_run_verification",
      type: "tool_result",
      detail,
    });

    const row = await durableRow("agent-001", "run-001");
    expect(row.detail).toBe(detail.slice(0, AGENT_LOG_TOOL_DETAIL_LIMIT));
    expect(row.detailSpill).toBeDefined();
    expect(row.detailSpill!.chars).toBe(detail.length);
    expect(row.detailSpill!.bytes).toBe(Buffer.byteLength(detail, "utf8"));
    // The payload is diacritic-heavy, so a byte count that merely repeated the char count would be a lie.
    expect(row.detailSpill!.bytes).toBeGreaterThan(row.detailSpill!.chars);
    expect(row.detailSpill!.digest).toBe(agentLogSpillDigest(detail));
    expect(row.detailSpill!.body).toContain(join(AGENT_LOG_DETAIL_SPILL_DIR, "run", "agent-001", "run-001"));

    // Emitted frame equals persisted row, pointer included.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.detail).toBe(row.detail);
    expect(emitted[0]!.detailSpill).toEqual(row.detailSpill);

    // Reader equals emitted bytes: the whole payload, with no pointer left to be written back.
    const [readBack] = await store.getRunLogs("agent-001", "run-001");
    expect(readBack!.detail).toBe(detail);
    expect(readBack!.detailSpill).toBeUndefined();
  });

  it("persists a payload far past the old 64 KB detail clamp whole, with no marker in the row", async () => {
    const detail = oversizedDetail(200_000);

    await store.appendRunLog("agent-002", "run-002", {
      timestamp: "2026-11-08T00:00:00.000Z",
      taskId: "RUFU-340",
      text: "bash",
      type: "tool_result",
      detail,
    });

    const raw = await readFile(join(rootDir, "agents", "agent-002-runlogs-run-002.jsonl"), "utf8");
    expect(raw).not.toMatch(/truncat/i);
    const [readBack] = await store.getRunLogs("agent-002", "run-002");
    expect(readBack!.detail).toBe(detail);
  });

  it("names the body by its content digest so an identical payload is stored once", async () => {
    const detail = oversizedDetail();

    await store.appendRunLog("agent-003", "run-003", {
      timestamp: "2026-11-08T00:00:00.000Z", taskId: "RUFU-340", text: "bash", type: "tool_result", detail,
    });
    await store.appendRunLog("agent-003", "run-003", {
      timestamp: "2026-11-08T00:00:01.000Z", taskId: "RUFU-340", text: "bash", type: "tool_result", detail,
    });

    const rows = await store.getRunLogs("agent-003", "run-003");
    expect(rows).toHaveLength(2);
    expect(rows.every((entry) => entry.detail === detail)).toBe(true);

    const producerDir = join(
      rootDir, AGENT_LOG_DETAIL_SPILL_DIR, "run", "agent-003", "run-003",
    );
    const digest = createHash("sha256").update(detail, "utf8").digest("hex");
    const body = await readFile(join(producerDir, `${digest}.txt`), "utf8");
    expect(body).toBe(detail);
    const listed = await stat(producerDir);
    expect(listed.isDirectory()).toBe(true);
  });

  it("redacts once at the seam, so a secret never reaches the body either", async () => {
    const detail = `authorization: Bearer sk-secretvalue1234567890\n${oversizedDetail()}`;

    await store.appendRunLog("agent-004", "run-004", {
      timestamp: "2026-11-08T00:00:00.000Z", taskId: "RUFU-340", text: "bash", type: "tool_result", detail,
    });

    const [readBack] = await store.getRunLogs("agent-004", "run-004");
    expect(readBack!.detail).toContain("[REDACTED]");
    expect(readBack!.detail).not.toContain("sk-secretvalue1234567890");
    // The pointer describes the stored bytes, not the bytes handed in — that is what makes it checkable.
    const row = await durableRow("agent-004", "run-004");
    const body = await readFile(row.detailSpill!.body, "utf8");
    expect(body).toBe(readBack!.detail);
    expect(row.detailSpill!.chars).toBe(body.length);
    expect(row.detailSpill!.bytes).toBe(Buffer.byteLength(body, "utf8"));
  });

  it("keeps the 64 KB outer guard for non-tool text, which this card does not touch", async () => {
    const oversizedText = "t".repeat(64 * 1024 + 1);

    await store.appendRunLog("agent-005", "run-005", {
      timestamp: "2026-11-08T00:00:00.000Z",
      taskId: "RUFU-340",
      text: oversizedText,
      type: "text",
    });

    const [persisted] = await store.getRunLogs("agent-005", "run-005");
    expect(persisted?.text).toContain(`... (truncated, ${oversizedText.length} chars)`);
    expect(persisted?.text.length).toBeGreaterThan(64 * 1024);
  });

  it("leaves a within-bound detail inline and pointer-free", async () => {
    const detail = "kompilac prebehol bez chýb";

    await store.appendRunLog("agent-006", "run-006", {
      timestamp: "2026-11-08T00:00:00.000Z", taskId: "RUFU-340", text: "bash", type: "tool_result", detail,
    });

    const row = await durableRow("agent-006", "run-006");
    expect(row.detail).toBe(detail);
    expect(row).not.toHaveProperty("detailSpill");
  });
});
