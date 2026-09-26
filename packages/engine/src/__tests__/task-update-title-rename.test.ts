/**
 * FNXC:TaskTitleHygiene 2026-09-26-04:45 (RUFU-295):
 * `fn_task_update` gained a `title` parameter on BOTH of its copies — the executor's step-status tool and
 * the agent-tools copy other lanes use — because the lane that discovers a mis-titled card is usually the
 * lane executing it. RUFU-294's author could not repair its own `## Pôvodný popis` title: the CLI rename
 * lives in a different process, and `deleteTask` refuses a card's own creator, so the junk label was stuck
 * on the board and in every history view.
 *
 * The contract pinned here:
 *  - a valid one-line title persists through `store.updateTask` (the seam that also keeps the card's
 *    PROMPT.md heading in sync), and the result text names the new label;
 *  - junk shapes (markdown heading, multi-line paste, blank, over-budget) are refused with an error
 *    BEFORE any write, so a caller is never left with a label it did not type;
 *  - a rename is applied first, so a combined call reports the rename even when the step transition is
 *    refused — the two outcomes must not be conflated.
 */
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { createTaskUpdateTool as createExecutorTaskUpdateTool } from "../executor/create-task-update-tool.js";
import { createTaskUpdateTool as createAgentTaskUpdateTool } from "../agent-tools.js";

function taskFixture(): Task {
  return {
    id: "RUFU-295",
    title: "Titles from heading slicing",
    description: "Derive labels from the first sentence.",
    priority: "normal",
    column: "in-progress",
    currentStep: 1,
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Implement", status: "in-progress" },
    ],
    dependencies: [],
    log: [],
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
  } as Task;
}

function fakeStore() {
  const updateTask = vi.fn(async (_id: string, _updates: Record<string, unknown>) => taskFixture());
  const updateStep = vi.fn(async () => taskFixture());
  const store = {
    updateTask,
    updateStep,
    getTask: vi.fn(async () => taskFixture()),
    updateTaskCustomFields: vi.fn(async () => ({ ok: true })),
  } as unknown as TaskStore;
  return { store, updateTask, updateStep };
}

function executorTool(store: TaskStore) {
  return createExecutorTaskUpdateTool(
    { store, resolveTaskCustomFieldDefs: async () => undefined, loopRecoveryState: new Map() },
    "RUFU-295",
    new Map(),
    { current: null },
  );
}

const lanes = [
  { name: "executor copy", tool: (store: TaskStore) => executorTool(store) },
  { name: "agent-tools copy", tool: (store: TaskStore) => createAgentTaskUpdateTool(store, "RUFU-295") },
] as const;

describe("fn_task_update title rename (RUFU-295)", () => {
  for (const lane of lanes) {
    it(`${lane.name}: publishes the title parameter`, () => {
      const schema = lane.tool(fakeStore().store).parameters as { properties?: Record<string, unknown> };
      expect(schema.properties?.title).toBeDefined();
    });

    it(`${lane.name}: persists a trimmed title without touching steps`, async () => {
      const { store, updateTask, updateStep } = fakeStore();
      const result = await lane.tool(store).execute("call", {
        title: "  Heading-sliced titles must stop reaching the board  ",
      });

      expect(updateTask).toHaveBeenCalledWith("RUFU-295", {
        title: "Heading-sliced titles must stop reaching the board",
      });
      expect(updateStep).not.toHaveBeenCalled();
      expect(result.isError).not.toBe(true);
      expect((result.content[0] as { text: string }).text).toContain("Heading-sliced titles must stop reaching the board");
    });

    it(`${lane.name}: reports a rename alongside a step transition`, async () => {
      const { store, updateTask } = fakeStore();
      const result = await lane.tool(store).execute("call", {
        title: "Renamed while stepping",
        step: 1,
        status: "done",
        summary: "Renamed the card and closed the step.",
      });

      expect(updateTask).toHaveBeenCalledWith("RUFU-295", { title: "Renamed while stepping" });
      expect((result.content[0] as { text: string }).text).toContain('Title → "Renamed while stepping"');
    });

    it(`${lane.name}: refuses a markdown heading title and writes nothing`, async () => {
      const { store, updateTask, updateStep } = fakeStore();
      const result = await lane.tool(store).execute("call", { title: "## Pôvodný popis" });

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/title rejected .*markdown heading is not a title/);
      expect((result.details as { code?: string }).code).toBe("TITLE_REJECTED");
      expect(updateTask).not.toHaveBeenCalled();
      expect(updateStep).not.toHaveBeenCalled();
    });

    it(`${lane.name}: refuses a multi-line title rather than storing a description slice`, async () => {
      const { store, updateTask } = fakeStore();
      const result = await lane.tool(store).execute("call", {
        title: "Merateľná prompt-cache telemetria per lane\nusage + system head hash",
      });

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/single line/);
      expect(updateTask).not.toHaveBeenCalled();
    });

    it(`${lane.name}: refuses a blank title instead of clearing the card label`, async () => {
      const { store, updateTask } = fakeStore();
      const result = await lane.tool(store).execute("call", { title: "   " });

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/a title is required/);
      expect(updateTask).not.toHaveBeenCalled();
    });

    it(`${lane.name}: refuses a title over the label budget`, async () => {
      const { store, updateTask } = fakeStore();
      const result = await lane.tool(store).execute("call", { title: "x".repeat(221) });

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/at most 220 characters/);
      expect(updateTask).not.toHaveBeenCalled();
    });
  }

  it("names the title parameter in the bare-call refusal so an empty call is self-describing", async () => {
    const { store } = fakeStore();
    const result = await executorTool(store).execute("call", {});

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("title (rename the card)");
  });
});
