/*
RUFU-552: the durable-agent copy of the dependency tools must refuse in band too.

`agent-tools.ts` is what a permanent agent holds. Its `fn_task_update` dependency write had no catch at all,
and its `fn_task_add_dep` write fell into a generic catch that answers with the store-OUTAGE sentence -
"did not reach the task store … Retry the call" - for a refusal the store made on the merits. Both shapes
taught an agent to re-propose the exact edge the board had just refused; the second one actively lied about
the cause. Every case drives the real registered tool against a store that throws the real core error.
*/
import { describe, expect, it, vi } from "vitest";
import {
  DependencyCycleError,
  SelfSpawnedDependencyError,
  type Task,
  type TaskStore,
} from "@fusion/core";
import {
  createTaskUpdateTool as createAgentTaskUpdateTool,
  createTaskAddDepTool as createAgentTaskAddDepTool,
} from "../agent-tools.js";

const TASK_ID = "RUFU-553";
const BLOCKER = "RUFU-554";
const SANE_EDGE = `${TASK_ID} -> ${BLOCKER} -> ${TASK_ID}`;
const OUTAGE = "ECONNREFUSED 127.0.0.1:5432";

function cycleError(): DependencyCycleError {
  return new DependencyCycleError(TASK_ID, [TASK_ID, BLOCKER, TASK_ID]);
}

function card(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "Reconcile the plugin sync queue",
    column: "todo",
    steps: [{ name: "Preflight", status: "done" }],
    currentStep: 0,
    dependencies: [],
    log: [],
    ...overrides,
  } as unknown as Task;
}

function fakeStore(opts: { cycle?: boolean; outage?: boolean; column?: string } = {}) {
  const logEntry = vi.fn(async () => {});
  const updateTask = vi.fn(async (_id: string, updates: Record<string, unknown>) => {
    if (opts.outage) throw new Error(OUTAGE);
    if (opts.cycle && Array.isArray(updates.dependencies)) throw cycleError();
    return card(updates as Partial<Task>);
  });
  const store = {
    isBackendMode: () => false,
    getTask: vi.fn(async (id: string) => (id === BLOCKER ? card({ id: BLOCKER }) : card({ column: opts.column }))),
    updateTask,
    logEntry,
  } as unknown as TaskStore;
  return { store, logEntry, updateTask };
}

async function run(tool: { execute: (...args: unknown[]) => Promise<any> }, params: Record<string, unknown>) {
  return tool.execute("call", params, undefined, undefined, { cwd: "/project" });
}

function textOf(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((part: { text?: string }) => part.text ?? "").join("\n");
}

describe("agent-tools fn_task_update dependency refusal (RUFU-552 Step 5)", () => {
  it("resolves with a refusal naming the loop rather than rejecting", async () => {
    const h = fakeStore({ cycle: true });

    const result = await run(createAgentTaskUpdateTool(h.store, TASK_ID), { dependencies: [BLOCKER] });

    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("DEPENDENCY_CYCLE");
    // The result forwards the store's own sentence (which joins the loop with arrows) and carries the path
    // structurally; the ASCII-joined form is what the card's log line holds.
    expect(result.details.cyclePath).toEqual([TASK_ID, BLOCKER, TASK_ID]);
    expect(textOf(result)).toContain(`Dependency cycle detected for ${TASK_ID}`);
    expect(textOf(result)).toContain(BLOCKER);
    expect(textOf(result)).not.toMatch(/ECONNREFUSED|Retry the call/i);
  });

  it("records the refused edge on the card's own log", async () => {
    const h = fakeStore({ cycle: true });

    await run(createAgentTaskUpdateTool(h.store, TASK_ID), { dependencies: [BLOCKER] });

    const logged = h.logEntry.mock.calls.map((call) => String(call[1])).join("\n");
    expect(logged).toContain(SANE_EDGE);
    expect(logged).toContain("Nothing was persisted");
  });

  it("keeps a store outage on the retry-shaped path", async () => {
    const h = fakeStore({ outage: true });

    const result = await run(createAgentTaskUpdateTool(h.store, TASK_ID), { dependencies: [BLOCKER] });

    expect(result.isError).toBe(true);
    expect(result.details.code).not.toBe("DEPENDENCY_CYCLE");
    expect(textOf(result)).toContain("Retry the call");
    const logged = h.logEntry.mock.calls.map((call) => String(call[1])).join("\n");
    expect(logged).not.toContain(SANE_EDGE);
  });

  it("still replaces a dependency list the board accepts", async () => {
    const h = fakeStore();
    const accepted = "RUFU-100";
    h.store.getTask = vi.fn(async (id: string) => (id === accepted ? card({ id: accepted }) : card()));

    const result = await run(createAgentTaskUpdateTool(h.store, TASK_ID), { dependencies: [accepted] });

    expect(result.isError).toBeUndefined();
    expect(h.updateTask).toHaveBeenCalledWith(TASK_ID, { dependencies: [accepted] });
  });

  it("keeps the pre-existing unknown-id refusal ahead of the store call", async () => {
    const h = fakeStore();
    const missing = "RUFU-999";
    h.store.getTask = vi.fn(async (id: string) => {
      if (id === missing) throw new Error("Task not found");
      return card();
    });

    const result = await run(createAgentTaskUpdateTool(h.store, TASK_ID), { dependencies: [missing] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown dependency task(s)");
    expect(h.updateTask).not.toHaveBeenCalled();
  });
});

describe("agent-tools fn_task_add_dep dependency refusal (RUFU-552 Step 5)", () => {
  it("names the refused edge instead of the store-outage sentence its generic catch produced", async () => {
    const h = fakeStore({ cycle: true });

    const result = await run(createAgentTaskAddDepTool(h.store, TASK_ID), { task_id: BLOCKER, confirm: true });

    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("DEPENDENCY_CYCLE");
    expect(result.details.cyclePath).toEqual([TASK_ID, BLOCKER, TASK_ID]);
    expect(textOf(result)).toContain(BLOCKER);
    // The lie this site existed to tell: an unreachable store, retry recommended.
    expect(textOf(result)).not.toMatch(/did not reach the task store|Retry the call/i);
    const logged = h.logEntry.mock.calls.map((call) => String(call[1])).join("\n");
    expect(logged).toContain(SANE_EDGE);
    expect(logged).toContain("Nothing was added");
  });

  it("treats a code-less rejection as transient, not as a rule", async () => {
    const h = fakeStore({ outage: true });

    const result = await run(createAgentTaskAddDepTool(h.store, TASK_ID), { task_id: BLOCKER, confirm: true });

    expect(result.isError).toBe(true);
    expect(result.details.code).not.toBe("DEPENDENCY_CYCLE");
    expect(textOf(result)).toContain("Retry the call");
  });

  it("refuses a self-spawned dependency in band with its own code", async () => {
    const h = fakeStore();
    h.store.updateTask = vi.fn(async () => {
      throw new SelfSpawnedDependencyError(TASK_ID, BLOCKER);
    });

    const result = await run(createAgentTaskAddDepTool(h.store, TASK_ID), { task_id: BLOCKER, confirm: true });

    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("SELF_SPAWNED_DEPENDENCY");
    expect(textOf(result)).not.toMatch(/Retry the call/i);
  });

  it("keeps the WIP confirmation guard ahead of the write", async () => {
    const h = fakeStore({ column: "in-progress" });

    const result = await run(createAgentTaskAddDepTool(h.store, TASK_ID), { task_id: BLOCKER });

    expect(result.details.requiresConfirm).toBe(true);
    expect(h.updateTask).not.toHaveBeenCalled();
  });

  it("still appends a dependency the board accepts", async () => {
    const h = fakeStore();
    const accepted = "RUFU-100";
    h.store.getTask = vi.fn(async (id: string) => (id === accepted ? card({ id: accepted }) : card()));

    const result = await run(createAgentTaskAddDepTool(h.store, TASK_ID), { task_id: accepted, confirm: true });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain(`Added dependency ${accepted}`);
    expect(h.updateTask).toHaveBeenCalledWith(TASK_ID, { dependencies: [accepted] });
  });
});
