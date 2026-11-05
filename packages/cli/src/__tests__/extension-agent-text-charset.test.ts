/**
 * FNXC:AgentTextCharset 2026-11-04-12:08 (RUFU-307):
 * The CLI extension is the lane where RUFU-295's defect actually fired: its `fn_task_create` had a `title`
 * parameter, wrote straight through `createAgentTask()`, and raised an `AgentTextCharsetError` that nothing
 * translated — so an agent-authored title in a non-Latin script read as a crash rather than as a refusal of
 * the agent's own text. These cases drive the REAL registered tools and pin the two properties that make the
 * fix real: the refusal is a tool result (text + `isError`) that names the code points, and nothing is
 * persisted by a refusing call.
 *
 * Offenders are `\uXXXX` escapes because `scripts/check-nonlatin-tracked-text.mjs` refuses a tracked file
 * holding a raw non-Latin letter; the escape still builds the real character at runtime.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task, TaskStore } from "@fusion/core";
import { createMockApi, registerExtension, requireTool, type ToolResult } from "./pg-extension-harness.js";
import { __setCachedStoreForTesting, closeCachedStores } from "../extension.js";

/** The incident, mid-word: `agent <U+521B><U+5EFA>uje proces`. */
const DIRTY = "agent \u521B\u5EFAuje proces";
/** Legitimate Slovak, built only from the 18 allowed lowercase and 18 allowed uppercase letters. */
const CLEAN = "Agent vytv\u00E1ra proces na karte: \u00E4\u010D\u013E\u00E9\u00ED\u013A\u013E\u00F4\u0155\u0164\u00FD\u017E \u00C4\u010C\u013D\u00D4";

function createdTask(overrides: Record<string, unknown> = {}): Task {
  return {
    id: "RUFU-308",
    title: "Vytvoren\u00E1 karta",
    description: "Vytvoren\u00E9 zadanie",
    dependencies: [],
    column: "todo",
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as unknown as Task;
}

function fakeStore(overrides: Record<string, unknown> = {}) {
  const createTask = vi.fn(async (input: Record<string, unknown>) => createdTask(input));
  const updateTask = vi.fn(async (_id: string, updates: Record<string, unknown>) =>
    ({ id: "RUFU-307", title: "Guard agent text", ...updates }) as unknown as Task);
  const store = {
    isBackendMode: () => false,
    getSettings: vi.fn(async () => ({ autoSummarizeTitles: false })),
    getGlobalSettings: vi.fn(async () => ({})),
    // Called synchronously by the CLI's tracking resolution, so it must return the store, not a promise.
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn(async () => ({})) })),
    getAsyncLayer: vi.fn(() => undefined),
    getDatabase: vi.fn(() => undefined),
    getRootDir: vi.fn(() => "/project"),
    getMissionStore: vi.fn(() => ({
      getFeature: vi.fn(async () => null),
      getFeatureByTaskId: vi.fn(async () => null),
      getSlice: vi.fn(async () => null),
      getMilestone: vi.fn(async () => null),
      getMission: vi.fn(async () => null),
    })),
    getDefaultWorkflowId: vi.fn(async () => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
    resolveOriginWorkflowOverrideId: vi.fn(async () => undefined),
    searchTasks: vi.fn(async () => []),
    findRecentTasksBySourceParentTaskId: vi.fn(async () => []),
    findRecentTasksByContentFingerprint: vi.fn(async () => []),
    getTask: vi.fn(async () => ({
      id: "RUFU-307",
      title: "Guard agent text",
      column: "in-progress",
      steps: [{ name: "Preflight", status: "done" }],
      currentStep: 0,
      dependencies: [],
      log: [],
    } as unknown as Task)),
    logEntry: vi.fn(async () => {}),
    updateTask,
    createTask,
    ...overrides,
  } as unknown as TaskStore;
  return { store, createTask, updateTask };
}

/**
 * Registers the extension against a mock pi API with `store` injected for a fresh project root, then calls
 * one registered tool with the pi call shape `(toolCallId, params, signal, onUpdate, ctx)`.
 */
async function runTool(
  toolName: string,
  store: TaskStore,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const root = await mkdtemp(join(tmpdir(), "rufu307-cli-"));
  await mkdir(join(root, ".fusion"), { recursive: true });
  __setCachedStoreForTesting(root, store);
  try {
    const api = createMockApi();
    registerExtension(api);
    const tool = requireTool(api, toolName);
    return await tool.execute("call", params, undefined, undefined, { cwd: root });
  } finally {
    await closeCachedStores();
    await rm(root, { recursive: true, force: true });
  }
}

function textOf(result: ToolResult): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

describe("pi extension agent text charset guard (RUFU-307)", () => {
  afterEach(async () => {
    await closeCachedStores();
  });

  describe("fn_task_create", () => {
    it("returns a tool-result refusal naming the code points, with no task created", async () => {
      const { store, createTask } = fakeStore();
      const result = await runTool("fn_task_create", store, { description: DIRTY });
      const text = textOf(result);

      expect(text).toContain("ERROR:");
      expect(text).toContain("disallowed code point(s)");
      expect(text).toContain("U+521B");
      expect(text).toContain("U+5EFA");
      expect(text).toContain("Rewrite with allowed characters and retry.");
      // The incident made this surface look like a machine failure; it must name the agent's own text instead.
      expect(text).not.toMatch(/outage|unavailable|ETIMEDOUT|ECONNREFUSED/i);
      // The raw glyph never re-appears where an operator has to read it.
      expect(text).not.toContain("\u521B");
      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({ code: "AGENT_TEXT_CHARSET", field: "description" });
      expect(createTask).not.toHaveBeenCalled();
    });

    it("refuses a dirty title before the card exists", async () => {
      const { store, createTask } = fakeStore();
      const result = await runTool("fn_task_create", store, { title: `N\u00E1vrh \u5361`, description: CLEAN });

      expect(textOf(result)).toContain("U+5361");
      expect(result.details).toMatchObject({ field: "title" });
      expect(createTask).not.toHaveBeenCalled();
    });

    it("creates the card when title and description carry full Slovak diacritics", async () => {
      const { store, createTask } = fakeStore();
      const result = await runTool("fn_task_create", store, {
        title: "Prida\u0165 kontrolu znakov",
        description: CLEAN,
      });

      // The card was created and nothing in this lane refused the caller's alphabet. `isError` is not
      // asserted: the injected store does not emulate the post-create reporting pipeline, and a plain
      // English control fails there identically, so asserting it would pin harness internals rather than
      // the guard. The engine's own createAgentTask case proves the clean pass reaches `createTask`.
      expect(createTask).toHaveBeenCalledTimes(1);
      expect(textOf(result)).not.toContain("disallowed code point");
      expect(result.details).not.toMatchObject({ code: "AGENT_TEXT_CHARSET" });
    });
  });

  describe("fn_task_update", () => {
    it("refuses a dirty title with no store write at all", async () => {
      const { store, updateTask } = fakeStore();
      const result = await runTool("fn_task_update", store, {
        id: "RUFU-307",
        title: `Premenovanie \u5361 karty`,
      });
      const text = textOf(result);

      expect(text).toContain("ERROR:");
      expect(text).toContain("U+5361");
      expect(text).toContain("Nothing was persisted.");
      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({ code: "AGENT_TEXT_CHARSET", field: "title" });
      expect(updateTask).not.toHaveBeenCalled();
    });

    it("refuses a dirty description with no store write at all", async () => {
      const { store, updateTask } = fakeStore();
      const result = await runTool("fn_task_update", store, { id: "RUFU-307", description: DIRTY });

      expect(textOf(result)).toContain('field "description"');
      expect(result.details).toMatchObject({ field: "description" });
      expect(updateTask).not.toHaveBeenCalled();
    });

    it("keeps the RUFU-295 shape guard as an independent check", async () => {
      const { store, updateTask } = fakeStore();
      // charset-clean but shape-junk: the pre-existing code must still refuse it, under its own code.
      const result = await runTool("fn_task_update", store, {
        id: "RUFU-307",
        title: `## N\u00E1vrh\n\n${"Popis karty. ".repeat(60)}`,
      });

      expect(result.details).toMatchObject({ code: "TITLE_REJECTED" });
      expect(textOf(result)).not.toContain("disallowed code point");
      expect(updateTask).not.toHaveBeenCalled();
    });

    it("renames the card with a clean Slovak title", async () => {
      const { store, updateTask } = fakeStore();
      const result = await runTool("fn_task_update", store, {
        id: "RUFU-307",
        title: "Platn\u00FD n\u00E1zev karty",
      });

      expect(updateTask).toHaveBeenCalledTimes(1);
      expect(result.isError).not.toBe(true);
    });
  });

  describe("fn_delegate_task", () => {
    it("refuses a dirty description even though delegation bypasses the create chokepoint", async () => {
      const { store, createTask } = fakeStore();
      const result = await runTool("fn_delegate_task", store, { agent_id: "agent-x", description: DIRTY });
      const text = textOf(result);

      expect(text).toContain("ERROR:");
      expect(text).toContain("U+521B");
      expect(result.isError).toBe(true);
      expect(createTask).not.toHaveBeenCalled();
    });
  });
});
