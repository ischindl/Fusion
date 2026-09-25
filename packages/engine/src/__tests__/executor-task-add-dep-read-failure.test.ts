/*
STAS-259: the executor lane's fn_task_add_dep must not call a refused read "not found".

The target-existence lookup is a shared catch: any error from `store.getTask(targetId)` — timeout, boot stall,
closed pool — answered `Task X not found. Cannot add dependency on a non-existent task.`, the same lie
STAS-251 removed from fn_task_show ("absent" and "unreachable" send the agent in opposite directions, and here
the agent is told a dependency target it may well have just created is gone). Only the store's typed
not-found may name a missing task; anything else is the board being unreachable, composed through the shared
store-error shape and flagged, exactly as the engine lane's add-dependency catch (agent-tools.ts) already does.
*/
import { describe, expect, it, vi } from "vitest";
import { TaskNotFoundError, type TaskStore } from "@fusion/core";
import { createTaskAddDepTool, type TaskAddDepToolDeps } from "../executor/task-add-dep-tool.js";
import { STORE_RETRY_GUIDANCE, storeErrorResult } from "../tool-store-errors.js";

const SENTINEL = "STAS-259 sentinel: target lookup refused";
const TARGET = "STAS-999";
const SELF = "STAS-259";
const SHARED_SHAPE = storeErrorResult("probe", new Error("probe"));
const SHARED_CODE = SHARED_SHAPE.details.code;

function depsWith(getTask: TaskStore["getTask"]): TaskAddDepToolDeps {
  const store = { getTask } as unknown as TaskStore;
  return {
    store,
    depAborted: new Set<string>(),
    getActiveSession: () => undefined,
    getActiveStepExecutor: () => undefined,
  };
}

type ToolResult = { content: Array<{ type: string; text: string }>; details?: Record<string, unknown>; isError?: boolean };

const textOf = (result: ToolResult) => result.content[0]?.text ?? "";

describe("fn_task_add_dep target lookup failure (STAS-259)", () => {
  it("reports a refused target read as a flagged store error, never as a missing task", async () => {
    const tool = createTaskAddDepTool(depsWith(vi.fn().mockRejectedValue(new Error(SENTINEL))), SELF);

    const result = (await tool.execute("call-1", { task_id: TARGET, confirm: true })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.details?.code).toBe(SHARED_CODE);
    const text = textOf(result);
    expect(text).toContain(SENTINEL);
    expect(text).toContain(STORE_RETRY_GUIDANCE);
    expect(text).not.toMatch(/not found/i);
  });

  it("keeps the store's typed not-found as the unflagged fact it is", async () => {
    /*
    The classification pin that keeps the fix honest: a genuine miss is a fact about the board,
    not an outage. Telling an agent to retry an absence is the other half of the STAS-251 lie,
    so this branch must keep its own text and must not grow the store-outage code.
    */
    const tool = createTaskAddDepTool(depsWith(vi.fn().mockRejectedValue(new TaskNotFoundError(TARGET))), SELF);

    const result = (await tool.execute("call-1", { task_id: TARGET, confirm: true })) as ToolResult;

    expect(result.isError).toBeUndefined();
    expect(result.details?.code).toBeUndefined();
    expect(textOf(result)).toContain(`${TARGET} not found`);
  });
});
