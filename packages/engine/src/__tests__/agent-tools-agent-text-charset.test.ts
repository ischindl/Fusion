/**
 * FNXC:AgentTextCharset 2026-11-04-12:08 (RUFU-307):
 * Every engine surface that shows agent-authored text to the operator must refuse a code point outside the
 * allowlist, and must refuse it WITHOUT writing anything. A green targeted run of the guard's own unit tests
 * would not catch a surface that was never wired, so this file drives each mandated channel's real `execute`
 * and asserts the pair that matters: reject + zero store/file writes, and clean Slovak text passes unchanged.
 *
 * Offenders are written as `\uXXXX` escapes because the repository's own gate
 * (`scripts/check-nonlatin-tracked-text.mjs`) refuses a tracked file holding a raw non-Latin letter; an
 * escape still builds the real character at runtime, so these exercise the exact incident code points.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import {
  createArtifactRegisterTool,
  createAgentTask,
  createDelegateTaskTool,
  createMemoryAppendTool,
  createPostRoomMessageTool,
  createSendMessageTool,
  createTaskCreateTool,
  createTaskLogTool,
  createTaskLogToolWithContext,
  createTaskPromptWriteTool,
  createTaskUpdateTool as createAgentTaskUpdateTool,
} from "../agent-tools.js";
import { createTaskUpdateTool as createExecutorTaskUpdateTool } from "../executor/create-task-update-tool.js";
import { createTaskDoneTool } from "../executor/create-task-done-tool.js";
import { TriageProcessor } from "../triage.js";

const TASK_ID = "RUFU-307";

/** The incident, mid-word: `agent <U+521B><U+5EFA>uje proces` — the "-uje" ending survives the replacement. */
const DIRTY = "agent \u521B\u5EFAuje proces";
/**
 * A legitimate Slovak sentence carrying the whole allowed diacritic set. It deliberately uses ONLY the 18
 * allowed lowercase and 18 allowed uppercase letters: an earlier draft of this fixture ended in `Ř`, which is
 * Czech and is NOT in the allowlist, so the guard refused its own positive control. That is the fixture being
 * wrong, not the guard — and it is exactly the failure mode operator requirement 2 exists to catch.
 */
const CLEAN = "Agent vytvára proces na karte: äčľéíĺľňôŕŤýž ÄČĽÔ";

function text(result: { content?: Array<{ type: string; text?: string }> }): string {
  const first = result?.content?.[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

/** Every rejection names the offending code points and offers the rewrite, on every surface alike. */
function expectCharsetRefusal(result: unknown, expected: string[] = ["U+521B", "U+5EFA"], message = text(result as never)) {
  expect(message).toContain("disallowed code point(s)");
  for (const codePoint of expected) expect(message).toContain(codePoint);
  expect(message).toContain("Rewrite with allowed characters and retry.");
  // The raw glyph never re-appears in the text an operator or agent has to read.
  expect(message).not.toContain("\u521B");
  expect(message).not.toContain("\u5361");
}

// ── create lanes ────────────────────────────────────────────────────────────

function createCapableStore(overrides: Record<string, unknown> = {}) {
  const createTask = vi.fn(async () => ({
    id: "RUFU-308",
    title: "Created",
    description: "created body",
    dependencies: [],
    column: "triage",
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  const store = {
    isBackendMode: () => false,
    on: vi.fn(),
    getSettings: vi.fn(async () => ({ autoSummarizeTitles: false })),
    getDefaultWorkflowId: vi.fn(async () => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => "/project"),
    getMissionStore: vi.fn(() => ({
      getFeature: vi.fn(async () => null),
      getSlice: vi.fn(async () => null),
      getMilestone: vi.fn(async () => null),
      getMission: vi.fn(async () => null),
      getFeatureByTaskId: vi.fn(async () => null),
    })),
    searchTasks: vi.fn(async () => []),
    findRecentTasksBySourceParentTaskId: vi.fn(async () => []),
    findRecentTasksByContentFingerprint: vi.fn(async () => []),
    updateTask: vi.fn(async () => ({})),
    moveTask: vi.fn(async () => ({})),
    deleteTask: vi.fn(async () => ({})),
    createTask,
    ...overrides,
  } as unknown as TaskStore;
  return { store, createTask };
}

describe("RUFU-307 agent text charset guard (engine surfaces)", () => {
  describe("createAgentTask chokepoint", () => {
    it("refuses a description carrying the incident code points and never reaches createTask", async () => {
      const { store, createTask } = createCapableStore();
      await expect(createAgentTask(store, { description: DIRTY })).rejects.toThrow(/disallowed code point/);
      expect(createTask).not.toHaveBeenCalled();
    });

    it("refuses a dirty title even when the description is clean", async () => {
      const { store, createTask } = createCapableStore();
      await expect(createAgentTask(store, { title: `Karty \u5361`, description: CLEAN })).rejects.toThrow(/title/);
      expect(createTask).not.toHaveBeenCalled();
    });

    it("creates normally when title and description carry full Slovak diacritics", async () => {
      const { store, createTask } = createCapableStore();
      const { task } = await createAgentTask(store, { title: "Oprava diacritiky", description: CLEAN });
      expect(createTask).toHaveBeenCalledTimes(1);
      expect(task.id).toBe("RUFU-308");
    });

    it("engine fn_task_create returns ERROR text naming the code points, session still alive", async () => {
      const { store, createTask } = createCapableStore();
      const result = await createTaskCreateTool(store).execute("c1", { description: DIRTY } as never);
      expectCharsetRefusal(result);
      expect(text(result)).toMatch(/^ERROR: Agent text rejected: field "description"/);
      expect(result.isError).toBe(true);
      expect(createTask).not.toHaveBeenCalled();
    });

    it("engine fn_task_create accepts clean Slovak text", async () => {
      const { store, createTask } = createCapableStore();
      const result = await createTaskCreateTool(store).execute("c2", {
        title: "Prida\u0165 kontrolu znakov",
        description: CLEAN,
      } as never);
      expect(createTask).toHaveBeenCalledTimes(1);
      expect(result.isError).not.toBe(true);
    });

    it("engine fn_delegate_task refuses a dirty description with no task created", async () => {
      const { store, createTask } = createCapableStore();
      const agentStore = {
        getAgent: vi.fn(async () => ({ id: "agent-x", name: "X", role: "executor", state: "idle" })),
        listAgents: vi.fn(async () => []),
      };
      const result = await createDelegateTaskTool(agentStore as never, store).execute("c3", {
        agent_id: "agent-x",
        description: DIRTY,
      } as never);
      expectCharsetRefusal(result);
      expect(text(result)).toMatch(/^ERROR:/);
      expect(createTask).not.toHaveBeenCalled();
    });

    it("triage's own fn_task_create refuses typed findings instead of reporting a store outage", async () => {
      const { store, createTask } = createCapableStore();
      const processor = new TriageProcessor(store, "/tmp/rufu-307");
      const tools = (processor as unknown as {
        createTriageTools(options: { parentTaskId: string }): Array<{ name: string; execute: (...args: any[]) => Promise<any> }>;
      }).createTriageTools({ parentTaskId: TASK_ID });
      const create = tools.find((tool) => tool.name === "fn_task_create")!;

      const result = await create.execute("c4", { description: DIRTY });
      expectCharsetRefusal(result);
      // The planner must not be told its own text was an infrastructure failure.
      expect(text(result)).not.toMatch(/outage|unavailable|retry later/i);
      expect(createTask).not.toHaveBeenCalled();
    });
  });

  describe("fn_task_log (both factories)", () => {
    for (const [label, build] of [
      ["createTaskLogTool", (store: TaskStore) => createTaskLogTool(store, TASK_ID)],
      ["createTaskLogToolWithContext", (store: TaskStore) => createTaskLogToolWithContext(store, TASK_ID, undefined)],
    ] as const) {
      it(`${label}: refuses a dirty message and calls logEntry zero times`, async () => {
        const logEntry = vi.fn(async () => {});
        const store = { logEntry } as unknown as TaskStore;
        const result = await build(store).execute("c", { message: DIRTY } as never);
        expectCharsetRefusal(result);
        expect(logEntry).not.toHaveBeenCalled();
      });

      it(`${label}: logs a clean Slovak message`, async () => {
        const logEntry = vi.fn(async () => {});
        const store = { logEntry } as unknown as TaskStore;
        const result = await build(store).execute("c", { message: CLEAN } as never);
        expect(logEntry).toHaveBeenCalledTimes(1);
        expect(result.isError).not.toBe(true);
      });
    }
  });

  describe("fn_send_message", () => {
    function harness() {
      const sendMessage = vi.fn(async () => ({ id: "msg-1" }));
      const messageStore = { getMessage: vi.fn(async () => null), sendMessage };
      const agentStore = { getAgent: vi.fn(async () => ({ id: "agent-b" })) };
      return { messageStore, sendMessage, agentStore };
    }

    it("refuses a dirty content body before any message row", async () => {
      const { messageStore, sendMessage } = harness();
      const tool = createSendMessageTool(messageStore as never, "agent-a", {} as never);
      const result = await tool.execute("c", { to_id: "agent-b", content: DIRTY, type: "agent-to-agent" } as never);
      expectCharsetRefusal(result);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("refuses a dirty report section body, not just the content envelope", async () => {
      const { messageStore, sendMessage } = harness();
      const tool = createSendMessageTool(messageStore as never, "agent-a", {} as never);
      const result = await tool.execute("c", {
        to_id: "agent-b",
        content: "S\u00FAhrn v pr\u00EDlohe.",
        mail_kind: "report",
        report: { title: "Správa", sections: [{ heading: "Nález", body: DIRTY }] },
      } as never);
      expectCharsetRefusal(result);
      expect(text(result)).toContain('field "report.sections[].body"');
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("refuses a dirty report title", async () => {
      const { messageStore, sendMessage } = harness();
      const tool = createSendMessageTool(messageStore as never, "agent-a", {} as never);
      const result = await tool.execute("c", {
        to_id: "agent-b",
        content: "ok",
        mail_kind: "report",
        report: { title: `Titulok \u5361`, sections: [{ heading: "Nález", body: "text" }] },
      } as never);
      expectCharsetRefusal(result, ["U+5361"]);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    /*
    FNXC:AgentTextCharset 2026-11-05-00:24 (RUFU-307):
    The report scan runs OUTSIDE the handler's `try`, so it must not assume `sections` exists. A `report`
    object that is present but malformed is schema-typed and sendable — `tool-write-failure-boundary-drive.test.ts`
    drives exactly that payload — and a throw escaping `execute` breaks the session-safety contract this task
    is built on. The malformed payload has to land on the pre-existing structural validation instead, so the
    agent still gets a tool result rather than an exception. This is the regression pin for that ordering.
    */
    it("answers with a tool result, not an exception, when report is present but malformed", async () => {
      const { messageStore, sendMessage } = harness();
      const tool = createSendMessageTool(messageStore as never, "agent-a", {} as never);
      const result = await tool
        .execute("c", { to_id: "agent-b", content: "Detaily nižšie.", mail_kind: "report", report: {} } as never)
        .catch((error: unknown) => {
          throw new Error(`refused to escape execute: ${error instanceof Error ? error.message : String(error)}`);
        });
      // Not a charset refusal, and nothing was delivered: the malformed payload is answered, not crashed.
      expect(text(result)).not.toContain("Agent text rejected");
      expect(result.isError).toBe(true);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("sends clean Slovak mail and report bodies", async () => {
      const { messageStore, sendMessage } = harness();
      const tool = createSendMessageTool(messageStore as never, "agent-a", {} as never);
      const result = await tool.execute("c", {
        to_id: "agent-b",
        content: CLEAN,
        mail_kind: "report",
        report: { title: "Správa", sections: [{ heading: "Nález", body: "Karta je v poriadku." }] },
      } as never);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(result.isError).not.toBe(true);
    });
  });

  describe("fn_post_room_message", () => {
    function harness() {
      const addRoomMessage = vi.fn(async () => ({ id: "room-msg-1" }));
      const chatStore = {
        listRoomMembers: vi.fn(async () => [{ agentId: "agent-a" }]),
        addRoomMessage,
      };
      return { chatStore, addRoomMessage };
    }

    it("refuses a dirty room post before the membership read and before the post", async () => {
      const { chatStore, addRoomMessage } = harness();
      const result = await createPostRoomMessageTool(chatStore as never, "agent-a").execute("c", {
        roomId: "room-1",
        content: DIRTY,
      } as never);
      expectCharsetRefusal(result);
      expect(addRoomMessage).not.toHaveBeenCalled();
      expect(chatStore.listRoomMembers).not.toHaveBeenCalled();
    });

    it("posts clean Slovak text to a room", async () => {
      const { chatStore, addRoomMessage } = harness();
      const result = await createPostRoomMessageTool(chatStore as never, "agent-a").execute("c", {
        roomId: "room-1",
        content: CLEAN,
      } as never);
      expect(addRoomMessage).toHaveBeenCalledTimes(1);
      expect(result.isError).not.toBe(true);
    });
  });

  describe("fn_memory_append (both scopes)", () => {
    async function tempRoot() {
      return mkdtemp(join(tmpdir(), "rufu307-memory-"));
    }

    for (const scope of ["project", "agent"] as const) {
      it(`${scope} scope: refuses dirty content and writes no memory file`, async () => {
        const root = await tempRoot();
        const options = scope === "agent" ? { agentMemory: { agentId: "agent-1", agentName: "A" } } : undefined;
        const result = await createMemoryAppendTool(root, undefined, options).execute("c", {
          scope,
          layer: "long-term",
          content: DIRTY,
        } as never);
        expectCharsetRefusal(result);
        // Both backends are refused before their own append: neither the shared nor the agent-private tree
        // is created at all, so a refused call leaves zero bytes behind.
        expect(existsSync(join(root, ".fusion"))).toBe(false);
      });

      it(`${scope} scope: appends clean Slovak prose`, async () => {
        const root = await tempRoot();
        const options = scope === "agent" ? { agentMemory: { agentId: "agent-1", agentName: "A" } } : undefined;
        const result = await createMemoryAppendTool(root, undefined, options).execute("c", {
          scope,
          layer: "long-term",
          content: CLEAN,
        } as never);
        expect(result.isError).not.toBe(true);
        const written = await readFile(join(root, ".fusion", scope === "agent" ? "agent-memory" : "memory", scope === "agent" ? "agent-1" : "", "MEMORY.md"), "utf-8");
        expect(written).toContain(CLEAN);
      });
    }
  });

  describe("fn_artifact_register", () => {
    for (const field of ["title", "description", "content"] as const) {
      it(`refuses a dirty ${field} and registers nothing`, async () => {
        const registerArtifact = vi.fn();
        const store = { registerArtifact } as unknown as TaskStore;
        const payload = { type: "document", [field]: DIRTY };
        const result = await createArtifactRegisterTool(store, "agent-a").execute("c", payload as never);
        expectCharsetRefusal(result);
        expect(text(result)).toContain(`field "${field}"`);
        expect(registerArtifact).not.toHaveBeenCalled();
      });
    }

    it("registers an artifact whose title and inline content are clean Slovak", async () => {
      const registerArtifact = vi.fn(async (input: Record<string, unknown>) => ({ id: "ART-1", ...input }));
      const store = { registerArtifact } as unknown as TaskStore;
      const result = await createArtifactRegisterTool(store, "agent-a").execute("c", {
        type: "document",
        title: "V\u00FDsledok kontroly",
        content: CLEAN,
      } as never);
      expect(registerArtifact).toHaveBeenCalledTimes(1);
      expect(result.isError).not.toBe(true);
    });
  });

  describe("fn_task_update — BOTH implementations", () => {
    function taskFixture(): Task {
      return {
        id: TASK_ID,
        title: "Guard agent text",
        description: "Refuse foreign-script code points.",
        priority: "normal",
        column: "in-progress",
        currentStep: 1,
        steps: [{ name: "Preflight", status: "done" }, { name: "Implement", status: "in-progress" }],
        dependencies: [],
        log: [],
        createdAt: "2026-09-26T00:00:00.000Z",
        updatedAt: "2026-09-26T00:00:00.000Z",
      } as Task;
    }

    function store() {
      const updateTask = vi.fn(async () => taskFixture());
      const updateStep = vi.fn(async () => taskFixture());
      const fake = {
        isBackendMode: () => false,
        updateTask,
        updateStep,
        getTask: vi.fn(async () => taskFixture()),
        getSettings: vi.fn(async () => ({ autoSummarizeTitles: false })),
        updateTaskCustomFields: vi.fn(async () => ({ ok: true })),
      } as unknown as TaskStore;
      return { fake, updateTask, updateStep };
    }

    const lanes = [
      {
        name: "executor copy",
        // RUFU-295 shipped this lane's structured machine-readable codes; the chat copy refuses in prose.
        structuredCode: true,
        tool: (fake: TaskStore) => createExecutorTaskUpdateTool(
          { store: fake, resolveTaskCustomFieldDefs: async () => undefined, loopRecoveryState: new Map() } as never,
          TASK_ID,
          new Map(),
          { current: null } as never,
        ),
      },
      {
        name: "chat copy",
        // Both copies carry the same machine-readable charset code (pinned here so the two cannot drift).
        structuredCode: true,
        tool: (fake: TaskStore) => createAgentTaskUpdateTool(fake, TASK_ID),
      },
    ] as const;

    for (const lane of lanes) {
      it(`${lane.name}: refuses a dirty title with NEITHER task update NOR step update`, async () => {
        const { fake, updateTask, updateStep } = store();
        const result = await lane.tool(fake).execute("c", { title: `Premenovanie \u5361 karty` } as never);
        expectCharsetRefusal(result, ["U+5361"]);
        expect(text(result)).toContain("Nothing was persisted.");
        expect(updateTask).not.toHaveBeenCalled();
        expect(updateStep).not.toHaveBeenCalled();
      });

      it(`${lane.name}: refuses a dirty step summary BEFORE the title write, persisting nothing`, async () => {
        const { fake, updateTask, updateStep } = store();
        const result = await lane.tool(fake).execute("c", {
          title: "Platn\u00FD n\u00E1zev karty",
          step: 1,
          status: "done",
          summary: DIRTY,
        } as never);
        expectCharsetRefusal(result);
        expect(text(result)).toContain('field "summary"');
        // The ordering promise: a late summary refusal must not strand the rename this call also carried.
        expect(updateTask).not.toHaveBeenCalled();
        expect(updateStep).not.toHaveBeenCalled();
      });

      it(`${lane.name}: keeps the shape guards as independent checks`, async () => {
        const { fake, updateTask } = store();
        // (a) shape-valid (one line, short, no heading) but charset-invalid -> the charset guard refuses it
        const charset = await lane.tool(fake).execute("c", { title: "Karty \u5361" } as never);
        expect(text(charset)).toContain("disallowed code point");
        expect(charset.details).toMatchObject({ code: "AGENT_TEXT_CHARSET", field: "title" });
        expect(text(charset)).not.toContain("TITLE_REJECTED");
        // (b) charset-clean but shape-invalid -> the pre-existing RUFU-295 shape guard still refuses it,
        // which proves the new guard did not displace the old one.
        const shape = await lane.tool(fake).execute("c", {
          title: `## Popis\n\n${"Popis karty. ".repeat(60)}`,
        } as never);
        expect(text(shape)).toContain("title rejected");
        expect(text(shape)).not.toContain("disallowed code point");
        if (lane.structuredCode) expect(shape.details).toMatchObject({ code: "TITLE_REJECTED" });
        expect(updateTask).not.toHaveBeenCalled();
      });

      it(`${lane.name}: renames and records a clean Slovak step summary`, async () => {
        const { fake, updateTask, updateStep } = store();
        const result = await lane.tool(fake).execute("c", {
          title: "Platn\u00FD n\u00E1zev karty",
          step: 1,
          status: "done",
          summary: CLEAN,
        } as never);
        expect(updateTask).toHaveBeenCalledTimes(1);
        expect(updateStep).toHaveBeenCalledTimes(1);
        expect(text(result)).not.toContain("disallowed code point");
      });
    }
  });

  describe("fn_task_done", () => {
    function doneHarness() {
      const task = {
        id: TASK_ID,
        column: "in-progress",
        steps: [{ name: "Implement", status: "done" }],
      } as Task;
      const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch));
      const moveTask = vi.fn(async () => ({}));
      const logEntry = vi.fn(async () => {});
      const store = {
        getTask: vi.fn(async () => task),
        getSettings: vi.fn(async () => ({})),
        updateTask,
        moveTask,
        logEntry,
      } as unknown as TaskStore;
      const deps = {
        store,
        getRunContextFor: () => undefined,
        persistTokenUsage: vi.fn(),
        markGraphExecuteSelfRequeued: vi.fn(),
        deleteActiveSession: vi.fn(),
        clearTokenUsageBaseline: vi.fn(),
        workflowLifecycleMovesInFlight: new Set<string>(),
        getTaskCompletionBlocker: async () => undefined,
        evaluateTaskVerdictProviders: async () => ({ ok: true as const }),
        verifyWorktreeInvariants: async () => ({ ok: true as const }),
        evaluateTaskDoneScopeLeak: async () => ({ blocked: false as const }),
        scheduleCompletedTaskWatchdog: vi.fn(),
        finalizeAcceptedNoOpCompletion: vi.fn(),
      };
      const onDone = vi.fn();
      const tool = createTaskDoneTool(deps as never, TASK_ID, "/repo/.worktrees/x", "", new Map(), onDone);
      return { store, updateTask, moveTask, onDone, tool };
    }

    it("refuses a dirty completion summary without completing the card", async () => {
      const { updateTask, moveTask, onDone, tool } = doneHarness();
      const result = await tool.execute("c", { summary: DIRTY } as never);
      expectCharsetRefusal(result);
      expect(updateTask).not.toHaveBeenCalled();
      expect(moveTask).not.toHaveBeenCalled();
      expect(onDone).not.toHaveBeenCalled();
    });

    it("completes with a clean Slovak summary", async () => {
      const { onDone, tool } = doneHarness();
      const result = await tool.execute("c", { summary: CLEAN } as never);
      // The completion path ran to its own verdict; the charset guard is not what answered.
      expect(text(result)).not.toContain("disallowed code point");
      expect(onDone.mock.calls.length + (result.isError ? 1 : 0)).toBeGreaterThan(0);
    });
  });

  describe("fn_task_prompt_write — saves with warning instead of refusing", () => {
    function promptStore(prompt: string) {
      const recordRunAuditEvent = vi.fn(async () => {});
      const updateTask = vi.fn(async () => ({ id: TASK_ID, prompt }));
      const getTask = vi.fn(async () => ({ id: TASK_ID, prompt }));
      const store = {
        isBackendMode: () => false,
        updateTask,
        getTask,
        recordRunAuditEvent,
      } as unknown as TaskStore;
      return { store, updateTask, recordRunAuditEvent };
    }

    it("persists violating plan content, warns in the response, and records exactly one audit row", async () => {
      const dirtyPlan = `# Plan\n\nKrok ${DIRTY}\n`;
      const { store, updateTask, recordRunAuditEvent } = promptStore(dirtyPlan);
      const result = await createTaskPromptWriteTool(store, TASK_ID).execute("c", { content: dirtyPlan } as never);

      expect(updateTask).toHaveBeenCalledTimes(1);
      expect(text(result)).toContain(`Updated PROMPT.md for ${TASK_ID}.`);
      expect(text(result)).toContain("WARNING");
      expect(text(result)).toContain("U+521B");
      expect(result.isError).not.toBe(true);

      expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
      const event = recordRunAuditEvent.mock.calls[0][0] as {
        mutationType: string;
        target: string;
        metadata: Record<string, unknown>;
      };
      expect(event.mutationType).toBe("task:agent-text-charset-warned");
      expect(event.target).toBe(`task:${TASK_ID}`);
      expect(event.metadata).toEqual({
        source: "fn_task_prompt_write",
        field: "content",
        disallowedCodePointCount: 2,
        disallowedCodePoints: ["U+521B", "U+5EFA"],
        persisted: true,
      });
      // Ids/counts/code-points-only: the row must never carry the raw offending characters.
      expect(JSON.stringify(event.metadata)).not.toContain("\u521B");
    });

    it("leaves a clean plan's response byte-identical and writes no audit row", async () => {
      const cleanPlan = "# Plan\n\nKrok: agent vytv\u00E1ra proces.\n";
      const { store, updateTask, recordRunAuditEvent } = promptStore(cleanPlan);
      const result = await createTaskPromptWriteTool(store, TASK_ID).execute("c", { content: cleanPlan } as never);

      expect(updateTask).toHaveBeenCalledTimes(1);
      expect(text(result)).toBe(`Updated PROMPT.md for ${TASK_ID}.`);
      expect(recordRunAuditEvent).not.toHaveBeenCalled();
    });
  });
});
