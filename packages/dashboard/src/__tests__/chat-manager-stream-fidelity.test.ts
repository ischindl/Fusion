/*
FNXC:ChatPersistence 2026-09-13-23:20:
RUFU-234 stream-fidelity contract on the persistence side. The operator's corrupted reply was COMPLETE, so the
persisted chat row itself carried the character holes — which is only possible when the string that reaches
`chatStore.addMessage` is the streamed accumulator rather than an intact transcript. These tests drive the
REAL `createAssistantStreamCapture` (wired exactly as packages/engine/src/pi.ts wires it: pi events in,
onText/onThinking/onTextBlockBoundary out) through the REAL `ChatManager.sendMessage` sinks, so the whole
lane — capture -> accumulatedText -> broadcast -> authoritative-reply join -> addMessage — is asserted, not
just the seam. Two transcript states are required because the join is a LONGER-WINS reconciliation: with an
intact pi transcript present the join masks a lossy accumulator (that is the falsification of the join as the
deleting layer), while a no-state runtime transcript (the plugin-CLI shape that omits `state`) leaves the
accumulator as the only candidate, which is how loss reaches the operator-visible row.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ChatManager,
  __setBuildAgentChatPrompt,
  __setCreateResolvedAgentSession,
  __resetChatState,
} from "../chat.js";
import { createAssistantStreamCapture } from "../../../engine/src/execution/assistant-text-capture.js";

const { mockSummarizeTitle } = vi.hoisted(() => ({ mockSummarizeTitle: vi.fn() }));

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  summarizeTitle: mockSummarizeTitle,
  DASHBOARD_USER_ID: "dashboard",
}));

vi.mock("../sse.js", () => ({ emitWorkflowSseEvent: vi.fn() }));

const fakeSessionManager = {
  getSessionFile: () => "/tmp/rufu-234-fidelity/.pi-fake/session.jsonl",
  getLeafId: () => "leaf-fake",
  branch: () => {},
  resetLeaf: () => {},
  appendMessage: () => "entry-fake",
  buildSessionContext: () => ({ messages: [] }),
  createBranchedSession: () => "/tmp/rufu-234-fidelity/.pi-fake/session-branched.jsonl",
};
vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    create: () => fakeSessionManager,
    open: () => fakeSessionManager,
  },
}));

type Block = { type: string; text?: string; thinking?: string };
type SessionMessage = { role: string; content?: string | Block[]; stopReason?: string };

const upd = (assistantMessageEvent: Record<string, unknown>) => ({ type: "message_update", assistantMessageEvent });

function assistant(text: string, stopReason = "stop"): SessionMessage {
  return { role: "assistant", content: [{ type: "text", text }], stopReason };
}

describe("ChatManager.sendMessage — streamed reply persists byte-faithfully (RUFU-234)", () => {
  const store = {
    getSession: vi.fn(),
    addMessage: vi.fn(),
    getMessage: vi.fn(),
    getMessages: vi.fn(),
    updateSession: vi.fn(),
    setCliSessionFile: vi.fn(),
    setInFlightGeneration: vi.fn(),
    updateMessageMetadata: vi.fn(),
    recordTokenUsage: vi.fn(),
  };
  const agentStore = { init: vi.fn(), getAgent: vi.fn(), listAgents: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetChatState();
    store.getSession.mockReturnValue({ id: "chat-001", agentId: "agent-001", status: "active", title: "Existing" });
    store.addMessage.mockImplementation((_sessionId: string, input: { role: string; content: string }) => ({
      id: `msg-${input.role}`,
      sessionId: "chat-001",
      role: input.role,
      content: input.content,
      createdAt: "2026-09-13T00:00:00.000Z",
    }));
    store.getMessages.mockReturnValue([]);
    store.setInFlightGeneration.mockResolvedValue(undefined);
    agentStore.init.mockResolvedValue(undefined);
    agentStore.getAgent.mockResolvedValue({ id: "agent-001", name: "Avery", role: "executor", runtimeConfig: {} });
    agentStore.listAgents.mockResolvedValue([]);
    __setBuildAgentChatPrompt(async ({ basePrompt }: any) => basePrompt);
  });

  afterEach(() => {
    __resetChatState();
    vi.restoreAllMocks();
  });

  /**
   * Streams one assistant turn through a real capture seam. `events` are pi-shaped events delivered to the
   * seam exactly as pi.ts delivers them; `mutate` runs the producer's in-place block mutation at the point
   * the real producer performs it (before async delivery of the paired delta).
   */
  async function runTurn(options: {
    events: (capture: { handleAgentEvent(event: unknown): void }) => void;
    transcript: SessionMessage[] | undefined;
  }): Promise<{ persisted: string; liveLane: string }> {
    const liveFrames: string[] = [];
    __setCreateResolvedAgentSession(async (sessionOptions: any) => {
      const capture = createAssistantStreamCapture({
        onText: (delta) => {
          liveFrames.push(delta);
          sessionOptions.onText?.(delta);
        },
        onThinking: (delta) => sessionOptions.onThinking?.(delta),
        onTextBlockBoundary: () => sessionOptions.onTextBlockBoundary?.(),
      });
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            options.events(capture);
          }),
          dispose: vi.fn(),
          model: { provider: "openai", id: "vllm-model" },
          ...(options.transcript ? { state: { messages: options.transcript } } : {}),
        },
      } as any;
    });

    const manager = new ChatManager(store as any, "/tmp/rufu-234-fidelity", agentStore as any);
    await manager.sendMessage("chat-001", "Is the approval in place?");

    const assistantCalls = store.addMessage.mock.calls.filter(([, input]) => input.role === "assistant");
    expect(assistantCalls).toHaveLength(1);
    return { persisted: assistantCalls[0]![1].content, liveLane: liveFrames.join("") };
  }

  /**
   * The operator's inter-word-space signature. The openai-completions producer mutates the shared block
   * (`block.text += delta`) before pi re-delivers the paired events asynchronously, so the space between two
   * words can live in the authoritative block text without ever being the payload of its own delta.
   */
  function spaceGapEvents(capture: { handleAgentEvent(event: unknown): void }) {
    const partial = { content: [{ type: "text", text: "healthy" } as Block] };
    capture.handleAgentEvent({ type: "message_start" });
    capture.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    partial.content[0].text = "healthy in-review"; // producer coalesced " in-review" into the block
    capture.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: "in-review" }));
    capture.handleAgentEvent({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "healthy in-review" }] },
    });
  }

  it("persists the intact reply when the pi transcript is absent (no-state runtime)", async () => {
    // The plugin-CLI/no-state shape: with no transcript slice the accumulator is the only candidate for
    // the persisted row, so a lossy capture reaches the operator-visible row. This is the discriminator
    // for "the persisted row itself is corrupted" and is RED while the seam under-delivers.
    const { persisted, liveLane } = await runTurn({ events: spaceGapEvents, transcript: undefined });
    expect(liveLane).toBe("healthy in-review");
    expect(persisted).toBe("healthy in-review");
  });

  it("persists the intact reply byte-for-byte for the operator's leading-loss shape (no-state runtime)", async () => {
    const events = (capture: { handleAgentEvent(event: unknown): void }) => {
      const partial = { content: [{ type: "text", text: "LongerFirst" } as Block] };
      capture.handleAgentEvent({ type: "message_start" });
      capture.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
      // A second assistant turn reuses the same partial object; the stale block ledger must not slice
      // the new block's leading characters ("notes" -> "otes").
      partial.content[0].text = "notes/origin/using-39";
      capture.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
      capture.handleAgentEvent({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "notes/origin/using-39" }] },
      });
    };
    const { persisted, liveLane } = await runTurn({ events, transcript: undefined });
    // The first block was genuinely streamed, so both are visible — but nothing may be deleted from either.
    expect(liveLane).toBe("LongerFirstnotes/origin/using-39");
    expect(persisted).toBe("LongerFirstnotes/origin/using-39");
  });

  it("persists the intact reply when the transcript is present (join is faithful, not the deleting layer)", async () => {
    // Falsification record: the authoritative-reply join never deletes intra-word characters. With the
    // intact pi transcript present its longer-wins reconciliation already masks a lossy accumulator, so
    // the join cannot be the layer that produced the operator's holes.
    const intact = "healthy in-review";
    const { persisted } = await runTurn({
      events: spaceGapEvents,
      transcript: [
        { role: "user", content: "Is the approval in place?" },
        assistant(intact),
      ],
    });
    expect(persisted).toBe(intact);
  });

  it("emits one live text frame per delivered span with no dropped frame", async () => {
    // The live overlay consumes one `text` frame per capture emission; the frames concatenated must equal
    // the same intact text the persisted row carries, so live view and re-rendered row show the same bytes.
    const { persisted, liveLane } = await runTurn({ events: spaceGapEvents, transcript: undefined });
    expect(liveLane).toBe(persisted);
    expect(liveLane).toBe("healthy in-review");
  });

  /*
  FNXC:ChatPersistence 2026-09-13-23:28:
  RUFU-234 plan-review F1: `onTextBlockBoundary` is the ONLY writer of the inter-block separator in the chat lane,
  and its trigger is the capture seam's boundary predicate (partial identity + content index). Every single-block
  fixture above leaves that path unobserved, so a predicate regression would glue blocks — the `healthyin-review`
  signature — and stay green. This multi-block turn (the correctly-indexed shape pi and the repo's own
  cross-runtime-fallback producer emit) pins the signal end-to-end: the persisted row carries the "\n\n" separator,
  and neither block's text is glued, dropped, or duplicated by the terminal sweep.
  */
  it("persists a multi-block turn with the inter-block separator intact (no gluing)", async () => {
    const events = (capture: { handleAgentEvent(event: unknown): void }) => {
      const partial = { content: [{ type: "text", text: "" } as Block, { type: "text", text: "" } as Block] };
      capture.handleAgentEvent({ type: "message_start" });
      capture.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
      partial.content[0].text = "first block"; // producer mutated ahead of the delta's async delivery
      capture.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: "first" }));
      capture.handleAgentEvent(upd({ type: "text_end", partial, contentIndex: 0, content: "first block" }));
      capture.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 1 }));
      partial.content[1].text = "notes/origin/using-39";
      capture.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 1, delta: "notes" }));
      capture.handleAgentEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "first block" } as Block,
            { type: "text", text: "notes/origin/using-39" } as Block,
          ],
        },
      });
    };
    const { persisted, liveLane } = await runTurn({ events, transcript: undefined });
    // The seam hands out block texts; the separator is chat.ts's insertion at the boundary signal, from the same
    // statement that appends it to `accumulatedText` — so the intact persisted row proves the signal fired.
    expect(liveLane).toBe("first block" + "notes/origin/using-39");
    expect(persisted).toBe("first block\n\nnotes/origin/using-39");
  });

  it("keeps diacritics intact end-to-end (Reštartuj, not Reštuj)", async () => {
    const events = (capture: { handleAgentEvent(event: unknown): void }) => {
      const chunks = ["Reš", "tar", "tuj", " použit", "ý", " daemon"];
      const partial = { content: [{ type: "text", text: "" } as Block] };
      capture.handleAgentEvent({ type: "message_start" });
      capture.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
      for (let i = 0; i < chunks.length; i++) {
        partial.content[0].text = chunks.slice(0, Math.min(chunks.length, i + 2)).join("");
        capture.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: chunks[i] }));
      }
      partial.content[0].text = chunks.join("");
      capture.handleAgentEvent({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: chunks.join("") }] },
      });
    };
    const expected = "Reštartuj použitý daemon";
    const { persisted, liveLane } = await runTurn({ events, transcript: undefined });
    expect(liveLane).toBe(expected);
    expect(persisted).toBe(expected);
  });
});
