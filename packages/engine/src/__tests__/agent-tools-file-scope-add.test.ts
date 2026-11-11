import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fusionCore from "@fusion/core";
import type { TaskStore } from "@fusion/core";
import { createTaskFileScopeAddTool } from "../agent-tools.js";

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>());
});

const TASK_ID = "FN-4242";

const PROMPT_WITH_SCOPE = `## Mission
Do the thing.

## File Scope
- \`packages/engine/src/existing.ts\`

## Steps
1. Go.
`;

function createMockStore(prompt: string) {
  const getTask = vi.fn<TaskStore["getTask"]>().mockResolvedValue({ id: TASK_ID, prompt } as any);
  const updateTask = vi.fn<TaskStore["updateTask"]>().mockResolvedValue(undefined as any);
  const appendAgentLog = vi.fn<TaskStore["appendAgentLog"]>().mockResolvedValue(undefined);
  const store = { getTask, updateTask, appendAgentLog } as unknown as TaskStore;
  return { store, getTask, updateTask, appendAgentLog };
}

async function runTool(tool: { execute: (...args: any[]) => Promise<any> }, params: Record<string, unknown>) {
  return tool.execute("call-1", params, undefined as any, undefined as any, undefined as any);
}

function getText(result: any): string {
  const first = result?.content?.[0];
  return first?.type === "text" ? first.text : "";
}

describe("fn_task_file_scope_add", () => {
  beforeEach(() => vi.clearAllMocks());

  it("appends new valid files to the ## File Scope section and persists via updateTask", async () => {
    const { store, updateTask, appendAgentLog } = createMockStore(PROMPT_WITH_SCOPE);
    const tool = createTaskFileScopeAddTool(store, TASK_ID);

    const result = await runTool(tool, { files: ["packages/engine/src/foo.ts"], reason: "needed for the fix" });

    expect(updateTask).toHaveBeenCalledTimes(1);
    const [, updates] = updateTask.mock.calls[0];
    const newPrompt = (updates as { prompt: string }).prompt;
    // Both the original and the new entry are present, and the new one is inside File Scope.
    expect(newPrompt).toContain("`packages/engine/src/existing.ts`");
    expect(newPrompt).toContain("`packages/engine/src/foo.ts`");
    // Appended into the File Scope section, not after ## Steps.
    const scopeIdx = newPrompt.indexOf("## File Scope");
    const stepsIdx = newPrompt.indexOf("## Steps");
    expect(newPrompt.indexOf("`packages/engine/src/foo.ts`")).toBeGreaterThan(scopeIdx);
    expect(newPrompt.indexOf("`packages/engine/src/foo.ts`")).toBeLessThan(stepsIdx);
    expect(appendAgentLog).toHaveBeenCalledTimes(1);
    expect(getText(result)).toMatch(/Added to File Scope/);
  });

  it("does not duplicate an entry already in scope and does not call updateTask when nothing new", async () => {
    const { store, updateTask } = createMockStore(PROMPT_WITH_SCOPE);
    const tool = createTaskFileScopeAddTool(store, TASK_ID);

    const result = await runTool(tool, { files: ["packages/engine/src/existing.ts"] });

    expect(updateTask).not.toHaveBeenCalled();
    expect(getText(result)).toMatch(/Already present/);
  });

  it("rejects invalid entries (path traversal / leading slash) and reports them", async () => {
    const { store, updateTask } = createMockStore(PROMPT_WITH_SCOPE);
    const tool = createTaskFileScopeAddTool(store, TASK_ID);

    const result = await runTool(tool, { files: ["../secrets.txt", "/etc/passwd"] });

    expect(updateTask).not.toHaveBeenCalled();
    expect(getText(result)).toMatch(/Rejected/);
  });

  it("adds valid files while rejecting invalid ones in the same call", async () => {
    const { store, updateTask } = createMockStore(PROMPT_WITH_SCOPE);
    const tool = createTaskFileScopeAddTool(store, TASK_ID);

    const result = await runTool(tool, { files: ["packages/engine/src/foo.ts", "../bad"] });

    expect(updateTask).toHaveBeenCalledTimes(1);
    const text = getText(result);
    expect(text).toMatch(/Added to File Scope: packages\/engine\/src\/foo\.ts/);
    expect(text).toMatch(/Rejected.*\.\.\/bad/);
  });

  it("errors without mutating when PROMPT.md has no ## File Scope section", async () => {
    const { store, updateTask } = createMockStore("## Mission\nDo it.\n\n## Steps\n1. Go.\n");
    const tool = createTaskFileScopeAddTool(store, TASK_ID);

    const result = await runTool(tool, { files: ["packages/engine/src/foo.ts"] });

    expect(updateTask).not.toHaveBeenCalled();
    expect(getText(result)).toMatch(/no "## File Scope" section/);
  });
});

/*
FNXC:FileScope 2026-11-11-16:09 (RUFU-494):
`fn_task_file_scope_add` persists through `store.updateTask({ prompt })`, and that write runs
`validateFileScopeInPromptContent` over the WHOLE new prompt. So a card whose spec declares its files
in the repo's encouraged annotated style could not widen its own scope at all: the surviving
annotation from the pre-existing bullet made the new prompt invalid and the store refused it - which
strands the executor's edits at the squash, the exact failure the tool exists to prevent. These cases
put the store's real gate on the mock so the round trip is proven, not assumed.
*/
const PROMPT_WITH_ANNOTATED_BULLET = `## Mission
Do the thing.

## File Scope
- \`packages/engine/src/existing.ts\` (returns an object literal with a \`rerouted\` false branch)

## Steps
1. Go.
`;

/**
 * A mock store that enforces the SAME gate the real store applies on a prompt write, expressed
 * through the shared core harvest - so a refusal here is the production refusal, not an invention.
 */
function createGatedMockStore(prompt: string) {
  const getTask = vi.fn<TaskStore["getTask"]>().mockResolvedValue({ id: TASK_ID, prompt } as any);
  const updateTask = vi.fn<TaskStore["updateTask"]>().mockImplementation(async (_id, updates) => {
    const next = (updates as { prompt?: string }).prompt ?? "";
    const invalid = fusionCore.extractFileScopeTokens(next).filter((token) => !fusionCore.isValidFileScopeEntry(token));
    if (invalid.length > 0) {
      throw new Error(`InvalidFileScopeError: Invalid File Scope entries in PROMPT.md for ${_id}: ${invalid.join(", ")}`);
    }
    return undefined as any;
  });
  const appendAgentLog = vi.fn<TaskStore["appendAgentLog"]>().mockResolvedValue(undefined);
  return { store: { getTask, updateTask, appendAgentLog } as unknown as TaskStore, updateTask };
}

describe("fn_task_file_scope_add with inline annotations in the declared scope (RUFU-494)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds a file to a section whose existing bullet carries an inline annotation", async () => {
    const { store, updateTask } = createGatedMockStore(PROMPT_WITH_ANNOTATED_BULLET);
    const tool = createTaskFileScopeAddTool(store, TASK_ID);

    const result = await runTool(tool, { files: ["packages/engine/src/new.ts"], reason: "needed for the fix" });

    expect(getText(result)).not.toMatch(/ERROR/);
    expect(getText(result)).toMatch(/Added to File Scope: packages\/engine\/src\/new\.ts/);
    expect(updateTask).toHaveBeenCalledTimes(1);
    const newPrompt = (updateTask.mock.calls[0]![1] as { prompt: string }).prompt;
    // The annotated bullet survives verbatim - the tool must not launder the operator's annotation.
    expect(newPrompt).toContain(
      "- `packages/engine/src/existing.ts` (returns an object literal with a `rerouted` false branch)",
    );
    expect(newPrompt).toContain("- `packages/engine/src/new.ts`");
  });

  it("adds a path that only appears as an annotation instead of reporting Already present", async () => {
    const prompt = `## File Scope

- \`packages/engine/src/existing.ts\` (see also \`packages/engine/src/extra.ts\` for the reason)

## Steps
1. Go.
`;
    const { store, updateTask } = createMockStore(prompt);
    const tool = createTaskFileScopeAddTool(store, TASK_ID);

    const result = await runTool(tool, { files: ["packages/engine/src/extra.ts"] });

    expect(getText(result)).not.toMatch(/Already present/);
    expect(getText(result)).toMatch(/Added to File Scope: packages\/engine\/src\/extra\.ts/);
    expect(updateTask).toHaveBeenCalledTimes(1);
  });

  it("keeps refusing an invalid addition while the annotated bullet stays untouched", async () => {
    const { store, updateTask } = createGatedMockStore(PROMPT_WITH_ANNOTATED_BULLET);
    const tool = createTaskFileScopeAddTool(store, TASK_ID);

    const result = await runTool(tool, { files: ["../escape.ts"] });

    expect(updateTask).not.toHaveBeenCalled();
    expect(getText(result)).toMatch(/Rejected/);
  });
});
