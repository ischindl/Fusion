import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import {
  createArtifactRegisterTool,
  createTaskAssignTool,
  createTaskDocumentWriteTool,
  createTaskFileScopeAddTool,
  createTaskPromptWriteTool,
} from "../agent-tools.js";

/*
FNXC:WriteFailureSurfacing 2026-09-23-06:10:
STAS-251. AgentLogger.onToolEnd records a tool call as `tool_error` only when the result
carries isError; without it the task log — and every automated reader of it — records a
persisted row that never existed. A mutating tool whose write did not commit must therefore
fail at the protocol boundary, not merely in prose. Each case below rejects the real store
call the tool depends on and asserts the result is a failed tool result.
*/

const TASK_ID = "FN-2510";
const PERSISTENCE_FAILURE = "connection terminated unexpectedly";

async function run(tool: { execute: (...args: any[]) => Promise<any> }, params: Record<string, unknown>) {
  return tool.execute("call-1", params);
}

function failingStore(overrides: Record<string, unknown>) {
  return {
    isBackendMode: () => false,
    ...overrides,
  } as unknown as TaskStore;
}

function taskWithFileScope(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "Instrument TaskStore boot",
    prompt: "## File Scope\n\n- `packages/core/src/postgres/advisory-locks.ts`\n",
    ...overrides,
  } as unknown as Task;
}

describe("write tools fail the tool boundary when the write does not commit (STAS-251)", () => {
  it("fn_task_document_write reports an error result when upsertTaskDocument rejects", async () => {
    const store = failingStore({
      upsertTaskDocument: vi.fn().mockRejectedValue(new Error(PERSISTENCE_FAILURE)),
    });

    const result = await run(createTaskDocumentWriteTool(store, TASK_ID), { key: "plan", content: "x" });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(PERSISTENCE_FAILURE);
  });

  it("fn_task_prompt_write reports an error result when updateTask rejects", async () => {
    const store = failingStore({
      updateTask: vi.fn().mockRejectedValue(new Error(PERSISTENCE_FAILURE)),
    });

    const result = await run(createTaskPromptWriteTool(store, TASK_ID), { content: "# Plan" });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(PERSISTENCE_FAILURE);
  });

  it("fn_task_file_scope_add reports an error result when the scope write rejects", async () => {
    const store = failingStore({
      getTask: vi.fn().mockResolvedValue(taskWithFileScope()),
      updateTask: vi.fn().mockRejectedValue(new Error(PERSISTENCE_FAILURE)),
    });

    const result = await run(createTaskFileScopeAddTool(store, TASK_ID), {
      files: ["packages/cli/src/extension.ts"],
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(PERSISTENCE_FAILURE);
  });

  it("fn_artifact_register reports an error result when registerArtifact rejects", async () => {
    const store = failingStore({
      registerArtifact: vi.fn().mockRejectedValue(new Error(PERSISTENCE_FAILURE)),
    });

    const result = await run(createArtifactRegisterTool(store, "agent-executor"), {
      type: "document",
      title: "Boot path map",
      content: "phase timings",
      mimeType: "text/markdown",
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(PERSISTENCE_FAILURE);
  });

  it("fn_task_assign reports an error result when the task lookup behind the write fails", async () => {
    const durableAgent = {
      id: "agent-executor",
      name: "Executor",
      role: "executor",
      state: "idle",
    };
    const agentStore = {
      getAgent: vi.fn().mockResolvedValue(durableAgent),
    } as never;
    const store = failingStore({
      getTask: vi.fn().mockRejectedValue(new Error(PERSISTENCE_FAILURE)),
    });

    const result = await run(createTaskAssignTool(agentStore, store), {
      task_id: TASK_ID,
      agent_id: "agent-executor",
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not found");
  });
});
