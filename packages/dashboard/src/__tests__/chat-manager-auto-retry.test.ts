/**
 * FNXC:ChatAutoRetry 2026-09-17-16:30 — one bounded auto-retry for reply-less chat turns.
 *
 * A turn that ends with thinking/tool evidence but NO visible reply (the "thinking ended,
 * no answer" shape from ai_workstation chat-ed81f6e8) must be re-prompted exactly ONCE by
 * ChatManager itself, riding the normal send path as a metadata-marked user row. It must
 * NOT retry: budget-exhausted turns (a retry hits the same wall), silent runtimes that
 * produced nothing at all, a second time after the retry itself ends reply-less, an
 * explicitly stopped turn, or a turn parked on a question card awaiting the user's answer.
 *
 * FNXC:ChatAutoRetry 2026-09-17-23:31 (RUFU-255 retro audit):
 * The never-retry gate matrix is now fully pinned: this file additionally covers the
 * explicit-Stop gate (cancellation returns before the dispatch point), the pending-question
 * gate (last tool is fn_ask_question), and asserts the provider-error reason VALUE on the
 * synthetic row (chat-manager.test.ts pinned only the row counts).
 *
 * Pattern: chat-manager-budget-exhaustion.test.ts — mocked engine seams + fake pi-shaped
 * session; the real ChatManager success path runs against the fake. No LLM, no network.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { mockCreateResolvedAgentSession, mockPromptWithFallback, mockChatStore } = vi.hoisted(() => ({
  mockCreateResolvedAgentSession: vi.fn(),
  mockPromptWithFallback: vi.fn(async (_session: unknown, _prompt: unknown, _options?: unknown) => undefined),
  mockChatStore: {
    getSession: vi.fn(),
    createSession: vi.fn(),
    addMessage: vi.fn(async () => ({ id: "msg-persisted" })),
    getMessages: vi.fn(async () => []),
    updateSession: vi.fn(),
    updateMessageMetadata: vi.fn(),
    setInFlightGeneration: vi.fn(),
    setCliSessionFile: vi.fn(),
    recordTokenUsage: vi.fn(),
  },
}));

vi.mock("@fusion/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/engine")>();
  return {
    ...actual,
    createResolvedAgentSession: mockCreateResolvedAgentSession,
    promptWithFallback: mockPromptWithFallback,
  };
});

import { ChatManager, __setBuildAgentChatPrompt } from "../chat.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "fusion-chat-auto-retry-"));
afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

interface FakeFinalAssistant {
  role: "assistant";
  content?: unknown;
  stopReason?: string;
}

/** The fake plays one scripted final row per prompt call, then repeats the last one. */
function makeFakeSession(finals: FakeFinalAssistant[], thinkingDeltas: string[] = []) {
  let call = 0;
  const session = {
    model: { provider: "test-provider", id: "test-model", contextWindow: 128_000, maxTokens: 4_096 },
    state: { messages: [] as Array<Record<string, unknown>> },
    prompt: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  const createSession = vi.fn(async (opts: { onThinking?: (delta: string) => void }) => {
    session.prompt = vi.fn(async () => {
      for (const delta of thinkingDeltas) opts.onThinking?.(delta);
      const final = finals[Math.min(call, finals.length - 1)];
      call += 1;
      session.state.messages.push({ ...final });
    });
    return { session, model: { provider: "test-provider", modelId: "test-model" } };
  });
  return { createSession, promptCalls: () => call };
}

function makeManager(): ChatManager {
  return new ChatManager(mockChatStore as never, TEST_ROOT, undefined as never, undefined, undefined);
}

function autoRetryUserRows() {
  return mockChatStore.addMessage.mock.calls.filter(
    (c) => (c[1] as { role?: string; metadata?: Record<string, unknown> } | undefined)?.role === "user"
      && (c[1] as { metadata?: Record<string, unknown> }).metadata?.autoRetry === true,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockChatStore.getSession.mockReturnValue({
    id: "chat-auto-retry",
    projectId: "proj-1",
    title: "auto-retry-test-session",
  });
  mockChatStore.addMessage.mockImplementation(async () => ({ id: "msg-persisted" }));
  mockChatStore.getMessages.mockImplementation(async () => []);
  __setBuildAgentChatPrompt(async ({ basePrompt }: { basePrompt: string }) => basePrompt);
  mockPromptWithFallback.mockImplementation(async (sessionArg?: { prompt?: () => Promise<void> }) => {
    await sessionArg?.prompt?.();
  });
});

describe("ChatManager.sendMessage — bounded auto-retry of reply-less turns", () => {
  it("re-prompts exactly once, as a marked user row, when a thinking-only turn ends with no reply", async () => {
    const { createSession, promptCalls } = makeFakeSession(
      [
        { role: "assistant", content: [{ type: "thinking", thinking: "planning the answer" }], stopReason: "stop" },
        { role: "assistant", content: "Here is the real reply.", stopReason: "stop" },
      ],
      ["thinking delta"],
    );
    mockCreateResolvedAgentSession.mockImplementation(createSession);

    await makeManager().sendMessage("chat-auto-retry", "do the thing");

    expect(promptCalls()).toBe(2);
    const retries = autoRetryUserRows();
    expect(retries).toHaveLength(1);
    expect((retries[0][1] as { metadata: Record<string, unknown> }).metadata).toEqual(
      expect.objectContaining({ autoRetry: true, reason: "empty" }),
    );
    const assistantRows = mockChatStore.addMessage.mock.calls
      .filter((c) => (c[1] as { role?: string }).role === "assistant")
      .map((c) => (c[1] as { content: string }).content);
    expect(assistantRows[0]).toBe("");
    expect(assistantRows[1]).toBe("Here is the real reply.");
  });

  it("does not retry a budget-exhausted turn", async () => {
    const { createSession, promptCalls } = makeFakeSession(
      [{ role: "assistant", content: [{ type: "thinking", thinking: "spent it all" }], stopReason: "length" }],
      ["thinking delta"],
    );
    mockCreateResolvedAgentSession.mockImplementation(createSession);

    await makeManager().sendMessage("chat-auto-retry", "do the thing");

    expect(promptCalls()).toBe(1);
    expect(autoRetryUserRows()).toHaveLength(0);
  });

  it("never chains: a retry that also ends reply-less is not retried again", async () => {
    const { createSession, promptCalls } = makeFakeSession(
      [{ role: "assistant", content: [{ type: "thinking", thinking: "silent again" }], stopReason: "stop" }],
      ["thinking delta"],
    );
    mockCreateResolvedAgentSession.mockImplementation(createSession);

    await makeManager().sendMessage("chat-auto-retry", "do the thing");

    expect(promptCalls()).toBe(2);
    expect(autoRetryUserRows()).toHaveLength(1);
  });

  it("does not retry a silent runtime that produced no thinking and no tools", async () => {
    const { createSession, promptCalls } = makeFakeSession(
      [{ role: "assistant", content: [], stopReason: "stop" }],
    );
    mockCreateResolvedAgentSession.mockImplementation(createSession);

    await makeManager().sendMessage("chat-auto-retry", "do the thing");

    expect(promptCalls()).toBe(1);
    expect(autoRetryUserRows()).toHaveLength(0);
  });

  /*
  FNXC:ChatAutoRetry 2026-09-17-23:31 (RUFU-255 retro audit):
  The explicit-Stop gate is control-flow in the production code (the cancellation branch
  returns before the auto-retry dispatch point), so the assertion that matters is that a
  mid-work Stop persists its interrupted row and never earns a synthetic retry row.
  Fake shape mirrors the proven native-interruption test in chat-manager.test.ts:
  `abort()` rejects the pending prompt so the send loop enters its catch.
  */
  it("never retries a turn the operator explicitly stopped", async () => {
    let rejectPrompt: ((reason?: unknown) => void) | undefined;
    let promptCount = 0;
    mockCreateResolvedAgentSession.mockImplementation(async (opts: { onThinking?: (delta: string) => void }) => {
      const session = {
        model: { provider: "test-provider", id: "test-model", contextWindow: 128_000, maxTokens: 4_096 },
        state: { messages: [] as Array<Record<string, unknown>> },
        prompt: vi.fn(() => {
          promptCount += 1;
          opts.onThinking?.("streamed work before the operator hit Stop");
          return new Promise<void>((_resolve, reject) => {
            rejectPrompt = reject;
          });
        }),
        abort: vi.fn(async () => {
          rejectPrompt?.(new Error("Runtime interrupted"));
        }),
        dispose: vi.fn(),
      };
      return { session, model: { provider: "test-provider", modelId: "test-model" } };
    });

    const manager = makeManager();
    const sendPromise = manager.sendMessage("chat-auto-retry", "do the thing");
    await new Promise((resolve) => setTimeout(resolve, 0));

    let sentinel: ReturnType<typeof setTimeout> | undefined;
    try {
      const cancellation = await Promise.race([
        manager.cancelGeneration("chat-auto-retry"),
        new Promise<never>((_resolve, reject) => {
          sentinel = setTimeout(() => reject(new Error("Cancellation did not settle")), 250);
        }),
      ]);
      await sendPromise;

      // Non-vacuity: the turn really ran and the Stop path really persisted its record.
      expect(cancellation).toEqual(expect.objectContaining({ success: true, interrupted: true }));
      expect(promptCount).toBe(1);
      const interruptedRows = mockChatStore.addMessage.mock.calls.filter(
        (c) => (c[1] as { role?: string; metadata?: Record<string, unknown> }).role === "assistant"
          && (c[1] as { metadata?: Record<string, unknown> }).metadata?.interrupted === true,
      );
      expect(interruptedRows).toHaveLength(1);
      // The gate itself: an explicit Stop must not enqueue a synthetic retry.
      expect(autoRetryUserRows()).toHaveLength(0);
    } finally {
      if (sentinel !== undefined) clearTimeout(sentinel);
    }
  });

  /*
  FNXC:ChatAutoRetry 2026-09-17-23:31 (RUFU-255 retro audit):
  A turn whose LAST tool call is a question tool is legitimately waiting for the operator's
  answer - retrying it would answer the question card for them. Same scripted shape as the
  "no reply" retry scenario minus the suppression: the question tool call is the only delta,
  so a green run here proves the gate (not an unrelated condition) suppresses the retry.
  */
  it("does not retry a turn parked on a pending question card", async () => {
    let promptCount = 0;
    mockCreateResolvedAgentSession.mockImplementation(async (opts: {
      onThinking?: (delta: string) => void;
      onToolStart?: (name: string, args?: Record<string, unknown>) => void;
      onToolEnd?: (name: string, isError: boolean, result?: unknown) => void;
    }) => {
      const session = {
        model: { provider: "test-provider", id: "test-model", contextWindow: 128_000, maxTokens: 4_096 },
        state: { messages: [] as Array<Record<string, unknown>> },
        prompt: vi.fn(async () => {
          promptCount += 1;
          opts.onThinking?.("need the operator's choice");
          opts.onToolStart?.("fn_ask_question", { question: "Which option?" });
          opts.onToolEnd?.("fn_ask_question", false, { status: "awaiting-answer" });
          session.state.messages.push({
            role: "assistant",
            content: [{ type: "thinking", thinking: "need the operator's choice" }],
            stopReason: "stop",
          });
        }),
        dispose: vi.fn(),
      };
      return { session, model: { provider: "test-provider", modelId: "test-model" } };
    });

    await makeManager().sendMessage("chat-auto-retry", "do the thing");

    expect(promptCount).toBe(1);
    expect(autoRetryUserRows()).toHaveLength(0);
  });

  /*
  FNXC:ChatAutoRetry 2026-09-17-23:31 (RUFU-255 retro audit):
  chat-manager.test.ts pins the provider-error retry's row COUNTS; this pins the synthetic
  row's `reason: "provider-error"` value and the evidence requirement (a throw AFTER
  streamed output is retried; the chain guard bounds it at one attempt).
  */
  it("retries once with reason 'provider-error' when an error interrupts work in progress", async () => {
    let promptCount = 0;
    mockCreateResolvedAgentSession.mockImplementation(async (opts: {
      onThinking?: (delta: string) => void;
      onText?: (delta: string) => void;
    }) => {
      const session = {
        model: { provider: "test-provider", id: "test-model", contextWindow: 128_000, maxTokens: 4_096 },
        state: { messages: [] as Array<Record<string, unknown>> },
        prompt: vi.fn(async () => {
          promptCount += 1;
          opts.onThinking?.("halfway through the work");
          opts.onText?.("Partial answer");
          throw new Error("model container restarted mid-turn");
        }),
        dispose: vi.fn(),
      };
      return { session, model: { provider: "test-provider", modelId: "test-model" } };
    });

    await makeManager().sendMessage("chat-auto-retry", "do the thing");

    // First attempt fails with evidence -> one bounded retry -> retry fails identically but
    // the chain guard stops it there.
    expect(promptCount).toBe(2);
    const retries = autoRetryUserRows();
    expect(retries).toHaveLength(1);
    expect((retries[0][1] as { metadata: Record<string, unknown> }).metadata).toEqual(
      expect.objectContaining({ autoRetry: true, reason: "provider-error" }),
    );
  });
});
