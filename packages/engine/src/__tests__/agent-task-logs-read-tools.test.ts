import { describe, expect, it, vi } from "vitest";
import type { AgentLogEntry, TaskStore } from "@fusion/core";
import {
  AGENT_LOG_READ_DETAIL_PREVIEW_MAX,
  createChatTaskLogsReadTool,
  createTaskLogsReadTool,
  normalizeAgentLogPaging,
} from "../agent-tools.js";

const TASK_ID = "FN-8058";

function entry(text: string, type: AgentLogEntry["type"], detail?: string): AgentLogEntry {
  return { taskId: TASK_ID, timestamp: "2026-07-16T00:00:00.000Z", text, type, agent: "executor", detail };
}

function storeWith(entries: AgentLogEntry[]) {
  const getAgentLogs = vi.fn(async (_taskId: string, options?: { limit?: number; offset?: number; type?: AgentLogEntry["type"] }) => {
    const filtered = options?.type ? entries.filter((item) => item.type === options.type) : entries;
    const end = filtered.length - (options?.offset ?? 0);
    return filtered.slice(Math.max(0, end - (options?.limit ?? filtered.length)), Math.max(0, end));
  });
  const getAgentLogCount = vi.fn(async (_taskId: string, options?: { type?: AgentLogEntry["type"] }) => (
    options?.type ? entries.filter((item) => item.type === options.type).length : entries.length
  ));
  return { store: { getAgentLogs, getAgentLogCount } as unknown as TaskStore, getAgentLogs, getAgentLogCount };
}

async function run(tool: ReturnType<typeof createTaskLogsReadTool> | ReturnType<typeof createChatTaskLogsReadTool>, params: Record<string, unknown>) {
  return tool.execute("call", params as never, undefined, undefined, undefined);
}

/*
FNXC:TaskLogsRead 2026-09-09-15:19:
RUFU-204: a fake store whose answer is keyed by the id it was ASKED for. The pre-fix task-bound tool
ignored the id, so a store that returns per-task rows is the minimal instrument that distinguishes
"honored the target" from "silently read the bound card" — the exact defect. Rows for the bound card (B)
are stamped fresh; rows for the requested card (A) are stamped stale, so a regression that hands back B's
log would also hand back B's freshness (inverting stall detection). Both are asserted.
*/
function storeByKey(logs: Record<string, AgentLogEntry[]>) {
  const getAgentLogs = vi.fn(async (taskId: string, options?: { limit?: number; offset?: number; type?: AgentLogEntry["type"] }) => {
    const entries = logs[taskId] ?? [];
    const filtered = options?.type ? entries.filter((item) => item.type === options.type) : entries;
    const end = filtered.length - (options?.offset ?? 0);
    return filtered.slice(Math.max(0, end - (options?.limit ?? filtered.length)), Math.max(0, end));
  });
  const getAgentLogCount = vi.fn(async (taskId: string, options?: { type?: AgentLogEntry["type"] }) => {
    const entries = logs[taskId] ?? [];
    return options?.type ? entries.filter((item) => item.type === options.type).length : entries.length;
  });
  return { store: { getAgentLogs, getAgentLogCount } as unknown as TaskStore, getAgentLogs, getAgentLogCount };
}

function entryFor(taskId: string, timestamp: string, text: string, type: AgentLogEntry["type"] = "text"): AgentLogEntry {
  return { taskId, timestamp, text, type, agent: "executor" };
}

const BOUND_ID = "FN-BOUND";
const OTHER_ID = "FN-OTHER";
const BOUND_STAMP = "2026-09-09T11:26:00.000Z";
const OTHER_STAMP = "2026-09-08T00:00:00.000Z";

describe("fn_task_logs_read", () => {
  it("normalizes paging rather than relying on schema defaults", () => {
    expect(normalizeAgentLogPaging()).toEqual({ limit: 100, offset: 0 });
    expect(normalizeAgentLogPaging(-1, -1)).toEqual({ limit: 100, offset: 0 });
    expect(normalizeAgentLogPaging(0, Number.NaN)).toEqual({ limit: 100, offset: 0 });
    expect(normalizeAgentLogPaging(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toEqual({ limit: 100, offset: 0 });
    expect(normalizeAgentLogPaging(3.9, 2.9)).toEqual({ limit: 3, offset: 2 });
  });

  it("filters before pagination, reports the filtered total, and renders detail", async () => {
    const { store, getAgentLogs, getAgentLogCount } = storeWith([
      entry("old", "text"), entry("tool output", "tool_result", "persisted result"), entry("new", "text"),
    ]);
    const result = await run(createTaskLogsReadTool(store, TASK_ID), { limit: 1, type: "text" });
    const text = result.content[0].text;
    expect(getAgentLogs).toHaveBeenCalledWith(TASK_ID, { limit: 1, offset: 0, type: "text" });
    expect(getAgentLogCount).toHaveBeenCalledWith(TASK_ID, { type: "text" });
    expect(text).toContain("1/2 entries");
    const detailResult = await run(createTaskLogsReadTool(store, TASK_ID), { type: "tool_result" });
    expect(detailResult.content[0].text).toContain("persisted result");
  });

  it("preserves adjacent streamed rows and status blocks without a persisted run boundary", async () => {
    const { store } = storeWith([
      entry("Done.", "text"), entry("Starting review", "text"), entry("complete status", "status"), entry("next", "text"),
    ]);
    const result = await run(createTaskLogsReadTool(store, TASK_ID), {});
    const text = result.content[0].text;
    expect(text).toContain("text (executor)\nDone.\n\n[2026-07-16T00:00:00.000Z] text (executor)\nStarting review");
    expect(text).not.toContain("Done.Starting review");
    expect(text).toContain("status (executor)\ncomplete status");
    expect(text).toContain("\n\n[");
  });

  it("caps long logs while retaining the paging header and narrowing hint", async () => {
    const { store } = storeWith([entry("x".repeat(20_000), "tool_result")]);
    const result = await run(createTaskLogsReadTool(store, TASK_ID), { limit: 1 });
    expect(result.content[0].text.length).toBeLessThanOrEqual(12_000);
    expect(result.content[0].text).toContain("Agent log (FN-8058): 1/1 entries");
    expect(result.content[0].text).toContain("smaller limit, offset, or type filter");
  });

  it("bounds each previewed detail row with an elision marker", async () => {
    const detail = "x".repeat(AGENT_LOG_READ_DETAIL_PREVIEW_MAX + 300);
    const { store } = storeWith([entry("tool output", "tool_result", detail)]);
    const result = await run(createTaskLogsReadTool(store, TASK_ID), { detail: "preview" });
    const text = result.content[0].text;
    const preview = text.split("Detail:\n")[1] ?? "";

    expect(preview.length).toBeLessThanOrEqual(AGENT_LOG_READ_DETAIL_PREVIEW_MAX);
    expect(preview).toMatch(/Detail preview truncated: \d+ characters omitted/);
    expect(preview).toContain('Use detail: "full"');
  });

  it("lifts the per-row preview in full mode while retaining the whole-response budget", async () => {
    const detail = "x".repeat(20_000);
    const { store } = storeWith([entry("tool output", "tool_result", detail)]);
    const result = await run(createTaskLogsReadTool(store, TASK_ID), { detail: "full" });
    const text = result.content[0].text;

    expect(text).toContain("Agent log (FN-8058): 1/1 entries");
    expect(text).not.toContain("Detail preview truncated:");
    expect(text.length).toBeLessThanOrEqual(12_000);
    expect(text).toContain("smaller limit, offset, or type filter");
  });

  it("requires task_id in chat and shares the bounded payload builder", async () => {
    const detail = "x".repeat(AGENT_LOG_READ_DETAIL_PREVIEW_MAX + 300);
    const { store, getAgentLogs } = storeWith([entry("chat", "tool_result", detail)]);
    const tool = createChatTaskLogsReadTool(store);
    const result = await run(tool, { task_id: "FN-other", detail: "preview" });

    expect(getAgentLogs).toHaveBeenCalledWith("FN-other", expect.any(Object));
    expect((tool.parameters as { required?: string[] }).required).toContain("task_id");
    expect(result.content[0].text).toContain("Detail preview truncated:");
  });

  describe("RUFU-204 cross-task target resolution", () => {
    it("honors an explicit task_id: returns the requested card's rows, total, and freshness — not the bound card's", async () => {
      const { store, getAgentLogs, getAgentLogCount } = storeByKey({
        [BOUND_ID]: [entryFor(BOUND_ID, BOUND_STAMP, "bound card is fresh")],
        [OTHER_ID]: [entryFor(OTHER_ID, OTHER_STAMP, "queried card is stale")],
      });
      const result = await run(createTaskLogsReadTool(store, BOUND_ID), { task_id: OTHER_ID });
      const text = result.content[0].text;

      expect(getAgentLogs).toHaveBeenCalledWith(OTHER_ID, { limit: 100, offset: 0, type: undefined });
      expect(getAgentLogCount).toHaveBeenCalledWith(OTHER_ID, { type: undefined });
      // The payload names the SERVED card, carries the SERVED card's rows, and reports the SERVED card's
      // (stale) freshness — not the bound card's fresh timestamp. That freshness inversion is what made the
      // fleet misdiagnose a live card as stalled.
      expect(text).toContain(`Agent log (${OTHER_ID}): 1/1 entries`);
      expect(text).toContain("queried card is stale");
      expect(text).toContain(OTHER_STAMP);
      expect(text).not.toContain("bound card is fresh");
      expect(text).not.toContain(BOUND_STAMP);
      expect(result.details).toMatchObject({ taskId: OTHER_ID });
    });

    it("accepts the pi/chat `id` alias and resolves it to the requested card", async () => {
      const { store, getAgentLogs } = storeByKey({
        [BOUND_ID]: [entryFor(BOUND_ID, BOUND_STAMP, "bound")],
        [OTHER_ID]: [entryFor(OTHER_ID, OTHER_STAMP, "queried via id alias")],
      });
      const result = await run(createTaskLogsReadTool(store, BOUND_ID), { id: OTHER_ID });

      expect(getAgentLogs).toHaveBeenCalledWith(OTHER_ID, expect.any(Object));
      expect(result.content[0].text).toContain(`Agent log (${OTHER_ID}):`);
      expect(result.details).toMatchObject({ taskId: OTHER_ID });
    });

    it("keeps the bound-card default when no target is supplied", async () => {
      const { store, getAgentLogs } = storeByKey({
        [BOUND_ID]: [entryFor(BOUND_ID, BOUND_STAMP, "bound default")],
        [OTHER_ID]: [entryFor(OTHER_ID, OTHER_STAMP, "other")],
      });
      await run(createTaskLogsReadTool(store, BOUND_ID), {});

      expect(getAgentLogs).toHaveBeenCalledWith(BOUND_ID, expect.any(Object));
    });

    it("refuses conflicting task_id and id values and never consults the store", async () => {
      const { store, getAgentLogs, getAgentLogCount } = storeByKey({ [BOUND_ID]: [] });
      const result = await run(createTaskLogsReadTool(store, BOUND_ID), { task_id: OTHER_ID, id: "FN-THIRD" });

      expect(result.content[0].text).toContain("conflicting");
      expect(result.content[0].text).toContain(OTHER_ID);
      expect(result.content[0].text).toContain("FN-THIRD");
      expect(result.content[0].text).toContain(BOUND_ID);
      expect(getAgentLogs).not.toHaveBeenCalled();
      expect(getAgentLogCount).not.toHaveBeenCalled();
      expect(result.details).toEqual({});
    });

    it.each([
      ["a parent-relative id", "../secrets"],
      ["a nested id", "a/b"],
      ["an absolute id", "/etc/passwd"],
      ["a dot segment", "."],
      ["a dot-dot segment", ".."],
      ["a backslash id", "a\\b"],
      ["a control-character id", "FN\u0000-1"],
      ["an empty id", ""],
      ["a whitespace-only id", "   "],
    ])("refuses %s before touching the store", async (_label, target) => {
      const { store, getAgentLogs, getAgentLogCount } = storeByKey({ [BOUND_ID]: [] });
      const result = await run(createTaskLogsReadTool(store, BOUND_ID), { task_id: target });

      expect(result.content[0].text).toContain("invalid task id");
      expect(getAgentLogs).not.toHaveBeenCalled();
      expect(getAgentLogCount).not.toHaveBeenCalled();
      expect(result.details).toEqual({});
    });

    it("keeps an unknown-but-well-formed target as the honest empty answer, not an error", async () => {
      const { store } = storeByKey({ [BOUND_ID]: [entryFor(BOUND_ID, BOUND_STAMP, "bound")] });
      const result = await run(createTaskLogsReadTool(store, BOUND_ID), { task_id: "FN-DOES-NOT-EXIST" });
      const text = result.content[0].text;

      expect(text).toContain("Agent log (FN-DOES-NOT-EXIST): 0/0 entries");
      expect(text).toContain("(no matching log entries)");
      expect(text).not.toContain("ERROR");
      expect(text).not.toContain("bound");
    });

    it("applies paging and the type filter to the requested card's store, reporting its filtered total", async () => {
      const { store, getAgentLogs, getAgentLogCount } = storeByKey({
        [OTHER_ID]: [
          entryFor(OTHER_ID, OTHER_STAMP, "tool a", "tool_result"),
          entryFor(OTHER_ID, OTHER_STAMP, "note b", "text"),
        ],
      });
      const result = await run(createTaskLogsReadTool(store, BOUND_ID), { task_id: OTHER_ID, limit: 1, type: "tool_result" });

      expect(getAgentLogs).toHaveBeenCalledWith(OTHER_ID, { limit: 1, offset: 0, type: "tool_result" });
      expect(getAgentLogCount).toHaveBeenCalledWith(OTHER_ID, { type: "tool_result" });
      expect(result.content[0].text).toContain("1/1 entries");
      expect(result.content[0].text).toContain("type=tool_result");
    });

    it("exposes task_id and id as optional schema properties while leaving the bound card default required-free", () => {
      const props = (createTaskLogsReadTool(storeByKey({}).store, BOUND_ID).parameters as {
        properties: Record<string, unknown>;
        required?: string[];
      });
      expect(props.properties).toHaveProperty("task_id");
      expect(props.properties).toHaveProperty("id");
      expect(props.required ?? []).not.toContain("task_id");
      expect(props.required ?? []).not.toContain("id");
    });
  });

  it("names the served card in the chat header too", async () => {
    const { store } = storeByKey({ [OTHER_ID]: [entryFor(OTHER_ID, OTHER_STAMP, "chat row")] });
    const result = await run(createChatTaskLogsReadTool(store), { task_id: OTHER_ID });

    expect(result.content[0].text).toContain(`Agent log (${OTHER_ID}): 1/1 entries`);
  });
});
