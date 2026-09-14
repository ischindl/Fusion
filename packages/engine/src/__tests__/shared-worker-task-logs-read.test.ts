import { describe, expect, it, vi } from "vitest";
import type { AgentLogEntry, TaskStore } from "@fusion/core";
import { createTaskLogsReadTool } from "../executor/shared-worker-tools.js";

/*
FNXC:TaskLogsRead 2026-09-09-15:19:
RUFU-204: the shared-worker (executor lane) registration is a thin forwarder to the shared log-read factory.
This test locks the forward: when a durable executor, mid-run on its OWN card, asks to read a SIBLING card's
log, the wrapper must hand the requested target through to the shared factory — not read its own card. That is
the executor lane's half of the invariant the heartbeat and chat lanes already hold; a lane-local regression
would hand the executor its own log while it explicitly asked for another, which is exactly the wrong-card
misdiagnosis RUFU-204 removed. Kept in its own file so the log-read contract lives with its own assertions.
*/

function row(taskId: string): AgentLogEntry {
  return { taskId, timestamp: "2026-09-08T00:00:00.000Z", text: `sibling log for ${taskId}`, type: "text", agent: "executor" };
}

function depsFor(store: Partial<TaskStore>) {
  return { store: store as unknown as TaskStore, getRunContextFor: vi.fn() } as unknown as Parameters<typeof createTaskLogsReadTool>[0];
}

describe("shared-worker (executor lane) fn_task_logs_read", () => {
  it("forwards an explicit target through the shared factory instead of reading the bound card", async () => {
    const getAgentLogs = vi.fn(async (id: string): Promise<AgentLogEntry[]> => (id === "FN-OTHER" ? [row("FN-OTHER")] : []));
    const getAgentLogCount = vi.fn(async (id: string) => (id === "FN-OTHER" ? 1 : 0));
    const tool = createTaskLogsReadTool(depsFor({ getAgentLogs, getAgentLogCount }), "FN-BOUND");

    const result = await tool.execute("call", { task_id: "FN-OTHER" }, undefined, undefined, undefined) as {
      content: { text?: string }[];
      details: { taskId?: string };
    };

    // The forwarded store call is the requested card, never the executor's own bound card.
    expect(getAgentLogs).toHaveBeenCalledWith("FN-OTHER", expect.objectContaining({ limit: 100, offset: 0 }));
    expect(getAgentLogs).not.toHaveBeenCalledWith("FN-BOUND", expect.anything());
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Agent log (FN-OTHER):");
    expect(text).toContain("sibling log for FN-OTHER");
    expect(text).not.toContain("FN-BOUND");
    expect(result.details.taskId).toBe("FN-OTHER");
  });

  it("falls back to the bound card when no target is supplied", async () => {
    const getAgentLogs = vi.fn(async (): Promise<AgentLogEntry[]> => []);
    const getAgentLogCount = vi.fn(async () => 0);
    const tool = createTaskLogsReadTool(depsFor({ getAgentLogs, getAgentLogCount }), "FN-BOUND");

    await tool.execute("call", {}, undefined, undefined, undefined);

    expect(getAgentLogs).toHaveBeenCalledWith("FN-BOUND", expect.any(Object));
  });
});
