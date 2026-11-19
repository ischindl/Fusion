/*
RUFU-552: the CLI pi extension is the planning lane's dependency writer.

A planning session runs `tools: "coding"` with this extension loaded, so `fn_task_update` here is the copy
whose `depends` argument reaches the store's cycle guard. That write had no catch, so the board's own rule
escaped as an exception out of the pi tool: the agent turn died, the card kept no record of the edge it had
proposed, and three identical deaths in the planning lane drained the recovery budget into a park that reads
like a specification failure. These cases drive the REAL registered tool and pin the two properties that make
the fix real: the refusal is a tool result naming the loop, and a store outage is still distinguishable from
a board rule.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DependencyCycleError, type Task, type TaskStore } from "@fusion/core";
import { createMockApi, registerExtension, requireTool, type ToolResult } from "./pg-extension-harness.js";
import { __setCachedStoreForTesting, closeCachedStores } from "../extension.js";

const TASK_ID = "RUFU-553";
const BLOCKER = "RUFU-554";
const SANE_EDGE = `${TASK_ID} -> ${BLOCKER} -> ${TASK_ID}`;
const OUTAGE = "ECONNREFUSED 127.0.0.1:5432";

function cycleError(): DependencyCycleError {
  return new DependencyCycleError(TASK_ID, [TASK_ID, BLOCKER, TASK_ID]);
}

function fakeStore(opts: { cycle?: boolean; outage?: boolean } = {}) {
  const logEntry = vi.fn(async () => {});
  const updateTask = vi.fn(async (_id: string, updates: Record<string, unknown>) => {
    if (opts.outage) throw new Error(OUTAGE);
    if (opts.cycle && Array.isArray(updates.dependencies)) throw cycleError();
    return { id: TASK_ID, dependencies: updates.dependencies ?? [] } as unknown as Task;
  });
  const store = {
    isBackendMode: () => false,
    getSettings: vi.fn(async () => ({})),
    getGlobalSettings: vi.fn(async () => ({})),
    getRootDir: vi.fn(() => "/project"),
    getTask: vi.fn(async () => ({
      id: TASK_ID,
      title: "Reconcile the plugin sync queue",
      column: "in-progress",
      steps: [],
      currentStep: 0,
      dependencies: [],
      log: [],
    } as unknown as Task)),
    logEntry,
    updateTask,
  } as unknown as TaskStore;
  return { store, logEntry, updateTask };
}

async function runTool(store: TaskStore, params: Record<string, unknown>): Promise<ToolResult> {
  const root = await mkdtemp(join(tmpdir(), "rufu553-cli-"));
  await mkdir(join(root, ".fusion"), { recursive: true });
  __setCachedStoreForTesting(root, store);
  try {
    const api = createMockApi();
    registerExtension(api);
    const tool = requireTool(api, "fn_task_update");
    return await tool.execute("call", { id: TASK_ID, ...params }, undefined, undefined, { cwd: root });
  } finally {
    await closeCachedStores();
    await rm(root, { recursive: true, force: true });
  }
}

function textOf(result: ToolResult): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

describe("pi extension fn_task_update dependency refusal (RUFU-552 Step 5)", () => {
  afterEach(async () => {
    await closeCachedStores();
  });

  it("returns a refusal naming the cycle instead of throwing out of the tool", async () => {
    const h = fakeStore({ cycle: true });

    const result = await runTool(h.store, { depends: [BLOCKER] });
    const text = textOf(result);

    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("DEPENDENCY_CYCLE");
    // The result forwards the store's own sentence; the refused loop is also carried structurally.
    expect(result.details.cyclePath).toEqual([TASK_ID, BLOCKER, TASK_ID]);
    expect(text).toContain(`Dependency cycle detected for ${TASK_ID}`);
    expect(text).not.toMatch(/ECONNREFUSED|did not reach the task store|Retry the call/i);
    // Nothing was written, so the card's dependency list is exactly what it was.
    expect(h.updateTask).toHaveBeenCalledTimes(1);
  });

  it("records the refused edge on the card's own log", async () => {
    const h = fakeStore({ cycle: true });

    await runTool(h.store, { depends: [BLOCKER] });

    const logged = h.logEntry.mock.calls.map((call) => String(call[1])).join("\n");
    expect(logged).toContain(SANE_EDGE);
    expect(logged).toContain("Nothing was persisted");
  });

  it("keeps an outage distinguishable from a rule", async () => {
    const h = fakeStore({ outage: true });

    const result = await runTool(h.store, { depends: [BLOCKER] });
    const text = textOf(result);

    expect(result.isError).toBe(true);
    expect(result.details.code).not.toBe("DEPENDENCY_CYCLE");
    expect(text).toContain("Retry the call");
    const logged = h.logEntry.mock.calls.map((call) => String(call[1])).join("\n");
    expect(logged).not.toContain(SANE_EDGE);
  });

  it("still writes a dependency list the board accepts", async () => {
    const h = fakeStore();

    const result = await runTool(h.store, { depends: [BLOCKER] });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Updated");
    expect(h.updateTask).toHaveBeenCalledWith(TASK_ID, { dependencies: [BLOCKER] });
  });
});
