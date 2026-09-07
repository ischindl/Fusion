/*
FNXC:ChatSendDurability 2026-09-07-11:00:
RUFU-192 Step 1 — the `user_persisted` side-channel acknowledgement.

The SSE route flushes headers before `ChatManager.sendMessage` runs, so `res.ok` is not proof
the user turn was stored; every send that died between acceptance and `chatStore.addMessage`
destroyed the typed prompt. This suite pins the server half of the contract:
- exactly one `user_persisted` event carrying the persisted row id when `addMessage` resolves,
  ordered before the turn's `done`/terminal event;
- no `user_persisted` and an `error` broadcast when `addMessage` rejects (the non-persisted signal);
- the acknowledgement is generation-scoped (carries the send's `generationId`), so the route's
  fenced subscriber can receive it.
Narrow fakes only — no real network, DB, or model loop (no-slow-tests rule).
*/
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
FNXC:TestHygiene 2026-09-07-11:00:
Exclusive temp root (ThreatCrush CWE-377 rule — never a predictable OS temp path). The suite
never writes through this root; afterAll removes it anyway.
*/
const TEST_ROOT = mkdtempSync(join(tmpdir(), "fusion-chat-user-persisted-"));
afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

const { mockSessionManagerCreate, mockSessionManagerOpen } = vi.hoisted(() => {
  const fakeManager = {
    getSessionFile: () => "session-fake.jsonl",
    getLeafId: () => "leaf-fake",
    branch: () => {},
    resetLeaf: () => {},
    appendMessage: () => "entry-fake",
    buildSessionContext: () => ({ messages: [] }),
    createBranchedSession: () => "session-branched-fake.jsonl",
  };
  return {
    mockSessionManagerCreate: vi.fn(() => fakeManager),
    mockSessionManagerOpen: vi.fn(() => fakeManager),
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    create: mockSessionManagerCreate,
    open: mockSessionManagerOpen,
  },
}));

import {
  ChatManager,
  __resetChatState,
  __setBuildAgentChatPrompt,
  __setCreateResolvedAgentSession,
  chatStreamManager,
} from "../chat.js";

const mockChatStore = {
  getSession: vi.fn(),
  createSession: vi.fn(),
  addMessage: vi.fn(),
  getMessage: vi.fn(),
  getMessages: vi.fn(),
  updateSession: vi.fn(),
  setCliSessionFile: vi.fn(),
  setInFlightGeneration: vi.fn(),
  getRoomMessages: vi.fn(),
  recordTokenUsage: vi.fn(),
  deleteMessagesFrom: vi.fn(),
  updateMessageMetadata: vi.fn(),
};

const mockAgentStore = {
  init: vi.fn(),
  getAgent: vi.fn(),
  listAgents: vi.fn(),
};

function createChatManager(): ChatManager {
  return new ChatManager(mockChatStore as never, TEST_ROOT, mockAgentStore as never);
}

describe("ChatManager.sendMessage — user_persisted acknowledgement (RUFU-192)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetChatState();

    mockChatStore.getSession.mockReturnValue({
      id: "chat-ack",
      agentId: "agent-001",
      status: "active",
      title: "ack-test-session",
    });
    mockChatStore.addMessage.mockImplementation((_sessionId: string, input: { role: string }) => ({
      id: input.role === "user" ? "user-row-1" : "assistant-row-1",
      sessionId: "chat-ack",
      role: input.role,
      content: input.content ?? "",
      createdAt: "2026-09-07T00:00:00.000Z",
    }));
    mockChatStore.getMessages.mockReturnValue([]);
    mockChatStore.getRoomMessages.mockReturnValue([]);
    mockChatStore.setInFlightGeneration.mockResolvedValue(undefined);

    mockAgentStore.init.mockResolvedValue(undefined);
    mockAgentStore.getAgent.mockResolvedValue({
      id: "agent-001",
      name: "Avery",
      role: "executor",
      soul: "Be calm and precise.",
      memory: "",
      instructionsText: "",
      runtimeConfig: {},
    });
    mockAgentStore.listAgents.mockResolvedValue([]);

    __setBuildAgentChatPrompt(async ({ basePrompt }: { basePrompt: string }) => basePrompt);
    __setCreateResolvedAgentSession(async () => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        model: { provider: "anthropic", id: "claude-test" },
        state: { messages: [{ role: "assistant", content: "done" }] },
      },
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("broadcasts exactly one user_persisted carrying the persisted user row id, before the terminal event", async () => {
    const events: Array<{ type: string; data: unknown }> = [];
    const unsubscribe = chatStreamManager.subscribe("chat-ack", (event) => {
      events.push(event);
    });

    try {
      await createChatManager().sendMessage("chat-ack", "the typed prompt");
    } finally {
      unsubscribe();
    }

    const persistedEvents = events.filter((event) => event.type === "user_persisted");
    expect(persistedEvents).toHaveLength(1);
    // Id-only payload: the acknowledgement is the persisted row id, never the prompt text.
    expect(persistedEvents[0]?.data).toEqual({ messageId: "user-row-1" });

    // Ordering contract: the row exists before any terminal event can close the stream.
    const persistedIndex = events.findIndex((event) => event.type === "user_persisted");
    const terminalIndex = events.findIndex((event) => event.type === "done" || event.type === "error");
    expect(persistedIndex).toBeGreaterThanOrEqual(0);
    expect(terminalIndex).toBeGreaterThan(persistedIndex);
  });

  it("broadcasts no user_persisted and an error event when addMessage rejects", async () => {
    mockChatStore.addMessage.mockRejectedValueOnce(new Error("database unavailable"));

    const events: Array<{ type: string; data: unknown }> = [];
    const unsubscribe = chatStreamManager.subscribe("chat-ack", (event) => {
      events.push(event);
    });

    try {
      await createChatManager().sendMessage("chat-ack", "the typed prompt");
    } finally {
      unsubscribe();
    }

    expect(events.some((event) => event.type === "user_persisted")).toBe(false);
    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent).toBeDefined();
    expect(typeof errorEvent?.data === "string" ? errorEvent.data : JSON.stringify(errorEvent?.data)).toContain(
      "Failed to save message",
    );
  });

  it("carries the send's generationId on the acknowledgement broadcast", async () => {
    const broadcast = vi.spyOn(chatStreamManager, "broadcast");
    const { generationId } = createChatManager().beginGeneration("chat-ack");

    await createChatManager().sendMessage("chat-ack", "the typed prompt", undefined, undefined, undefined, {
      generationId,
    });

    const ackCalls = broadcast.mock.calls.filter(
      ([, event]) => (event as { type: string }).type === "user_persisted",
    );
    expect(ackCalls).toHaveLength(1);
    expect(ackCalls[0]?.[2]).toEqual({ generationId });
  });
});
