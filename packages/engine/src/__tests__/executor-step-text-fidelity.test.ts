/*
FNXC:AssistantTextCapture 2026-09-13-21:15:
RUFU-234 executor-lane capture-consumer contract. The workflow-step session feeds TWO sinks from one
closure — `output += delta` (the string a prompt/verdict step persists and downstream gates parse) and
`agentLogger.onText(delta)` (the agent-log text rows) — so a capture-seam regression silently corrupts the
workflow verdict AND the operator-visible task log at once, and the two can drift apart. This drives the
real `executeWorkflowStep` with a real pi event stream (openai-completions producer shape: the shared
`partial` block is mutated ahead of async delivery, exactly what dropped the operator's inter-word space at
the seam) and asserts both sinks receive the intact text, identically.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

function captureMutatedAheadSession(finalText: string, firstChunk: string) {
  mockedCreateFnAgent.mockImplementation(async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const partial = { content: [{ type: "text", text: firstChunk }] };
    const session: any = {
      state: {},
      subscribe: (fn: (event: unknown) => void) => {
        listeners.push(fn);
        return () => {};
      },
      prompt: vi.fn(async () => {
        const emit = (assistantMessageEvent: Record<string, unknown>) => {
          for (const fn of listeners) fn({ type: "message_update", assistantMessageEvent });
        };
        listeners.forEach((fn) => fn({ type: "message_start" }));
        emit({ type: "text_start", partial, contentIndex: 0 });
        // The producer coalesced " in-review" into the block before the paired delta was delivered.
        partial.content[0].text = finalText;
        emit({ type: "text_delta", partial, contentIndex: 0, delta: finalText.slice(firstChunk.length + 1) });
        listeners.forEach((fn) =>
          fn({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }] } }),
        );
      }),
      dispose: vi.fn(),
    };
    return { session };
  });
}

function quietGit() {
  mockedExecSync.mockImplementation(() => Buffer.from(""));
}

function baseTask() {
  const now = new Date().toISOString();
  return {
    id: "FN-234-LANE",
    title: "Stream fidelity lane",
    description: "verify executor capture sinks",
    column: "in-progress" as const,
    worktree: "/tmp/wt",
    branch: "fusion/fn-234-lane",
    baseCommitSha: "abc123",
    dependencies: [],
    steps: [{ name: "s", status: "in-progress" as const }],
    currentStep: 0,
    log: [],
    createdAt: now,
    updatedAt: now,
  };
}

function workflowStep() {
  const now = new Date().toISOString();
  return {
    id: "step:fidelity",
    name: "Fidelity Step",
    description: "",
    mode: "prompt" as const,
    phase: "pre-merge" as const,
    gateMode: "advisory" as const,
    prompt: "Answer.",
    summaryTarget: "task" as const,
    toolMode: "readonly" as const,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

describe("executeWorkflowStep — capture fan-out stays byte-faithful (RUFU-234)", () => {
  beforeEach(() => {
    resetExecutorMocks();
    quietGit();
  });

  it("hands the workflow output and the agent-log rows the same intact text (no dropped space)", async () => {
    const intact = "healthy in-review";
    const store = createMockStore();
    store.getSettings.mockResolvedValue({});
    const agentTextDeltas: string[] = [];
    const executor = new TaskExecutor(store as any, "/tmp/test", {
      agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
      onAgentText: (_taskId: string, delta: string) => { agentTextDeltas.push(delta); },
    } as any);
    captureMutatedAheadSession(intact, "healthy");

    const result = await (executor as any).executeWorkflowStep(baseTask(), workflowStep(), "/tmp/wt", {}, undefined, undefined);

    expect(result?.success).toBe(true);
    // Sink 1: the workflow verdict/output string downstream gates parse.
    expect(result.output).toBe(intact);
    // Sink 2: the agent-log lane, both as it streams per delta and as it persists text rows.
    expect(agentTextDeltas.join("")).toBe(intact);
    const batchCalls: any[][] = (store as any).appendAgentLogBatch?.mock?.calls ?? [];
    const singleCalls: any[][] = store.appendAgentLog?.mock?.calls ?? [];
    const persistedText = [
      ...batchCalls.flatMap(([entries]) => (entries ?? []).filter((entry: any) => entry.type === "text").map((entry: any) => String(entry.text))),
      ...singleCalls.filter(([, , type]) => type === "text").map(([, text]) => String(text)),
    ].join("");
    expect(persistedText).toBe(intact);
  });
});
