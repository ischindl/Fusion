import { describe, expect, it, vi } from "vitest";
import { TaskNotFoundError, type Task, type TaskStore } from "@fusion/core";
import {
  createArtifactRegisterTool,
  createTaskAssignTool,
  createTaskDocumentWriteTool,
  createTaskFileScopeAddTool,
  createTaskPromptWriteTool,
  createTaskShowTool,
  createTaskUpdateTool as createAgentTaskUpdateTool,
} from "../agent-tools.js";
import { createTaskUpdateTool as createExecutorTaskUpdateTool } from "../executor/create-task-update-tool.js";

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

/** A two-step card whose only unfinished step is the one the tests close. */
function taskWithStep(stepStatus: Task["steps"][number]["status"]): Task {
  return {
    id: TASK_ID,
    title: "Instrument TaskStore boot",
    column: "in-progress",
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Instrument boot", status: stepStatus },
    ],
    dependencies: [],
    log: [],
  } as unknown as Task;
}

function executorUpdateTool(store: TaskStore) {
  return createExecutorTaskUpdateTool(
    { store, resolveTaskCustomFieldDefs: async () => undefined, loopRecoveryState: new Map() },
    TASK_ID,
    new Map(),
    { current: null },
  );
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

  it("fn_task_assign names the store failure instead of calling an unreachable card missing", async () => {
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

    const text = JSON.stringify(result.content);
    expect(result.isError).toBe(true);
    expect(text).toContain(PERSISTENCE_FAILURE);
    /*
    The old shape pinned "not found" for a rejected lookup, which taught agents the card had
    vanished and the repair is to re-create it. Only the store's own not-found may say that.
    */
    expect(text).not.toContain("not found");
    expect(text).toContain("Retry");
  });

  it("fn_task_assign still says a genuinely absent card is not found", async () => {
    const agentStore = { getAgent: vi.fn().mockResolvedValue({ id: "agent-executor", name: "Executor", role: "executor", state: "idle" }) } as never;
    const store = failingStore({ getTask: vi.fn().mockRejectedValue(new TaskNotFoundError(TASK_ID)) });

    const result = await run(createTaskAssignTool(agentStore, store), { task_id: TASK_ID, agent_id: "agent-executor" });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not found");
  });

  it("fn_task_show reports a store failure rather than asserting the card is absent", async () => {
    const store = failingStore({ getTask: vi.fn().mockRejectedValue(new Error(PERSISTENCE_FAILURE)) });

    const result = await run(createTaskShowTool(store), { id: TASK_ID });

    const text = JSON.stringify(result.content);
    expect(result.isError).toBe(true);
    expect(text).toContain(PERSISTENCE_FAILURE);
    expect(text).not.toContain("not found");
  });

  it("fn_task_show reports a genuinely absent card as not found without failing the call", async () => {
    const store = failingStore({ getTask: vi.fn().mockRejectedValue(new TaskNotFoundError(TASK_ID)) });

    const result = await run(createTaskShowTool(store), { id: TASK_ID });

    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain(`Task ${TASK_ID} not found.`);
  });
});

describe("step closure cannot report success for a transition that did not commit (STAS-251)", () => {
  const DONE_CALL = { step: 1, status: "done", summary: "Instrumented the boot path and logged its duration." };

  it("the executor tool fails when the store keeps the step on its old status", async () => {
    /* `updateStep` refuses an out-of-order transition by returning the task unchanged — the
       board holds `pending` while the agent asked for `done`. STAS-246 step 7 is this case. */
    const store = failingStore({ updateStep: vi.fn(async () => taskWithStep("pending")) });

    const result = await run(executorUpdateTool(store), DONE_CALL);

    const text = JSON.stringify(result.content);
    expect(result.isError).toBe(true);
    expect(text).toContain("remains pending");
    /* The closure sentence the tool used to emit for a write that never landed. */
    expect(text).not.toContain(") → done");
    expect(result.details).toMatchObject({ requestedStatus: "done", persistedStatus: "pending" });
  });

  it("the executor tool fails when the step write rejects", async () => {
    const store = failingStore({ updateStep: vi.fn().mockRejectedValue(new Error(PERSISTENCE_FAILURE)) });

    const result = await run(executorUpdateTool(store), DONE_CALL);

    const text = JSON.stringify(result.content);
    expect(result.isError).toBe(true);
    expect(text).toContain(PERSISTENCE_FAILURE);
    expect(text).not.toContain(") → done");
  });

  it("the agent-tools tool fails when the store keeps the step on its old status", async () => {
    const store = failingStore({ updateStep: vi.fn(async () => taskWithStep("pending")) });

    const result = await run(createAgentTaskUpdateTool(store, TASK_ID), DONE_CALL);

    const text = JSON.stringify(result.content);
    expect(result.isError).toBe(true);
    expect(text).toContain("remains pending");
    expect(text).not.toContain(`Updated ${TASK_ID}: step 1 → done`);
  });

  it("the agent-tools tool fails when the step write rejects", async () => {
    const store = failingStore({ updateStep: vi.fn().mockRejectedValue(new Error(PERSISTENCE_FAILURE)) });

    const result = await run(createAgentTaskUpdateTool(store, TASK_ID), DONE_CALL);

    const text = JSON.stringify(result.content);
    expect(result.isError).toBe(true);
    expect(text).toContain(PERSISTENCE_FAILURE);
    expect(text).not.toContain(`Updated ${TASK_ID}: step 1 → done`);
  });

  it("the agent-tools tool reports the status the store committed, after the write resolves", async () => {
    /* The success text is only evidence if it can only be produced from the awaited write, so
       the store here commits asynchronously and reports a status the caller never requested. */
    let commitOrder = 0;
    let resolvedOrder = 0;
    const store = failingStore({
      updateStep: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        commitOrder = 1;
        return taskWithStep("in-progress");
      }),
    });

    const result = await run(createAgentTaskUpdateTool(store, TASK_ID), { step: 1, status: "done" });
    resolvedOrder = 2;

    expect(commitOrder).toBe(1);
    expect(resolvedOrder).toBe(2);
    expect(result.isError).toBe(true);
    /* params.status said "done"; the board said "in-progress", and only the board may be quoted. */
    const text = JSON.stringify(result.content);
    expect(text).toContain("remains in-progress");
    expect(text).not.toContain(`Updated ${TASK_ID}: step 1 → done`);
  });

  it("both copies fail when the store returns a task with no such step", async () => {
    /* `updateStep` tolerates an out-of-range index by answering with the untouched task, so the
       only signal is that the reply has no step at that index — and the write already ran. */
    const outOfRange = { step: 9, status: "done", summary: "Closed a step the plan does not have." };

    const executorResult = await run(executorUpdateTool(failingStore({ updateStep: vi.fn(async () => taskWithStep("done")) })), outOfRange);
    const agentResult = await run(createAgentTaskUpdateTool(failingStore({ updateStep: vi.fn(async () => taskWithStep("done")) }), TASK_ID), outOfRange);

    expect(executorResult.isError).toBe(true);
    expect(executorResult.details).toMatchObject({ code: "STEP_OUT_OF_RANGE" });
    expect(agentResult.isError).toBe(true);
    expect(agentResult.details).toMatchObject({ code: "STEP_OUT_OF_RANGE" });
  });

  it("the agent-tools tool reports the committed step when the store accepts the transition", async () => {
    const store = failingStore({ updateStep: vi.fn(async () => taskWithStep("done")) });

    const result = await run(createAgentTaskUpdateTool(store, TASK_ID), DONE_CALL);

    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain("→ done");
    expect(result.details).toMatchObject({ status: "done" });
  });
});
